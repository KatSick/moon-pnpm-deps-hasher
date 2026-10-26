import { formatNumberReport } from "@example/reports";

/** Render a CLI-style dashboard without printing or mutating the input. */
export function renderDashboard(values: readonly number[]): string {
  return ["=== Number dashboard ===", "", formatNumberReport(values)].join("\n");
}
