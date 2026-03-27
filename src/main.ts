import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig } from "./config.js";
import { createMcpServer, MUTATING_TOOLS } from "./mcp.js";
import { createApp } from "./server.js";

const execFileAsync = promisify(execFile);

const LOCALHOST_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function main() {
  const config = await loadConfig();
  const app = createApp(config);

  // MCP endpoint — stateless: new server + transport per request
  app.post("/mcp", async (request, reply) => {
    const remoteAddr = request.ip;
    const body = request.body as Record<string, unknown>;

    // Block mutating tool calls from non-localhost
    if (
      !LOCALHOST_ADDRS.has(remoteAddr) &&
      body?.method === "tools/call" &&
      MUTATING_TOOLS.has((body?.params as Record<string, unknown>)?.name as string)
    ) {
      void reply.code(403);
      return {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32600,
          message: `Tool "${(body.params as Record<string, unknown>).name}" is only available from localhost`,
        },
      };
    }

    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    await transport.handleRequest(request.raw, reply.raw, body);

    request.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    // Tell Fastify we're managing the response
    void reply.hijack();
  });

  // GET and DELETE on /mcp — method not allowed (stateless mode)
  app.get("/mcp", async (_request, reply) => {
    void reply.code(405);
    return {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    };
  });

  app.delete("/mcp", async (_request, reply) => {
    void reply.code(405);
    return {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    };
  });

  await app.listen({ port: config.port, host: config.host });

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
