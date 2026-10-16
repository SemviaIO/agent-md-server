import { describe, expect, it } from "vitest";

import { hostHtml, RELOAD_SCRIPT } from "./html-host.js";

describe("hostHtml", () => {
  it("serves a document with a doctype behind leading comments unchanged", () => {
    const page = "<!-- generated -->\n<!doctype html>\n<h1>hi</h1>\n";

    expect(hostHtml(page)).toBe(page + RELOAD_SCRIPT);
  });

  it("wraps a fragment that opens with many comments, in linear time", () => {
    const page = "<!--a-->".repeat(40) + "<h1>hi</h1>\n";
    const started = performance.now();

    const hosted = hostHtml(page);

    expect(performance.now() - started).toBeLessThan(100);
    expect(hosted.startsWith("<!doctype html>\n")).toBe(true);
    expect(hosted).toContain(page);
  });
});
