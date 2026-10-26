import { describe, expect, it } from "vitest";

import { colorLabel, type ColorName } from "./index.js";

describe("colorLabel", () => {
  it.each<[ColorName, number]>([
    ["red", 31],
    ["green", 32],
    ["blue", 34],
    ["yellow", 33],
  ])("colors %s labels when explicitly enabled", (color, code) => {
    expect(colorLabel("Ready", color, { enabled: true })).toBe(`\u001b[${code}mReady\u001b[39m`);
  });

  it("leaves labels unchanged when coloring is disabled", () => {
    expect(colorLabel("Warning: café", "yellow", { enabled: false })).toBe("Warning: café");
  });

  it("preserves empty labels in plain output", () => {
    expect(colorLabel("", "red", { enabled: false })).toBe("");
  });

  it("preserves whitespace and multiline text", () => {
    expect(colorLabel(" first\nsecond ", "green", { enabled: true })).toBe(
      "\u001b[32m first\nsecond \u001b[39m",
    );
  });

  it("keeps the requested color after an embedded foreground reset", () => {
    expect(colorLabel("first\u001b[39msecond", "blue", { enabled: true })).toBe(
      "\u001b[34mfirst\u001b[34msecond\u001b[39m",
    );
  });
});
