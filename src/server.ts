import { randomBytes } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./types.js";
import { registerListingRoutes } from "./routes/listing.js";
import { registerFileRoutes } from "./routes/file.js";
import { registerWatchRoutes } from "./routes/watch.js";
import { renderShell } from "./templates/shell.js";
import { renderListingPage } from "./templates/listing-page.js";

declare module "fastify" {
  interface FastifyRequest {
    nonce: string;
  }
}

export function createApp(config: Config): FastifyInstance {
  const app = Fastify();

  const sourceNames = config.sources.map((s) => s.name);

  app.decorateRequest("nonce", "");

  // CSP hook — generate a per-request nonce and set the header
  app.addHook("onRequest", async (request, reply) => {
    request.nonce = randomBytes(16).toString("base64");

    // Mermaid renders SVG with dynamic inline styles that cannot use nonces,
    // so 'unsafe-inline' is required for style-src.
    void reply.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${request.nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net`,
    );
  });

  // API and SSE routes
  registerListingRoutes(app, config.sources);
  registerFileRoutes(app, config.sources);
  registerWatchRoutes(app, config.sources);

  // Root index
  app.get("/", async (request, reply) => {
    void reply.type("text/html");
    return renderListingPage("agent-md-server", request.nonce, sourceNames);
  });

  // Per-source HTML routes. A source name may contain "/" (e.g. "claude/plans"),
  // so we register explicit routes per source rather than using a /:source param,
  // which would only match a single path segment.
  for (const source of config.sources) {
    const prefix = `/${source.name}`;

    app.get(`${prefix}/`, async (request, reply) => {
      void reply.type("text/html");
      return renderListingPage(source.name, request.nonce);
    });

    app.get<{ Params: { file: string } }>(
      `${prefix}/:file`,
      async (request, reply) => {
        const { file } = request.params;

        if (file.endsWith(".md")) {
          void reply.redirect(`${prefix}/${file.slice(0, -3)}`);
          return;
        }

        void reply.type("text/html");
        return renderShell(file, request.nonce, source.name);
      },
    );
  }

  return app;
}
