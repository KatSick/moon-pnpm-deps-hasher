import { describe, expect, test } from "vitest";
import { renderDashboard } from "./index.js";

describe("renderDashboard", () => {
  test("assembles a dashboard with the complete number report", () => {
    expect(renderDashboard([-1, 0, 2, 3])).toBe(
      "=== Number dashboard ===\n\nNumber report\nTotal: 4\nOdd: 2\nEven: 2",
    );
  });

  test("renders a useful empty dashboard", () => {
    expect(renderDashboard([])).toBe(
      "=== Number dashboard ===\n\nNumber report\nTotal: 0\nOdd: 0\nEven: 0",
    );
  });

  test("accepts a read-only collection", () => {
    const values = Object.freeze([2, 4]);

    expect(renderDashboard(values)).toBe(
      "=== Number dashboard ===\n\nNumber report\nTotal: 2\nOdd: 0\nEven: 2",
    );
    expect(values).toEqual([2, 4]);
  });

  test("rejects invalid input rather than rendering a partial dashboard", () => {
    expect(() => renderDashboard([1, Infinity])).toThrow(RangeError);
  });
});
