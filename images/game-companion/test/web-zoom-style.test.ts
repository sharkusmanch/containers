import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUIDE_ZOOM_STEPS } from "../src/web/device.js";

const css = readFileSync(new URL("../web-static/style.css", import.meta.url), "utf8");

/** A consistency check, not a CSS engine: strips comments and splits on the closing brace. */
const rules = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("}")
  .map((chunk) => chunk.split("{"))
  .filter((parts): parts is [string, string] => parts.length === 2)
  .map(([selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    body: body.replace(/\s+/g, " ").trim(),
  }));

const zoomRules = rules.filter((r) => /^\.frames\.zoom-\d+ \.frame$/.test(r.selector));

describe("the guide text size stylesheet rules", () => {
  it("has one rule per size other than 100 and none for another size", () => {
    const wanted = GUIDE_ZOOM_STEPS.filter((step) => step !== 100).map(
      (step) => `.frames.zoom-${step} .frame`,
    );
    expect(zoomRules.map((r) => r.selector).sort()).toEqual(wanted.sort());
  });

  it.each(GUIDE_ZOOM_STEPS.filter((step) => step !== 100))(
    "enlarges the frame and scales it back by the matching factor at %i",
    (step) => {
      const rule = zoomRules.find((r) => r.selector === `.frames.zoom-${step} .frame`);
      const factor = `0.${step / 10}`;
      expect(rule).toBeDefined();
      expect(rule?.body).toContain(`width: calc(100% / ${factor});`);
      expect(rule?.body).toContain(`height: calc(100% / ${factor});`);
      expect(rule?.body).toContain(`transform: scale(${factor});`);
      expect(rule?.body).toContain("transform-origin: 0 0;");
      expect(rule?.body).toContain("right: auto;");
      expect(rule?.body).toContain("bottom: auto;");
    },
  );

  it("clips the stage so the enlarged frame cannot overflow it", () => {
    const frames = rules.find((r) => r.selector === ".frames");
    expect(frames?.body).toContain("overflow: hidden;");
  });
});

describe("the find highlight rule", () => {
  it("is in the stylesheet, since the reader may not inject one", () => {
    const rule = rules.find((r) => r.selector === "::highlight(gc-find)");
    expect(rule?.body).toContain("background: #ffd54a;");
    expect(rule?.body).toContain("color: #111;");
  });
});

describe("the guide reader rules", () => {
  it.each(GUIDE_ZOOM_STEPS.filter((step) => step !== 100))(
    "sizes the reader's text by font-size, never by a transform, at %i",
    (step) => {
      const rule = rules.find((r) => r.selector === `.frames.zoom-${step} .reader`);
      expect(rule?.body).toContain(`font-size: ${step}%;`);
      expect(rule?.body).not.toContain("transform");
    },
  );

  it("has no other reader text size rule", () => {
    const sized = rules.filter((r) => /^\.frames\.zoom-\d+ \.reader$/.test(r.selector));
    expect(sized).toHaveLength(GUIDE_ZOOM_STEPS.length - 1);
  });

  it("gives a checkbox a hit area of at least 44 by 44 pixels", () => {
    const rule = rules.find((r) => r.selector === ".reader .cb");
    expect(rule?.body).toContain("min-width: 44px;");
    expect(rule?.body).toContain("min-height: 44px;");
  });

  it("is a scroll container of its own, kept in the layout while hidden", () => {
    const reader = rules.find((r) => r.selector === ".reader");
    expect(reader?.body).toContain("overflow-y: auto;");
    const inactive = rules.find((r) => r.selector === ".reader.inactive");
    expect(inactive?.body).toContain("visibility: hidden;");
    expect(inactive?.body).not.toContain("display");
  });

  it("styles a row by the box's checked state, not by the item's class", () => {
    expect(rules.some((r) => r.selector.includes('.cb[aria-checked="true"]'))).toBe(true);
    expect(rules.some((r) => r.selector.includes(".cb-item.checked"))).toBe(false);
  });
});
