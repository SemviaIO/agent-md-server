export interface FileEntry {
  name: string;
  /** Path relative to the source root, posix-style (forward slashes). */
  path: string;
  /** Discriminator used by listing consumers. Files end in `.md`; dirs are navigable. */
  kind: "file" | "dir";
  modified: string;
  /** 0 for directories. */
  size: number;
}

export interface SourceConfig {
  /** URL path prefix, e.g. "plans" or "claude/plans". */
  prefix: string;
  /** Filesystem directory. */
  root: string;
  /**
   * When true, the source is served (routes register, `get_url` resolves) but
   * is omitted from MCP tool descriptions, `list_paths`, and the browser root
   * index. Use for fallback directories you want available by absolute-path
   * lookup without advertising them.
   */
  hidden?: boolean;
}

export interface Config {
  sources: SourceConfig[];
  port: number;
  host: string;
  tailscale: boolean;
  /** Resolved at runtime from `tailscale status --json` when tailscale is enabled. */
  tailscaleUrl?: string;
}
