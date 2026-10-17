import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../web-static/style.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** A consistency check, not a CSS engine: the body of the media block opened by `query`. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  return "";
}

/** The selectors of the rules inside a media block. */
const selectorsIn = (block: string): string[] =>
  [...block.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) =>
    (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s !== ""),
  );

describe("the layout stylesheet rules", () => {
  it("respects the safe areas on every outer edge", () => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(`env(safe-area-inset-${edge}`);
    }
  });

  it("pads the bottom tab bar by the bottom safe area", () => {
    const rule = /\.layout-tabs \.rail \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("padding-bottom: env(safe-area-inset-bottom");
    expect(rule).toContain("flex-direction: row");
  });

  it.each([
    ["(vertical-viewport-segments: 2)", "env(viewport-segment-bottom 0 0)"],
    ["(horizontal-viewport-segments: 2)", "env(viewport-segment-right 0 0)"],
  ])("splits at the hinge for %s, in two panes only", (query, boundary) => {
    const block = mediaBlock(query);
    expect(block).toContain(boundary);
    const selectors = selectorsIn(block.slice(block.indexOf("{") + 1, -1));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith(".layout-split ")).toBe(true);
  });

  it("hides the divider except between two panes", () => {
    expect(css).toMatch(/\.split-divider \{[^}]*display: none;/);
    expect(css).toMatch(/\.layout-split \.two-panes > \.split-divider \{[^}]*display: block;/);
  });
});
