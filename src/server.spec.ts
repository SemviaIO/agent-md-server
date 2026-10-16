import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./server.js";
import { RELOAD_SCRIPT } from "./templates/html-host.js";
import type { Config } from "./types.js";

/** Non-ASCII body — mojibake under a charset-less `text/html` (#38). */
const HTML_FIXTURE = "<!doctype html>\n<h1>Café — naïve résumé</h1>\n";

/** A Claude Code Artifact main page: a fragment with no doctype. */
const FRAGMENT_FIXTURE =
  '<title>Artifact</title>\n<link rel="stylesheet" href="assets/style.css">\n<img src="logo.png">\n';

/** A 1×1 PNG, so the byte-for-byte round trip covers a real binary file. */
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

function configFor(root: string): Config {
  return {
    sources: [{ prefix: "plans", root }],
    port: 3333,
    host: "127.0.0.1",
    tailscale: false,
  };
}

describe("hosted .html route", () => {
  let sourceRoot: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-http-"));
    await writeFile(path.join(sourceRoot, "page.html"), HTML_FIXTURE, "utf-8");
    await writeFile(path.join(sourceRoot, "index.html"), FRAGMENT_FIXTURE, "utf-8");
    await writeFile(
      path.join(sourceRoot, "commented.html"),
      "\uFEFF  <!-- generated -->\n<!DOCTYPE html>\n<p>hi</p>\n",
      "utf-8",
    );

    app = createApp(configFor(sourceRoot));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it("declares utf-8 in the content-type", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/page.html" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("serves a page with a doctype byte-for-byte, followed only by the reload script", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/page.html" });

    expect(response.body).toBe(HTML_FIXTURE + RELOAD_SCRIPT);
  });

  it("finds a doctype behind a BOM, whitespace and comments", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/commented.html" });

    expect(response.body.startsWith("\uFEFF  <!-- generated -->")).toBe(true);
    expect(response.body).not.toContain('<meta charset="utf-8">');
  });

  it("wraps a fragment in a standards-mode skeleton ahead of its own bytes", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/index.html" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.body.startsWith("<!doctype html>")).toBe(true);
    const fragmentAt = response.body.indexOf(FRAGMENT_FIXTURE);
    expect(fragmentAt).toBeGreaterThan(0);
    expect(response.body.indexOf('<meta charset="utf-8">')).toBeLessThan(fragmentAt);
    expect(
      response.body.indexOf(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      ),
    ).toBeLessThan(fragmentAt);
    expect(response.body.endsWith(RELOAD_SCRIPT)).toBe(true);
  });

  it("leaves the /api/ raw route untouched", async () => {
    const fragment = await app.inject({ method: "GET", url: "/api/plans/index.html" });
    const page = await app.inject({ method: "GET", url: "/api/plans/page.html" });

    expect(fragment.body).toBe(FRAGMENT_FIXTURE);
    expect(page.body).toBe(HTML_FIXTURE);
  });

  it("drops the strict CSP so inline scripts and styles survive", async () => {
    const page = await app.inject({ method: "GET", url: "/plans/page.html" });
    const fragment = await app.inject({ method: "GET", url: "/plans/index.html" });

    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect(fragment.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("sibling assets", () => {
  let parent: string;
  let sourceRoot: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-assets-"));
    sourceRoot = path.join(parent, "root");
    await mkdir(path.join(sourceRoot, "assets"), { recursive: true });
    await writeFile(path.join(sourceRoot, "index.html"), FRAGMENT_FIXTURE);
    await writeFile(path.join(sourceRoot, "assets", "style.css"), "h1 { color: red }\n");
    await writeFile(path.join(sourceRoot, "logo.png"), PNG_FIXTURE);
    await writeFile(path.join(sourceRoot, "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    await writeFile(path.join(sourceRoot, "notes.txt"), "not an asset\n");
    await writeFile(path.join(sourceRoot, "schema.json.md"), "# Schema\n");

    await writeFile(path.join(parent, "secret.png"), PNG_FIXTURE);
    await symlink(path.join(parent, "secret.png"), path.join(sourceRoot, "escape.png"));

    app = createApp(configFor(sourceRoot));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(parent, { recursive: true, force: true });
  });

  it("serves CSS with its MIME type", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/assets/style.css" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(response.body).toBe("h1 { color: red }\n");
  });

  it("keeps the strict CSP and forbids sniffing on assets", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/assets/style.css" });

    expect(response.headers["content-security-policy"]).toBeDefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("round-trips a PNG byte-for-byte", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/logo.png" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.equals(PNG_FIXTURE)).toBe(true);
  });

  it("serves a font with its MIME type", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/font.woff2" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("font/woff2");
  });

  it("does not serve the bytes of a non-asset sibling", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/notes.txt" });

    expect(response.body).not.toContain("not an asset");
  });

  it("answers 404 for a missing asset", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/missing.css" });

    expect(response.statusCode).toBe(404);
  });

  it("serves the viewer for the clean URL of an asset-named markdown file", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/schema.json" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("/api/plans/schema.json.md");
  });

  it("forbids `..` traversal to an asset-shaped path", async () => {
    // Percent-encoded so the URL parser cannot collapse the climb before
    // routing; the wildcard param decodes to `../secret.png`, which only
    // the jail stops.
    const response = await app.inject({ method: "GET", url: "/plans/..%2Fsecret.png" });

    expect(response.statusCode).toBe(403);
  });

  it("forbids a symlinked asset that escapes the source", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/escape.png" });

    expect(response.statusCode).toBe(403);
  });

  it("keeps assets out of listings", async () => {
    const response = await app.inject({ method: "GET", url: "/api/plans/" });
    const names = (response.json() as { name: string }[]).map((e) => e.name);

    expect(names).toEqual(["assets", "schema.json.md", "index.html"]);
  });
});

describe("live reload for hosted HTML", () => {
  let sourceRoot: string;
  let app: FastifyInstance;
  let origin: string;

  beforeAll(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-sse-"));
    await mkdir(path.join(sourceRoot, "assets"));
    await writeFile(path.join(sourceRoot, "index.html"), FRAGMENT_FIXTURE);
    await writeFile(path.join(sourceRoot, "assets", "style.css"), "h1 {}\n");

    app = createApp(configFor(sourceRoot));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it("only watches pages, not assets", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/events/plans/assets/style.css",
    });

    expect(response.statusCode).toBe(404);
  });

  it("emits `changed` when an asset beside the page is edited", async () => {
    // The stream sends nothing, headers included, until the first event, so
    // there is no signal for "watcher wired". Keep editing until one lands,
    // spaced wider than the 100ms debounce so each edit can fire.
    const touch = setInterval(() => {
      void writeFile(path.join(sourceRoot, "assets", "style.css"), "h1 { color: red }\n");
    }, 250);

    try {
      const { status, type, data } = await new Promise<{
        status: number;
        type: string;
        data: string;
      }>((resolve, reject) => {
        const req = http.get(`${origin}/events/plans/index.html`, (res) => {
          res.setEncoding("utf-8");
          res.once("data", (chunk: string) => {
            req.destroy();
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers["content-type"]),
              data: chunk,
            });
          });
        });
        req.on("error", reject);
      });

      expect(status).toBe(200);
      expect(type).toBe("text/event-stream");
      expect(data).toBe("data: changed\n\n");
    } finally {
      clearInterval(touch);
    }
  });
});
