import node_fs from "node:fs/promises";
import node_os from "node:os";
import node_path from "node:path";
import node_util from "node:util";

import type { Config, SourceConfig } from "./types.js";

const VALID_SOURCE_NAME = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

const CONFIG_PATH = node_path.join(
  node_os.homedir(),
  ".config",
  "agent-md-server",
  "config.json",
);

const DEFAULT_SOURCES: Record<string, string> = {
  plans: "~/plans",
  "claude/plans": "~/.claude/plans",
  temp: "/tmp/agent-md-server",
};

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TAILSCALE = false;

interface RawConfig {
  sources?: Record<string, string>;
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

function validateSourceName(name: string) {
  if (!VALID_SOURCE_NAME.test(name)) {
    throw new Error(
      `Invalid source name "${name}": must be one or more [a-z0-9-] segments joined by "/" (e.g. "plans" or "claude/plans")`,
    );
  }
}

function validateSourceSet(names: string[]) {
  // Reject overlapping source names — one cannot be a path-prefix of another.
  // e.g. "plans" + "plans/foo" would produce Fastify route collisions between
  // "/plans/:file" (file under outer) and "/plans/foo/" (listing for inner).
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      if (
        a === b ||
        a.startsWith(b + "/") ||
        b.startsWith(a + "/")
      ) {
        throw new Error(
          `Overlapping source names "${a}" and "${b}": one cannot be a path-prefix of the other`,
        );
      }
    }
  }
}

function transformSources(sources: Record<string, string>): SourceConfig[] {
  const entries = Object.entries(sources);
  for (const [name] of entries) {
    validateSourceName(name);
  }
  validateSourceSet(entries.map(([name]) => name));
  return entries.map(([name, directory]) => ({
    name,
    directory: resolveTilde(directory),
  }));
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
      node_fs.mkdir(source.directory, { recursive: true }),
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

  const sources = transformSources(raw?.sources ?? DEFAULT_SOURCES);
  if (sources.length === 0) {
    console.warn(
      "No sources configured; only the root index will be served.",
    );
  }
  await ensureDirectories(sources);

  return {
    sources,
    port: args.port ?? raw?.port ?? DEFAULT_PORT,
    host: args.host ?? raw?.host ?? DEFAULT_HOST,
    tailscale: args.tailscale ?? raw?.tailscale ?? DEFAULT_TAILSCALE,
  };
}
