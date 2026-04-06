import dns from "node:dns";
import os from "node:os";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { Renderer } from "./renderer.js";
import { createApp } from "./server.js";

async function main() {
  const config = await loadConfig();
  const app = createApp(config);

  // Late-bound renderer — set after listen() so Playwright can reach the server.
  let renderer: Renderer | undefined;

  // MCP endpoint — stateless: new server + transport per request
  app.post("/mcp", async (request, reply) => {
    if (!renderer) {
      void reply.code(503);
      return { jsonrpc: "2.0", error: { code: -32000, message: "Server starting up" }, id: null };
    }

    const body = request.body as Record<string, unknown>;

    const server = createMcpServer(config, renderer);
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
    config.tailscaleUrl = await setupTailscale();
    if (config.tailscaleUrl) {
      console.log(`Tailscale: ${config.tailscaleUrl}`);
    }
  }

  // Renderer uses Playwright to visit the server's own viewer pages.
  // Must use local URL (not Tailscale) since Playwright runs on the same machine.
  renderer = new Renderer(`http://${config.host}:${config.port}`);
  console.log("Playwright renderer ready");
}

async function setupTailscale(): Promise<string | undefined> {
  try {
    // Find the Tailscale IP from network interfaces (CGNAT range 100.64.0.0/10)
    const tailscaleIp = findTailscaleIp();
    if (!tailscaleIp) {
      console.warn("Warning: No Tailscale interface found. Continuing without Tailscale.");
      return undefined;
    }

    // Reverse DNS lookup via Tailscale's MagicDNS to get the hostname.
    // This avoids the `tailscale` CLI which requires GUI/XPC and fails under launchd.
    const resolver = new dns.promises.Resolver();
    resolver.setServers(["100.100.100.100"]);
    const hostnames = await resolver.reverse(tailscaleIp);
    const dnsName = hostnames[0]?.replace(/\.$/, "");
    if (dnsName) {
      return `https://${dnsName}/`;
    }
  } catch (error: unknown) {
    console.warn("Warning: Tailscale setup failed:", String(error));
  }
  return undefined;
}

function findTailscaleIp(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && isCGNAT(addr.address)) {
        return addr.address;
      }
    }
  }
  return undefined;
}

/** Tailscale uses the CGNAT range 100.64.0.0/10 (100.64.0.0 – 100.127.255.255). */
function isCGNAT(ip: string): boolean {
  const first = Number(ip.split(".")[0]);
  const second = Number(ip.split(".")[1]);
  return first === 100 && second >= 64 && second <= 127;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
