import { countParity } from "@example/numbers";

/** Format safe-integer parity totals as a plain-text report. */
export function formatNumberReport(values: readonly number[]): string {
  const counts = countParity(values);

  return [
    "Number report",
    `Total: ${counts.total}`,
    `Odd: ${counts.odd}`,
    `Even: ${counts.even}`,
  ].join("\n");
}
