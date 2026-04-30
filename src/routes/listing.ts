import type { FastifyInstance, FastifyReply } from "fastify";

import { listFiles } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerListingRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    // Source root listing (no sub-path).
    //
    // Sub-directory listings are served by the catch-all in
    // `registerFileRoutes`, which dispatches by suffix:
    //   trailing slash → sendListing
    //   .md            → readMarkdown
    //   otherwise      → 404
    // We can't register `/api/${prefix}/*` here too -- Fastify rejects
    // duplicate routes for the same method+path.
    app.get(`/api/${source.prefix}/`, async (_request, reply) => {
      return sendListing(reply, source, "");
    });
  }
}

export async function sendListing(
  reply: FastifyReply,
  source: SourceConfig,
  subPath: string,
) {
  try {
    const entries = await listFiles(source.root, subPath);
    const mapped = entries.map((entry) => ({
      ...entry,
      path: `/${source.prefix}/${entry.path}`,
    }));
    return reply.send(mapped);
  } catch (error: unknown) {
    if (error instanceof Error) {
      if ("code" in error && error.code === "ENOENT") {
        return reply
          .status(404)
          .send({ error: `Directory "${subPath}" not found` });
      }
      if ("code" in error && error.code === "ENOTDIR") {
        return reply
          .status(404)
          .send({ error: `"${subPath}" is not a directory` });
      }
      if (error.message.includes("Path traversal")) {
        return reply.status(403).send({ error: "Forbidden" });
      }
    }
    return reply.status(500).send({ error: "Internal server error" });
  }
}
