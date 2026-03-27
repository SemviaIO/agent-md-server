import type { FastifyInstance } from "fastify";

import { readMarkdown } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function registerFileRoutes(
  app: FastifyInstance,
  sources: SourceConfig[],
): void {
  app.get("/api/:source/:file", async (request, reply) => {
    const { source: sourceName, file: filename } = request.params as {
      source: string;
      file: string;
    };
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return reply
        .status(404)
        .send({ error: `Source "${sourceName}" not found` });
    }

    try {
      const content = await readMarkdown(source.directory, filename);
      return reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .send(content);
    } catch (error: unknown) {
      if (error instanceof Error) {
        if ("code" in error && error.code === "ENOENT") {
          return reply
            .status(404)
            .send({ error: `File "${filename}" not found` });
        }
        if (error.message.includes("Path traversal")) {
          return reply.status(403).send({ error: "Forbidden" });
        }
      }
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
