import type { FastifyInstance } from "fastify";

import { readMarkdown, watchFile } from "../fs.js";
import type { SourceConfig } from "../types.js";
import { sendFsError } from "./errors.js";

export function registerWatchRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    app.get<{ Params: { "*": string } }>(
      `/events/${source.prefix}/*`,
      async (request, reply) => {
        const filename = request.params["*"];

        if (!filename.endsWith(".md")) {
          return reply.status(404).send({ error: "Only .md files are served" });
        }

        // Validate the file via readMarkdown (full resolveSafePath check)
        // BEFORE wiring the watcher. watchFile only does a synchronous
        // prefix check, so symlink-escape detection lives here.
        try {
          await readMarkdown(source.root, filename);
        } catch (error: unknown) {
          return sendFsError(reply, error, filename);
        }

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        reply.hijack();

        const cleanup = watchFile(source.root, filename, () => {
          reply.raw.write("data: changed\n\n");
        });

        request.raw.on("close", () => {
          cleanup();
        });
      },
    );
  }
}
