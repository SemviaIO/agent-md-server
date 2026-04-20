import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Config, SourceConfig } from "./types.js";
import { listFiles, resolveSafePath } from "./fs.js";
import type { Renderer } from "./renderer.js";

/**
 * Reverse-map an absolute filesystem path to a configured source.
 * Returns the matching source and the relative path within it, or undefined
 * if the path doesn't fall within any source directory. Hidden sources are
 * included — `hidden` only controls discovery surfaces, not resolution.
 */
function resolvePathToSource(
  sources: SourceConfig[],
  absolutePath: string,
): { source: SourceConfig; relative: string } | undefined {
  const resolved = path.resolve(absolutePath);
  for (const source of sources) {
    const sourceDir = path.resolve(source.root);
    if (resolved.startsWith(sourceDir + path.sep)) {
      const relative = path.relative(sourceDir, resolved);
      if (relative.includes("..")) return undefined;
      return { source, relative };
    }
  }
  return undefined;
}

export function createMcpServer(config: Config, renderer: Renderer): Server {
  const server = new Server(
    { name: "agent-md-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const baseUrl = `http://${config.host}:${config.port}`;

  function viewerUrl(): string {
    return (config.tailscaleUrl ?? baseUrl).replace(/\/+$/, "");
  }

  // Visible sources are surfaced in tool descriptions and `list_paths`.
  // Hidden sources are excluded from these discovery surfaces but remain
  // resolvable via `get_url` when given an absolute path under them.
  const visibleSources = config.sources.filter((s) => !s.hidden);

  function sourceListDescription(): string {
    return visibleSources.map((s) => s.root).join(", ");
  }

  function pathNotInSourceError(): { content: { type: string; text: string }[]; isError: true } {
    return {
      content: [{
        type: "text",
        text: `Path is not within any configured source directory. Configured directories: ${sourceListDescription()}`,
      }],
      isError: true,
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_url",
        description:
          `Validates a markdown file's Mermaid diagrams and returns its viewer URL. Returns an error with details if validation fails — fix the file and call again to get the URL. Configured directories: ${sourceListDescription()}. Viewer: ${viewerUrl()}`,
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Absolute filesystem path to a .md file",
            },
          },
          required: ["path"],
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "list_paths",
        description:
          "Lists all markdown files currently hosted by the server, as absolute filesystem paths grouped by directory.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "get_url": {
        const filePath = String(args?.path ?? "");
        if (!path.isAbsolute(filePath)) {
          return {
            content: [{ type: "text", text: "Path must be absolute" }],
            isError: true,
          };
        }

        const match = resolvePathToSource(config.sources, filePath);
        if (!match) return pathNotInSourceError();

        // Validate the file exists and isn't a symlink escape
        try {
          await resolveSafePath(match.source.root, match.relative);
        } catch (e) {
          return {
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          };
        }

        const viewName = match.relative.endsWith(".md")
          ? match.relative.slice(0, -3)
          : match.relative;

        // Render and validate via Playwright
        const safePath = path.resolve(match.source.root, match.relative);
        const result = await renderer.render(match.source.prefix, viewName, safePath);

        if (result.status === "error") {
          const errorList = result.errors
            .map((e, i) => `  ${i + 1}. ${e}`)
            .join("\n");
          return {
            content: [{ type: "text", text: `Mermaid rendering errors — fix and call get_url again:\n${errorList}` }],
            isError: true,
          };
        }

        const url = `${viewerUrl()}/${match.source.prefix}/${viewName}`;
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", url }) }],
        };
      }

      case "list_paths": {
        const sections: string[] = [];
        for (const source of visibleSources) {
          const files = await listFiles(source.root);
          const dir = path.resolve(source.root);
          const paths = files.map((f) => path.join(dir, f.name));
          sections.push(
            `${dir}/\n${paths.length === 0 ? "  (empty)" : paths.map((p) => `  ${p}`).join("\n")}`,
          );
        }
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return server;
}
