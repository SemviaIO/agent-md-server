// Stress-reproduces the Mach-port leak from issue #22 and verifies the
// renderer-lifecycle fix. Generates N distinct .md files under a temp
// source directory, calls `get_url` for each via the MCP HTTP endpoint,
// and asserts that `[renderer] launching chromium` appears at most
// --max-launches times in the server log since the script started.
//
// Run by hand:  pnpm stress
//
// MUST: kick the server to a known state first:
//   launchctl kickstart -k gui/$(id -u)/io.semvia.agent-md-server

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";

interface Options {
  count: number;
  maxLaunches: number;
  logPath: string;
  concurrency: number;
  endpoint: string;
  workDir: string;
}

interface RenderOk {
  ok: true;
  url: string;
}

interface RenderFail {
  ok: false;
  error: string;
}

type RenderOutcome = RenderOk | RenderFail;

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      count: { type: "string", default: "100" },
      "max-launches": { type: "string", default: "2" },
      "log-path": { type: "string", default: "/tmp/agent-md-server.log" },
      concurrency: { type: "string", default: "1" },
      endpoint: { type: "string", default: "http://127.0.0.1:3333/mcp" },
      "work-dir": {
        type: "string",
        default: "/tmp/agent-md-server/stress",
      },
    },
    strict: true,
  });

  return {
    count: Number(values.count),
    maxLaunches: Number(values["max-launches"]),
    logPath: String(values["log-path"]),
    concurrency: Number(values.concurrency),
    endpoint: String(values.endpoint),
    workDir: String(values["work-dir"]),
  };
}

function diagram(i: number): string {
  // Vary the content per-file so the renderer's mtime cache cannot
  // short-circuit the second call on the same path.
  return `# stress ${i}

\`\`\`mermaid
flowchart LR
  a${i}[Start ${i}] --> b${i}[End ${i}]
\`\`\`
`;
}

async function generateFiles(opts: Options): Promise<string[]> {
  await mkdir(opts.workDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const file = path.join(opts.workDir, `stress-${i}.md`);
    await writeFile(file, diagram(i), "utf-8");
    paths.push(file);
  }
  return paths;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: {
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/**
 * Parses the MCP Streamable HTTP response. The transport emits either
 * application/json or text/event-stream; for a stateless request we get a
 * single SSE `data:` frame. Extract the JSON-RPC payload from either.
 */
function parseMcpBody(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  // SSE: lines `event: message`, `data: <json>`, blank line. Pull the
  // first `data:` payload — for a stateless tools/call there's only one.
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
    }
  }
  throw new Error(`unrecognized MCP response body: ${body.slice(0, 200)}`);
}

async function callGetUrl(
  endpoint: string,
  filePath: string,
  id: number,
): Promise<RenderOutcome> {
  const payload = {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: {
      name: "get_url",
      arguments: { path: filePath },
    },
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { ok: false, error: `fetch failed: ${String(error)}` };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status} ${response.statusText}`,
    };
  }

  let parsed: JsonRpcResponse;
  try {
    parsed = parseMcpBody(await response.text());
  } catch (error) {
    return { ok: false, error: `parse: ${String(error)}` };
  }

  if (parsed.error) {
    return { ok: false, error: `JSON-RPC ${parsed.error.code}: ${parsed.error.message}` };
  }

  if (parsed.result?.isError) {
    const text = parsed.result.content?.[0]?.text ?? "(no error text)";
    return { ok: false, error: `tool error: ${text}` };
  }

  const text = parsed.result?.content?.[0]?.text ?? "";
  try {
    const inner = JSON.parse(text) as { status?: string; url?: string };
    if (inner.status === "ok" && typeof inner.url === "string") {
      return { ok: true, url: inner.url };
    }
    return { ok: false, error: `unexpected tool result: ${text.slice(0, 200)}` };
  } catch {
    return { ok: false, error: `non-json tool result: ${text.slice(0, 200)}` };
  }
}

async function runWithConcurrency(
  paths: string[],
  concurrency: number,
  endpoint: string,
): Promise<RenderOutcome[]> {
  const outcomes: RenderOutcome[] = new Array(paths.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= paths.length) return;
      outcomes[i] = await callGetUrl(endpoint, paths[i], i + 1);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return outcomes;
}

async function countLaunchLines(
  logPath: string,
  startMs: number,
): Promise<number> {
  let content: string;
  try {
    content = await readFile(logPath, "utf-8");
  } catch (error) {
    console.warn(
      `[stress] could not read log at ${logPath}: ${String(error)}`,
    );
    return 0;
  }
  // Count occurrences of the launch marker. The log is append-only and
  // truncates by launchctl on kickstart -k, so anything we see here was
  // written during this script's run when the operator kicked first.
  const marker = "[renderer] launching chromium";
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(marker, idx)) !== -1) {
    count++;
    idx += marker.length;
  }
  // startMs is unused for counting (kickstart truncates the log) but kept
  // in the signature for future enhancement (e.g. timestamped log lines).
  void startMs;
  return count;
}

function banner(opts: Options): void {
  console.log("[stress] agent-md-server renderer stress test");
  console.log(
    `[stress] kick the server first:\n` +
      `         launchctl kickstart -k gui/$(id -u)/io.semvia.agent-md-server`,
  );
  console.log(
    `[stress] count=${opts.count} concurrency=${opts.concurrency} max-launches=${opts.maxLaunches}`,
  );
  console.log(`[stress] endpoint=${opts.endpoint} log=${opts.logPath}`);
}

async function main(): Promise<void> {
  const opts = parseOptions();
  banner(opts);

  const startMs = Date.now();
  const startPerf = performance.now();

  console.log(`[stress] generating ${opts.count} .md files in ${opts.workDir}`);
  const paths = await generateFiles(opts);

  console.log(`[stress] issuing ${opts.count} get_url calls`);
  const outcomes = await runWithConcurrency(paths, opts.concurrency, opts.endpoint);

  const elapsedMs = Math.round(performance.now() - startPerf);
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - ok;

  // Give the server a moment to flush its log before we count.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const launches = await countLaunchLines(opts.logPath, startMs);

  console.log(
    `[stress] renders=${outcomes.length} ok=${ok} failed=${failed} elapsed=${elapsedMs}ms`,
  );
  console.log(`[stress] launches observed in log: ${launches}`);

  if (failed > 0) {
    console.log("[stress] failures (first 5):");
    let shown = 0;
    for (const o of outcomes) {
      if (o.ok || shown >= 5) continue;
      console.log(`         - ${o.error}`);
      shown++;
    }
  }

  if (launches > opts.maxLaunches) {
    console.error(
      `[stress] FAIL: ${launches} launches exceeds --max-launches ${opts.maxLaunches}`,
    );
    process.exit(1);
  }

  if (failed > 0) {
    console.error(`[stress] FAIL: ${failed} render(s) failed`);
    process.exit(1);
  }

  console.log("[stress] PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
