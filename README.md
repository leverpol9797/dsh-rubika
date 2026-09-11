# dsh-rubika — Rubika Bot Gateway for DeepSeek Harness (DSH)

A DSH (cordis) plugin that connects your DeepSeek Harness agent to the
**Rubika bot platform** ([Bot API docs](https://rubika.ir/botapi)).

- Uses **Bot API v3** (`https://botapi.rubika.ir/v3`) with `getUpdates` **long polling** —
  outbound-only, so it works on Railway with no inbound port.
- One **persistent agent session per `chat_id`** (`rubika:<chat_id>`), messages per
  chat are serialized through a queue so rapid messages don't race.
- Optional **user allowlist**, **allow-all flag**, and **group allowlist**.
- Button clicks (`aux_data.button_id`) and `CallbackQuery` updates are routed as text.
- **Commands**: `/new`, `/reset`, `/clear` → disposes the current chat agent and starts a fresh session (same as clicking `+` in DSH Web).
- **File attachments**: images → vision (agent sees the picture),
  PDF → extracted text ([`unpdf`](https://www.npmjs.com/package/unpdf)),
  text formats (`srt/txt/md/json/code/...`) → inline text.
  Caps: 20MB download, 50k chars of text per file.

Inspired by the [hermes-agent](https://github.com/NousResearch/hermes-agent)
gateway architecture, adapted to DSH's cordis plugin system.

## Files

| File          | Purpose                                                        |
|---------------|----------------------------------------------------------------|
| `gateway.js`  | The plugin. `name` + `inject` + `apply(ctx)`.                  |
| `package.json`| `type: module` + runtime dep `unpdf` (PDF text extraction).    |
| `install.sh`  | Installer: copies files, `npm install`, symlinks DSH packages, registers in `cordis.patch.yml`. |
| `.env.example`| All supported environment variables with examples.           |

## Requirements

- A running **DeepSeek Harness** host (tested on the Railway template:
  Caddy on `$PORT` → `dsh web` on `127.0.0.1:3080`).
- A Rubika bot token from **BotFather@** on Rubika.
- The bot's DSH profile must provide the `agents`, `agentDefaultModel`, `agentPresets`, and `sessionPersistence`
  services (the default `web` profile with `dsh-base` bundle does).
- **All DSH tools and persona**: The gateway automatically mounts the DSH **Standard Agent Preset** (`default: standard`) for each agent session, enabling all core tools (bash, file system, glob, grep, job management, web search, subagents, and skills).
- **Danger Full Access**: Agent sessions run with `danger-full-access` sandbox policy and `approval: never`, allowing unrestricted execution of all available tools without requiring manual approvals (which are not possible in a bot environment).

## Install (exact steps performed on Railway)

```bash
# 1. Copy the plugin onto the DSH host (volume persists at /home/dsh)
#    — e.g. clone this repo into the workspace, then run:
sudo bash install.sh
#    (or: DSH_HOME=/home/dsh DSH_PROFILE=web bash install.sh)
```

What `install.sh` does, step by step:

1. **Copies** `gateway.js` + `package.json` → `/home/dsh/dsh-rubika/`
2. **Runs `npm install`** for the runtime dep (`unpdf`).
   ⚠️ Must run *before* step 3 — npm prunes the symlinks.
3. **Symlinks** the DSH packages the plugin imports, so plain `node`
   resolution works from the plugin dir:
   ```
   /home/dsh/dsh-rubika/node_modules/@deepseek-ai/
     cordis      -> <dsh>/node_modules/@deepseek-ai/cordis
     dsh-agent   -> <dsh>/node_modules/@deepseek-ai/dsh-agent
     dsh-llm     -> <dsh>/node_modules/@deepseek-ai/dsh-llm
     dsh-session -> <dsh>/node_modules/@deepseek-ai/dsh-session
     schemastery -> <dsh>/node_modules/@deepseek-ai/.../schemastery
   ```
   (`agentPresets` and `sessionPersistence` need no symlinks — they are
   resolved at runtime through Cordis `inject`, not static imports.)
4. **Registers** the plugin in the profile patch file
   `/home/dsh/.dsh/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: dsh-rubika
         name: /home/dsh/dsh-rubika/gateway.js
   ```
5. **Verifies** with `node --check` + a test `import()` of the plugin.

Then:

```bash
# 2. Set env vars — Railway dashboard → service → Variables:
RUBIKA_BOT_TOKEN=<token-from-BotFather>        # required
RUBIKA_ALLOWED_USERS=uXXX,uYYY                 # optional (empty = allow all)
RUBIKA_ALLOW_ALL_USERS=true                    # optional explicit allow-all
RUBIKA_GROUP_ALLOWED_CHATS=gXXX                # optional; bot must be in the group

# 3. Restart DSH (Railway: Redeploy).
# 4. Message the bot on Rubika — it should answer.
```

> Note: Railway-injected Variables are the source of truth at runtime
> (`process.env` inside the DSH process). A local `.env` file is *not*
> required on the host.

## Verify

- DSH dashboard → **Settings → Plugins → plugin list** should show
  `dsh-rubika` with Cordis status **Mounted**.
- `dsh --profile web --dump-config` should list:
  ```yaml
  - id: dsh-rubika
    name: /home/dsh/dsh-rubika/gateway.js
  ```
- Send the bot a message → it replies with the agent's answer.
- With a wrong configuration the bot tells you, e.g.
  `⛔ شما اجازه استفاده از این ربات را ندارید.`

## Add another allowed user / group

1. Railway dashboard → **Variables** → edit `RUBIKA_ALLOWED_USERS`,
   append the new user ID (they start with `u`) comma-separated, no spaces:
   ```
   RUBIKA_ALLOWED_USERS=uOLDID,uNEWID
   ```
2. For a group: add the bot to the group, then set/extend
   `RUBIKA_GROUP_ALLOWED_CHATS` with the group ID (starts with `g`).
3. **Redeploy.**

## How it works

```
Rubika client → botapi.rubika.ir/v3/{token}/getUpdates (long poll, 1s)
      → processUpdate: auth check → per-chat queue
      → getOrCreateAgent: resolve default model + default agent preset
      → ctx.agents.create/resume({ sessionId: "rubika:<chat_id>", ... })
        setup: installModelSelection → set sandbox/mode + approval/policy
               → agentPresets.mount(agentCtx, presetId)  // ALL tools
      → agent.followup(createUserMessage(...)) → agent.whenIdle()
      → extract all assistant/message texts of the turn → sendMessage(chat_id, reply)
```

- **Same tools as Web:** each Rubika agent mounts the deployment's default
  agent preset (`standard`), so it gets the exact same tool catalog as a Web
  session (bash/pwsh, filesystem, glob/grep, background jobs, subagents,
  skills, web search) plus the preset persona and tool instructions.
- **Bot-safe policy:** every Rubika session is switched to
  `sandbox/mode = danger-full-access` and `approval/policy = never`, so tool
  calls never stall on an interactive approval dialog that cannot be answered
  from a messenger.
- **Resume/restart safe:** live agents are reused via `agents.get()`;
  persisted sessions are resumed via `agents.resume()`; otherwise a fresh
  `agents.create()` session is published. If an old session cannot be resumed,
  a new `rubika:<chat_id>:<suffix>` session is created automatically.
- **Live model selection:** the model is re-read from
  `ctx.agentDefaultModel.currentSelection()` on **every** prompt assembly
  instead of being snapshotted when the chat session is created. Switching the
  model in the DSH Web UI (Settings → Models) therefore applies to existing
  Rubika chats on their next message — no `/new` needed. If the default is
  momentarily unreadable, the last known good selection is reused so a turn
  never fails on a bad read.
- **After updating:** chats created before the preset fix keep their old
  tool-less composition — send `/new` (or `/reset`, `/clear`) once so the chat
  starts a fresh session with the full preset mounted.

- **Pagination** follows the official docs: `offset_id` request cursor ←
  `next_offset_id` of the previous response.
- **Backlog guard:** `lastSeenTime` starts at boot time, so messages queued
  while the host was offline are skipped, not answered.
- **Dedup** key is `chat_id + message_id` (timestamps repeat within a second).
- **Reconnect** backoff on poll errors: 2s → 5s → 10s → 30s → 60s.

## Bugs fixed during development (vs first draft)

1. **Undeclared `offset` / `lastSeenTime`** — used in `pollLoop`/`processUpdate`
   but never declared; in ESM strict mode the first poll threw `ReferenceError`
   and polling never started. Now declared as module-level `let`.
2. **Stale backlog answered after restart** — `lastSeenTime` started at `0`,
   so every restart answered the whole queued backlog. Now initialized to boot
   time (same idea as `gateway_start_time` in the hermes adapter).
3. **Wrong dedup key** — `type + update_time` dropped healthy messages sharing
   a timestamp second. Now `chat_id + message_id`.
4. **`CreateAgentOptions.meta` validation** — only real session fields allowed
   (`cwd`, `parentSession`, …); extra keys (`platform`, `chatId`) failed the
   boundary. Kept minimal: `{ cwd: process.cwd() }`.
5. **Missing `inject`** — cordis forbids `ctx.agents` without declaring it
   (`cannot get property "agents" without inject`).
6. **Tool-less Rubika sessions (root cause)** — tools/persona live in the
   agent preset (`standard`), not on the host plane. The gateway created
   agents with only `installModelSelection` and never called
   `agentPresets.mount(agentCtx, presetId)`, so Rubika agents had zero tools
   while Web sessions had all of them. Now the gateway injects
   `["agents", "agentDefaultModel", "agentPresets", "sessionPersistence"]`,
   resolves the default preset, mounts it in `setup`, records
   `agentPreset` in `meta`, sets `sandbox/mode = danger-full-access` +
   `approval/policy = never`, and supports `agents.get()` / `agents.resume()`
   with a fresh-session fallback. Old chats need one `/new` after updating.
7. **Model switch did not reach Rubika (stale model snapshot)** — the gateway
   read `agentDefaultModel.currentSelection()` once at session-create time and
   froze it for the agent's lifetime, so a model changed in the Web UI never
   applied to an existing chat. An invalid/stale model then failed every turn
   with `pi-ai provider "<p>" has no configured model "<m>"`. Now
   `installModelSelection` receives a **live selection view** that re-reads the
   default during each `system-prompt/assemble`, matching how the Web proxy's
   `selectionFor()` behaves, with a last-known-good fallback for unreadable
   defaults.

## File attachments

| Kind | Handling |
|------|----------|
| 🖼️ Image (`jpg/png/webp/gif`) | Downloaded via `getFile` → stored with `ctx.attachments.saveImage` → sent as an `image` content block. The agent **sees** the picture. |
| 📕 PDF | Downloaded → text extracted per page with `unpdf` → sent as text. Scanned (image-only) PDFs yield no text. |
| 📝 Text (`srt/vtt/txt/md/json/csv/code/...`) | Downloaded → decoded UTF-8 → sent inline. |
| 🎵🎬📦 Audio/video/archives/other | Metadata only (name + size) — content is not readable. |

Limits: max 20MB download, max 50,000 chars of text per file —
protects Railway memory. Failures degrade gracefully (the agent is told
the download/extraction failed instead of crashing).

## License

MIT
