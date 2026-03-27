import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { loadConfig } from "./config.js";
import { createMcpServer, MUTATING_TOOLS } from "./mcp.js";
import { createApp } from "./server.js";

const execFileAsync = promisify(execFile);

const LOCALHOST_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function main() {
  const config = await loadConfig();
  const app = createApp(config);

  // Mount MCP over HTTP at /mcp
  const mcpServer = createMcpServer(config);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);

  app.all("/mcp", async (c) => {
    // Block mutating MCP tool calls from non-localhost (e.g. Tailscale)
    const connInfo = getConnInfo(c);
    const remoteAddr = connInfo.remote.address ?? "";
    const isLocal = LOCALHOST_ADDRS.has(remoteAddr);

    if (!isLocal && c.req.method === "POST") {
      // Parse the JSON-RPC body to check the tool name
      const body = await c.req.json();
      if (
        body?.method === "tools/call" &&
        MUTATING_TOOLS.has(body?.params?.name)
      ) {
        return c.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -32600,
              message: `Tool "${body.params.name}" is only available from localhost`,
            },
          },
          403,
        );
      }
      // Re-create the request with the consumed body for the transport
      const newReq = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      });
      return transport.handleRequest(newReq);
    }

    return transport.handleRequest(c.req.raw);
  });

  serve({ fetch: app.fetch, port: config.port, hostname: config.host });

  console.log(
    `agent-md-server running at http://${config.host}:${config.port}/`,
  );
  console.log(
    `MCP endpoint: http://${config.host}:${config.port}/mcp`,
  );
  for (const source of config.sources) {
    console.log(`  ${source.name} → ${source.directory}`);
  }

  if (config.tailscale) {
    await setupTailscale(config.port);
  }
}

async function setupTailscale(port: number) {
  const localUrl = `http://localhost:${port}`;

  try {
    await execFileAsync("tailscale", ["serve", "--bg", localUrl]);

    // Fetch the Tailscale hostname to print a clickable URL
    try {
      const { stdout: statusJson } = await execFileAsync("tailscale", [
        "status",
        "--json",
      ]);
      const status = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
      const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
      if (dnsName) {
        console.log(`Tailscale: https://${dnsName}/`);
      } else {
        console.log("Tailscale serve enabled");
      }
    } catch {
      console.log("Tailscale serve enabled");
    }
  } catch (error: unknown) {
    if (isCommandNotFound(error)) {
      console.warn(
        "Warning: tailscale command not found. Continuing without Tailscale.",
      );
      return;
    }
    throw error;
  }

  const cleanup = async () => {
    try {
      await execFileAsync("tailscale", ["serve", "--remove", localUrl]);
    } catch {
      // Best-effort cleanup on exit
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
}

function isCommandNotFound(error: unknown) {
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
