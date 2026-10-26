import { describe, expect, test } from "vitest";
import { classifyInteger, countParity } from "./index.js";

describe("classifyInteger", () => {
  test.each([
    [1, "odd"],
    [2, "even"],
    [0, "even"],
    [-3, "odd"],
    [-4, "even"],
    [Number.MAX_SAFE_INTEGER, "odd"],
    [Number.MIN_SAFE_INTEGER, "odd"],
  ] as const)("classifies %s as %s", (value, parity) => {
    expect(classifyInteger(value)).toBe(parity);
  });

  test.each([1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects values outside the safe integer domain: %s",
    (value) => {
      expect(() => classifyInteger(value)).toThrow(RangeError);
    },
  );
});

describe("countParity", () => {
  test("counts repeated, negative, and zero values without changing input", () => {
    const values = Object.freeze([-3, -2, 0, 1, 1, 4]);

    expect(countParity(values)).toEqual({ total: 6, odd: 3, even: 3 });
    expect(values).toEqual([-3, -2, 0, 1, 1, 4]);
  });

  test("returns zero counts for an empty collection", () => {
    expect(countParity([])).toEqual({ total: 0, odd: 0, even: 0 });
  });

  test("rejects a collection containing a fractional value", () => {
    expect(() => countParity([1, 2.5, 3])).toThrow(RangeError);
  });
});
