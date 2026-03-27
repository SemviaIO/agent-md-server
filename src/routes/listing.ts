import { Hono } from "hono";

import { listFiles } from "../fs.js";
import type { SourceConfig } from "../types.js";

export function createListingRoutes(sources: SourceConfig[]) {
  const app = new Hono();

  app.get("/api/:source/", async (c) => {
    const sourceName = c.req.param("source");
    const source = sources.find((s) => s.name === sourceName);

    if (!source) {
      return c.json({ error: `Source "${sourceName}" not found` }, 404);
    }

    const files = await listFiles(source.directory);
    const mapped = files.map((entry) => ({
      ...entry,
      path: `/${source.name}/${entry.name}`,
    }));

    return c.json(mapped);
  });

  return app;
}
