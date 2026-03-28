import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { createApp } from "./server.js";

const execFileAsync = promisify(execFile);

async function main() {
  const config = await loadConfig();
  const app = createApp(config);

  // MCP endpoint — stateless: new server + transport per request
  app.post("/mcp", async (request, reply) => {
    const body = request.body as Record<string, unknown>;

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

  if (config.tailscale && !config.tailscaleUrl) {
    config.tailscaleUrl = await setupTailscale(config.port);
  }
  if (config.tailscaleUrl) {
    console.log(`Tailscale: ${config.tailscaleUrl}`);
  }
}

async function setupTailscale(port: number): Promise<string | undefined> {
  try {
    // Try to register the serve proxy (works from interactive shells,
    // may fail under launchd due to GUI IPC restrictions)
    try {
      await execFileAsync("tailscale", ["serve", "--bg", `http://localhost:${port}`]);
    } catch {
      // If serve --bg fails (common under launchd), that's OK —
      // the user can run it once manually. We just need the hostname.
    }

    // Get the Tailscale hostname to construct the viewer URL
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (dnsName) {
      const url = `https://${dnsName}/`;
      console.log(`Tailscale: ${url}`);
      return url;
    }
  } catch (error: unknown) {
    if (isCommandNotFound(error)) {
      console.warn(
        "Warning: tailscale command not found. Continuing without Tailscale.",
      );
    } else {
      console.warn("Warning: Tailscale setup failed:", (error as Error).message);
    }
  }
  return undefined;
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
