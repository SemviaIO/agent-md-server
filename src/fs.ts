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
 * Directories in `IGNORED_DIRS` are filtered out; non-`.md` files are
 * filtered out. The security boundary is `resolveSafePath`, which is
 * called on the resolved target before reading.
 *
 * Sort order: directories first (alphabetical), then `.md` files
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
          name: entry.name,
          path: path.posix.join(subPath, entry.name),
          kind: "dir",
          modified: dirStat.mtime.toISOString(),
          size: 0,
        });
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(targetDir, entry.name);
        const fileStat = await stat(filePath);
        fileEntries.push({
          name: entry.name,
          path: path.posix.join(subPath, entry.name),
          kind: "file",
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

export async function readMarkdown(
  sourceDir: string,
  filename: string,
): Promise<string> {
  const safePath = await resolveSafePath(sourceDir, filename);
  return readFile(safePath, "utf-8");
}

export function watchFile(
  sourceDir: string,
  filename: string,
  onChange: () => void,
): () => void {
  const resolvedRoot = path.resolve(sourceDir);
  const joined = path.resolve(resolvedRoot, filename);

  // Synchronous prefix check -- the same logic as resolveSafePath but
  // without the async realpath step. Callers MUST run readMarkdown (or
  // an equivalent resolveSafePath call) before invoking watchFile, since
  // that is what catches symlink escapes; this function only validates
  // the normalised lexical path.
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Path traversal attempt: "${filename}" resolves outside source directory`,
    );
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const watcher: FSWatcher = watch(joined, (_event) => {
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
