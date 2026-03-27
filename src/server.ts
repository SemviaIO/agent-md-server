import { randomBytes } from "node:crypto";

import { Hono } from "hono";

import type { Config } from "./types.js";
import { createListingRoutes } from "./routes/listing.js";
import { createFileRoutes } from "./routes/file.js";
import { createWatchRoutes } from "./routes/watch.js";
import { renderShell } from "./templates/shell.js";
import { renderListingPage } from "./templates/listing-page.js";

type Variables = { nonce: string };

export function createApp(config: Config) {
  const app = new Hono<{ Variables: Variables }>();

  const sourceNames = config.sources.map((s) => s.name);
  const sourceSet = new Set(sourceNames);

  // CSP middleware -- generate a per-request nonce and set the header
  app.use("*", async (c, next) => {
    const nonce = randomBytes(16).toString("base64");
    c.set("nonce", nonce);

    await next();

    // Mermaid renders SVG with dynamic inline styles that cannot use nonces,
    // so 'unsafe-inline' is required for style-src.
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net`,
    );
  });

  // Mount API/event route sub-apps
  app.route("/", createListingRoutes(config.sources));
  app.route("/", createFileRoutes(config.sources));
  app.route("/", createWatchRoutes(config.sources));

  // HTML page routes
  app.get("/", (c) => {
    const nonce = c.get("nonce");
    return c.html(renderListingPage("agent-md-server", nonce, sourceNames));
  });

  app.get("/:source/", (c) => {
    const sourceName = c.req.param("source");
    if (!sourceSet.has(sourceName)) {
      return c.notFound();
    }
    const nonce = c.get("nonce");
    return c.html(renderListingPage(sourceName, nonce));
  });

  // Clean URLs: /plans/foo renders the view, /api/plans/foo.md serves raw markdown
  app.get("/:source/:file", (c) => {
    const sourceName = c.req.param("source");
    const fileName = c.req.param("file");

    if (!sourceSet.has(sourceName)) {
      return c.notFound();
    }
    // Reject .md extension in the view URL — that's what /api/ is for
    if (fileName.endsWith(".md")) {
      return c.redirect(`/${sourceName}/${fileName.slice(0, -3)}`);
    }

    const nonce = c.get("nonce");
    return c.html(renderShell(fileName, nonce));
  });

  return app;
}
