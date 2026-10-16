/**
 * Listing entry — discriminated union so consumers can only access
 * `size` after narrowing on `kind === "file"`.
 *
 * `path` is always posix-style (forward slashes), relative to the
 * configured source root.
 */
export type FileEntry =
  | {
      kind: "file";
      name: string;
      path: string;
      modified: string;
      size: number;
    }
  | {
      kind: "dir";
      name: string;
      path: string;
      modified: string;
    };

export interface SourceConfig {
  /** URL path prefix, e.g. "plans" or "claude/plans". */
  prefix: string;
  /** Filesystem directory. */
  root: string;
  /**
   * When true, the source is served (routes register, `preview` resolves) but
   * is omitted from MCP tool descriptions, `list_paths`, and the browser root
   * index. The built-in `claude-sessions` source is the exception: its root
   * is named in the MCP instructions and the `preview` description. Use for fallback directories you want available by absolute-path
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
