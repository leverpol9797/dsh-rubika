# dsh-rubika — Rubika Bot Gateway for DeepSeek Harness (DSH)

A DSH (cordis) plugin that connects your DeepSeek Harness agent to the
**Rubika bot platform** ([Bot API docs](https://rubika.ir/botapi)).

- Uses **Bot API v3** (`https://botapi.rubika.ir/v3`) with `getUpdates` **long polling** —
  outbound-only, so it works on Railway with no inbound port.
- One **persistent agent session per `chat_id`** (`rubika:<chat_id>`), messages per
  chat are serialized through a queue so rapid messages don't race.
- Optional **user allowlist**, **allow-all flag**, and **group allowlist**.
- Button clicks (`aux_data.button_id`) and `CallbackQuery` updates are routed as text.

Inspired by the [hermes-agent](https://github.com/NousResearch/hermes-agent)
gateway architecture, adapted to DSH's cordis plugin system.

## Files

| File          | Purpose                                                        |
|---------------|----------------------------------------------------------------|
| `gateway.js`  | The plugin (single file). `name` + `inject` + `apply(ctx)`.    |
| `install.sh`  | Installer: copies the plugin, symlinks DSH packages, registers it in `cordis.patch.yml`. |
| `.env.example`| All supported environment variables with examples.           |

## Requirements

- A running **DeepSeek Harness** host (tested on the Railway template:
  Caddy on `$PORT` → `dsh web` on `127.0.0.1:3080`).
- A Rubika bot token from **BotFather@** on Rubika.
- The bot's DSH profile must provide the `agents` and `agentDefaultModel`
  services (the default `web` profile with `dsh-base` bundle does).

## Install (exact steps performed on Railway)

```bash
# 1. Copy the plugin onto the DSH host (volume persists at /home/dsh)
#    — e.g. clone this repo into the workspace, then run:
sudo bash install.sh
#    (or: DSH_HOME=/home/dsh DSH_PROFILE=web bash install.sh)
```

What `install.sh` does, step by step:

1. **Copies** `gateway.js` → `/home/dsh/dsh-rubika/gateway.js`
2. **Symlinks** the DSH packages the plugin imports, so plain `node`
   resolution works from the plugin dir:
   ```
   /home/dsh/dsh-rubika/node_modules/@deepseek-ai/
     cordis      -> <dsh>/node_modules/@deepseek-ai/cordis
     dsh-agent   -> <dsh>/node_modules/@deepseek-ai/dsh-agent
     dsh-llm     -> <dsh>/node_modules/@deepseek-ai/dsh-llm
     dsh-session -> <dsh>/node_modules/@deepseek-ai/dsh-session
     schemastery -> <dsh>/node_modules/@deepseek-ai/.../schemastery
   ```
3. **Registers** the plugin in the profile patch file
   `/home/dsh/.dsh/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: dsh-rubika
         name: /home/dsh/dsh-rubika/gateway.js
   ```
4. **Verifies** with `node --check` + a test `import()` of the plugin.

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
      → ctx.agents.create({ sessionId: "rubika:<chat_id>", ... })
      → agent.followup(createUserMessage(...)) → agent.whenIdle()
      → extract last assistant/message text → sendMessage(chat_id, reply)
```

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
   (`cannot get property "agents" without inject`). Now
   `inject = ["agents", "agentDefaultModel"]`.

## License

MIT
