import isOdd from "is-odd";

export type Parity = "odd" | "even";

export interface ParityCounts {
  total: number;
  odd: number;
  even: number;
}

/** Classify a safe integer, rejecting fractional or imprecise values. */
export function classifyInteger(value: number): Parity {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Expected a safe integer");
  }

  return isOdd(value) ? "odd" : "even";
}

/** Count each parity without changing the input collection. */
export function countParity(values: readonly number[]): ParityCounts {
  const counts: ParityCounts = { total: 0, odd: 0, even: 0 };

  for (const value of values) {
    counts[classifyInteger(value)] += 1;
    counts.total += 1;
  }

  return counts;
}
