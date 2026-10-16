import { realpathSync } from "node:fs";
import node_fs from "node:fs/promises";
import node_os from "node:os";
import node_path from "node:path";
import node_util from "node:util";

import type { Config, SourceConfig } from "./types.js";

const VALID_PREFIX = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

const CONFIG_PATH = node_path.join(
  node_os.homedir(),
  ".config",
  "agent-md-server",
  "config.json",
);

const DEFAULT_SOURCES: SourceConfig[] = [
  { prefix: "plans", root: "~/plans" },
  { prefix: "claude/plans", root: "~/.claude/plans", hidden: true },
  { prefix: "temp", root: "/tmp/agent-md-server" },
];

/**
 * Claude Code's per-user session tree, which holds every session's
 * scratchpad and so every Artifact page written before publishing. Spelled
 * the way Claude Code prints scratchpad paths (`/private/tmp/claude-501` on
 * macOS), since the preview tool matches paths lexically.
 */
export const CLAUDE_SESSIONS_ROOT = node_path.join(
  realpathSync("/tmp"),
  // POSIX-only, like the session tree itself.
  `claude-${process.getuid!()}`,
);

export const CLAUDE_SESSIONS_PREFIX = "claude-sessions";

/**
 * Always served, whatever the config file says: a config that sets
 * `sources` replaces the defaults, so a default entry would vanish from
 * exactly the deployments that have a config file.
 */
const CLAUDE_SESSIONS_SOURCE: SourceConfig = {
  prefix: CLAUDE_SESSIONS_PREFIX,
  root: CLAUDE_SESSIONS_ROOT,
  hidden: true,
};

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TAILSCALE = false;

interface RawSource {
  prefix?: unknown;
  root?: unknown;
  hidden?: unknown;
}

interface RawConfig {
  sources?: unknown;
  port?: number;
  host?: string;
  tailscale?: boolean;
}

function resolveTilde(filePath: string) {
  if (filePath.startsWith("~/")) {
    return node_path.join(node_os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function validatePrefix(prefix: string) {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(
      `Invalid source prefix "${prefix}": must be one or more [a-z0-9-] segments joined by "/" (e.g. "plans" or "claude/plans")`,
    );
  }
}

function validateSourceSet(prefixes: string[]) {
  // Reject overlapping prefixes — one cannot be a path-prefix of another.
  // e.g. "plans" + "plans/foo" would produce Fastify route collisions between
  // "/plans/:file" (file under outer) and "/plans/foo/" (listing for inner).
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      const [a, b] = [prefixes[i], prefixes[j]];
      if (
        a === b ||
        a.startsWith(b + "/") ||
        b.startsWith(a + "/")
      ) {
        throw new Error(
          `Overlapping source prefixes "${a}" and "${b}": one cannot be a path-prefix of the other`,
        );
      }
    }
  }
}

export function parseSources(raw: unknown): SourceConfig[] {
  if (raw === undefined) {
    return DEFAULT_SOURCES.map((s) => ({ ...s, root: resolveTilde(s.root) }));
  }

  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid "sources": expected an array of {prefix, root, hidden?} objects. ` +
        `The map shape ({"plans": "~/plans"}) was removed in favor of a list. ` +
        `Example: [{"prefix": "plans", "root": "~/plans"}, {"prefix": "claude/plans", "root": "~/.claude/plans", "hidden": true}]`,
    );
  }

  const sources: SourceConfig[] = raw.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid "sources[${index}]": expected an object with {prefix, root, hidden?}`,
      );
    }
    const src = entry as RawSource;
    if (typeof src.prefix !== "string") {
      throw new Error(
        `Invalid "sources[${index}].prefix": expected string, got ${typeof src.prefix}`,
      );
    }
    if (typeof src.root !== "string") {
      throw new Error(
        `Invalid "sources[${index}].root": expected string, got ${typeof src.root}`,
      );
    }
    if (src.hidden !== undefined && typeof src.hidden !== "boolean") {
      throw new Error(
        `Invalid "sources[${index}].hidden": expected boolean, got ${typeof src.hidden}`,
      );
    }
    validatePrefix(src.prefix);
    const result: SourceConfig = {
      prefix: src.prefix,
      root: resolveTilde(src.root),
    };
    if (src.hidden === true) result.hidden = true;
    return result;
  });

  validateSourceSet(sources.map((s) => s.prefix));
  return sources;
}

/**
 * Append the built-in sources to the user's. A user prefix that collides
 * with a built-in one fails the same overlap check as any other pair.
 */
export function withBuiltinSources(sources: SourceConfig[]): SourceConfig[] {
  const all = [...sources, CLAUDE_SESSIONS_SOURCE];
  validateSourceSet(all.map((s) => s.prefix));
  return all;
}

async function readConfigFile(): Promise<RawConfig | undefined> {
  try {
    const content = await node_fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(content) as RawConfig;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function ensureDirectories(sources: SourceConfig[]) {
  await Promise.all(
    sources.map((source) =>
      node_fs.mkdir(source.root, { recursive: true }),
    ),
  );
}

export function parseArgs() {
  const { values } = node_util.parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "h" },
      tailscale: { type: "boolean", short: "t" },
    },
    strict: true,
  });

  return {
    port: values.port !== undefined ? Number(values.port) : undefined,
    host: values.host,
    tailscale: values.tailscale,
  };
}

export async function loadConfig(): Promise<Config> {
  const raw = await readConfigFile();
  const args = parseArgs();

  const userSources = parseSources(raw?.sources);
  const sources = withBuiltinSources(userSources);
  if (userSources.length === 0) {
    console.warn(
      "No sources configured; only the root index and built-in sources will be served.",
    );
  }
  // Only user roots are created: the session tree belongs to Claude Code,
  // which creates it with its own permissions.
  await ensureDirectories(userSources);

  return {
    sources,
    port: args.port ?? raw?.port ?? DEFAULT_PORT,
    host: args.host ?? raw?.host ?? DEFAULT_HOST,
    tailscale: args.tailscale ?? raw?.tailscale ?? DEFAULT_TAILSCALE,
  };
}
