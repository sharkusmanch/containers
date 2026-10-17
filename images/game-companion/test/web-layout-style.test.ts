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
  // Every innermost rule, media blocks included: its selectors and its body.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s !== ""),
    body: (m[2] ?? "").replace(/\s+/g, " ").trim(),
  }));
  const scoped = (selector: string): boolean => /^(#app)?\.layout-(tabs|split)( |$)/.test(selector);

  it("keeps the safe areas to bottom tabs and two panes, never a single page", () => {
    const withInsets = rules.filter((r) => r.body.includes("safe-area-inset"));
    expect(withInsets.length).toBeGreaterThan(0);
    for (const rule of withInsets) {
      for (const selector of rule.selectors) expect(scoped(selector)).toBe(true);
    }
  });

  it.each(["tabs", "split"])("pads the outer edges with the safe areas in %s", (mode) => {
    const edges = rules
      .filter((r) => r.selectors.some((s) => s === `#app.layout-${mode}`))
      .map((r) => r.body)
      .join(" ");
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(edges).toContain(`env(safe-area-inset-${edge}`);
    }
    const picker = rules
      .filter((r) => r.selectors.some((s) => s === `.layout-${mode} .picker`))
      .map((r) => r.body)
      .join(" ");
    expect(picker).toContain("inset: env(safe-area-inset-top");
  });

  it("leaves the page grid and the picker as they were for a single page", () => {
    const app = rules.find((r) => r.selectors.join() === "#app" && r.body.includes("display"));
    expect(app?.body).not.toContain("padding");
    const picker = rules.find((r) => r.selectors.join() === ".picker");
    expect(picker?.body).toContain("inset: 0;");
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
