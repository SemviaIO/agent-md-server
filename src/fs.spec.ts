import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { watchPageDirectory } from "./fs.js";

describe("watchPageDirectory", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-md-server-watch-"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>hi</h1>\n");
    // Let FSEvents settle so fixture creation cannot surface as a change.
    await sleep(500);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ignores changes inside denylisted directories but not the page", async () => {
    let changes = 0;
    const close = watchPageDirectory(root, "index.html", () => changes++, () => {});

    try {
      for (let i = 0; i < 4; i++) {
        await writeFile(path.join(root, ".git", "HEAD"), `ref ${i}\n`);
        await writeFile(path.join(root, "node_modules", "pkg", "index.js"), `${i}\n`);
        await sleep(150);
      }
      await sleep(300);
      expect(changes).toBe(0);

      // No signal for "watcher wired", so keep editing until one lands.
      for (let i = 0; changes === 0 && i < 20; i++) {
        await writeFile(path.join(root, "index.html"), `<h1>${i}</h1>\n`);
        await sleep(250);
      }
      expect(changes).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});
