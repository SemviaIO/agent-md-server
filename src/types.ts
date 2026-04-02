export interface FileEntry {
  name: string;
  path: string;
  modified: string;
  size: number;
}

export interface SourceConfig {
  name: string;
  directory: string;
}

export interface Config {
  sources: SourceConfig[];
  port: number;
  host: string;
  tailscale: boolean;
  /** Resolved at runtime from `tailscale status --json` when tailscale is enabled. */
  tailscaleUrl?: string;
}
