import picocolors from "picocolors";

export type ColorName = "red" | "green" | "blue" | "yellow";

export interface ColorOptions {
  readonly enabled: boolean;
}

const colors = picocolors.createColors(true);

/** Color a label explicitly, without consulting terminal capabilities. */
export function colorLabel(label: string, color: ColorName, options: ColorOptions): string {
  return options.enabled ? colors[color](label) : label;
}
