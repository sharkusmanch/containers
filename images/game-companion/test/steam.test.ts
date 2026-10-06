import { describe, expect, it } from "vitest";
import { SteamClient } from "../src/server/steam.js";
import { fakeFetch, fixture } from "./helpers.js";

const opts = { apiKey: "KEY", steamId: "76561190000000000" };

describe("SteamClient.presence", () => {
  it("reports the app being played", async () => {
    const f = fakeFetch([["GetPlayerSummaries", { body: fixture("steam-summary-ingame.json") }]]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).presence()).toEqual({
      appId: "1000001",
      name: "Test Game",
    });
    expect(f.calls[0]?.url).toContain("steamids=76561190000000000");
  });

  it("reports nulls when not in a game", async () => {
    const f = fakeFetch([["GetPlayerSummaries", { body: fixture("steam-summary-idle.json") }]]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).presence()).toEqual({
      appId: null,
      name: null,
    });
  });

  it("passes a shortcut's oversized id through for the detector to judge", async () => {
    const f = fakeFetch([["GetPlayerSummaries", { body: fixture("steam-summary-shortcut.json") }]]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).presence()).toEqual({
      appId: "15564589419463376896",
      name: "Emulator",
    });
  });

  it("reports nulls when the player list is empty", async () => {
    const f = fakeFetch([["GetPlayerSummaries", { body: '{"response":{"players":[]}}' }]]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).presence()).toEqual({
      appId: null,
      name: null,
    });
  });
});

describe("SteamClient.gameData", () => {
  it("combines player progress, schema and global percentages", async () => {
    const f = fakeFetch([
      ["GetPlayerAchievements", { body: fixture("steam-player-achievements.json") }],
      ["GetSchemaForGame", { body: fixture("steam-schema.json") }],
      ["GetGlobalAchievementPercentagesForApp", { body: fixture("steam-percentages.json") }],
    ]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data?.title).toBe("Test Game");
    expect(data?.player).toHaveLength(3);
    expect(data?.schema[1]?.description).toBeUndefined();
    expect(data?.percents.get("ACH_01")).toBe(92.7);
    expect(data?.percents.has("ACH_03")).toBe(false);
  });

  it("returns null for an app with no achievements", async () => {
    const f = fakeFetch([
      ["GetPlayerAchievements", { status: 400, body: fixture("steam-no-stats.json") }],
      ["GetSchemaForGame", { body: '{"game":{}}' }],
      ["GetGlobalAchievementPercentagesForApp", { status: 403, body: "{}" }],
    ]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("5")).toBeNull();
  });

  it("still returns data when global percentages fail", async () => {
    const f = fakeFetch([
      ["GetPlayerAchievements", { body: fixture("steam-player-achievements.json") }],
      ["GetSchemaForGame", { body: fixture("steam-schema.json") }],
      ["GetGlobalAchievementPercentagesForApp", { status: 500, body: "x" }],
    ]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data?.percents.size).toBe(0);
  });
});
