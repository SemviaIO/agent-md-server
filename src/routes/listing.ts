import type { FastifyInstance } from "fastify";

import { listFiles } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerListingRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  app.get("/api/:source/", async (request, reply) => {
    const { source: sourceName } = request.params as { source: string };
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return reply
        .status(404)
        .send({ error: `Source "${sourceName}" not found` });
    }

    const files = await listFiles(source.directory);
    const mapped = files.map((entry) => ({
      ...entry,
      path: `/${source.name}/${entry.name}`,
    }));

    return reply.send(mapped);
  });
}
