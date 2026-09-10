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

// ─── Plugin metadata ─────────────────────────────────────────────────────────

export const name = "dsh-rubika";
// Declare required services: cordis forbids ctx.<svc> access without inject.
export const inject = ["agents", "agentDefaultModel", "attachments"];

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
      const url = await resolveDownloadUrl(token, fileId);
      const bytes = await downloadBytes(url, MAX_FILE_DOWNLOAD_BYTES);
      const ref = await ctx.attachments.saveImage({
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

// ─── Agent management ────────────────────────────────────────────────────────

/** In-memory agent handles: chat_id → { agent, dispose } */
const _agents = new Map();

async function getOrCreateAgent(ctx, chatId) {
  if (_agents.has(chatId)) return _agents.get(chatId);

  // ── Default model selection (optional — must never throw) ──
  // inject guarantees the service is available on this context.
  let selection;
  try {
    selection = ctx.agentDefaultModel?.currentSelection?.();
  } catch {
    selection = undefined;
  }
  // currentSelection() returns { provider, model, reasoningEffort? }
  const hasModel = !!(selection && selection.provider && selection.model);

  const sessionId = SessionId(`rubika:${chatId}`);

  // NOTE: meta only accepts validated session fields (cwd, parentSession,
  // seedLength, origin, delegationDepth, agentPreset). Extra keys fail the
  // session-boundary validation — keep it minimal.
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    ...(hasModel
      ? {
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
          },
        }
      : {}),
    setup: (agentCtx) => {
      if (hasModel) {
        installModelSelection(agentCtx, {
          current: {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
          },
          assembled: undefined,
        });
      }
    },
  });

  const entry = { agent: handle.agent, dispose: handle.dispose };
  _agents.set(chatId, entry);
  return entry;
}

/** Extract the last assistant text from session events after a given seq. */
function extractReply(session, afterSeq) {
  let text = "";
  for (const event of session.events) {
    if (event.seq <= afterSeq) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (joined) text = joined;
    }
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

      // Paginate if more pages
      if (nextOffset && updates.length) {
        offset = nextOffset;
        continue;
      }

      offset = nextOffset || "0";
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

import { writeFileSync } from "node:fs";

const DEBUG_FILE = "/home/dsh/dsh-rubika/.applied";

export function apply(ctx) {
  // Debug: write file to confirm apply() was called
  writeFileSync(DEBUG_FILE, new Date().toISOString() + " apply() called\n");

  const token = getToken();
  if (!token) {
    writeFileSync(DEBUG_FILE, new Date().toISOString() + " RUBIKA_BOT_TOKEN not set\n");
    return;
  }

  writeFileSync(DEBUG_FILE, new Date().toISOString() + " starting gateway...\n");

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
    };
  }, "dsh-rubika: rubika gateway");
}
