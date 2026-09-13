import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./server.js";
import type { Config } from "./types.js";

/** Non-ASCII body — mojibake under a charset-less `text/html` (#38). */
const HTML_FIXTURE = "<h1>Café — naïve résumé</h1>\n";

describe("hosted .html route", () => {
  let sourceRoot: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-http-"));
    await writeFile(path.join(sourceRoot, "page.html"), HTML_FIXTURE, "utf-8");

    const config: Config = {
      sources: [{ prefix: "plans", root: sourceRoot }],
      port: 3333,
      host: "127.0.0.1",
      tailscale: false,
    };
    app = createApp(config);
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

  it("round-trips non-ASCII content byte-for-byte", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/page.html" });

    expect(response.body).toBe(HTML_FIXTURE);
  });

  it("drops the strict CSP so inline scripts and styles survive", async () => {
    const response = await app.inject({ method: "GET", url: "/plans/page.html" });

    expect(response.headers["content-security-policy"]).toBeUndefined();
  });
});
