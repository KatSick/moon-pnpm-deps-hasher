import { describe, expect, test } from "vitest";
import { splitByParity } from "./index.js";

describe("splitByParity", () => {
  test("groups odd and even integers while preserving order and duplicates", () => {
    const values = Object.freeze([3, 2, -1, 0, -4, 3]);

    expect(splitByParity(values)).toEqual({
      odd: [3, -1, 3],
      even: [2, 0, -4],
    });
    expect(values).toEqual([3, 2, -1, 0, -4, 3]);
  });

  test("returns empty groups for an empty collection", () => {
    expect(splitByParity([])).toEqual({ odd: [], even: [] });
  });

  test("leaves the other group empty when all values are even", () => {
    expect(splitByParity([0, 2, -6])).toEqual({ odd: [], even: [0, 2, -6] });
  });

  test.each([0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects values outside the safe integer domain: %s",
    (value) => {
      expect(() => splitByParity([1, value])).toThrow(RangeError);
    },
  );
});
