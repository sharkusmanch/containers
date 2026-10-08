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
