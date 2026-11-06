import { describe, expect, it } from "vitest";
import { cleanLabel, defaultLabel, isKnownName, knownLabel, LABEL_MAX } from "../src/web/labels.js";

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
