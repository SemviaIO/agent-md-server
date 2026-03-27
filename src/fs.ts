import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { FileEntry } from "./types.js";

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

export async function listFiles(sourceDir: string): Promise<FileEntry[]> {
  const entries = await readdir(sourceDir);

  const mdFiles = entries.filter((name) => name.endsWith(".md"));

  const fileEntries = await Promise.all(
    mdFiles.map(async (name) => {
      const filePath = path.join(sourceDir, name);
      const fileStat = await stat(filePath);
      return {
        name,
        path: name,
        modified: fileStat.mtime.toISOString(),
        size: fileStat.size,
      } satisfies FileEntry;
    }),
  );

  // Most recently modified first
  fileEntries.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  );

  return fileEntries;
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
  // without the async realpath step. For watch we accept the normalised
  // path; the initial read that precedes the watch should have already
  // gone through resolveSafePath with the full symlink check.
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
