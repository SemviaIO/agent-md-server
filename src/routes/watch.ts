import type { FastifyInstance } from "fastify";

import { readSourceFile, watchFile, watchPageDirectory } from "../fs.js";
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

        const isPage = filename.endsWith(".html");
        if (!filename.endsWith(".md") && !isPage) {
          return reply
            .status(404)
            .send({ error: "Only .md and .html files are watched" });
        }

        // Validate the file via readSourceFile (full resolveSafePath check)
        // BEFORE wiring the watcher. watchFile only does a synchronous
        // prefix check, so symlink-escape detection lives here.
        try {
          await readSourceFile(source.root, filename);
        } catch (error: unknown) {
          return sendFsError(reply, error, filename);
        }

        // Start watching before the 200 goes out, so a watcher that cannot
        // start is answered with an error rather than a dead stream. The
        // first change fires after the debounce, by which time the headers
        // below are written. A watcher that fails later ends the stream.
        // A hosted page reloads when its directory changes, so edits to its
        // CSS, scripts or images count as well as edits to the page.
        const watch = isPage ? watchPageDirectory : watchFile;
        let cleanup: () => void;
        try {
          cleanup = watch(
            source.root,
            filename,
            () => {
              reply.raw.write("data: changed\n\n");
            },
            () => {
              reply.raw.end();
            },
          );
        } catch (error: unknown) {
          return sendFsError(reply, error, filename);
        }

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        reply.hijack();

        request.raw.on("close", () => {
          cleanup();
        });
      },
    );
  }
}
