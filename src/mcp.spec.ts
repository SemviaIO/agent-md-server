import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer, type ValidatingRenderer } from "./mcp.js";
import type { RenderResult } from "./renderer.js";
import type { Config } from "./types.js";

/**
 * Records every `render` call so a test can assert the `.html` branch never
 * reaches Playwright — that routing is the bug behind #37, and a stub that
 * only returned a canned result would let a regression pass silently.
 */
class StubRenderer implements ValidatingRenderer {
  calls: { sourceName: string; fileName: string; filePath: string }[] = [];
  result: RenderResult = { status: "ok", html: "<p>ok</p>", mtimeMs: 1 };

  async render(
    sourceName: string,
    fileName: string,
    filePath: string,
  ): Promise<RenderResult> {
    this.calls.push({ sourceName, fileName, filePath });
    return this.result;
  }
}

/**
 * First text block of a tool result, which is all these tools emit. Takes the
 * open shape both `callTool` result variants share, since the legacy
 * `toolResult` variant has no `content` at all.
 */
function textOf(result: Record<string, unknown>): string {
  const blocks = result.content as { type: string; text?: string }[] | undefined;
  const first = blocks?.find((b) => b.type === "text");
  if (!first?.text) throw new Error("tool result carried no text content");
  return first.text;
}

describe("mcp get_url", () => {
  let sourceRoot: string;
  let renderer: StubRenderer;
  let client: Client;
  let config: Config;

  beforeAll(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-mcp-"));
    await writeFile(path.join(sourceRoot, "doc.md"), "# hi\n");
    await writeFile(path.join(sourceRoot, "page.html"), "<h1>hi</h1>\n");
    await writeFile(path.join(sourceRoot, "notes.txt"), "hi\n");
    // Literal dots in a directory name — contained, but a naive `..`
    // substring screen would reject it.
    await mkdir(path.join(sourceRoot, "a..b"));
    await writeFile(path.join(sourceRoot, "a..b", "notes.md"), "# hi\n");

    config = {
      sources: [{ prefix: "plans", root: sourceRoot }],
      port: 3333,
      host: "127.0.0.1",
      tailscale: false,
    };
  });

  afterAll(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    renderer = new StubRenderer();
    const server = createMcpServer(config, renderer);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "spec", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  it("returns a URL for a hosted .html file without invoking the renderer", async () => {
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "page.html") },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      status: "ok",
      url: "http://127.0.0.1:3333/plans/page.html",
    });
    expect(renderer.calls).toEqual([]);
  });

  it("still renders and validates a .md file, returning its extensionless URL", async () => {
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "doc.md") },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      status: "ok",
      url: "http://127.0.0.1:3333/plans/doc",
    });
    expect(renderer.calls).toEqual([
      {
        sourceName: "plans",
        fileName: "doc",
        filePath: path.join(sourceRoot, "doc.md"),
      },
    ]);
  });

  it("surfaces Mermaid errors from the .md branch instead of a URL", async () => {
    renderer.result = {
      status: "error",
      errors: ["Parse error on line 2"],
      mtimeMs: 1,
    };

    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "doc.md") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parse error on line 2");
  });

  it("rejects an extension the server does not host, with the API route's wording", async () => {
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "notes.txt") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Only .md and .html files are served");
    expect(renderer.calls).toEqual([]);
  });

  it("blames the extension, not the missing file, for an absent .txt", async () => {
    // Pins extension-before-jail ordering. The existing-`.txt` case above
    // passes under either ordering; only a path that is *both* unsupported
    // and absent distinguishes them, and jail-first would answer ENOENT —
    // implying that creating the file would make the call work.
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "no-such.txt") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Only .md and .html files are served");
    expect(renderer.calls).toEqual([]);
  });

  it("resolves a file whose path contains literal dots in a name", async () => {
    // `path.resolve` has already collapsed real traversals by the time
    // containment is checked, so `a..b/` is a plain directory — it must not
    // be mistaken for an escape attempt.
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "a..b", "notes.md") },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      status: "ok",
      url: "http://127.0.0.1:3333/plans/a..b/notes",
    });
  });

  it("reports a missing file rather than handing back a URL", async () => {
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "nope.md") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ENOENT");
    expect(renderer.calls).toEqual([]);
  });

  it("rejects `..` segments that climb out of the source", async () => {
    // The complement of the dotted-name case: containment is checked on the
    // resolved path, so a genuine traversal is caught even though nothing
    // screens the relative form for a `..` substring.
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(sourceRoot, "a..b", "..", "..", "escaped.md") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not within any configured source");
    expect(renderer.calls).toEqual([]);
  });

  it("rejects a path outside every configured source", async () => {
    const result = await client.callTool({
      name: "get_url",
      arguments: { path: path.join(os.tmpdir(), "elsewhere.md") },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not within any configured source");
    expect(renderer.calls).toEqual([]);
  });

  it("declares both hosted formats in the tool descriptions", async () => {
    const { tools } = await client.listTools();

    const getUrl = tools.find((t) => t.name === "get_url");
    expect(getUrl?.description).toContain(".md");
    expect(getUrl?.description).toContain(".html");
    expect(getUrl?.inputSchema.properties?.path).toMatchObject({
      description: "Absolute filesystem path to a .md or .html file",
    });

    const listPaths = tools.find((t) => t.name === "list_paths");
    expect(listPaths?.description).toContain(".md");
    expect(listPaths?.description).toContain(".html");
  });
});
