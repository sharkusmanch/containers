import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/server/fetch-json.js";
import { parseRaDate, RaClient } from "../src/server/ra.js";
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

describe("RaClient", () => {
  it("summarises the last game and its presence time", async () => {
    const f = fakeFetch([["API_GetUserSummary", { body: fixture("ra-summary.json") }]]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).summary()).toEqual({
      gameId: "30002",
      title: "Test Quest",
      presenceAt: Date.UTC(2026, 0, 3, 4, 5, 6),
    });
    expect(f.calls[0]?.url).toContain("u=tester");
  });

  it("reports nulls for an account that has played nothing", async () => {
    const f = fakeFetch([["API_GetUserSummary", { body: fixture("ra-summary-empty.json") }]]);
    expect(await new RaClient({ ...opts, fetchFn: f.fn }).summary()).toEqual({
      gameId: null,
      title: null,
      presenceAt: null,
    });
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
