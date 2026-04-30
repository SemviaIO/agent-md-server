import type { FastifyInstance } from "fastify";

import { readMarkdown } from "../fs.js";
import type { SourceConfig } from "../types.js";
import { sendFsError } from "./errors.js";
import { sendListing } from "./listing.js";

export function registerFileRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    // This catch-all owns every URL under /api/${prefix}/ except the
    // bare source root (which `registerListingRoutes` handles). Dispatch
    // by suffix:
    //   trailing slash → sub-directory listing (delegate)
    //   .md            → raw markdown
    //   otherwise      → 404
    app.get<{ Params: { "*": string } }>(
      `/api/${source.prefix}/*`,
      async (request, reply) => {
        const captured = request.params["*"];

        if (captured.endsWith("/")) {
          return sendListing(reply, source, captured.replace(/\/+$/, ""));
        }

        if (!captured.endsWith(".md")) {
          return reply.status(404).send({ error: "Only .md files are served" });
        }

        try {
          const content = await readMarkdown(source.root, captured);
          return reply
            .header("Content-Type", "text/markdown; charset=utf-8")
            .send(content);
        } catch (error: unknown) {
          return sendFsError(reply, error, captured);
        }
      },
    );
  }
}
