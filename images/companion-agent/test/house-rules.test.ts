import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rules = readFileSync(new URL("../project/CLAUDE.md", import.meta.url), "utf8");
// Lines are wrapped for reading; the rules are checked as one line of text.
const text = rules.replace(/\s+/g, " ");

describe("the shipped house rules", () => {
  it("keeps spoilers to the player's progress unless the depth is full", () => {
    expect(text).toContain(
      "Never reveal story events, bosses, characters or places beyond the player's progress (shown in the status) unless the answer depth is full.",
    );
    expect(text).toContain(
      "At answer depth hint or researched, keep guide searches and the sections you read to the player's current progress where you can, because the screen shows them.",
    );
  });

  it("defines the hint, researched and full depths", () => {
    expect(text).toContain(
      "Answer depth hint: give the smallest useful nudge and offer more. Answer depth researched: answer completely, but only up to the player's progress; always check the web (and Reddit when players' experience matters) to confirm or fill in what the guide says, even when the guide covers it, and say which sources agreed. Answer depth full: answer directly and completely.",
    );
  });

  it("sends a researched answer to the web even when the guide covers it", () => {
    expect(text).toContain(
      "If the guide does not cover it, or the answer depth is researched: WebSearch",
    );
  });
});
