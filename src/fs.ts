import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { FileEntry } from "./types.js";

/**
 * Discovery filter applied to directory listings. Anything in this set is
 * silently omitted when enumerating subdirectories so a source pointed at
 * a dev tree (e.g. `~/projects`) does not surface noisy build / VCS
 * artefacts.
 *
 * This is *not* a security boundary. `resolveSafePath` does not consult
 * this set, so a direct URL like `/api/<prefix>/node_modules/foo.md`
 * still resolves and serves the file. The product position is that the
 * denylist prevents accidental discovery, while the symlink/traversal
 * jail in `resolveSafePath` is what guards against escape.
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

/**
 * File extensions the server hosts. `.md` is rendered through the markdown
 * viewer; `.html` is served as a standalone page. Anything else is omitted
 * from listings; of those, only the sibling assets below are served.
 */
const SERVED_EXTENSIONS = [".md", ".html"];

export function isServedFile(name: string): boolean {
  return SERVED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Sibling assets a hosted `.html` page may reference by relative path, with
 * the `Content-Type` each is served under. They back a page rather than
 * being hosted in their own right, so they never appear in listings and
 * `isServedFile` does not accept them.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** `Content-Type` for a sibling asset, or undefined if `name` is not one. */
export function assetContentType(name: string): string | undefined {
  return ASSET_CONTENT_TYPES[path.posix.extname(name).toLowerCase()];
}

/**
 * Resolve a filename within a source directory, rejecting any path that
 * escapes the jail. This is the critical security boundary -- every
 * filesystem read must go through this function.
 *
 * Defence-in-depth:
 * 1. `path.resolve` normalises away `.` / `..` segments
 * 2. Prefix check ensures the result is still under `sourceDir`
 * 3. `realpath` resolves symlinks so a link pointing outside is caught
 */
export async function resolveSafePath(
  sourceDir: string,
  filename: string,
): Promise<string> {
  const resolvedRoot = path.resolve(sourceDir);
  const joined = path.resolve(resolvedRoot, filename);

  // After normalisation the joined path must be strictly inside the root.
  // Appending `path.sep` prevents prefix collisions like
  // `/data/docs` matching `/data/docs-secret/file.md`.
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Path traversal attempt: "${filename}" resolves outside source directory`,
    );
  }

  // Resolve symlinks to their real targets and re-check.
  const realResolved = await realpath(joined);
  const realRoot = await realpath(resolvedRoot);

  if (
    realResolved !== realRoot &&
    !realResolved.startsWith(realRoot + path.sep)
  ) {
    throw new Error(
      `Path traversal attempt: "${filename}" resolves outside source directory via symlink`,
    );
  }

  return realResolved;
}

/**
 * List the immediate children of `sourceDir/subPath` as a flat array of
 * file and directory entries. One `readdir` per call -- no recursion.
 * Directories in `IGNORED_DIRS` are filtered out; files whose extension
 * is not in `SERVED_EXTENSIONS` are filtered out. The security boundary
 * is `resolveSafePath`, which is called on the resolved target before
 * reading.
 *
 * Sort order: directories first (alphabetical), then files
 * (most-recently-modified first -- preserves the flat-source default).
 */
export async function listFiles(
  sourceDir: string,
  subPath = "",
): Promise<FileEntry[]> {
  const targetDir = await resolveSafePath(sourceDir, subPath);
  const entries = await readdir(targetDir, { withFileTypes: true });

  const dirEntries: FileEntry[] = [];
  const fileEntries: FileEntry[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) return;
        const dirPath = path.join(targetDir, entry.name);
        const dirStat = await stat(dirPath);
        dirEntries.push({
          kind: "dir",
          name: entry.name,
          path: path.posix.join(subPath, entry.name),
          modified: dirStat.mtime.toISOString(),
        });
      } else if (entry.isFile() && isServedFile(entry.name)) {
        const filePath = path.join(targetDir, entry.name);
        const fileStat = await stat(filePath);
        fileEntries.push({
          kind: "file",
          name: entry.name,
          path: path.posix.join(subPath, entry.name),
          modified: fileStat.mtime.toISOString(),
          size: fileStat.size,
        });
      }
    }),
  );

  dirEntries.sort((a, b) => a.name.localeCompare(b.name));
  fileEntries.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  );

  return [...dirEntries, ...fileEntries];
}

export async function readSourceFile(
  sourceDir: string,
  filename: string,
): Promise<string> {
  const safePath = await resolveSafePath(sourceDir, filename);
  return readFile(safePath, "utf-8");
}

/** Like `readSourceFile`, but as raw bytes so images and fonts round-trip. */
export async function readSourceBytes(
  sourceDir: string,
  filename: string,
): Promise<Buffer> {
  const safePath = await resolveSafePath(sourceDir, filename);
  return readFile(safePath);
}

export function watchFile(
  sourceDir: string,
  filename: string,
  onChange: () => void,
): () => void {
  return watchDebounced(lexicalJail(sourceDir, filename), false, onChange);
}

/**
 * Watch the directory holding a hosted page, recursively, so an edit to the
 * page or to any asset beside or below it (e.g. `assets/style.css`) fires.
 * The same caller contract as `watchFile` applies: validate `filename`
 * through `resolveSafePath` first.
 */
export function watchPageDirectory(
  sourceDir: string,
  filename: string,
  onChange: () => void,
): () => void {
  const page = lexicalJail(sourceDir, filename);
  return watchDebounced(path.dirname(page), true, onChange);
}

/**
 * Synchronous prefix check -- the same logic as resolveSafePath but without
 * the async realpath step. Callers MUST run readSourceFile (or an
 * equivalent resolveSafePath call) before watching, since that is what
 * catches symlink escapes; this function only validates the normalised
 * lexical path.
 */
function lexicalJail(sourceDir: string, filename: string): string {
  const resolvedRoot = path.resolve(sourceDir);
  const joined = path.resolve(resolvedRoot, filename);

  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Path traversal attempt: "${filename}" resolves outside source directory`,
    );
  }
  return joined;
}

function watchDebounced(
  target: string,
  recursive: boolean,
  onChange: () => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const watcher: FSWatcher = watch(target, { recursive }, (_event) => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(onChange, 100);
  });

  return () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}
