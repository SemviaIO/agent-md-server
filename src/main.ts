import { execFile } from "node:child_process";
import dns from "node:dns";
import { existsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { Renderer } from "./renderer.js";
import { createApp } from "./server.js";

const execFileAsync = promisify(execFile);

/**
 * launchd's PATH is bare (/usr/bin:/bin:/usr/sbin:/sbin), so the `tailscale`
 * CLI is not discoverable by name. Probe known install locations, mirroring
 * how run.sh probes for volta.
 */
const TAILSCALE_BIN_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

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
    const tag = source.hidden ? " (hidden)" : "";
    console.log(`  ${source.prefix} → ${source.root}${tag}`);
  }

  if (config.tailscale) {
    config.tailscaleUrl = await setupTailscale(config.port);
    if (config.tailscaleUrl) {
      console.log(`Tailscale: ${config.tailscaleUrl}`);
    }
  }

  // Renderer uses Playwright to visit the server's own viewer pages.
  // Must use local URL (not Tailscale) since Playwright runs on the same machine.
  renderer = new Renderer(`http://${config.host}:${config.port}`);
  console.log("Playwright renderer ready");
}

async function setupTailscale(port: number): Promise<string | undefined> {
  try {
    // Find the Tailscale IP from network interfaces (CGNAT range 100.64.0.0/10)
    const tailscaleIp = findTailscaleIp();
    if (!tailscaleIp) {
      console.warn("Warning: No Tailscale interface found. Continuing without Tailscale.");
      return undefined;
    }

    // Reverse DNS lookup via Tailscale's MagicDNS to get the hostname. This
    // derives the URL without `tailscale status`, which can need GUI/XPC under
    // launchd.
    const resolver = new dns.promises.Resolver();
    resolver.setServers(["100.100.100.100"]);
    const hostnames = await resolver.reverse(tailscaleIp);
    const dnsName = hostnames[0]?.replace(/\.$/, "");
    if (!dnsName) {
      return undefined;
    }

    // (Re)establish the tailnet HTTPS proxy on every startup. `tailscale serve`
    // persists its rule in tailscaled, but reboots / app updates / `serve reset`
    // can wipe it -- re-running here keeps the exposure self-healing so the
    // advertised URL never points at a dead listener.
    await ensureServeProxy(port);

    return `https://${dnsName}/`;
  } catch (error: unknown) {
    console.warn("Warning: Tailscale setup failed:", String(error));
  }
  return undefined;
}

/**
 * Runs `tailscale serve --bg` to proxy the tailnet HTTPS endpoint (:443) to the
 * local server. Best-effort: if the CLI is missing or fails (e.g. no GUI/XPC
 * session under launchd), the server still serves locally and advertises the
 * URL, which keeps working as long as a serve rule was configured out of band.
 */
async function ensureServeProxy(port: number): Promise<void> {
  const bin = TAILSCALE_BIN_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!bin) {
    console.warn(
      "Warning: tailscale CLI not found; skipping `tailscale serve`. The advertised URL only works if a serve rule is configured manually.",
    );
    return;
  }
  try {
    await execFileAsync(bin, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    console.log(`Tailscale serve: tailnet :443 → http://127.0.0.1:${port}`);
  } catch (error: unknown) {
    console.warn("Warning: `tailscale serve` failed:", String(error));
  }
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
