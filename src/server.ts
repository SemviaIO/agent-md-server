import path from "node:path";
import { randomBytes } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./types.js";
import { registerListingRoutes } from "./routes/listing.js";
import { registerFileRoutes } from "./routes/file.js";
import { registerWatchRoutes } from "./routes/watch.js";
import { renderShell } from "./templates/shell.js";
import { renderListingPage } from "./templates/listing-page.js";

/**
 * URL of the parent directory for a sub-path captured by a wildcard route.
 * For an empty sub-path (the source root) the parent stays at the source
 * root URL, since there's nothing above it within the prefix.
 */
function parentUrlOf(urlPrefix: string, subPath: string): string {
  const parent = path.posix.dirname(subPath);
  return parent === "." || parent === "/" || parent === ""
    ? `${urlPrefix}/`
    : `${urlPrefix}/${parent}/`;
}

declare module "fastify" {
  interface FastifyRequest {
    nonce: string;
  }
}

export function createApp(config: Config): FastifyInstance {
  const app = Fastify();

  // Hidden sources are served but not listed on the root index.
  const visiblePrefixes = config.sources
    .filter((s) => !s.hidden)
    .map((s) => s.prefix);

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

  // API and SSE routes (hidden sources still get routes — `hidden` only
  // controls discovery, not reachability)
  registerListingRoutes(app, config.sources);
  registerFileRoutes(app, config.sources);
  registerWatchRoutes(app, config.sources);

  // Root index
  app.get("/", async (request, reply) => {
    void reply.type("text/html");
    return renderListingPage("agent-md-server", request.nonce, {
      kind: "rootIndex",
      sources: visiblePrefixes,
    });
  });

  // Per-source HTML routes. A source prefix may contain "/" (e.g. "claude/plans"),
  // so we register explicit routes per source rather than using a /:source param,
  // which would only match a single path segment.
  //
  // The narrow `${urlPrefix}/` route is registered before the wildcard so
  // Fastify's route specificity wins for the source-root listing.
  for (const source of config.sources) {
    const urlPrefix = `/${source.prefix}`;

    app.get(`${urlPrefix}/`, async (request, reply) => {
      void reply.type("text/html");
      return renderListingPage(source.prefix, request.nonce, {
        kind: "sourceRoot",
      });
    });

    app.get<{ Params: { "*": string } }>(
      `${urlPrefix}/*`,
      async (request, reply) => {
        const captured = request.params["*"];

        // Trailing slash → directory listing for a sub-path.
        if (captured.endsWith("/")) {
          const subPath = captured.replace(/\/+$/, "");
          const title = `${source.prefix}/${subPath}`;
          void reply.type("text/html");
          return renderListingPage(title, request.nonce, {
            kind: "subDir",
            parentUrl: parentUrlOf(urlPrefix, subPath),
          });
        }

        // `.md` URL → redirect to the clean (no-extension) form, preserving
        // the captured subpath so nested files resolve correctly.
        if (captured.endsWith(".md")) {
          void reply.redirect(`${urlPrefix}/${captured.slice(0, -3)}`);
          return;
        }

        // Otherwise: render the viewer shell for a clean file URL.
        const titleName = path.posix.basename(captured);
        void reply.type("text/html");
        return renderShell(
          titleName,
          request.nonce,
          parentUrlOf(urlPrefix, captured),
        );
      },
    );
  }

  return app;
}
