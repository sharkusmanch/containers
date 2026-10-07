import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/server/fetch-json.js";
import { cleanPresence, parseRaDate, RaClient } from "../src/server/ra.js";
import { fakeFetch, fixture } from "./helpers.js";

const opts = { apiKey: "KEY", username: "tester" };

describe("parseRaDate", () => {
  it("reads the timestamp as UTC", () => {
    expect(parseRaDate("2026-01-03 04:05:06")).toBe(Date.UTC(2026, 0, 3, 4, 5, 6));
  });
  it("returns NaN for junk", () => {
    expect(parseRaDate("soon")).toBeNaN();
  });
});

describe("cleanPresence", () => {
  it("keeps plain text", () => {
    expect(cleanPresence("Exploring the Sample Caves")).toBe("Exploring the Sample Caves");
  });
  it("turns tabs, newlines, non-breaking spaces and control characters into single spaces", () => {
    expect(cleanPresence("a\tb\nc\u00a0d\u0000e\u007ff\u0085g\u009fh")).toBe("a b c d e f g h");
    expect(cleanPresence("a \t\n\u00a0 b")).toBe("a b");
  });
  it("trims", () => {
    expect(cleanPresence("  \n Level 3 \t")).toBe("Level 3");
  });
  it("returns a line of up to 300 code points whole, with no ellipsis", () => {
    expect(cleanPresence("a".repeat(300))).toBe("a".repeat(300));
    expect(cleanPresence("a".repeat(200))).toBe("a".repeat(200));
  });
  it("cuts a longer line to 299 code points and marks the cut with an ellipsis", () => {
    const cut = cleanPresence("a".repeat(301));
    expect(cut).toBe("a".repeat(299) + "\u2026");
    expect([...(cut ?? "")]).toHaveLength(300);
  });
  it("leaves no space before the ellipsis when the cut lands after a space", () => {
    expect(cleanPresence("a".repeat(298) + " bcd")).toBe("a".repeat(298) + "\u2026");
  });
  it("never splits a surrogate pair when cutting", () => {
    expect(cleanPresence("a".repeat(299) + "\u{1F600}" + "tail")).toBe("a".repeat(299) + "\u2026");
    const kept = cleanPresence("a".repeat(298) + "\u{1F600}" + "tail");
    expect(kept).toBe("a".repeat(298) + "\u{1F600}\u2026");
    expect([...(kept ?? "")]).toHaveLength(300);
  });
  it("gives null, not a lone ellipsis, for a long line of invisible characters", () => {
    expect(cleanPresence("\u200b".repeat(400))).toBeNull();
  });
  it("gives null for empty and white-space-only text", () => {
    expect(cleanPresence("")).toBeNull();
    expect(cleanPresence(" \t\n\u00a0\u0000 ")).toBeNull();
  });
  it("gives null when nothing visible remains", () => {
    for (const v of [
      "\u200b",
      "\u202e\u200e",
      "\u3164",
      "\u2800 \u2800",
      "\u115f\u1160",
      "\u2028",
    ]) {
      expect(cleanPresence(v)).toBeNull();
    }
  });
  it("keeps invisible characters inside a line that has visible text", () => {
    expect(cleanPresence("A\u200bB")).toBe("A\u200bB");
    expect(cleanPresence("\u{1F468}\u200d\u{1F469}")).toBe("\u{1F468}\u200d\u{1F469}");
  });
  it("gives null for anything that is not a string", () => {
    for (const v of [42, null, undefined, {}, ["x"], true]) expect(cleanPresence(v)).toBeNull();
  });
});

describe("RaClient", () => {
  it("summarises the last game and its presence time", async () => {
    const f = fakeFetch([["API_GetUserSummary", { body: fixture("ra-summary.json") }]]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).summary()).toEqual({
      gameId: "30002",
      title: "Test Quest",
      presenceAt: Date.UTC(2026, 0, 3, 4, 5, 6),
      presence: "Exploring",
    });
    expect(f.calls[0]?.url).toContain("u=tester");
  });

  it("reports nulls for an account that has played nothing", async () => {
    const f = fakeFetch([["API_GetUserSummary", { body: fixture("ra-summary-empty.json") }]]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).summary()).toEqual({
      gameId: null,
      title: null,
      presenceAt: null,
      presence: null,
    });
  });

  it("gives a null presence, without failing, when the response has no such field", async () => {
    const f = fakeFetch([
      [
        "API_GetUserSummary",
        { body: JSON.stringify({ LastGameID: 30002, LastGame: { Title: "Test Quest" } }) },
      ],
    ]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).summary()).toEqual({
      gameId: "30002",
      title: "Test Quest",
      presenceAt: null,
      presence: null,
    });
  });

  it("cleans the presence it returns", async () => {
    const f = fakeFetch([
      [
        "API_GetUserSummary",
        { body: JSON.stringify({ LastGameID: 1, RichPresenceMsg: "  Chapter\t2\n " }) },
      ],
    ]);
    expect((await new RaClient({ ...opts, fetchFn: f.fn }).summary()).presence).toBe("Chapter 2");
  });

  it("returns game progress with achievements in display order", async () => {
    const f = fakeFetch([
      ["API_GetGameInfoAndUserProgress", { body: fixture("ra-game-progress.json") }],
    ]);
    const g = await new RaClient({ ...opts, fetchFn: f.fn }).gameProgress("30002");
    expect(g?.title).toBe("Test Quest");
    expect(g?.distinctPlayers).toBe(1000);
    expect(g?.achievements.map((a) => a.ID)).toEqual([1, 2, 3, 4]);
    expect(f.calls[0]?.url).toContain("g=30002");
  });

  it("returns null when the game has no achievements", async () => {
    const f = fakeFetch([
      ["API_GetGameInfoAndUserProgress", { body: fixture("ra-game-empty.json") }],
    ]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).gameProgress("9")).toBeNull();
  });

  it("returns null for a game id RetroAchievements does not know", async () => {
    const f = fakeFetch([
      ["API_GetGameInfoAndUserProgress", { body: fixture("ra-game-unknown.json") }],
    ]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).gameProgress("99999")).toBeNull();
  });

  it("still throws for a response that has the fields but is malformed", async () => {
    const f = fakeFetch([
      [
        "API_GetGameInfoAndUserProgress",
        { body: '{"Title":5,"ConsoleName":"NES","NumDistinctPlayers":0,"Achievements":{}}' },
      ],
    ]);
    await expect(new RaClient({ ...opts, fetchFn: f.fn }).gameProgress("1")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});
