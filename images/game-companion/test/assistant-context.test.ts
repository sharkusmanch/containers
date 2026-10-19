import { describe, expect, it } from "vitest";
import {
  buildStatusBlock,
  type ContextInput,
  INSTRUCTIONS,
} from "../src/server/assistant-context.js";
import type { Achievement, AchievementsResponse } from "../src/shared/types.js";

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

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  gameTitle: "Lantern Vale",
  platformLabel: "RA · GC",
  playState: "playing",
  presence: "In the Glass Garden",
  achievements: null,
  missableNames: [],
  where: null,
  ...over,
});

describe("buildStatusBlock", () => {
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
    const statusBlock = buildStatusBlock(full());
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
    const statusBlock = buildStatusBlock(full());
    expect(statusBlock).toContain(
      "Missables still open:\n- Rare Bloom — Pick the bloom\n- Late Gift — Give the gift\n",
    );
  });

  it("lists up to five locked story achievements in array order", () => {
    const statusBlock = buildStatusBlock(full());
    const list = statusBlock.slice(statusBlock.indexOf("Next story achievements:"));
    expect(list).toContain(
      "- Gate One — Open gate\n- Gate Two — Open gate two\n- Gate Three\n- Gate Four — Open four\n- Gate Five — Open five\n",
    );
    expect(statusBlock).not.toContain("Gate Six");
    expect(statusBlock).not.toContain("Done Gate");
  });

  it("never reveals hidden locked achievements, only their count", () => {
    const statusBlock = buildStatusBlock(full());
    for (const secret of ["Secret Door", "Find the door", "Hidden Story", "Secret story"]) {
      expect(statusBlock).not.toContain(secret);
    }
    expect(statusBlock).toContain("Hidden achievements still locked: 2");
  });

  it("omits the hidden line when none are locked", () => {
    const statusBlock = buildStatusBlock(
      input({ achievements: response([ach("1", { hidden: true, unlocked: true })]) }),
    );
    expect(statusBlock).not.toContain("Hidden achievements still locked");
  });

  it("omits the list headings when there is nothing to list", () => {
    const statusBlock = buildStatusBlock(input({ achievements: response([ach("1")]) }));
    expect(statusBlock).not.toContain("Missables still open:");
    expect(statusBlock).not.toContain("Next story achievements:");
  });

  it("says unknown without achievements and lists nothing", () => {
    const statusBlock = buildStatusBlock(input({ missableNames: ["late gift"] }));
    expect(statusBlock).toContain("Achievements: unknown");
    expect(statusBlock).not.toContain("Missables still open:");
    expect(statusBlock).not.toContain("Next story achievements:");
    expect(statusBlock).not.toContain("Hidden achievements");
  });

  it("omits the status line and the guide section when absent", () => {
    const statusBlock = buildStatusBlock(input({ presence: null, playState: "last-played" }));
    expect(statusBlock).toContain("State: last-played");
    expect(statusBlock).not.toContain("Status line:");
    expect(statusBlock).not.toContain("Guide section matching");
  });
});

describe("INSTRUCTIONS", () => {
  it("sends the agent to the status given, then the player's guide through the companion tools", () => {
    expect(INSTRUCTIONS).toContain("status block");
    for (const tool of [
      "companion_status",
      "list_guides",
      "guide_outline",
      "search_guide",
      "read_guide_page",
    ]) {
      expect(INSTRUCTIONS).toContain(tool);
    }
    expect(INSTRUCTIONS).toContain("before any other source");
    expect(INSTRUCTIONS).toContain("guide id");
    expect(INSTRUCTIONS).not.toContain("pinned pages below");
  });

  it("names the other tools: read-only services, the web, and the shell for skills", () => {
    for (const name of ["RetroAchievements", "RomM", "Syncthing", "Outline", "redlib"]) {
      expect(INSTRUCTIONS).toContain(name);
    }
    expect(INSTRUCTIONS).toContain("web search");
    expect(INSTRUCTIONS).toContain("web fetch");
    expect(INSTRUCTIONS).toContain("shell");
  });

  it("keeps the answer style, sourcing and depth rules", () => {
    expect(INSTRUCTIONS).toContain("Plain text only");
    expect(INSTRUCTIONS).toContain("came from the guide, the web, or your own memory");
    expect(INSTRUCTIONS).toContain("Do not describe your lookups");
    expect(INSTRUCTIONS).toContain(
      "Answer depth hint: give the smallest useful nudge and offer more. Answer depth full: answer directly and completely.",
    );
  });

  it("keeps hint-depth lookups to the player's progress, right after the spoiler rule", () => {
    const rows = INSTRUCTIONS.split("\n");
    const spoiler = rows.findIndex((r) => r.startsWith("- Never reveal story events"));
    expect(spoiler).toBeGreaterThan(0);
    expect(rows[spoiler + 1]).toBe(
      "- At answer depth hint, keep guide searches and the sections you read to the player's current progress where you can, because the screen shows them.",
    );
  });

  it("names the Xbox source and device, with Gamerscore after the achievements", () => {
    const xbox = {
      ...response([ach("1")], 1),
      source: "xbox" as const,
      gamerscore: { current: 25, total: 150 },
    };
    const ls = buildStatusBlock(
      input({ platformLabel: "Xbox", xbox: { device: "Series X" }, achievements: xbox }),
    ).split("\n");
    expect(ls.slice(0, 5)).toEqual([
      "Game: Lantern Vale (Xbox)",
      "Source: Xbox (Series X)",
      "State: playing",
      "Status line: In the Glass Garden",
      "Achievements: 1/10 unlocked",
    ]);
    expect(ls[5]).toBe("Gamerscore: 25/150");
  });

  it("leaves out the device when unknown and the Gamerscore when not given", () => {
    const statusBlock = buildStatusBlock(
      input({ xbox: { device: null }, achievements: response([ach("1")]) }),
    );
    expect(statusBlock).toContain("Source: Xbox\n");
    expect(statusBlock).not.toContain("Gamerscore");
    expect(buildStatusBlock(input())).not.toContain("Source:");
  });

  it("counts locked secret Xbox achievements without naming them", () => {
    const statusBlock = buildStatusBlock(
      input({
        xbox: { device: "PC" },
        achievements: {
          ...response([
            ach("1", { name: "Quiet Moon", description: "Find the moon", hidden: true }),
            ach("2", { name: "Open Gate", description: "Open it", kind: "progression" }),
          ]),
          source: "xbox",
          gamerscore: { current: 0, total: 30 },
        },
      }),
    );
    expect(statusBlock).not.toContain("Quiet Moon");
    expect(statusBlock).not.toContain("Find the moon");
    expect(statusBlock).toContain("Hidden achievements still locked: 1");
    expect(statusBlock).toContain("- Open Gate — Open it");
  });
});
