import { describe, expect, it } from "vitest";
import type { XboxAchievementList, XboxTitleInfo } from "../src/server/xbox.js";
import { formatAchievements, formatTitles, TITLES_MAX } from "../src/server/xbox-tools.js";
import { fixture } from "./helpers.js";

const title = (over: Partial<XboxTitleInfo> & { id: string }): XboxTitleInfo => ({
  name: `Game ${over.id}`,
  isXboxLive: true,
  image: null,
  totalGamerscore: 1000,
  currentGamerscore: 100,
  devices: ["XboxSeries"],
  ...over,
});

describe("formatTitles", () => {
  it("lists one line per game, newest played first, unplayed last", () => {
    const text = formatTitles(
      [
        title({ id: "1", name: "Old", lastPlayed: "2026-01-01T00:00:00.000Z" }),
        title({ id: "2", name: "Never" }),
        title({
          id: "3",
          name: "New",
          lastPlayed: "2026-10-01T09:30:00.000Z",
          devices: ["PC", "XboxSeries"],
          currentGamerscore: 25,
          totalGamerscore: 1500,
        }),
      ],
      undefined,
    );
    expect(text.split("\n")).toEqual([
      "3 | New | PC, XboxSeries | last played 2026-10-01T09:30:00.000Z | 25/1500 G",
      "1 | Old | XboxSeries | last played 2026-01-01T00:00:00.000Z | 100/1000 G",
      "2 | Never | XboxSeries | last played unknown | 100/1000 G",
    ]);
  });

  it("filters by the normalised query, ignoring case, punctuation, quotes and trademark marks", () => {
    const infos = [
      title({ id: "1", name: "Sample Wars: E-Day™" }),
      title({ id: "2", name: "Sample Racer" }),
      title({ id: "3", name: "Knight’s Quest" }),
    ];
    expect(formatTitles(infos, "sample WARS e day")).toBe(
      "1 | Sample Wars: E-Day™ | XboxSeries | last played unknown | 100/1000 G",
    );
    expect(formatTitles(infos, "KNIGHT'S").split("\n")).toHaveLength(1);
    expect(formatTitles(infos, "sample").split("\n")).toHaveLength(2);
    expect(formatTitles(infos, "nothing like it")).toBe("No Xbox titles match that query.");
    expect(formatTitles(infos, "™!")).toBe("No Xbox titles match that query.");
  });

  it("puts no pipe inside a field: a | in a name becomes /", () => {
    expect(formatTitles([title({ id: "1", name: "Left | Right" })], undefined)).toBe(
      "1 | Left / Right | XboxSeries | last played unknown | 100/1000 G",
    );
  });

  it("leaves out apps and non-Xbox-Live programs", () => {
    expect(formatTitles([title({ id: "1", isXboxLive: false })], undefined)).toBe(
      "No Xbox titles found.",
    );
    expect(formatTitles([], undefined)).toBe("No Xbox titles found.");
  });

  it("caps the list at 50 and says so", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      title({ id: String(i), lastPlayed: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }),
    );
    const lines = formatTitles(many, undefined).split("\n");
    expect(TITLES_MAX).toBe(50);
    expect(lines).toHaveLength(51);
    expect(lines[0]).toMatch(/^59 \|/);
    expect(lines[49]).toMatch(/^10 \|/);
    expect(lines[50]).toBe("(showing 50 of 60; pass a query to narrow)");
  });

  it("keeps each title on one line", () => {
    expect(formatTitles([title({ id: "1", name: "Two\nLines\t here" })], undefined)).toContain(
      "1 | Two Lines here |",
    );
  });
});

describe("formatAchievements", () => {
  const list = JSON.parse(fixture("xbox-achievements.json")) as XboxAchievementList;

  it("gives a header and every field of every achievement, secret ones included", () => {
    const text = formatAchievements(
      "2000000002",
      list,
      title({ id: "2000000002", name: "Test Quest" }),
    );
    expect(text.split("\n")).toEqual([
      "Test Quest | 15/95 G",
      "1 | First Steps | 2026-10-12T01:02:03.456Z | 92.7% | 15 G | not secret | no progress | Take your first step on the Moon. | locked: Take your first step on the Moon.",
      "2 | Rock Collector | locked | 12.3% | 30 G | not secret | progress 3/10 | Collect 10 moon rocks. | locked: Collect 10 moon rocks.",
      "3 | The Far Side | locked | 1% | 50 G | secret | no progress | Find the hidden base on the far side. | locked: This achievement is a secret.",
    ]);
  });

  it("falls back to the title id when the title is not in the history", () => {
    expect(formatAchievements("77", list, null).split("\n")[0]).toBe("Xbox title 77 | 15/95 G");
  });

  it("marks missing text and rarity instead of leaving blanks", () => {
    const sparse: XboxAchievementList = {
      achievements: [{ id: 9, name: "Bare", progressState: "Achieved", progression: {} }],
    };
    expect(formatAchievements("5", sparse, null).split("\n")[1]).toBe(
      "9 | Bare | unlocked | ?% | 0 G | not secret | no progress | - | locked: -",
    );
  });

  it("explains an empty list (a game never launched on the account)", () => {
    const fresh = title({ id: "5", name: "Fresh", totalGamerscore: 0, currentGamerscore: 0 });
    const launchOnce =
      "Fresh: no achievements listed. If the game has never been launched on this account, launch it once and try again.";
    expect(formatAchievements("5", { achievements: [] }, fresh)).toBe(launchOnce);
    const noScore: XboxTitleInfo = { id: "5", name: "Fresh", isXboxLive: true, image: null };
    expect(formatAchievements("5", { achievements: [] }, noScore)).toBe(launchOnce);
    expect(formatAchievements("5", { achievements: [] }, null)).toBe(
      "Xbox title 5: no achievements listed. If the game has never been launched on this account, launch it once and try again.",
    );
  });

  it("says there is no list when the title has Gamerscore but no achievements are listed", () => {
    expect(formatAchievements("5", { achievements: [] }, title({ id: "5", name: "Old" }))).toBe(
      "Xbox has no achievement list for this title (it may be an Xbox 360 game).",
    );
  });

  it("puts no pipe inside a field: names and descriptions turn | into /", () => {
    const piped: XboxAchievementList = {
      achievements: [
        {
          id: "4",
          name: "Either | Or",
          description: "Pick A | B.",
          lockedDescription: "Choose | wisely.",
          progressState: "NotStarted",
        },
      ],
    };
    expect(
      formatAchievements("6", piped, title({ id: "6", name: "Pipe | Dream" })).split("\n"),
    ).toEqual([
      "Pipe / Dream | 0/0 G",
      "4 | Either / Or | locked | ?% | 0 G | not secret | no progress | Pick A / B. | locked: Choose / wisely.",
    ]);
  });
});
