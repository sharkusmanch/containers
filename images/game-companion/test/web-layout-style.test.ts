import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUIDE_ZOOM_STEPS } from "../src/web/device.js";

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

  it("styles the window readout as a quiet text row level with the other rows", () => {
    const rule = rules.find((r) => r.selectors.includes(".setting-layout-readout"));
    expect(rule?.body).toContain("margin: 0;");
    expect(rule?.body).toContain("padding: 4px 12px;");
    expect(rule?.body).toContain("font-size: 13px;");
    expect(rule?.body).toContain("color: var(--text-dim);");
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

  // The quoted rows of a rule's `grid-template-areas`, as lists of area names.
  const areas = (selector: string): string[][] => {
    const rule = rules.find((r) => r.selectors.join() === selector);
    const decl = /grid-template-areas:([^;]*);/.exec(rule?.body ?? "")?.[1] ?? "";
    return [...decl.matchAll(/"([^"]*)"/g)].map((m) => (m[1] ?? "").trim().split(/\s+/));
  };

  it("leaves the base achievement row template as it was for Steam and RetroAchievements", () => {
    expect(areas(".ach-row")).toEqual([
      ["icon", "name", "kind", "pct"],
      ["icon", "desc", "desc", "pct"],
      ["icon", "missable", "missable", "pct"],
      ["icon", "progress", "gs", "pct"],
    ]);
  });

  it("puts an Xbox row's percentage and Gamerscore in one column on consecutive lines", () => {
    const grid = areas(".ach-row.ach-row-xbox");
    expect(grid.length).toBeGreaterThan(0);
    const at = (name: string): [number, number] => {
      const row = grid.findIndex((cells) => cells.includes(name));
      return [row, grid[row]?.indexOf(name) ?? -1];
    };
    const [pctRow, pctCol] = at("pct");
    const [gsRow, gsCol] = at("gs");
    expect(pctRow).toBeGreaterThanOrEqual(0);
    expect(gsCol).toBe(pctCol);
    expect(gsRow).toBe(pctRow + 1);
    // Each of them in a single cell, on the name line and the description line.
    expect(grid.flat().filter((n) => n === "pct")).toHaveLength(1);
    expect(grid.flat().filter((n) => n === "gs")).toHaveLength(1);
    expect(grid[pctRow]).toContain("name");
    expect(grid[pctRow]?.indexOf("kind")).toBeLessThan(pctCol);
    expect(grid[gsRow]).toContain("desc");
    // Missable and the counter keep a line of their own, each below the description.
    for (const own of ["missable", "progress"]) {
      const row = grid.findIndex((cells) => cells.includes(own));
      expect(row).toBeGreaterThan(gsRow);
      expect(grid[row]?.filter((n) => n !== own && n !== "icon" && n !== ".")).toEqual([]);
    }
    const body = rules.find((r) => r.selectors.join() === ".ach-row.ach-row-xbox")?.body ?? "";
    expect(body).not.toContain("min-height");
  });

  it("right-aligns the Gamerscore on the percentage's edge", () => {
    const align = (selector: string) =>
      rules.find((r) => r.selectors.join() === selector)?.body ?? "";
    expect(align(".ach-pct")).toContain("justify-self: end;");
    expect(align(".ach-gs")).toContain("justify-self: end;");
  });

  // WebKit bug 301108 (iOS 26): in a Home Screen web app with viewport-fit=cover and a
  // black-translucent status bar, 100% / 100dvh / 100svh come up short by the top inset.
  it("uses the large viewport height in the installed app only", () => {
    const block = mediaBlock("(display-mode: standalone)");
    expect(block).not.toBe("");
    expect(block).toMatch(/html,\s*body\s*\{[^}]*height:\s*100lvh;/);
    expect(css).toMatch(/html,\s*body,\s*#app\s*\{[^}]*height:\s*100%;/);
  });

  const body = (selector: string): string =>
    rules
      .filter((r) => r.selectors.includes(selector))
      .map((r) => r.body)
      .join(" ");

  it("lets no callout or text selection come up on a held rail button", () => {
    const rule = body(".rail button");
    expect(rule).toContain("-webkit-touch-callout: none;");
    expect(rule).toContain("-webkit-user-select: none;");
    expect(rule).toContain("user-select: none;");
    expect(rule).toContain("min-width: 44px;");
    expect(rule).toContain("min-height: 44px;");
  });

  it("marks the slot shown on the right with an accent on the button's right edge", () => {
    expect(body(".rail button.right-pane")).toContain("inset -3px 0 0 var(--accent)");
  });

  describe("two pages side by side", () => {
    const pair = ".layout-split .two-panes > .frames.two-pages";

    it("spreads the frames over the whole stage and places each page by its pane", () => {
      const frames = body(pair);
      for (const decl of ["right: 0;", "bottom: 0;", "width: auto;"])
        expect(frames).toContain(decl);
      expect(body(`${pair} > :not(.pane-right)`)).toContain("--pane-w: var(--left-width);");
      const right = body(`${pair} > .pane-right`);
      expect(right).toContain("--pane-x: calc(var(--left-width) + var(--divider-width));");
      expect(right).toContain("--pane-w: calc(100% - var(--left-width) - var(--divider-width));");
      const placed = rules.find(
        (r) =>
          r.selectors.includes(`${pair} > :not(.pane-right)`) &&
          r.selectors.includes(`${pair} > .pane-right`),
      )?.body;
      for (const decl of [
        "left: var(--pane-x, 0px);",
        "top: var(--pane-y, 0px);",
        "width: var(--pane-w, 100%);",
        "height: var(--pane-h, 100%);",
        "right: auto;",
        "bottom: auto;",
      ]) {
        expect(placed).toContain(decl);
      }
    });

    // A hidden page keeps the box it had beside the achievements, so turning two pages on or off
    // (or Ask covering the right page) never resizes it, which would clamp its scroll position.
    it("gives every entry but the right pane's the left pane's box, hidden ones included", () => {
      const paired = rules.flatMap((r) => r.selectors).filter((sel) => sel.startsWith(pair));
      expect(paired.length).toBeGreaterThan(0);
      for (const selector of paired) expect(selector).not.toContain(".pane-left");
    });

    it.each(GUIDE_ZOOM_STEPS.filter((step) => step !== 100))(
      "enlarges a framed page in either pane by its pane's size at %i",
      (step) => {
        const factor = `0.${step / 10}`;
        for (const side of [":not(.pane-right)", ".pane-right"]) {
          const rule = body(`${pair}.zoom-${step} > .frame${side}`);
          expect(rule).toContain(`width: calc(var(--pane-w, 100%) / ${factor});`);
          expect(rule).toContain(`height: calc(var(--pane-h, 100%) / ${factor});`);
        }
      },
    );

    it.each(["(vertical-viewport-segments: 2)", "(horizontal-viewport-segments: 2)"])(
      "splits the two pages at the hinge too for %s",
      (query) => {
        const block = mediaBlock(query);
        const selectors = selectorsIn(block.slice(block.indexOf("{") + 1, -1));
        expect(selectors).toContain(`${pair} > :not(.pane-right)`);
        expect(selectors).toContain(`${pair} > .pane-right`);
      },
    );
  });
});
