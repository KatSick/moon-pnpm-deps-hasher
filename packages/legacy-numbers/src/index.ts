import isOdd from "is-odd";

export interface ParityGroups {
  odd: number[];
  even: number[];
}

/** Split safe integers by parity, preserving order and duplicate values. */
export function splitByParity(values: readonly number[]): ParityGroups {
  const groups: ParityGroups = { odd: [], even: [] };

  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Expected a safe integer");
    }

    const group = isOdd(value) ? groups.odd : groups.even;
    group.push(value);
  }

  return groups;
}
