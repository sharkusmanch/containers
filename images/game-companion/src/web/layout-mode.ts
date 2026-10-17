/** How the companion arranges itself: one page at a time, a bottom tab bar, or two panes. */
export type LayoutMode = "single" | "tabs" | "split";

/** What the person picked for this device: a fixed mode, or "auto" to follow the window. */
export type LayoutOverride = "auto" | LayoutMode;

export const LAYOUT_OVERRIDES: readonly LayoutOverride[] = ["auto", "single", "tabs", "split"];

export const LAYOUT_LABELS: Readonly<Record<LayoutOverride, string>> = {
  auto: "Automatic",
  single: "Single",
  tabs: "Bottom tabs",
  split: "Two panes",
};

/** Window widths (CSS px) at and above which the screen splits, and below which it may use tabs. */
export const SPLIT_MIN_WIDTH = 700;
export const TABS_MAX_WIDTH = 600;
/** A window at least this many times taller than wide, and narrow, gets the bottom tab bar. */
export const TABS_MIN_ASPECT = 1.5;

export const DEFAULT_SPLIT_FRACTION = 0.55;
export const MIN_SPLIT_FRACTION = 0.3;
export const MAX_SPLIT_FRACTION = 0.7;

/** The share of the width the left pane takes; anything unusable gives the default. */
export function clampSplitFraction(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SPLIT_FRACTION;
  return Math.min(MAX_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, value));
}

export function chooseLayout(window: {
  width: number;
  height: number;
  override: LayoutOverride;
}): LayoutMode {
  const { width, height, override } = window;
  if (override !== "auto") return override;
  // An unknown size (no window to ask) must not read as "very tall and narrow".
  if (!(width > 0 && height > 0)) return "single";
  if (width >= SPLIT_MIN_WIDTH) return "split";
  if (width < TABS_MAX_WIDTH && height >= TABS_MIN_ASPECT * width) return "tabs";
  return "single";
}

/** The next choice in the Display row, wrapping from the last back to Automatic. */
export function nextLayoutOverride(current: LayoutOverride): LayoutOverride {
  return LAYOUT_OVERRIDES[LAYOUT_OVERRIDES.indexOf(current) + 1] ?? "auto";
}

/** The Display line under the layout row, e.g. "Window 412 × 915 (2.22) · Bottom tabs". */
export function windowReadout(width: number, height: number, mode: LayoutMode): string {
  const ratio = width > 0 ? height / width : 0;
  return `Window ${width} × ${height} (${ratio.toFixed(2)}) · ${LAYOUT_LABELS[mode]}`;
}
