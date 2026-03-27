import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { readMarkdown, watchFile } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function createWatchRoutes(sources: SourceConfig[]) {
  const app = new Hono();

  app.get("/events/:source/:file", async (c) => {
    const sourceName = c.req.param("source");
    const filename = c.req.param("file");
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return c.json({ error: `Source "${sourceName}" not found` }, 404);
    }

    // Validate the file exists before setting up the watcher
    try {
      await readMarkdown(source.directory, filename);
    } catch {
      return c.json({ error: `File "${filename}" not found` }, 404);
    }

    return streamSSE(c, async (stream) => {
      const cleanup = watchFile(source.directory, filename, () => {
        stream.writeSSE({ data: "changed" }).catch(() => {
          // Stream may already be closed; ignore write errors
        });
      });

      stream.onAbort(() => {
        cleanup();
      });

      // Keep the stream open until the client disconnects
      while (!stream.aborted) {
        await stream.sleep(30_000);
      }
    });
  });

  return app;
}
