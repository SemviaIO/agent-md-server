import { readFile } from "node:fs/promises";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mermaid from "mermaid";

import type { Config, SourceConfig } from "./types.js";
import { listFiles, resolveSafePath } from "./fs.js";

// Initialize mermaid for server-side syntax validation only.
// Disable DOMPurify — it requires browser APIs and we only need parse(), not render().
mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, secure: [] });

interface MermaidError {
  block: number;
  message: string;
}

/** Extract ```mermaid blocks from markdown and validate each with mermaid.parse() */
async function validateMermaidBlocks(
  content: string,
): Promise<MermaidError[]> {
  const errors: MermaidError[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let blockIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    blockIndex++;
    const diagram = match[1].trim();
    try {
      await mermaid.parse(diagram);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : String(e);
      // Ignore environment errors (DOMPurify, DOM APIs) — not syntax errors
      if (message.includes("DOMPurify") || message.includes("is not a function") || message.includes("is not defined")) {
        continue;
      }
      errors.push({ block: blockIndex, message });
    }
  }

  return errors;
}

/**
 * Reverse-map an absolute filesystem path to a configured source.
 * Returns the matching source and the relative path within it, or undefined
 * if the path doesn't fall within any source directory.
 */
function resolvePathToSource(
  sources: SourceConfig[],
  absolutePath: string,
): { source: SourceConfig; relative: string } | undefined {
  const resolved = path.resolve(absolutePath);
  for (const source of sources) {
    const sourceDir = path.resolve(source.directory);
    if (resolved.startsWith(sourceDir + path.sep)) {
      const relative = path.relative(sourceDir, resolved);
      if (relative.includes("..")) return undefined;
      return { source, relative };
    }
  }
  return undefined;
}

export function createMcpServer(config: Config): Server {
  const server = new Server(
    { name: "agent-md-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const baseUrl = `http://${config.host}:${config.port}`;

  function viewerUrl(): string {
    return (config.tailscaleUrl ?? baseUrl).replace(/\/+$/, "");
  }

  function sourceListDescription(): string {
    return config.sources.map((s) => s.directory).join(", ");
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
        name: "get_url_for_path",
        description:
          `Given an absolute filesystem path to a markdown file, returns the viewer URL where it renders with Mermaid diagrams and live-reload. Configured directories: ${sourceListDescription()}. Viewer: ${viewerUrl()}`,
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
        name: "validate_path",
        description:
          `Validates a markdown file at the given absolute filesystem path, checking for Mermaid diagram syntax errors. Returns the viewer URL on success. Configured directories: ${sourceListDescription()}. Viewer: ${viewerUrl()}`,
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Absolute filesystem path to a .md file to validate",
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
      case "get_url_for_path": {
        const filePath = String(args?.path ?? "");
        if (!path.isAbsolute(filePath)) {
          return {
            content: [{ type: "text", text: "Path must be absolute" }],
            isError: true,
          };
        }

        const match = resolvePathToSource(config.sources, filePath);
        if (!match) return pathNotInSourceError();

        const viewName = match.relative.endsWith(".md")
          ? match.relative.slice(0, -3)
          : match.relative;
        const url = `${viewerUrl()}/${match.source.name}/${viewName}`;
        return {
          content: [{ type: "text", text: url }],
        };
      }

      case "validate_path": {
        const filePath = String(args?.path ?? "");
        if (!path.isAbsolute(filePath)) {
          return {
            content: [{ type: "text", text: "Path must be absolute" }],
            isError: true,
          };
        }

        const match = resolvePathToSource(config.sources, filePath);
        if (!match) return pathNotInSourceError();

        // Use resolveSafePath to prevent symlink escapes
        let safePath: string;
        try {
          safePath = await resolveSafePath(match.source.directory, match.relative);
        } catch (e) {
          return {
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          };
        }

        let content: string;
        try {
          content = await readFile(safePath, "utf-8");
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${filePath}` }],
            isError: true,
          };
        }

        const errors = await validateMermaidBlocks(content);
        if (errors.length === 0) {
          const viewName = match.relative.endsWith(".md")
            ? match.relative.slice(0, -3)
            : match.relative;
          const url = `${viewerUrl()}/${match.source.name}/${viewName}`;
          return {
            content: [{ type: "text", text: `Valid — no Mermaid syntax errors found.\n\nViewer URL: ${url}` }],
          };
        }

        const errorList = errors
          .map((e) => `  Block ${e.block}: ${e.message}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `Mermaid syntax errors found:\n${errorList}` }],
          isError: true,
        };
      }

      case "list_paths": {
        const sections: string[] = [];
        for (const source of config.sources) {
          const files = await listFiles(source.directory);
          const dir = path.resolve(source.directory);
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
