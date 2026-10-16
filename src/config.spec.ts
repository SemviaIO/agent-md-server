import { describe, expect, it } from "vitest";

import { CLAUDE_SESSIONS_ROOT, parseSources, withBuiltinSources } from "./config.js";

const SESSIONS = {
  prefix: "claude-sessions",
  root: CLAUDE_SESSIONS_ROOT,
  hidden: true,
};

describe("built-in sources", () => {
  it("names the session tree the way Claude Code prints it", () => {
    expect(CLAUDE_SESSIONS_ROOT).toMatch(/\/claude-\d+$/);
    if (process.platform === "darwin") {
      expect(CLAUDE_SESSIONS_ROOT.startsWith("/private/tmp/")).toBe(true);
    }
  });

  it("is appended to the defaults when the config sets no sources", () => {
    const sources = withBuiltinSources(parseSources(undefined));

    expect(sources.at(-1)).toEqual(SESSIONS);
    expect(sources.map((s) => s.prefix)).toEqual([
      "plans",
      "claude/plans",
      "temp",
      "claude-sessions",
    ]);
  });

  it("is appended when the config replaces the defaults", () => {
    const sources = withBuiltinSources(
      parseSources([{ prefix: "projects", root: "/srv/projects" }]),
    );

    expect(sources).toEqual([
      { prefix: "projects", root: "/srv/projects" },
      SESSIONS,
    ]);
  });

  it("rejects a user source that claims the built-in prefix", () => {
    expect(() =>
      withBuiltinSources(
        parseSources([{ prefix: "claude-sessions", root: "/srv/elsewhere" }]),
      ),
    ).toThrow(/Overlapping source prefixes "claude-sessions" and "claude-sessions"/);
  });
});
