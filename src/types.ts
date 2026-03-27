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
  /** Set by main.ts after Tailscale setup resolves the public URL */
  tailscaleUrl?: string;
}
