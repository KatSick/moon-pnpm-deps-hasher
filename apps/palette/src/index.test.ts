import { describe, expect, it } from "vitest";

import { createPalette } from "./index.js";

describe("createPalette", () => {
  it("renders an ordered plain-text legend", () => {
    expect(
      createPalette(
        [
          { label: "Ocean", color: "blue" },
          { label: "Sunshine", color: "yellow" },
          { label: "Forest", color: "green" },
        ],
        { enabled: false },
      ),
    ).toBe("■ Ocean\n■ Sunshine\n■ Forest");
  });

  it("colors only the swatches when explicitly enabled", () => {
    expect(
      createPalette(
        [
          { label: "Error", color: "red" },
          { label: "Success", color: "green" },
        ],
        { enabled: true },
      ),
    ).toBe("\u001b[31m■\u001b[39m Error\n\u001b[32m■\u001b[39m Success");
  });

  it.each([false, true])("renders an empty palette with enabled=%s", (enabled) => {
    expect(createPalette([], { enabled })).toBe("");
  });

  it("preserves duplicate entries and Unicode labels", () => {
    const entries = [
      { label: "Café", color: "blue" },
      { label: "Café", color: "blue" },
    ] as const;

    expect(createPalette(entries, { enabled: false })).toBe("■ Café\n■ Café");
  });

  it("preserves empty labels without adding a trailing newline", () => {
    expect(createPalette([{ label: "", color: "yellow" }], { enabled: false })).toBe("■ ");
  });
});
