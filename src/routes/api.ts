import type { FastifyInstance, FastifyReply } from "fastify";

import { listFiles, readMarkdown } from "../fs.js";
import type { SourceConfig } from "../types.js";
import { sendFsError } from "./errors.js";

/**
 * Owns the entire `/api/${prefix}/...` URL space for each configured
 * source.
 *
 * Two routes per source:
 *   /api/${prefix}/    — source-root listing
 *   /api/${prefix}/*   — catch-all dispatching by suffix:
 *                          trailing slash → sub-directory listing
 *                          .md            → raw markdown
 *                          otherwise      → 404
 *
 * Fastify rejects duplicate method+path registrations, so the bare
 * source-root route must be registered as its own narrow route rather
 * than handled inside the wildcard.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    app.get(`/api/${source.prefix}/`, async (_request, reply) => {
      return sendListing(reply, source, "");
    });

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

async function sendListing(
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
    return sendFsError(reply, error, subPath);
  }
}
