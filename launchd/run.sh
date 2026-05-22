#!/usr/bin/env bash
# launchd launcher for io.semvia.agent-md-server.
#
# Resolves the real Volta-pinned Node binary and exec-replaces this shell with
# it, so the PID launchd tracks is the process that actually holds port 3333.
# Launching via the ~/.volta/bin/node shim forks the real Node as a child,
# which strands an orphan socket holder on `kickstart -k` — see issue #24.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$("$HOME/.volta/bin/volta" which node)"

# `set -e` catches a non-zero `volta` exit; this guards the exit-0-bad-output
# case so a clear message lands in /tmp/agent-md-server.log instead of an
# opaque exec failure.
if [[ ! -x "$NODE_BIN" ]]; then
  echo "run.sh: Node resolution failed — 'volta which node' returned '$NODE_BIN', not an executable" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/../dist/main.js"
