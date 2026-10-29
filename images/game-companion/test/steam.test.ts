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

describe("SteamClient.gameData achievement groups", () => {
  const base: [string, { status?: number; body: string }][] = [
    ["GetPlayerAchievements", { body: fixture("steam-player-achievements.json") }],
    ["GetSchemaForGame", { body: fixture("steam-schema.json") }],
    ["GetGlobalAchievementPercentagesForApp", { body: fixture("steam-percentages.json") }],
  ];

  it("reads each achievement's group and the groups from GetGameAchievements", async () => {
    const f = fakeFetch([
      ...base,
      ["GetGameAchievements", { body: fixture("steam-game-achievements.json") }],
    ]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data?.groups?.byName).toEqual(
      new Map([
        ["ACH_01", 0],
        ["ACH_02", 1],
        ["ACH_03", 2],
      ]),
    );
    expect(data?.groups?.groups).toEqual([
      { groupId: 0, name: "", order: 0, isPublic: true, developerOnly: false },
      {
        groupId: 1,
        name: "Test Game: Hot Wheels",
        order: 0,
        isPublic: true,
        developerOnly: false,
      },
      {
        groupId: 2,
        name: "Test Game: Rally Adventure",
        order: 0,
        isPublic: true,
        developerOnly: false,
      },
    ]);
    const call = f.calls.find((c) => c.url.includes("GetGameAchievements"));
    expect(call?.url).toContain(
      "https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/?",
    );
    expect(call?.url).toContain("appid=1000001");
    expect(call?.url).toContain("language=english");
    expect(call?.url).toContain("key=KEY");
  });

  it("leaves groups out, and the rest as before, when GetGameAchievements fails", async () => {
    const f = fakeFetch([...base, ["GetGameAchievements", { status: 500, body: "x" }]]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data).not.toBeNull();
    expect(data && "groups" in data).toBe(false);
    expect(data?.player).toHaveLength(3);
    expect(data?.schema).toHaveLength(3);
    expect(data?.percents.get("ACH_01")).toBe(92.7);
  });

  it.each([
    ["no response", "{}"],
    ["no lists", '{"response":{}}'],
    ["a list that is not an array", '{"response":{"achievements":{},"groups":[]}}'],
    ["invalid JSON", "not json"],
  ])("leaves groups out for a malformed answer: %s", async (_label, body) => {
    const f = fakeFetch([...base, ["GetGameAchievements", { body }]]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data && "groups" in data).toBe(false);
    expect(data?.title).toBe("Test Game");
  });

  it("skips malformed entries and fills defaults for a group's missing optional fields", async () => {
    const body = JSON.stringify({
      response: {
        achievements: [
          { internal_name: "ACH_01", groupid: 0 },
          { internal_name: "ACH_02" },
          { groupid: 1 },
          null,
          { internal_name: "ACH_03", groupid: 1 },
        ],
        groups: [{ groupid: 0 }, { localized_name: "no id" }, "x", { groupid: 1, ispublic: true }],
      },
    });
    const f = fakeFetch([...base, ["GetGameAchievements", { body }]]);
    const data = await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("1000001");
    expect(data?.groups?.byName).toEqual(
      new Map([
        ["ACH_01", 0],
        ["ACH_03", 1],
      ]),
    );
    expect(data?.groups?.groups).toEqual([
      { groupId: 0, name: "", order: 0, isPublic: false, developerOnly: false },
      { groupId: 1, name: "", order: 0, isPublic: true, developerOnly: false },
    ]);
  });

  it("does not let a GetGameAchievements failure stand in for a missing schema", async () => {
    const f = fakeFetch([
      ["GetPlayerAchievements", { status: 400, body: fixture("steam-no-stats.json") }],
      ["GetSchemaForGame", { body: '{"game":{}}' }],
      ["GetGlobalAchievementPercentagesForApp", { status: 403, body: "{}" }],
      ["GetGameAchievements", { body: fixture("steam-game-achievements.json") }],
    ]);
    expect(await new SteamClient({ ...opts, fetchFn: f.fn }).gameData("5")).toBeNull();
  });
});

describe("SteamClient.gameData group cache", () => {
  const routes = (groups: { status?: number; body: string }) =>
    [
      ["GetPlayerAchievements", { body: fixture("steam-player-achievements.json") }],
      ["GetSchemaForGame", { body: fixture("steam-schema.json") }],
      ["GetGlobalAchievementPercentagesForApp", { body: fixture("steam-percentages.json") }],
      ["GetGameAchievements", groups],
    ] as [string, { status?: number; body: string }][];
  const groupCalls = (f: ReturnType<typeof fakeFetch>, appId = "1000001"): number =>
    f.calls.filter((c) => c.url.includes("GetGameAchievements") && c.url.includes(`appid=${appId}`))
      .length;

  it("asks Steam for an app's groups once a day, while the other calls run on every poll", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeFetch(routes({ body: fixture("steam-game-achievements.json") }));
    const steam = new SteamClient({ ...opts, fetchFn: f.fn, now: () => clock.t });
    await steam.gameData("1000001");
    clock.t += 23 * 3_600_000;
    const again = await steam.gameData("1000001");
    expect(again?.groups?.byName.get("ACH_02")).toBe(1);
    expect(groupCalls(f)).toBe(1);
    expect(f.calls.filter((c) => c.url.includes("GetPlayerAchievements"))).toHaveLength(2);
    await steam.gameData("2000002");
    expect(groupCalls(f, "2000002")).toBe(1);
    clock.t += 2 * 3_600_000;
    await steam.gameData("1000001");
    expect(groupCalls(f)).toBe(2);
  });

  it("does not cache a failed or malformed answer", async () => {
    const f = fakeFetch(routes({ status: 500, body: "x" }));
    const steam = new SteamClient({ ...opts, fetchFn: f.fn });
    await steam.gameData("1000001");
    await steam.gameData("1000001");
    expect(groupCalls(f)).toBe(2);
    const odd = fakeFetch(routes({ body: "{}" }));
    const steam2 = new SteamClient({ ...opts, fetchFn: odd.fn });
    await steam2.gameData("1000001");
    await steam2.gameData("1000001");
    expect(groupCalls(odd)).toBe(2);
  });
});
