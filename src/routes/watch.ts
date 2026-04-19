import type { FastifyInstance } from "fastify";

import { readMarkdown, watchFile } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerWatchRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    app.get(`/events/${source.name}/:file`, async (request, reply) => {
      const { file: filename } = request.params as { file: string };

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
}
