import type { FastifyInstance } from "fastify";

import { readMarkdown, watchFile } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerWatchRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  app.get("/events/:source/:file", async (request, reply) => {
    const { source: sourceName, file: filename } = request.params as {
      source: string;
      file: string;
    };
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return reply
        .status(404)
        .send({ error: `Source "${sourceName}" not found` });
    }

    // Validate the file exists before setting up the watcher
    try {
      await readMarkdown(source.directory, filename);
    } catch {
      return reply
        .status(404)
        .send({ error: `File "${filename}" not found` });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.hijack();

    const cleanup = watchFile(source.directory, filename, () => {
      reply.raw.write("data: changed\n\n");
    });

    request.raw.on("close", () => {
      cleanup();
    });
  });
}
