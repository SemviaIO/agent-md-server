import { Hono } from "hono";

import { readMarkdown } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function createFileRoutes(sources: SourceConfig[]) {
  const app = new Hono();

  app.get("/api/:source/:file", async (c) => {
    const sourceName = c.req.param("source");
    const filename = c.req.param("file");
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return c.json({ error: `Source "${sourceName}" not found` }, 404);
    }

    try {
      const content = await readMarkdown(source.directory, filename);
      return c.text(content, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        if ("code" in error && error.code === "ENOENT") {
          return c.json({ error: `File "${filename}" not found` }, 404);
        }
        if (error.message.includes("Path traversal")) {
          return c.json({ error: "Forbidden" }, 403);
        }
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
}
