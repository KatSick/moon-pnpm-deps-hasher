import { colorLabel, type ColorName, type ColorOptions } from "@example/colors";

export interface PaletteEntry {
  readonly label: string;
  readonly color: ColorName;
}

/** Render an ordered CLI legend with colored swatches and no trailing newline. */
export function createPalette(entries: readonly PaletteEntry[], options: ColorOptions): string {
  return entries
    .map(({ label, color }) => `${colorLabel("■", color, options)} ${label}`)
    .join("\n");
}
