import { describe, expect, it } from "vitest";
import {
  chooseLayout,
  clampSplitFraction,
  nextLayoutOverride,
  windowReadout,
} from "../src/web/layout-mode.js";

describe("chooseLayout", () => {
  it.each([
    ["Thor bottom screen", 411, 470, "single"],
    ["Fold cover screen", 412, 915, "tabs"],
    ["Fold main screen", 884, 1004, "split"],
    ["iPad portrait", 1024, 1366, "split"],
    ["iPad landscape", 1366, 1024, "split"],
    ["desktop", 1440, 900, "split"],
    ["a narrow window between the bands", 650, 700, "single"],
    ["exactly 700 wide", 700, 300, "split"],
    ["just under 700 wide", 699, 300, "single"],
    ["exactly 600 wide and tall", 600, 1000, "single"],
    ["just under 600 wide and tall", 599, 1000, "tabs"],
    ["exactly 1.5 times taller than wide", 400, 600, "tabs"],
    ["just under 1.5 times taller than wide", 400, 599, "single"],
    ["a window of unknown size", 0, 0, "single"],
  ] as const)("%s (%i x %i) is %s", (_name, width, height, expected) => {
    expect(chooseLayout({ width, height, override: "auto" })).toBe(expected);
  });

  it.each(["single", "tabs", "split"] as const)("an override of %s wins over any window", (o) => {
    for (const [width, height] of [
      [411, 470],
      [412, 915],
      [1440, 900],
    ] as const) {
      expect(chooseLayout({ width, height, override: o })).toBe(o);
    }
  });
});

describe("nextLayoutOverride", () => {
  it("cycles auto, single, tabs, split and back to auto", () => {
    expect(nextLayoutOverride("auto")).toBe("single");
    expect(nextLayoutOverride("single")).toBe("tabs");
    expect(nextLayoutOverride("tabs")).toBe("split");
    expect(nextLayoutOverride("split")).toBe("auto");
  });
});

describe("clampSplitFraction", () => {
  it.each([
    [0.55, 0.55],
    [0.3, 0.3],
    [0.7, 0.7],
    [0.1, 0.3],
    [0.95, 0.7],
    [-2, 0.3],
    [Infinity, 0.7],
    [Number.NaN, 0.55],
    ["0.4", 0.55],
    [null, 0.55],
    [undefined, 0.55],
  ])("%s becomes %s", (input, expected) => {
    expect(clampSplitFraction(input)).toBe(expected);
  });
});

describe("windowReadout", () => {
  it("names the size, the height to width ratio to two places and the resolved mode", () => {
    expect(windowReadout(412, 915, "tabs")).toBe("Window 412 × 915 (2.22) · Bottom tabs");
    expect(windowReadout(884, 1004, "split")).toBe("Window 884 × 1004 (1.14) · Two panes");
    expect(windowReadout(411, 470, "single")).toBe("Window 411 × 470 (1.14) · Single");
  });

  it("shows a ratio of 0.00 when the width is unknown", () => {
    expect(windowReadout(0, 0, "single")).toBe("Window 0 × 0 (0.00) · Single");
  });
});
