import { describe, expect, it } from "vitest";
import {
  buildContext,
  buildMessages,
  type ContextInput,
  INSTRUCTIONS,
} from "../src/server/assistant-context.js";
import type { PageText } from "../src/server/guide-pages.js";
import type { Achievement, AchievementsResponse } from "../src/shared/types.js";

const page = (title: string, text: string): PageText => ({
  id: title.toLowerCase().replace(/\s+/g, "-"),
  title,
  url: `/doc/${title}`,
  text,
});

const ach = (id: string, over: Partial<Achievement> = {}): Achievement => ({
  id,
  name: `Name ${id}`,
  description: `Desc ${id}`,
  icon: null,
  unlocked: false,
  unlockedAt: null,
  unlockPercent: null,
  hidden: false,
  missable: false,
  kind: null,
  ...over,
});

const response = (achievements: Achievement[], unlocked = 3): AchievementsResponse => ({
  source: "ra",
  id: "1",
  title: "Lantern Vale",
  total: 10,
  unlocked,
  stale: false,
  achievements,
});

const PAGES = [
  page("Notes", "note text"),
  page("Achievement Checklist", "check text"),
  page("Walkthrough", "walk text"),
];

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  gameTitle: "Lantern Vale",
  platformLabel: "RA · GC",
  playState: "playing",
  presence: "In the Glass Garden",
  achievements: null,
  missableNames: [],
  where: null,
  pages: PAGES,
  pinnedTitles: [],
  guideChars: 100_000,
  ...over,
});

const guideOf = (system: string): string => system.slice(system.indexOf("# Guide\n\n"));

describe("buildContext guide", () => {
  it("renders each page as a heading, a blank line, the text and a blank line", () => {
    const { system } = buildContext(input());
    expect(guideOf(system)).toBe(
      "# Guide\n\n## Notes\n\nnote text\n\n## Achievement Checklist\n\ncheck text\n\n## Walkthrough\n\nwalk text\n\n",
    );
  });

  it("puts pinned pages first in pinnedTitles order, then the rest in tree order", () => {
    const { system } = buildContext(
      input({ pinnedTitles: ["Walkthrough", "Achievement Checklist"] }),
    );
    const titles = [...guideOf(system).matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(titles).toEqual(["Walkthrough", "Achievement Checklist", "Notes"]);
  });

  it("starts with the instructions and is byte-stable for equal inputs", () => {
    const a = buildContext(input());
    const b = buildContext(input());
    expect(a.system.startsWith(INSTRUCTIONS)).toBe(true);
    expect(a.system === b.system).toBe(true);
  });

  it("changes when a page's text changes", () => {
    const a = buildContext(input());
    const b = buildContext(
      input({ pages: [PAGES[0]!, page("Achievement Checklist", "other"), PAGES[2]!] }),
    );
    expect(a.system).not.toBe(b.system);
  });

  it("does not depend on the status", () => {
    const a = buildContext(input());
    const b = buildContext(input({ presence: "Elsewhere", playState: "last-played" }));
    expect(a.system === b.system).toBe(true);
  });

  it("is not truncated with a big budget", () => {
    const ctx = buildContext(input());
    expect(ctx.truncatedGuide).toBe(false);
    expect(ctx.system).not.toContain("The guide below is incomplete.");
    expect(ctx.system).not.toContain("[guide cut here]");
  });

  it("cuts the overflowing page at the last newline that fits and drops later pages", () => {
    const pages = [page("One", "aaa"), page("Two", "line1\nline2\nline3"), page("Three", "zzz")];
    const first = "## One\n\naaa\n\n";
    // Room for the second page's heading, "line1" and a few characters of "line2".
    const budget = first.length + "## Two\n\nline1\nlin".length;
    const ctx = buildContext(input({ pages, guideChars: budget }));
    expect(ctx.truncatedGuide).toBe(true);
    expect(guideOf(ctx.system)).toBe(`# Guide\n\n${first}## Two\n\nline1\n[guide cut here]\n`);
    expect(ctx.system).not.toContain("Three");
    expect(ctx.system).toContain("The guide below is incomplete.");
  });

  it("cuts a page with no newline that fits down to its heading", () => {
    const pages = [page("One", "aaa bbb")];
    const ctx = buildContext(input({ pages, guideChars: 5 }));
    expect(ctx.truncatedGuide).toBe(true);
    expect(guideOf(ctx.system)).toBe("# Guide\n\n\n[guide cut here]\n");
  });

  it("counts only the rendered pages against the budget", () => {
    const rendered = PAGES.map((p) => `## ${p.title}\n\n${p.text}\n\n`).join("");
    expect(buildContext(input({ guideChars: rendered.length })).truncatedGuide).toBe(false);
    expect(buildContext(input({ guideChars: rendered.length - 1 })).truncatedGuide).toBe(true);
  });
});

describe("buildContext statusBlock", () => {
  const lines = (s: string): string[] => s.split("\n");
  const full = (): ContextInput =>
    input({
      achievements: response(
        [
          ach("1", { name: "Lamp Lit", description: "Light the lamp", unlocked: true }),
          ach("2", { name: "Rare Bloom", description: "Pick the bloom", missable: true }),
          ach("3", { name: "Late Gift", description: "Give the gift" }),
          ach("4", { name: "Secret Door", description: "Find the door", hidden: true }),
          ach("5", {
            name: "Hidden Story",
            description: "Secret story",
            hidden: true,
            kind: "progression",
          }),
          ach("6", { name: "Gate One", description: "Open gate", kind: "progression" }),
          ach("7", { name: "Gate Two", description: "Open gate two", kind: "progression" }),
          ach("8", { name: "Gate Three", description: null, kind: "progression" }),
          ach("9", { name: "Gate Four", description: "Open four", kind: "progression" }),
          ach("10", { name: "Gate Five", description: "Open five", kind: "progression" }),
          ach("11", { name: "Gate Six", description: "Open six", kind: "win" }),
          ach("12", {
            name: "Done Gate",
            description: "done",
            kind: "progression",
            unlocked: true,
          }),
        ],
        3,
      ),
      missableNames: ["late gift"],
      where: { pageTitle: "Walkthrough", heading: "Glass Garden" },
    });

  it("lists the facts in order", () => {
    const { statusBlock } = buildContext(full());
    const ls = lines(statusBlock);
    const at = (prefix: string): number => ls.findIndex((l) => l.startsWith(prefix));
    expect(ls[0]).toBe("Game: Lantern Vale (RA · GC)");
    expect(ls[1]).toBe("State: playing");
    expect(ls[2]).toBe("Status line: In the Glass Garden");
    expect(ls[3]).toBe("Achievements: 3/10 unlocked");
    expect(at("Missables still open:")).toBeGreaterThan(3);
    expect(at("Next story achievements:")).toBeGreaterThan(at("Missables still open:"));
    expect(ls[ls.length - 1]).toBe(
      "Guide section matching the status line: Walkthrough › Glass Garden",
    );
  });

  it("lists locked missables by flag or by guide mark, with descriptions", () => {
    const { statusBlock } = buildContext(full());
    expect(statusBlock).toContain(
      "Missables still open:\n- Rare Bloom — Pick the bloom\n- Late Gift — Give the gift\n",
    );
  });

  it("lists up to five locked story achievements in array order", () => {
    const { statusBlock } = buildContext(full());
    const list = statusBlock.slice(statusBlock.indexOf("Next story achievements:"));
    expect(list).toContain(
      "- Gate One — Open gate\n- Gate Two — Open gate two\n- Gate Three\n- Gate Four — Open four\n- Gate Five — Open five\n",
    );
    expect(statusBlock).not.toContain("Gate Six");
    expect(statusBlock).not.toContain("Done Gate");
  });

  it("never reveals hidden locked achievements, only their count", () => {
    const { statusBlock } = buildContext(full());
    for (const secret of ["Secret Door", "Find the door", "Hidden Story", "Secret story"]) {
      expect(statusBlock).not.toContain(secret);
    }
    expect(statusBlock).toContain("Hidden achievements still locked: 2");
  });

  it("omits the hidden line when none are locked", () => {
    const { statusBlock } = buildContext(
      input({ achievements: response([ach("1", { hidden: true, unlocked: true })]) }),
    );
    expect(statusBlock).not.toContain("Hidden achievements still locked");
  });

  it("omits the list headings when there is nothing to list", () => {
    const { statusBlock } = buildContext(input({ achievements: response([ach("1")]) }));
    expect(statusBlock).not.toContain("Missables still open:");
    expect(statusBlock).not.toContain("Next story achievements:");
  });

  it("says unknown without achievements and lists nothing", () => {
    const { statusBlock } = buildContext(input({ missableNames: ["late gift"] }));
    expect(statusBlock).toContain("Achievements: unknown");
    expect(statusBlock).not.toContain("Missables still open:");
    expect(statusBlock).not.toContain("Next story achievements:");
    expect(statusBlock).not.toContain("Hidden achievements");
  });

  it("omits the status line and the guide section when absent", () => {
    const { statusBlock } = buildContext(input({ presence: null, playState: "last-played" }));
    expect(statusBlock).toContain("State: last-played");
    expect(statusBlock).not.toContain("Status line:");
    expect(statusBlock).not.toContain("Guide section matching");
  });
});

describe("buildMessages", () => {
  it("replays history as plain turns, then the status, depth and question", () => {
    const ctx = buildContext(input());
    const msgs = buildMessages(
      ctx,
      [
        { question: "q1", answer: "a1" },
        { question: "q2", answer: "a2" },
      ],
      "q3",
      "hint",
    );
    expect(msgs).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: `${ctx.statusBlock}\n\nAnswer depth: hint\n\nQuestion: q3` },
    ]);
  });

  it("sends only the final turn without history and honours full depth", () => {
    const ctx = buildContext(input());
    expect(buildMessages(ctx, [], "where?", "full")).toEqual([
      { role: "user", content: `${ctx.statusBlock}\n\nAnswer depth: full\n\nQuestion: where?` },
    ]);
  });
});
