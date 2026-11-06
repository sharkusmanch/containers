import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanCustomLabel,
  cleanLabel,
  CUSTOM_LABEL_MAX,
  cutCustomLabel,
  defaultLabel,
  isKnownName,
  knownLabel,
  LABEL_MAX,
} from "../src/web/labels.js";

describe("knownLabel", () => {
  it.each([
    ["Achievement Checklist", "Checklist"],
    ["Blind Playthrough Essentials", "Blind"],
    ["Notes", "Notes"],
    ["Collectibles", "Collect"],
    ["  achievement   checklist ", "Checklist"],
    ["NOTES", "Notes"],
  ])("maps %s → %s", (title, label) => expect(knownLabel(title)).toBe(label));

  it.each([["Walkthrough"], ["Collectibles: Basalt Hills"], [""], ["constructor"], ["__proto__"]])(
    "has nothing for %j",
    (title) => expect(knownLabel(title)).toBeNull(),
  );
});

describe("defaultLabel", () => {
  it.each([
    ["Achievement Checklist", "Checklist"],
    ["Collectibles: Basalt Hills", "Basalt"],
    ["Walkthrough", "Walkthr…"],
    ["The Lost Bay", "Lost"],
    ["Collectibles:", "Collect"],
    ["  ", "?"],
  ])("%s → %s", (title, label) => expect(defaultLabel(title)).toBe(label));
});

describe("cleanLabel", () => {
  it("is 8 characters at most", () => expect(LABEL_MAX).toBe(8));

  it.each([
    ["Walk", "Walk"],
    [" Bosses ", "Bosses"],
    ["100%", "100%"],
    ["Q & A", "Q & A"],
    ["Tr. Dg's", "Tr. Dg's"],
    ["Épéeéçàü", "Épéeéçàü"],
    ["Walk-1", "Walk-1"],
  ])("keeps %j as %j", (value, label) => expect(cleanLabel(value)).toBe(label));

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "Walkthrou"],
    ["an emoji", "Map🗺"],
    ["a quote", '"Map"'],
    ["a leading dash", "-Map"],
    ["a slash", "A/B"],
    ["a tag", "<b>"],
    ["a number", 12],
    ["null", null],
  ])("refuses %s", (_name, value) => expect(cleanLabel(value)).toBeNull());
});

describe("isKnownName", () => {
  it("is true for the mapping's names in any case, false for others", () => {
    for (const name of ["Checklist", "blind", " NOTES ", "Collect"])
      expect(isKnownName(name)).toBe(true);
    for (const name of ["Walk", "Collectibles", ""]) expect(isKnownName(name)).toBe(false);
  });
});

describe("cleanCustomLabel", () => {
  it("is 12 characters at most", () => expect(CUSTOM_LABEL_MAX).toBe(12));

  it.each([
    ["Walk", "Walk"],
    ["  Boss fights  ", "Boss fights"],
    ["Notes", "Notes"],
    ["<b>A/B</b>", "<b>A/B</b>"],
    ["twelve chars", "twelve chars"],
    ["🎮".repeat(12), "🎮".repeat(12)],
    ["Map 🗺️", "Map 🗺️"],
    ["Épée", "Épée"],
    ["!", "!"],
    ["+", "+"],
    ["\u200bA", "\u200bA"],
  ])("keeps %j as %j", (value, label) => expect(cleanCustomLabel(value)).toBe(label));

  it.each([[""], ["   "], ["\t \n"]])("reads %j as a reset", (value) =>
    expect(cleanCustomLabel(value)).toBe(""),
  );

  it.each([
    ["13 characters", "thirteen char"],
    ["13 emoji", "🎮".repeat(13)],
    ["a control character", "Map\u0007"],
    ["a newline inside", "Boss\nRush"],
    ["a tab inside", "Boss\tRush"],
    ["a NUL", "A\u0000B"],
    ["DEL", "A\u007fB"],
    ["a C1 control", "A\u0085B"],
    ["a line separator", "A\u2028B"],
    ["a lone surrogate", "A\ud800B"],
    ["only a zero-width space", "\u200b"],
    ["only bidi overrides", "\u202e\u202d"],
    ["only a variation selector", "\ufe0f"],
    ["a number", 12],
    ["null", null],
    ["an object", { label: "Walk" }],
  ])("refuses %s", (_name, value) => expect(cleanCustomLabel(value)).toBeNull());
});

describe("cutCustomLabel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps text of 12 characters or fewer as it is", () => {
    expect(cutCustomLabel("abcdefghijkl")).toBe("abcdefghijkl");
    expect(cutCustomLabel("")).toBe("");
  });

  it("cuts on whole characters as shown, counting code points", () => {
    const family = "👨‍👩‍👧";
    expect(cutCustomLabel(`abcdefghij${family}`)).toBe("abcdefghij");
    expect(cutCustomLabel("e\u0301".repeat(7))).toBe("e\u0301".repeat(6));
  });

  it("cuts on code points where the browser has no Intl.Segmenter", () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    expect(cutCustomLabel("🎮".repeat(13))).toBe("🎮".repeat(12));
  });
});
