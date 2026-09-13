/**
 * dsh-rubika — Rubika Bot Gateway for DeepSeek Harness
 *
 * Connects to Rubika Bot API v3 via HTTP long-polling.
 * One persistent agent session per chat_id.
 * Works on Railway (outbound-only, no inbound port needed).
 *
 * Environment variables:
 *   RUBIKA_BOT_TOKEN           — required, from @BotFather on Rubika
 *   RUBIKA_ALLOWED_USERS       — optional, comma-separated user IDs (empty = allow all)
 *   RUBIKA_ALLOW_ALL_USERS     — optional, "true" to allow everyone
 *   RUBIKA_GROUP_ALLOWED_CHATS — optional, comma-separated group chat IDs
 */

import { randomUUID } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as fs from "node:fs/promises";

// ─── Plugin metadata ─────────────────────────────────────────────────────────

export const name = "dsh-rubika";
// Declare required services: cordis forbids ctx.<svc> access without inject.
export const inject = ["agents", "agentDefaultModel", "agentPresets", "sessionPersistence", "tools"]; // <-- ADDED "tools"

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = "https://botapi.rubika.ir/v3";
const MAX_MESSAGE_LENGTH = 4096;
const POLL_INTERVAL_MS = 1000;
const RECONNECT_BACKOFF = [2, 5, 10, 30, 60];
const DEDUP_MAX = 1000;

// ─── File attachment limits ──────────────────────────────────────────────────
// Caps protect Railway memory: downloads beyond the cap are refused, extracted
// text beyond the cap is truncated.
const MAX_FILE_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_FILE_TEXT_CHARS = 50_000; // ~50KB of extracted text per file

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const IMAGE_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
// Plain-text formats read directly (subtitles, docs, data, source code, ...).
const TEXT_EXTS = new Set([
  "txt", "srt", "vtt", "lrc", "md", "markdown", "json", "jsonl", "csv", "tsv",
  "log", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "env", "js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "sh", "bash", "c", "h",
  "cpp", "hpp", "java", "go", "rs", "php", "rb", "swift", "kt", "sql", "css",
  "scss", "vue", "diff", "patch",
]);

// ─── Environment helpers ─────────────────────────────────────────────────────

function getToken() {
  return (process.env.RUBIKA_BOT_TOKEN || "").trim();
}

function getAllowedUsers() {
  const raw = (process.env.RUBIKA_ALLOWED_USERS || "").trim();
  if (!raw) return null; // null = allow all
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function isAllowAll() {
  return (
    process.env.RUBIKA_ALLOW_ALL_USERS === "true" ||
    process.env.RUBIKA_ALLOW_ALL_USERS === "1"
  );
}

function getAllowedGroups() {
  const raw = (process.env.RUBIKA_GROUP_ALLOWED_CHATS || "").trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// ─── Dedup ───────────────────────────────────────────────────────────────────

const _seen = new Set();
function isDuplicate(key) {
  if (_seen.has(key)) return true;
  _seen.add(key);
  if (_seen.size > DEDUP_MAX) {
    const arr = [..._seen];
    for (let i = 0; i < Math.floor(arr.length / 2); i++) _seen.delete(arr[i]);
  }
  return false;
}

// ─── Poll cursor state ───────────────────────────────────────────────────────
// `offset` is the Rubika pagination cursor (next_offset_id from getUpdates).
// `lastSeenTime` filters out stale backlog accumulated while offline —
// initialized to boot time so old queued messages are skipped, not answered.
let offset = "";
let lastSeenTime = Math.floor(Date.now() / 1000);

// ─── HTTP client (native fetch) ──────────────────────────────────────────────

async function rubikaPost(path, token, body, timeoutMs = 15_000) {
  const url = `${API_BASE}/${token}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(
        `HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Rubika API wrappers ─────────────────────────────────────────────────────

async function rubikaSendMessage(token, chatId, text, replyTo) {
  const body = { chat_id: chatId, text: text.slice(0, MAX_MESSAGE_LENGTH) };
  if (replyTo) body.reply_to_message_id = replyTo;
  return rubikaPost("sendMessage", token, body);
}

async function rubikaGetChatInfo(token, chatId) {
  try {
    const data = await rubikaPost("getChat", token, { chat_id: chatId }, 10_000);
    const chat = data.data?.chat || {};
    return {
      name: chat.title || chat.first_name || chatId,
      type:
        chat.chat_type === "Group" || chat.chat_type === "Channel"
          ? "group"
          : "dm",
      username: chat.username || null,
    };
  } catch {
    return { name: chatId, type: "dm", username: null };
  }
}

// ─── File upload (agent → Rubika) ────────────────────────────────────────────
// Rubika Bot API v3 file sending is a 3-step flow (see
// https://rubika.ir/botapi/methods):
//   1. requestSendFile { type: FileTypeEnum } → { upload_url }
//   2. POST the bytes to upload_url as multipart/form-data field `file`
//      → { file_id }
//   3. sendFile { chat_id, file_id, text? } → message is delivered.
//
// FileTypeEnum (from https://rubika.ir/botapi/models): File (generic, ≤50MB),
// Image (jpg/gif/png/webp, ≤10MB), Voice (short mp3), Video (mp4, ≤50MB),
// Music (mp3), Gif (silent mp4).

// Agent-facing kind → Rubika FileTypeEnum.
const SEND_KIND_TO_FILE_TYPE = {
  photo: "Image",
  video: "Video",
  audio: "Music",
  voice: "Voice",
  document: "File",
  gif: "Gif",
  file: "File",
};

// Max bytes Rubika accepts per FileTypeEnum (docs). Reads beyond the cap are
// refused before upload to protect Railway memory.
const SEND_FILE_MAX_BYTES = {
  Image: 10 * 1024 * 1024, // 10MB
  File: 50 * 1024 * 1024, // 50MB
  Video: 50 * 1024 * 1024, // 50MB
  Music: 50 * 1024 * 1024,
  Voice: 50 * 1024 * 1024,
  Gif: 50 * 1024 * 1024,
};

const SEND_FILE_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** Step 1: ask Rubika for a dedicated upload URL for this file type. */
async function rubikaRequestSendFile(token, fileTypeEnum) {
  const data = await rubikaPost(
    "requestSendFile",
    token,
    { type: fileTypeEnum },
    15_000
  );
  if (data?.status === "ERROR") {
    throw new Error(
      `Rubika requestSendFile error: ${data.status_det || JSON.stringify(data).slice(0, 200)}`
    );
  }
  const uploadUrl = data?.data?.upload_url ?? data?.upload_url;
  if (!uploadUrl) {
    throw new Error(
      `Rubika requestSendFile returned no upload_url: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return uploadUrl;
}

/** Step 2: POST raw bytes to the upload_url; returns the file_id. */
async function rubikaUploadBytes(uploadUrl, bytes, fileName, mediaType, timeoutMs = 60_000) {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([bytes], { type: mediaType || "application/octet-stream" }),
    fileName
  );
  const resp = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Upload HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data?.status === "ERROR") {
    throw new Error(
      `Rubika upload error: ${data.status_det || JSON.stringify(data).slice(0, 200)}`
    );
  }
  const fileId = data?.data?.file_id ?? data?.file_id;
  if (!fileId) {
    throw new Error(
      `Rubika upload returned no file_id: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return fileId;
}

/** Step 3: deliver the uploaded file_id to a chat. */
async function rubikaDeliverFile(token, chatId, fileId, text) {
  const body = { chat_id: chatId, file_id: fileId };
  if (text) body.text = text.slice(0, MAX_MESSAGE_LENGTH);
  return rubikaPost("sendFile", token, body, 15_000);
}

/**
 * Send one file from disk to a Rubika chat (full 3-step flow).
 * @param {string} kind - photo | video | audio | voice | document | file
 * @returns {{ fileId: string, messageId: string|undefined }} delivery receipt
 */
async function rubikaSendFile(token, chatId, kind, filePath, caption) {
  const fileTypeEnum = SEND_KIND_TO_FILE_TYPE[kind] ?? "File";
  const cap = SEND_FILE_MAX_BYTES[fileTypeEnum] ?? MAX_FILE_DOWNLOAD_BYTES;
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new Error(`Cannot read file "${filePath}": ${err.message}`);
  }
  if (bytes.length > cap) {
    throw new Error(
      `حجم فایل (${formatBytes(bytes.length)}) از سقف روبیکا برای نوع ${fileTypeEnum} بیشتر است.`
    );
  }
  const fileName = filePath.split("/").pop() || "file";
  const mediaType = SEND_FILE_MIME[fileExt(fileName)] || "application/octet-stream";

  const uploadUrl = await rubikaRequestSendFile(token, fileTypeEnum);
  const fileId = await rubikaUploadBytes(uploadUrl, bytes, fileName, mediaType);
  const delivered = await rubikaDeliverFile(token, chatId, fileId, caption);
  if (delivered?.status === "ERROR") {
    throw new Error(
      `Rubika sendFile error: ${delivered.status_det || JSON.stringify(delivered).slice(0, 200)}`
    );
  }
  return { fileId, messageId: delivered?.data?.message_id ?? delivered?.message_id };
}

// ─── File download + conversion ──────────────────────────────────────────────
// Converts a Rubika file attachment into agent-ready message content:
//   images → image content block (agent sees the picture)
//   PDF → extracted per-page text (via unpdf)
//   text formats (srt/txt/md/json/code/...) → inline text
//   audio/video/archives/other → metadata note (content not readable)

function formatBytes(n) {
  const v = parseInt(n || "0", 10);
  if (!v) return "نامشخص";
  if (v < 1024) return `${v} بایت`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / (1024 * 1024)).toFixed(1)}MB`;
}

function fileExt(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name || "");
  return (m?.[1] || "").toLowerCase();
}

async function rubikaGetFile(token, fileId) {
  return rubikaPost("getFile", token, { file_id: fileId }, 15_000);
}

async function downloadBytes(url, maxBytes, timeoutMs = 30_000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`Download HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(
      `حجم فایل (${formatBytes(buf.length)}) از سقف مجاز بیشتر است.`
    );
  }
  return buf;
}

async function resolveDownloadUrl(token, fileId) {
  const dl = await rubikaGetFile(token, fileId);
  const url = dl.data?.download_url;
  if (!url) throw new Error("لینک دانلود دریافت نشد.");
  return url;
}

/**
 * Downloads a Rubika file and converts it to agent-ready content.
 * @returns {{ text: string, blocks: Array }} text augments the caption,
 *   blocks are extra user-message content blocks (e.g. images).
 */
async function prepareFileContent(ctx, token, file, caption) {
  const name = file?.file_name || "فایل";
  const ext = fileExt(name);
  const fileId = file?.file_id;
  const base = caption ? `${caption}\n` : "";

  if (!fileId) {
    return { text: `${base}[فایل: ${name}]`, blocks: [] };
  }

  // ── Images: download → attachments.saveImage → image block ──
  if (IMAGE_EXTS.has(ext)) {
    try {
      const attachments = ctx.get?.("attachments") || ctx.attachments;
      if (!attachments?.saveImage) {
        throw new Error("سرویس پردازش تصویر (attachments) در دسترس نیست.");
      }
      const url = await resolveDownloadUrl(token, fileId);
      const bytes = await downloadBytes(url, MAX_FILE_DOWNLOAD_BYTES);
      const ref = await attachments.saveImage({
        data: bytes,
        mediaType: IMAGE_MIME[ext],
        name,
      });
      return {
        text: `${base}[عکس: ${name}] — لطفاً این تصویر را تحلیل کن.`,
        blocks: [{ type: "image", attachment: ref }],
      };
    } catch (err) {
      console.error(`[dsh-rubika] Image failed for ${name}:`, err.message);
      return {
        text: `${base}[عکس: ${name} — دانلود ناموفق بود: ${err.message}]`,
        blocks: [],
      };
    }
  }

  // ── PDF: download → extract text per page ──
  if (ext === "pdf") {
    try {
      const url = await resolveDownloadUrl(token, fileId);
      const bytes = await downloadBytes(url, MAX_FILE_DOWNLOAD_BYTES);
      const { extractText } = await import("unpdf");
      const { text, totalPages } = await extractText(bytes);
      const joined = (Array.isArray(text) ? text.join("\n") : String(text || ""))
        .trim()
        .slice(0, MAX_FILE_TEXT_CHARS);
      if (!joined) {
        return {
          text: `${base}[PDF با ${totalPages} صفحه: ${name} — متنی استخراج نشد (ممکن است اسکن‌شده باشد).]`,
          blocks: [],
        };
      }
      return {
        text: `${base}[متن استخراج‌شده از PDF «${name}» (${totalPages} صفحه):]\n${joined}`,
        blocks: [],
      };
    } catch (err) {
      console.error(`[dsh-rubika] PDF failed for ${name}:`, err.message);
      return {
        text: `${base}[PDF: ${name} — استخراج متن ناموفق بود: ${err.message}]`,
        blocks: [],
      };
    }
  }

  // ── Plain text formats (srt, txt, md, json, code...): download → inline ──
  if (TEXT_EXTS.has(ext)) {
    try {
      const url = await resolveDownloadUrl(token, fileId);
      const bytes = await downloadBytes(url, MAX_FILE_DOWNLOAD_BYTES);
      const decoded = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes)
        .slice(0, MAX_FILE_TEXT_CHARS);
      return {
        text: `${base}[محتوای فایل «${name}»:]\n${decoded}`,
        blocks: [],
      };
    } catch (err) {
      console.error(`[dsh-rubika] Text file failed for ${name}:`, err.message);
      return {
        text: `${base}[فایل: ${name} — دانلود ناموفق بود: ${err.message}]`,
        blocks: [],
      };
    }
  }

  // ── Audio/video/archives/others: metadata only ──
  return {
    text: `${base}[فایل: ${name} (${formatBytes(file?.size)}) — این نوع فایل قابل خواندن نیست؛ فقط مشخصاتش ارسال شد.]`,
    blocks: [],
  };
}

// ─── Per-chat message queue ──────────────────────────────────────────────────
// Serializes message processing per chat so two rapid messages don't race.

const _chatQueues = new Map();

function enqueueChat(chatId, fn) {
  const prev = _chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _chatQueues.set(chatId, next);
  // garbage-collect resolved queue entry
  next.then(() => {
    if (_chatQueues.get(chatId) === next) _chatQueues.delete(chatId);
  }, () => {
    if (_chatQueues.get(chatId) === next) _chatQueues.delete(chatId);
  });
  return next;
}

// Max time one chat turn may occupy the gateway before the watchdog frees it.
// A stuck turn (e.g. a model call that never settles) previously wedged both
// the per-chat queue AND the poll loop via `await chatQueue`, so every chat
// looked "dead" while the process stayed alive.
const TURN_TIMEOUT_MS = parseInt(process.env.RUBIKA_TURN_TIMEOUT_MS || "300000", 10); // 5 min

/**
 * Wait for `promise`, but give up after `ms`. On timeout the turn is
 * considered stuck: the error tells the caller to reset that chat's agent.
 */
function withTurnTimeout(promise, ms, chatId) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`turn timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Agent management ────────────────────────────────────────────────────────

/** In-memory agent handles: chat_id → { agent, dispose } */
const _agents = new Map();
/** Session ID suffixes for new sessions: chat_id → suffix string */
const _chatSessionSuffix = new Map();

async function resetChatAgent(chatId) {
  const existing = _agents.get(chatId);
  if (existing) {
    try {
      await existing.dispose();
    } catch (err) {
      console.error(`[dsh-rubika] Agent dispose error for ${chatId}:`, err.message);
    }
    _agents.delete(chatId);
  }
  _chatSessionSuffix.set(chatId, randomUUID().slice(0, 8));
}

/** Reverse lookup: live agent object → chat_id (for tools called without chatId). */
function findChatIdForAgent(agent) {
  if (!agent) return undefined;
  for (const [chatId, entry] of _agents) {
    if (entry?.agent === agent) return chatId;
  }
  // Fallback: parse the session id (rubika:<chat_id>[:suffix]).
  try {
    const sid = String(agent.session?.id ?? agent.sessionId ?? "");
    const m = /^rubika:(.+)$/.exec(sid);
    if (m) return m[1].split(":")[0] || undefined;
  } catch { /* ignore */ }
  return undefined;
}

async function getOrCreateAgent(ctx, chatId) {
  if (_agents.has(chatId)) return _agents.get(chatId);

  // ── Live model selection: follows the deployment default ──
  // Read during EVERY prompt assembly rather than snapshotted at create time,
  // so a model switched in the DSH Web UI applies to this chat on its next
  // step. `lastGood` keeps the newest valid selection so a momentarily absent
  // default falls back instead of failing the turn.
  const lastGood = { current: undefined };
  const readDefault = () => {
    try {
      const next = ctx.agentDefaultModel?.currentSelection?.();
      return next && next.provider && next.model ? next : undefined;
    } catch {
      return undefined;
    }
  };
  const liveSelection = {
    get current() {
      const next = readDefault();
      if (next !== undefined) {
        lastGood.current = next;
        return next;
      }
      // No default configured: reuse the last known good one (may be undefined,
      // which installModelSelection treats as "leave the request untouched").
      return lastGood.current;
    },
    set current(next) {
      lastGood.current = next;
    },
    assembled: undefined,
  };

  const selection = readDefault();
  if (selection === undefined) {
    throw new Error(
      "مدل پیش‌فرض هوش مصنوعی در تنظیمات DSH مشخص نشده است. لطفاً از پنل وب (تنظیمات Models) یک مدل انتخاب کنید."
    );
  }
  lastGood.current = selection;

  const suffix = _chatSessionSuffix.get(chatId);
  const sessionId = SessionId(suffix ? `rubika:${chatId}:${suffix}` : `rubika:${chatId}`);

  // ── Check live agent in registry ──
  const live = ctx.agents?.get?.(sessionId);
  if (live) {
    const entry = { agent: live, dispose: () => live.cancel() };
    _agents.set(chatId, entry);
    return entry;
  }

  // ── Resolve agent preset (default is 'standard' which contains all tools) ──
  const presets = ctx.get("agentPresets") ?? ctx.agentPresets;
  let presetId;
  if (presets) {
    try {
      const resolved = await presets.resolve();
      presetId = resolved?.id;
    } catch (err) {
      console.warn("[dsh-rubika] Warning resolving agent preset:", err.message);
    }
  }

  const setup = async (agentCtx) => {
    // 1. Install LIVE model selection — every step re-reads the deployment
    //    default, so changing the model in the Web UI applies here too.
    installModelSelection(agentCtx, liveSelection);

    // 2. Set sandbox mode to danger-full-access & approval policy to never
    const session = agentCtx.agent?.session;
    if (session) {
      try {
        session.append("sandbox/mode", { mode: "danger-full-access" });
        session.append("approval/policy", { policy: "never" });
      } catch (err) {
        console.warn("[dsh-rubika] Warning setting session policy:", err.message);
      }
    }

    // 3. Mount the agent preset to install all tools (bash, fs, glob, grep, jobs, etc.)
    if (presets && presetId) {
      try {
        await presets.mount(agentCtx, presetId);
        console.log(`[dsh-rubika] Mounted preset "${presetId}" on agent for chat ${chatId}`);
      } catch (err) {
        console.error(`[dsh-rubika] Failed to mount preset "${presetId}":`, err);
      }
    }
  };

  const agentOptions = {
    provider: selection.provider,
    model: selection.model,
  };

  const cwd = process.cwd();

  // Check if session exists in persistence to resume, otherwise create
  let handle;
  const persistence = ctx.get("sessionPersistence") ?? ctx.sessionPersistence;
  let existsInPersistence = false;
  if (persistence) {
    try {
      const list = await persistence.list();
      existsInPersistence = list.some((h) => h.id === sessionId);
    } catch {
      existsInPersistence = false;
    }
  }

  if (existsInPersistence) {
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      });
    } catch (resumeErr) {
      console.warn(`[dsh-rubika] Resume failed for ${sessionId}, creating fresh session:`, resumeErr.message);
      const newSuffix = randomUUID().slice(0, 8);
      _chatSessionSuffix.set(chatId, newSuffix);
      const freshSessionId = SessionId(`rubika:${chatId}:${newSuffix}`);
      handle = await ctx.agents.create({
        sessionId: freshSessionId,
        meta: {
          cwd,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        agentOptions,
        setup,
      });
    }
  } else {
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        agentOptions,
        setup,
      });
    } catch (createErr) {
      console.warn(`[dsh-rubika] Create failed, trying fresh session ID for ${chatId}:`, createErr.message);
      const newSuffix = randomUUID().slice(0, 8);
      _chatSessionSuffix.set(chatId, newSuffix);
      const freshSessionId = SessionId(`rubika:${chatId}:${newSuffix}`);
      handle = await ctx.agents.create({
        sessionId: freshSessionId,
        meta: {
          cwd,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        agentOptions,
        setup,
      });
    }
  }

  const entry = { agent: handle.agent, dispose: handle.dispose };
  _agents.set(chatId, entry);
  return entry;
}

/** Extract assistant text or turn error from session events after a given seq. */
function extractReply(session, afterSeq) {
  const textParts = [];
  let errorMsg = "";
  for (const event of session.events) {
    if (event.seq <= afterSeq) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (joined) textParts.push(joined);
    }
    if (event.type === "turn/end" && event.data.reason?.kind === "error") {
      errorMsg = event.data.reason.error?.message || "خطای ناشناخته در مدل";
    }
  }
  const text = textParts.join("\n\n");
  if (!text && errorMsg) {
    return `❌ خطای هوش مصنوعی: ${errorMsg}`;
  }
  return text;
}

// ─── Message handling ────────────────────────────────────────────────────────

async function handleUserMessage(ctx, token, chatId, text, senderId, extraBlocks) {
  // ── Authorization ──
  if (!isAllowAll()) {
    const allowed = getAllowedUsers();
    if (allowed && !allowed.has(senderId || chatId)) {
      await rubikaSendMessage(
        token,
        chatId,
        "⛔ شما اجازه استفاده از این ربات را ندارید."
      ).catch(() => {});
      return;
    }
  }

  // ── Command: reset session (/new, /reset, /clear) ──
  const cmd = (text || "").trim().toLowerCase();
  if (cmd === "/new" || cmd === "/reset" || cmd === "/clear") {
    await resetChatAgent(chatId);
    await rubikaSendMessage(
      token,
      chatId,
      "🔄 نشست جدید ایجاد شد! گفتگو و حافظه دستیار بازنشانی گردید."
    ).catch(() => {});
    return;
  }

  // ── Get or create agent ──
  let entry;
  try {
    entry = await getOrCreateAgent(ctx, chatId);
  } catch (err) {
    console.error(`[dsh-rubika] Agent create failed for ${chatId}:`, err);
    const detail = String(err?.message || err).slice(0, 300);
    await rubikaSendMessage(
      token,
      chatId,
      `❌ خطا در ایجاد نشست ایجنت:\n${detail}\nلطفاً دوباره تلاش کنید.`
    ).catch(() => {});
    return;
  }

  const { agent } = entry;

  // ── Run the turn under a watchdog: a stuck model call must not wedge the
  //    per-chat queue (and through it, the poll loop) forever. ──
  try {
    await withTurnTimeout(
      (async () => {
        // ── Wait for agent to be idle (in case it's still processing) ──
        await agent.whenIdle();

        // ── Record sequence before submitting message ──
        const firstSeq = agent.session.seq;

        // ── Submit message (text + optional extra blocks, e.g. images) ──
        const content = [{ type: "text", text }];
        if (extraBlocks?.length) content.push(...extraBlocks);
        agent.followup(
          createUserMessage({
            content,
            source: { kind: "user" },
          })
        );

        // ── Wait for response ──
        await agent.whenIdle();
        return firstSeq;
      })(),
      TURN_TIMEOUT_MS,
      chatId
    ).then(async (firstSeq) => {
      // ── Extract reply ──
      const reply = extractReply(agent.session, firstSeq);

      if (reply) {
        await rubikaSendMessage(token, chatId, reply).catch((err) =>
          console.error(`[dsh-rubika] Send failed for ${chatId}:`, err.message)
        );
      } else {
        await rubikaSendMessage(
          token,
          chatId,
          "🤖 پاسخی تولید نشد."
        ).catch(() => {});
      }
    });
  } catch (err) {
    console.error(`[dsh-rubika] Turn failed for ${chatId}:`, err.message);
    // The agent is wedged — drop it so the NEXT message starts a fresh
    // session instead of queueing behind a turn that will never finish.
    _agents.delete(chatId);
    _chatSessionSuffix.set(chatId, randomUUID().slice(0, 8));
    await rubikaSendMessage(
      token,
      chatId,
      "⏳ پاسخ طول کشید و نشست بازنشانی شد. لطفاً پیامتان را دوباره بفرستید."
    ).catch(() => {});
  }
}

// ─── Update processing ───────────────────────────────────────────────────────

async function processUpdate(ctx, token, update) {
  const type = update.type;
  if (!type) return;

  // ── Callback query (button press) ──
  if (type === "CallbackQuery") {
    const data = update.callback_data;
    const chatId = update.chat_id;
    const userId = update.user_id;
    if (data && chatId) {
      const chatQueue = enqueueChat(chatId, () =>
        handleUserMessage(ctx, token, chatId, data, userId)
      );
      await chatQueue;
    }
    return;
  }

  // ── New message ──
  const msg = update.new_message;
  if (!msg) return;
  if (msg.sender_type === "Bot") return;

  const updateTime = parseInt(update.update_time || "0");
  if (updateTime <= lastSeenTime) return;

  // Dedup by unique message identity — NOT by timestamp alone, since many
  // updates can share the same update_time second.
  const dedupKey = `${update.chat_id}_${msg.message_id || update.update_time}`;
  if (isDuplicate(dedupKey)) return;

  // ── Button clicks via aux_data ──
  const buttonId = msg.aux_data?.button_id;
  if (buttonId) {
    const chatQueue = enqueueChat(update.chat_id, () =>
      handleUserMessage(ctx, token, update.chat_id, buttonId, msg.sender_id)
    );
    await chatQueue;
    return;
  }

  const text = (msg.text || "").trim();
  const file = msg.file?.file_id ? msg.file : null;
  if (!text && !file) return;
  if (!update.chat_id) return;

  // ── Group allowlist check ──
  const chatInfo = await rubikaGetChatInfo(token, update.chat_id);
  if (chatInfo.type === "group") {
    const allowedGroups = getAllowedGroups();
    if (allowedGroups && !allowedGroups.has(update.chat_id)) {
      return; // silently ignore messages from unauthorized groups
    }
  }

  // ── File attachment: download + convert to agent-ready content ──
  // (images → image block, PDF/text → extracted text, rest → metadata note)
  let displayText = text;
  let extraBlocks = [];
  if (file) {
    const prepared = await prepareFileContent(ctx, token, file, text);
    displayText = prepared.text;
    extraBlocks = prepared.blocks;
  }
  if (!displayText.trim() && !extraBlocks.length) return;

  // ── Enqueue for processing ──
  const chatQueue = enqueueChat(update.chat_id, () =>
    handleUserMessage(
      ctx,
      token,
      update.chat_id,
      displayText,
      msg.sender_id,
      extraBlocks
    )
  );
  await chatQueue;
}

// ─── Poll loop ───────────────────────────────────────────────────────────────

async function pollLoop(ctx, token, signal) {
  let backoffIdx = 0;

  while (!signal.aborted) {
    try {
      const body = offset && offset !== "0" ? { offset_id: offset } : {};
      const data = await rubikaPost("getUpdates", token, body, 20_000);

      const updates = data.data?.updates || [];
      const nextOffset = data.data?.next_offset_id || "";

      for (const update of updates) {
        if (signal.aborted) return;
        try {
          await processUpdate(ctx, token, update);
        } catch (err) {
          console.error("[dsh-rubika] processUpdate error:", err.message);
        }
        // Track highest update_time
        try {
          const ut = parseInt(update.update_time || "0");
          if (ut > lastSeenTime) lastSeenTime = ut;
        } catch {}
      }

      // FIX: Always advance offset after processing a batch of updates.
      // This ensures we don't re-read old updates if processUpdate returns early.
      offset = nextOffset || "0"; // <--- این خط باید همیشه اینجا باشد

      backoffIdx = 0;
      await sleep(POLL_INTERVAL_MS, signal);
    } catch (err) {
      if (signal.aborted) return;
      if (err.name === "AbortError") return;
      console.error(`[dsh-rubika] Poll error: ${err.message}`);
      const delay = RECONNECT_BACKOFF[Math.min(backoffIdx, RECONNECT_BACKOFF.length - 1)];
      await sleep(delay * 1000, signal);
      backoffIdx++;
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// ─── DSH Plugin entry point ──────────────────────────────────────────────────

export function apply(ctx) {
  const token = getToken();
  if (!token) {
    console.log("[dsh-rubika] RUBIKA_BOT_TOKEN is not set — gateway disabled.");
    return;
  }

  console.log("[dsh-rubika] Starting Rubika gateway...");

  // ─── DSH Tool: rubika_send_file ────────────────────────────────────────────
  // Sends a file from the server disk to a Rubika chat. Registered on the
  // host plane so every agent composition can call it; preset compositions
  // still decide which tools an agent may actually use.
  const rubikaTools = ctx.get("tools") ?? ctx.tools;
  if (rubikaTools?.register) {
    try {
      rubikaTools.register(defineTool({
        name: "rubika_send_file",
        description: "Send a file from the server to a Rubika chat (photo, video, audio, or document). Use it when the user asks for a file to be delivered to Rubika, or to report generated artifacts there. When called from a Rubika chat session, chatId defaults to that chat — omit it unless sending elsewhere.",
        parameters: {
          filePath: {
            type: "string",
            required: true,
            description: "Absolute path to the file on the server (e.g. /home/dsh/workspace/report.pdf).",
          },
          chatId: {
            type: "string",
            description: "Rubika chat_id to send the file to (e.g. uXXXX for a user, gXXXX for a group). Omit to send to the current Rubika chat.",
          },
          fileType: {
            type: "string",
            required: true,
            enum: ["photo", "video", "audio", "voice", "document"],
            description: "Type of file: photo (jpg/gif/png/webp, ≤10MB), video (mp4, ≤50MB), audio/voice (mp3), or document (generic, ≤50MB).",
          },
          caption: {
            type: "string",
            description: "Caption for the file (max 1024 characters).",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              sent: { type: "boolean", required: true },
              fileName: { type: "string", required: true },
              chatId: { type: "string", required: true },
              detail: { type: "string", required: true },
              fileId: { type: "string" },
            },
          },
          render: (_args, value) =>
            [{ type: "text", text: value.detail }],
        },
        async execute(args, exec) {
          const token = getToken();
          if (!token) throw new Error("RUBIKA_BOT_TOKEN is not set; cannot send file.");
          const { filePath, fileType, caption } = args;
          // Default to the chat this agent belongs to when chatId is omitted.
          const chatId = args.chatId || findChatIdForAgent(exec?.agent);
          if (!chatId) {
            throw new Error(
              "chatId is required when calling rubika_send_file outside a Rubika chat session."
            );
          }
          const fileName = filePath.split("/").pop() || "file";
          try {
            const { fileId } = await rubikaSendFile(token, chatId, fileType, filePath, caption);
            const detail = `فایل ${fileName} با موفقیت به چت ${chatId} ارسال شد.`;
            return { sent: true, fileName, chatId, detail, fileId };
          } catch (err) {
            console.error(`[dsh-rubika] Error sending file ${filePath} to ${chatId}:`, err.message);
            throw new Error(`خطا در ارسال فایل به روبیکا: ${err.message}`);
          }
        },
      }));
      console.log("[dsh-rubika] Registered tool: rubika_send_file");
    } catch (err) {
      console.warn("[dsh-rubika] Could not register rubika_send_file tool:", err.message);
    }
  } else {
    console.warn("[dsh-rubika] tools service unavailable — rubika_send_file not registered.");
  }

  ctx.effect(() => {
    const controller = new AbortController();

    pollLoop(ctx, token, controller.signal).catch((err) => {
      if (err.name !== "AbortError") {
        console.error(`[dsh-rubika] Fatal poll error: ${err.message}`);
      }
    });

    return async () => {
      console.log("[dsh-rubika] Shutting down...");
      controller.abort();

      // Dispose all agents
      for (const [chatId, entry] of _agents) {
        try {
          await entry.dispose();
        } catch (err) {
          console.error(`[dsh-rubika] Agent dispose error for ${chatId}:`, err.message);
        }
      }
      _agents.clear();
      _chatQueues.clear();
      _chatSessionSuffix.clear();
    };
  }, "dsh-rubika: rubika gateway");
}
