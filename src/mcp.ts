import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mermaid from "mermaid";

import type { Config, SourceConfig } from "./types.js";
import { listFiles, readMarkdown, resolveSafePath } from "./fs.js";

// Initialize mermaid for server-side syntax validation only
mermaid.initialize({ startOnLoad: false });

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
      errors.push({ block: blockIndex, message });
    }
  }

  return errors;
}

function formatValidationResult(
  baseMessage: string,
  errors: MermaidError[],
): { text: string; isError: boolean } {
  if (errors.length === 0) {
    return { text: baseMessage, isError: false };
  }
  const errorList = errors
    .map((e) => `  Block ${e.block}: ${e.message}`)
    .join("\n");
  return {
    text: `${baseMessage}\n\nMermaid syntax errors found:\n${errorList}`,
    isError: true,
  };
}

function findSource(
  sources: SourceConfig[],
  name: string,
): SourceConfig | undefined {
  return sources.find((s) => s.name === name);
}

function validateFilename(filename: string) {
  if (!filename.endsWith(".md")) {
    throw new Error("Filename must end in .md");
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error("Filename must not contain path separators or '..'");
  }
}

export const MUTATING_TOOLS = new Set(["write_document", "edit_document"]);

export function createMcpServer(config: Config): Server {
  const server = new Server(
    { name: "agent-md-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "write_document",
        description:
          "Write a markdown document to a source directory. Validates mermaid blocks and returns the viewer URL. Only available from localhost.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: {
              type: "string",
              description:
                'Which configured source to write to (e.g. "temp", "plans")',
            },
            filename: {
              type: "string",
              description: "Name of the file (must end in .md)",
            },
            content: {
              type: "string",
              description:
                "Markdown content (can include mermaid code blocks)",
            },
          },
          required: ["source", "filename", "content"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "edit_document",
        description:
          "Edit an existing markdown document with one or more text replacements. Validates mermaid blocks after edit. Follows the MCP filesystem edit_file convention. Only available from localhost.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: {
              type: "string",
              description: "Which configured source the file is in",
            },
            filename: {
              type: "string",
              description: "Name of the file to edit",
            },
            edits: {
              type: "array",
              description: "List of edit operations to apply sequentially",
              items: {
                type: "object",
                properties: {
                  oldText: {
                    type: "string",
                    description: "The exact text to find",
                  },
                  newText: {
                    type: "string",
                    description: "The replacement text",
                  },
                },
                required: ["oldText", "newText"],
              },
            },
            dryRun: {
              type: "boolean",
              description:
                "Preview the result and validate mermaid without writing. Default: false.",
            },
          },
          required: ["source", "filename", "edits"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: "read_document",
        description: "Read the raw markdown content of a document.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: {
              type: "string",
              description: "Which configured source to read from",
            },
            filename: {
              type: "string",
              description: "Name of the file to read",
            },
          },
          required: ["source", "filename"],
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "list_documents",
        description: "List all markdown documents in a source directory.",
        inputSchema: {
          type: "object" as const,
          properties: {
            source: {
              type: "string",
              description: "Which configured source to list",
            },
          },
          required: ["source"],
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "get_server_url",
        description: "Get the base URL of the markdown viewer server.",
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
      case "write_document": {
        const source = String(args?.source ?? "");
        const filename = String(args?.filename ?? "");
        const content = String(args?.content ?? "");

        const sourceConfig = findSource(config.sources, source);
        if (!sourceConfig) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown source "${source}". Available: ${config.sources.map((s) => s.name).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        try {
          validateFilename(filename);
        } catch (e) {
          return {
            content: [
              { type: "text", text: (e as Error).message },
            ],
            isError: true,
          };
        }

        // Use resolveSafePath to verify the target is within the source directory
        try {
          const safePath = await resolveSafePath(
            sourceConfig.directory,
            filename,
          );
          await writeFile(safePath, content, "utf-8");
        } catch {
          // resolveSafePath throws on new files because realpath fails.
          // Fall back to a manual resolve + prefix check for new files.
          const resolvedRoot = path.resolve(sourceConfig.directory);
          const joined = path.resolve(resolvedRoot, filename);
          if (!joined.startsWith(resolvedRoot + path.sep)) {
            return {
              content: [
                {
                  type: "text",
                  text: "Path traversal attempt detected",
                },
              ],
              isError: true,
            };
          }
          await writeFile(joined, content, "utf-8");
        }

        const viewName = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
        const url = `http://${config.host}:${config.port}/${source}/${viewName}`;
        const errors = await validateMermaidBlocks(content);
        const result = formatValidationResult(
          `Written to ${filename}. View at ${url}`,
          errors,
        );
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.isError,
        };
      }

      case "edit_document": {
        const source = String(args?.source ?? "");
        const filename = String(args?.filename ?? "");
        const edits = args?.edits as
          | { oldText: string; newText: string }[]
          | undefined;
        const dryRun = Boolean(args?.dryRun);

        if (!edits || !Array.isArray(edits) || edits.length === 0) {
          return {
            content: [
              { type: "text", text: "edits array is required and must not be empty" },
            ],
            isError: true,
          };
        }

        const sourceConfig = findSource(config.sources, source);
        if (!sourceConfig) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown source "${source}". Available: ${config.sources.map((s) => s.name).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        // Resolve the file path safely
        let filePath: string;
        try {
          filePath = await resolveSafePath(sourceConfig.directory, filename);
        } catch (e) {
          return {
            content: [
              { type: "text", text: (e as Error).message },
            ],
            isError: true,
          };
        }

        // Read current content
        let content: string;
        try {
          content = await readFile(filePath, "utf-8");
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `File "${filename}" not found in source "${source}"`,
              },
            ],
            isError: true,
          };
        }

        // Apply edits sequentially
        for (let i = 0; i < edits.length; i++) {
          const { oldText, newText } = edits[i];
          const occurrences = content.split(oldText).length - 1;
          if (occurrences === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Edit ${i + 1}: oldText not found in "${filename}". Provide the exact text to replace.`,
                },
              ],
              isError: true,
            };
          }
          if (occurrences > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `Edit ${i + 1}: oldText found ${occurrences} times in "${filename}". Provide more context to make it unique.`,
                },
              ],
              isError: true,
            };
          }
          content = content.replace(oldText, newText);
        }

        const viewName = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
        const url = `http://${config.host}:${config.port}/${source}/${viewName}`;
        const errors = await validateMermaidBlocks(content);

        if (dryRun) {
          const result = formatValidationResult(
            `Dry run: ${edits.length} edit(s) would be applied to ${filename}`,
            errors,
          );
          return {
            content: [{ type: "text", text: result.text }],
            isError: result.isError,
          };
        }

        await writeFile(filePath, content, "utf-8");
        const result = formatValidationResult(
          `Applied ${edits.length} edit(s) to ${filename}. View at ${url}`,
          errors,
        );
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.isError,
        };
      }

      case "list_documents": {
        const source = String(args?.source ?? "");
        const sourceConfig = findSource(config.sources, source);
        if (!sourceConfig) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown source "${source}". Available: ${config.sources.map((s) => s.name).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const files = await listFiles(sourceConfig.directory);
        if (files.length === 0) {
          return {
            content: [
              { type: "text", text: `No documents in "${source}".` },
            ],
          };
        }

        const listing = files
          .map((f) => `- ${f.name} (${f.size} bytes, modified ${f.modified})`)
          .join("\n");
        return {
          content: [{ type: "text", text: listing }],
        };
      }

      case "read_document": {
        const source = String(args?.source ?? "");
        const filename = String(args?.filename ?? "");
        const sourceConfig = findSource(config.sources, source);
        if (!sourceConfig) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown source "${source}". Available: ${config.sources.map((s) => s.name).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        try {
          const content = await readMarkdown(
            sourceConfig.directory,
            filename,
          );
          return {
            content: [{ type: "text", text: content }],
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read "${filename}": ${(e as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "get_server_url": {
        return {
          content: [
            {
              type: "text",
              text: `http://${config.host}:${config.port}/`,
            },
          ],
        };
      }

      default:
        return {
          content: [
            { type: "text", text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  });

  return server;
}
