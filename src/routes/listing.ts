import type { FastifyInstance } from "fastify";

import { listFiles } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerListingRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    app.get(`/api/${source.prefix}/`, async (_request, reply) => {
      const files = await listFiles(source.root);
      const mapped = files.map((entry) => ({
        ...entry,
        path: `/${source.prefix}/${entry.name}`,
      }));

      return reply.send(mapped);
    });
  }
}
