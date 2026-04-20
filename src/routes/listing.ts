import type { FastifyInstance } from "fastify";

import { listFiles } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerListingRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  for (const source of sources) {
    app.get(`/api/${source.name}/`, async (_request, reply) => {
      const files = await listFiles(source.directory);
      const mapped = files.map((entry) => ({
        ...entry,
        path: `/${source.name}/${entry.name}`,
      }));

      return reply.send(mapped);
    });
  }
}
