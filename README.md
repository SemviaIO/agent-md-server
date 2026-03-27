# agent-md-server

A thin server for helping you and your agent of choice communicate with rendered Markdown and Mermaid diagrams.

## Features

- Renders Mermaid diagrams with dark theme support
- GitHub-style markdown rendering with syntax highlighting
- Config-driven source directories (serve multiple folders)
- Live reload via Server-Sent Events (SSE) -- pages update when files change
- Tailscale integration for secure remote access
- MCP server for agent integration (write, edit, and validate documents)
- Mermaid syntax validation with error feedback
- Dark theme UI styled after GitHub

## Quick start

```bash
pnpm install
pnpm build
node dist/main.js
```

Open <http://localhost:3333/> in your browser.

The server watches configured source directories for `.md` files and renders them on demand.
No build step is needed for content -- write a markdown file, open the URL, and it appears.

## Configuration

The config file lives at `~/.config/agent-md-server/config.json`.

```json
{
  "sources": {
    "plans": "~/.claude/plans",
    "temp": "/tmp/agent-md-server"
  },
  "port": 3333,
  "host": "127.0.0.1",
  "tailscale": false
}
```

All fields are optional.
Defaults are applied when the config file is missing or a field is omitted.

### Sources

Sources are name-to-path mappings.
Each source name becomes a URL prefix (`/plans/`, `/temp/`, etc.).

- Names must match `[a-z0-9-]` (lowercase alphanumeric and hyphens).
- Paths support `~` expansion to the home directory.
- Directories are created automatically if they do not exist.

Default sources when no config file is present:

| Name | Path |
|------|------|
| `plans` | `~/.claude/plans` |
| `temp` | `/tmp/agent-md-server` |

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
| `get_server_info` | Get the server URL and configured sources. Call first to discover available sources. | No |

Mutating tools (`write_document`, `edit_document`) are blocked for non-localhost requests (e.g. via Tailscale).
Read-only tools work from anywhere.

The `write_document` and `edit_document` tools validate mermaid code blocks server-side using `mermaid.parse()`.
If any block has syntax errors, the response includes per-block errors so the agent can fix them in the same turn.

`edit_document` follows the [MCP filesystem `edit_file` convention](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) -- multiple edits per call, applied sequentially, with optional `dryRun` preview.

## Tailscale

The `--tailscale` flag runs `tailscale serve --bg` to expose the server on your tailnet over HTTPS.
This lets you view rendered documents from any device on your Tailscale network.

The serve rule is cleaned up automatically when the server exits (via SIGINT or SIGTERM).
If the `tailscale` command is not found, the server continues without it and prints a warning.

## URL scheme

```
/                         Index (lists all sources)
/:source/                 File listing for a source
/:source/foo              Rendered markdown view (clean URL, no .md)
/api/:source/             JSON file listing
/api/:source/foo.md       Raw markdown content
/events/:source/foo.md    SSE stream (emits on file change)
```

The `/api/` endpoints return JSON (listings) or raw markdown (files).
The `/events/` endpoint opens a persistent SSE connection that sends a `changed` event whenever the file is modified on disk.
The HTML views use these APIs internally -- the browser fetches markdown via `/api/`, renders it client-side, and subscribes to `/events/` for live updates.

## Development

```bash
pnpm dev    # Run with tsx (hot reload)
pnpm build  # Build for production
```

Requires Node.js >= 22.

## License

MIT
