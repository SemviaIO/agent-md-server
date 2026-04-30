import type { FastifyReply } from "fastify";

/**
 * Map a filesystem error from `resolveSafePath` / `readMarkdown` /
 * `listFiles` to the appropriate HTTP status. Centralises the mapping
 * so every route surfaces a consistent shape:
 *
 *   ENOENT             → 404 (with the user-supplied `target` echoed)
 *   ENOTDIR            → 404 (caller asked for a directory listing on a file)
 *   "Path traversal"   → 403 (do not echo the resolved path — it would
 *                              leak internals)
 *   anything else      → 500
 */
export function sendFsError(
  reply: FastifyReply,
  error: unknown,
  target: string,
) {
  if (error instanceof Error) {
    if ("code" in error && error.code === "ENOENT") {
      return reply.status(404).send({ error: `"${target}" not found` });
    }
    if ("code" in error && error.code === "ENOTDIR") {
      return reply
        .status(404)
        .send({ error: `"${target}" is not a directory` });
    }
    if (error.message.includes("Path traversal")) {
      return reply.status(403).send({ error: "Forbidden" });
    }
  }
  return reply.status(500).send({ error: "Internal server error" });
}
