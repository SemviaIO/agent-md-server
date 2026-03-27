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
  /** Explicit Tailscale URL override. Set by config file or resolved at runtime. */
  tailscaleUrl?: string;
}
