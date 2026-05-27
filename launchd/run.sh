#!/usr/bin/env bash
# launchd launcher for io.semvia.agent-md-server.
#
# Resolves the real Volta-pinned Node binary and exec-replaces this shell with
# it, so the PID launchd tracks is the process that actually holds port 3333.
# Launching via the ~/.volta/bin/node shim forks the real Node as a child,
# which strands an orphan socket holder on `kickstart -k` — see issue #24.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate the `volta` driver. The canonical installer drops it in
# ~/.volta/bin/; Homebrew installs it under /opt/homebrew/bin (Apple Silicon)
# or /usr/local/bin (Intel). launchd's default PATH excludes both Homebrew
# prefixes, so probe known locations explicitly instead of relying on PATH.
VOLTA_BIN=""
for candidate in "$HOME/.volta/bin/volta" /opt/homebrew/bin/volta /usr/local/bin/volta; do
  if [[ -x "$candidate" ]]; then
    VOLTA_BIN="$candidate"
    break
  fi
done
if [[ -z "$VOLTA_BIN" ]]; then
  echo "run.sh: volta not found in ~/.volta/bin, /opt/homebrew/bin, or /usr/local/bin" >&2
  exit 1
fi

NODE_BIN="$("$VOLTA_BIN" which node)"

# `set -e` catches a non-zero `volta` exit; this guards the exit-0-bad-output
# case so a clear message lands in /tmp/agent-md-server.log instead of an
# opaque exec failure.
if [[ ! -x "$NODE_BIN" ]]; then
  echo "run.sh: Node resolution failed — 'volta which node' returned '$NODE_BIN', not an executable" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/../dist/main.js"
