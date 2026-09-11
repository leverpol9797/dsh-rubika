#!/usr/bin/env bash
#
# install.sh — install dsh-rubika (Rubika Bot Gateway) on a DSH host.
#
# What it does:
#   1. Copies gateway.js + package.json to /home/dsh/dsh-rubika/
#   2. Runs `npm install` for runtime deps (unpdf — PDF text extraction)
#   3. Symlinks the DSH packages the plugin imports
#      (@deepseek-ai/dsh-agent, dsh-llm, dsh-session, dsh-tools, cordis, schemastery)
#      so plain `node` resolution works from the plugin directory.
#      NOTE: symlinks come AFTER npm install, because npm prunes them.
#   4. Registers the plugin in the profile's cordis.patch.yml (profile: web).
#
# Usage:
#   bash install.sh
#   DSH_PROFILE=web bash install.sh
#
# After install:
#   1. Set env vars (Railway dashboard → Variables, or export them):
#        RUBIKA_BOT_TOKEN           (required) — token from @BotFather on Rubika
#        RUBIKA_ALLOWED_USERS       (optional) — comma-separated user IDs, e.g. uXXXX,uYYYY
#        RUBIKA_ALLOW_ALL_USERS     (optional) — "true" to allow everyone
#        RUBIKA_GROUP_ALLOWED_CHATS (optional) — comma-separated group chat IDs, e.g. gXXXX
#   2. Restart DSH (Railway: Redeploy).
#   3. Send a message to the bot — it should reply.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_PROFILE="${DSH_PROFILE:-web}"

# Resolve DSH root directory and PROFILE_DIR safely
if [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME/profiles/$DSH_PROFILE" ]; then
  PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
  PLUGIN_DIR="$(dirname "$DSH_HOME")/dsh-rubika"
elif [ -d "/home/dsh/.dsh/profiles/$DSH_PROFILE" ]; then
  PROFILE_DIR="/home/dsh/.dsh/profiles/$DSH_PROFILE"
  PLUGIN_DIR="/home/dsh/dsh-rubika"
elif [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME/.dsh/profiles/$DSH_PROFILE" ]; then
  PROFILE_DIR="$DSH_HOME/.dsh/profiles/$DSH_PROFILE"
  PLUGIN_DIR="$DSH_HOME/dsh-rubika"
else
  PROFILE_DIR="${DSH_HOME:-/home/dsh/.dsh}/profiles/$DSH_PROFILE"
  PLUGIN_DIR="/home/dsh/dsh-rubika"
fi

PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

# --- 0. Locate the DSH installation (source of the symlinked packages) ---
DSH_PKG=""
for candidate in \
  "${DSH_HOME:-/home/dsh/.dsh}" \
  /home/dsh/.dsh \
  /opt/npm/lib/node_modules/@deepseek-ai/dsh \
; do
  if [ -d "$candidate/node_modules/@deepseek-ai/dsh-agent" ]; then
    DSH_PKG="$candidate"
    break
  fi
done
if [ -z "$DSH_PKG" ]; then
  # Fall back: resolve relative to the running `dsh` binary, if present.
  if command -v dsh >/dev/null 2>&1; then
    BIN_REAL="$(readlink -f "$(command -v dsh)")"
    # .../node_modules/@deepseek-ai/dsh/bin/... -> .../node_modules/@deepseek-ai/dsh
    DSH_PKG="$(cd -- "$BIN_REAL" && pwd | sed -E 's|/node_modules/@deepseek-ai/dsh.*|/node_modules/@deepseek-ai/dsh|')"
    [ -d "$DSH_PKG/node_modules/@deepseek-ai/dsh-agent" ] || DSH_PKG=""
  fi
fi
if [ -z "$DSH_PKG" ]; then
  echo "ERROR: could not locate DSH packages (dsh-agent). Set DSH_HOME or install DSH first." >&2
  exit 1
fi
echo "DSH packages: $DSH_PKG"

# --- 1. Copy the plugin files ---
mkdir -p "$PLUGIN_DIR"
cp -f "$SCRIPT_DIR/gateway.js" "$PLUGIN_DIR/gateway.js"
cp -f "$SCRIPT_DIR/package.json" "$PLUGIN_DIR/package.json"
echo "Installed: $PLUGIN_DIR/gateway.js + package.json"

# --- 2. Install runtime deps (unpdf for PDF text extraction) ---
# NOTE: npm install prunes unknown entries in node_modules (including our
# symlinks below), so this MUST run before step 3.
(cd "$PLUGIN_DIR" && npm install --omit=dev --no-audit --no-fund)
echo "npm deps installed (unpdf)."

# --- 3. Symlink DSH packages for plain node resolution (after npm!) ---
mkdir -p "$PLUGIN_DIR/node_modules/@deepseek-ai"
link_pkg() {
  local name="$1" src="$2"
  ln -sfn "$src" "$PLUGIN_DIR/node_modules/@deepseek-ai/$name"
  echo "Linked: @deepseek-ai/$name -> $src"
}
link_pkg cordis      "$DSH_PKG/node_modules/@deepseek-ai/cordis"
link_pkg dsh-agent   "$DSH_PKG/node_modules/@deepseek-ai/dsh-agent"
link_pkg dsh-llm     "$DSH_PKG/node_modules/@deepseek-ai/dsh-llm"
link_pkg dsh-session "$DSH_PKG/node_modules/@deepseek-ai/dsh-session"
link_pkg dsh-tools   "$DSH_PKG/node_modules/@deepseek-ai/dsh-tools"
# schemastery ships nested under dsh-llm on some installs:
if [ -d "$DSH_PKG/node_modules/@deepseek-ai/schemastery" ]; then
  link_pkg schemastery "$DSH_PKG/node_modules/@deepseek-ai/schemastery"
elif [ -d "$DSH_PKG/node_modules/@deepseek-ai/dsh-llm/node_modules/@deepseek-ai/schemastery" ]; then
  link_pkg schemastery "$DSH_PKG/node_modules/@deepseek-ai/dsh-llm/node_modules/@deepseek-ai/schemastery"
fi

# --- 4. Sanity check: node can resolve the imports ---
node --check "$PLUGIN_DIR/gateway.js"
node -e "import('$PLUGIN_DIR/gateway.js').then(m => console.log('Import OK, exports:', Object.keys(m).join(', ')))"

# --- 5. Register in cordis.patch.yml ---
mkdir -p "$PROFILE_DIR"
touch "$PATCH_FILE"

# Clean up standalone [] line which breaks YAML when appending items
if grep -qE '^\s*\[\]\s*$' "$PATCH_FILE" 2>/dev/null; then
  sed -i '/^\s*\[\]\s*$/d' "$PATCH_FILE"
fi

if grep -q "dsh-rubika" "$PATCH_FILE" 2>/dev/null; then
  echo "Already registered in $PATCH_FILE"
else
  if grep -q "^- insert:" "$PATCH_FILE" 2>/dev/null; then
    # Append to the existing insert list (2-space list indent).
    printf '    - id: dsh-rubika\n      name: %s/gateway.js\n' "$PLUGIN_DIR" >> "$PATCH_FILE"
  else
    printf -- '- insert:\n    - id: dsh-rubika\n      name: %s/gateway.js\n' "$PLUGIN_DIR" >> "$PATCH_FILE"
  fi
  echo "Registered in $PATCH_FILE"
fi

echo
echo "Done. Next steps:"
echo "  1. Set RUBIKA_BOT_TOKEN (and optionally RUBIKA_ALLOWED_USERS / RUBIKA_GROUP_ALLOWED_CHATS)."
echo "  2. Restart DSH (Railway: Redeploy)."
echo "  3. Message the bot on Rubika — it should answer."
