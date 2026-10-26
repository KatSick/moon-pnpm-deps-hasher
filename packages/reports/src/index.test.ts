import { describe, expect, test } from "vitest";
import { formatNumberReport } from "./index.js";

describe("formatNumberReport", () => {
  test("formats totals for mixed integers as a readable report", () => {
    expect(formatNumberReport([-3, 0, 2, 5, 5])).toBe("Number report\nTotal: 5\nOdd: 3\nEven: 2");
  });

  test("formats an empty collection with explicit zero counts", () => {
    expect(formatNumberReport([])).toBe("Number report\nTotal: 0\nOdd: 0\nEven: 0");
  });

  test("includes a zero count for an absent parity", () => {
    expect(formatNumberReport([1, -1, 3])).toBe("Number report\nTotal: 3\nOdd: 3\nEven: 0");
  });

  test("rejects invalid input rather than formatting misleading totals", () => {
    expect(() => formatNumberReport([1, NaN])).toThrow(RangeError);
  });
});
