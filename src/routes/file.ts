import type { FastifyInstance } from "fastify";

import { readMarkdown } from "../fs.js";
import type { SourceConfig } from "../types.js";
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
    app.get(`/api/${source.prefix}/*`, async (request, reply) => {
      const captured = (request.params as { "*": string })["*"] ?? "";

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
        if (error instanceof Error) {
          if ("code" in error && error.code === "ENOENT") {
            return reply
              .status(404)
              .send({ error: `File "${captured}" not found` });
          }
          if (error.message.includes("Path traversal")) {
            return reply.status(403).send({ error: "Forbidden" });
          }
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    });
  }
}
