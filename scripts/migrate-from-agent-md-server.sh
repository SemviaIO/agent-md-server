#!/bin/bash
# One-time migration of a machine from agent-md-server to local-artifacts.
# Run from the moved checkout (see README "Migrating from agent-md-server"):
#
#   bash scripts/migrate-from-agent-md-server.sh
#
# Removes the io.semvia.agent-md-server LaunchAgent, installs and loads
# io.semvia.local-artifacts from this checkout, moves ~/.config/agent-md-server
# to ~/.config/local-artifacts, and re-registers the MCP server under its new
# name. Every step tolerates its old piece being absent, so a re-run is a
# no-op that verifies again. Exits non-zero unless the machine ends with only
# the new LaunchAgent serving http://127.0.0.1:3333/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLD_LABEL="io.semvia.agent-md-server"
NEW_LABEL="io.semvia.local-artifacts"
AGENTS_DIR="$HOME/Library/LaunchAgents"
OLD_PLIST="$AGENTS_DIR/$OLD_LABEL.plist"
NEW_PLIST="$AGENTS_DIR/$NEW_LABEL.plist"
OLD_CONFIG="$HOME/.config/agent-md-server"
NEW_CONFIG="$HOME/.config/local-artifacts"
URL="http://127.0.0.1:3333/"
domain="gui/$(id -u)"

loaded() {
  launchctl print "$domain/$1" >/dev/null 2>&1
}

# bootout returns before launchd finishes tearing the service down, and a
# bootstrap in that window fails with an I/O error, so wait (up to 5 s).
wait_unloaded() {
  local tries=0
  while loaded "$1" && [ "$tries" -lt 25 ]; do
    sleep 0.2
    tries=$((tries + 1))
  done
}

# A refused bootstrap (an SSH session while the console is logged in) is
# reported here and caught by the verification at the end, which fails the run.
bootstrap_agent() {
  if launchctl bootstrap "$domain" "$NEW_PLIST"; then
    echo "launchd: $1 $NEW_LABEL"
  else
    echo "WARNING: launchctl bootstrap $domain $NEW_PLIST failed; re-run this script from a GUI login session" >&2
  fi
}

# Prechecks run before anything is torn down, so a failure leaves the old
# LaunchAgent serving.
if ! launchctl print "$domain" >/dev/null 2>&1; then
  echo "error: no launchd domain $domain; run this script from a GUI login session" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI not on PATH; it is needed to re-register the MCP server" >&2
  exit 1
fi

# Build this checkout so the new LaunchAgent never starts a stale dist/ that
# still reads ~/.config/agent-md-server.
if ! (cd "$REPO" && npm run build); then
  echo "error: build failed; run bash scripts/setup.sh, then re-run this script" >&2
  exit 1
fi

# 1. Old LaunchAgent: unload, then remove its plist.
launchctl bootout "$domain/$OLD_LABEL" 2>/dev/null || true
rm -f "$OLD_PLIST"
wait_unloaded "$OLD_LABEL"
echo "launchd: $OLD_LABEL removed"

# 2. Config folder: move it and repoint the old default temp root, before
# the new LaunchAgent starts so its first boot reads the moved config.
if [ -d "$OLD_CONFIG" ] && [ ! -e "$NEW_CONFIG" ]; then
  mv "$OLD_CONFIG" "$NEW_CONFIG"
  if [ -f "$NEW_CONFIG/config.json" ]; then
    sed -i '' 's|/tmp/agent-md-server|/tmp/local-artifacts|g' "$NEW_CONFIG/config.json"
  fi
  echo "config: moved $OLD_CONFIG to $NEW_CONFIG"
elif [ -d "$OLD_CONFIG" ]; then
  echo "WARNING: both $OLD_CONFIG and $NEW_CONFIG exist; $NEW_CONFIG is used and $OLD_CONFIG left in place" >&2
fi

# 3. New LaunchAgent: render from this checkout, (re)load when it changed or
# is not loaded.
mkdir -p "$AGENTS_DIR"
tmp="$(mktemp "${TMPDIR:-/tmp}/local-artifacts.plist.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed "s|__REPO__|$REPO|g" "$REPO/launchd/$NEW_LABEL.plist" >"$tmp"

if [ ! -f "$NEW_PLIST" ] || ! cmp -s "$tmp" "$NEW_PLIST"; then
  mv "$tmp" "$NEW_PLIST"
  launchctl bootout "$domain/$NEW_LABEL" 2>/dev/null || true
  wait_unloaded "$NEW_LABEL"
  bootstrap_agent "(re)bootstrapped"
elif ! loaded "$NEW_LABEL"; then
  bootstrap_agent "bootstrapped (plist unchanged, was not loaded)"
else
  echo "launchd: $NEW_LABEL unchanged and loaded"
fi

# 4. MCP registration.
claude mcp remove agent-md-server --scope user >/dev/null 2>&1 || true
# Re-added unconditionally: `claude mcp get` health-checks the server, so its
# exit code cannot tell a missing entry from a server still starting.
claude mcp remove local-artifacts --scope user >/dev/null 2>&1 || true
claude mcp add --transport http --scope user local-artifacts "${URL}mcp"

# 5. Verify the end state.
failed=0
fail() {
  echo "FAIL: $1" >&2
  failed=1
}

if loaded "$OLD_LABEL"; then fail "$OLD_LABEL is still loaded"; fi
if [ -e "$OLD_PLIST" ]; then fail "$OLD_PLIST still exists"; fi
# The new agent is serving only when launchd's pid for it is the process
# listening on 3333 and the root page carries its title. A bare 200 would
# also come from an orphaned old server still holding the port. Polled,
# since launchd may not have spawned the process yet.
served=0
launchd_pid=""
listen_pid=""
tries=0
while [ "$tries" -lt 20 ]; do
  info="$(launchctl print "$domain/$NEW_LABEL" 2>/dev/null || true)"
  launchd_pid="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)"
  listen_pid="$(lsof -nP -iTCP:3333 -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  body="$(curl -s -m 1 "$URL" || true)"
  if [ -n "$launchd_pid" ] && [ "$launchd_pid" = "$listen_pid" ]; then
    case "$body" in
      *'<title>local-artifacts</title>'*) served=1; break ;;
    esac
  fi
  sleep 0.5
  tries=$((tries + 1))
done
if [ "$served" -ne 1 ]; then
  fail "$NEW_LABEL is not serving $URL (launchd pid '${launchd_pid:-none}', port 3333 listener '${listen_pid:-none}')"
fi

if [ "$failed" -ne 0 ]; then
  echo "Migration incomplete; see /tmp/local-artifacts.log" >&2
  exit 1
fi
echo "Migration complete: $NEW_LABEL serves $URL"
