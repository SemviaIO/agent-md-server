# agent-md-server

A thin server for helping you and your agent of choice communicate with rendered Markdown and Mermaid diagrams.

## Features

- Renders Mermaid diagrams with dark theme support
- GitHub-style markdown rendering with syntax highlighting
- Config-driven source directories (serve multiple folders)
- Recursive directory browsing — point a source at a tree and navigate it lazily, one directory per request
- Live reload via Server-Sent Events (SSE) -- pages update when files change
- Tailscale integration for secure remote access
- MCP server for agent integration (write, edit, and validate documents)
- Mermaid syntax validation with error feedback
- Dark theme UI styled after GitHub

## Quick start

```bash
bash scripts/setup.sh   # install, build, configure git hooks
node dist/main.js
```

Open <http://localhost:3333/> in your browser.

The server serves `.md` files (rendered on demand) and `.html` files (served as-is) from
the configured source directories.
No build step is needed for content -- write a file, open the URL, and it appears.

## Configuration

The config file lives at `~/.config/agent-md-server/config.json`.

```json
{
  "sources": [
    {"prefix": "plans", "root": "~/plans"},
    {"prefix": "claude/plans", "root": "~/.claude/plans", "hidden": true},
    {"prefix": "temp", "root": "/tmp/agent-md-server"}
  ],
  "port": 3333,
  "host": "127.0.0.1",
  "tailscale": false
}
```

All fields are optional.
Defaults are applied when the config file is missing or a field is omitted.

### Sources

Each source is an object with a URL `prefix` and a filesystem `root`, matching `@fastify/static` conventions.

- `prefix` — one or more `[a-z0-9-]` segments joined by `/`. Each segment becomes a URL path segment — e.g. `claude/plans` is served at `/claude/plans/`.
- `root` — filesystem directory. Supports `~` expansion to the home directory. Created automatically if it does not exist.
- `hidden` — optional boolean (default `false`). When `true`, the source is served normally but omitted from MCP tool descriptions, `list_paths`, and the browser root index. Use for fallback directories you want available by absolute-path lookup without advertising them.

Two sources cannot have overlapping prefixes (e.g. `plans` and `plans/foo` would collide) — the server exits at boot with a clear error if this happens.

Default sources when no config file is present:

| Prefix | Root | Hidden |
|--------|------|:-:|
| `plans` | `~/plans` | |
| `claude/plans` | `~/.claude/plans` | ✓ |
| `temp` | `/tmp/agent-md-server` | |

> **Note:** In v0.1.0 the `sources` field changed from a `{name: path}` map to a list of `{prefix, root, hidden?}` objects. The old shape is rejected at boot with an error pointing to the new shape.

## CLI flags

CLI flags override values from the config file.

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--port` | `-p` | Port to listen on | `3333` |
| `--host` | `-h` | Host to bind to | `127.0.0.1` |
| `--tailscale` | `-t` | Enable Tailscale serve | `false` |

Example:

```bash
node dist/main.js --port 8080 --tailscale
```

## MCP integration

The server exposes an MCP endpoint at `/mcp` over HTTP (Streamable HTTP transport).
Any MCP-compatible agent (Claude Code, Cursor, etc.) can connect to it.

```bash
# Claude Code
claude mcp add --transport http --scope user agent-md-server http://127.0.0.1:3333/mcp
```

### MCP tools

| Tool | Description | Localhost only |
|------|-------------|:-:|
| `write_document` | Write a markdown file. Validates mermaid blocks and returns errors. | Yes |
| `edit_document` | Edit a file with one or more `{ oldText, newText }` replacements. Supports `dryRun`. | Yes |
| `read_document` | Read the raw markdown content of a file. | No |
| `list_documents` | List all markdown files in a source directory. | No |

Mutating tools (`write_document`, `edit_document`) are blocked for non-localhost requests (e.g. via Tailscale).
Read-only tools work from anywhere.

The `write_document` and `edit_document` tools validate mermaid code blocks server-side using `mermaid.parse()`.
If any block has syntax errors, the response includes per-block errors so the agent can fix them in the same turn.

`edit_document` follows the [MCP filesystem `edit_file` convention](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) -- multiple edits per call, applied sequentially, with optional `dryRun` preview.

## Tailscale

With `--tailscale` (or `"tailscale": true` in the config file), on startup the server
runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` to expose itself on your
tailnet over HTTPS, and advertises the resulting `https://<host>/` URL via the MCP tools.
This lets you view rendered documents from any device on your Tailscale network.

The serve rule is (re)established on every startup. `tailscale serve` persists its rule in
tailscaled, but reboots, Tailscale app updates, and `tailscale serve reset` can wipe it —
re-running on startup keeps the exposure self-healing, so the advertised URL never points
at a dead listener. The rule is intentionally left in place on exit so the long-running
(launchd) deployment stays reachable across restarts.

The `tailscale` CLI is located by probing known install paths (Homebrew, `/usr/local/bin`,
the Tailscale.app bundle), since launchd's PATH does not include them. If it cannot be found
or the command fails (for example, no GUI/XPC session is available), the server continues
without it and prints a warning; the advertised URL then works only if a serve rule was
configured out of band.

## URL scheme

```
/                              Index (lists all sources)
/:source/                      Listing for a source root
/:source/sub/                  Listing for a sub-directory
/:source/foo                   Rendered markdown (clean URL, no .md)
/:source/sub/foo               Rendered markdown for a nested file
/:source/page.html             Hosted HTML file (served as-is)
/api/:source/                  JSON listing (files + directories)
/api/:source/sub/              JSON listing for a sub-directory
/api/:source/foo.md            Raw markdown content
/api/:source/sub/foo.md        Raw markdown for a nested file
/api/:source/page.html         Raw HTML content
/events/:source/foo.md         SSE stream (emits on file change)
/events/:source/sub/foo.md     SSE stream for a nested file
```

`:source` may itself be a multi-segment prefix (e.g. `claude/plans`), in which case the URLs include each segment — `/claude/plans/foo`, `/api/claude/plans/foo.md`, etc.

Sub-paths under a source are resolved lazily: each listing request reads exactly the directory it lists, with no upfront scan. Listings include `.md` files, `.html` files, and subdirectories (entries carry a `kind: "file" | "dir"` field). `.html` files are served as-is for the browser to render natively — the markdown viewer shell and SSE live-reload apply only to `.md` files. Because hosted HTML carries its own inline scripts and styles, the strict nonce-based Content-Security-Policy is dropped for raw HTML responses. The following directory names are silently omitted from listings as a noise filter, so a source can safely point at a dev tree like `~/projects`:

```
node_modules, .git, dist, build, target, .next, .venv, __pycache__
```

The denylist is a discovery filter only — direct URLs into those directories still resolve via the same `resolveSafePath` jail used by every other read.

The `/api/` endpoints return JSON (listings) or raw file content (`.md` as `text/markdown`, `.html` as `text/html`).
The `/events/` endpoint opens a persistent SSE connection that sends a `changed` event whenever the file is modified on disk.
The HTML views use these APIs internally -- the browser fetches markdown via `/api/`, renders it client-side, and subscribes to `/events/` for live updates.

## Development

```bash
pnpm dev    # Run with tsx (hot reload)
pnpm build  # Build for production
```

Requires Node.js >= 22.

### Git hooks

The repo uses checked-in git hooks in `.githooks/`. The setup script configures this automatically, but you can also run it manually:

```bash
git config core.hooksPath .githooks
```

**`post-merge`** — When you pull changes on the `main` branch, automatically rebuilds and restarts the launchd service (`io.semvia.agent-md-server`).

## License

MIT
