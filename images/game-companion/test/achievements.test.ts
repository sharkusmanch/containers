import { describe, expect, it, vi } from "vitest";
import {
  AchievementService,
  normaliseRa,
  normaliseSteam,
  safeIcon,
} from "../src/server/achievements.js";
import type { RaGameProgress } from "../src/server/ra.js";
import type { SteamGameData } from "../src/server/steam.js";
import { XboxClient, type XboxAchievementList, type XboxTitleInfo } from "../src/server/xbox.js";
import { fixture } from "./helpers.js";

const steamData: SteamGameData = {
  title: "Test Game",
  player: [
    { apiname: "ACH_01", achieved: 1, unlocktime: 1700000000 },
    { apiname: "ACH_02", achieved: 0, unlocktime: 0 },
    { apiname: "ACH_03", achieved: 0, unlocktime: 0 },
    { apiname: "ACH_GONE", achieved: 0, unlocktime: 0 },
  ],
  schema: [
    {
      name: "ACH_01",
      displayName: "First",
      description: "Do the first thing",
      hidden: 0,
      icon: "https://steamcdn-a.akamaihd.net/a.jpg",
      icongray: "https://steamcdn-a.akamaihd.net/a_g.jpg",
    },
    {
      name: "ACH_02",
      displayName: "Secret",
      hidden: 1,
      icon: "https://steamcdn-a.akamaihd.net/b.jpg",
      icongray: "https://steamcdn-a.akamaihd.net/b_g.jpg",
    },
    {
      name: "ACH_03",
      displayName: "Third",
      description: "Do the third thing",
      hidden: 0,
      icon: "https://evil.example/c.jpg",
      icongray: "https://evil.example/c_g.jpg",
    },
  ],
  percents: new Map([
    ["ACH_01", 92.74],
    ["ACH_02", 12.25],
  ]),
};

const raData: RaGameProgress = {
  title: "Test Quest",
  consoleName: "PlayStation 2",
  distinctPlayers: 1000,
  achievements: [
    {
      ID: 1,
      Title: "Opening",
      Description: "Win the first battle",
      Type: null,
      BadgeName: "100",
      NumAwardedHardcore: 900,
      DisplayOrder: 1,
      DateEarnedHardcore: "2026-01-02 03:04:05",
    },
    {
      ID: 2,
      Title: "Soft Only",
      Description: "Earned in softcore",
      Type: null,
      BadgeName: "101",
      NumAwardedHardcore: 500,
      DisplayOrder: 2,
    },
    {
      ID: 3,
      Title: "Chapter One",
      Description: "Finish chapter one",
      Type: "progression",
      BadgeName: "102",
      NumAwardedHardcore: 250,
      DisplayOrder: 3,
    },
    {
      ID: 4,
      Title: "One Shot",
      Description: "Beat the boss without items",
      Type: "missable",
      BadgeName: "103",
      NumAwardedHardcore: 41,
      DisplayOrder: 4,
    },
    {
      ID: 5,
      Title: "The End",
      Description: "Finish the game",
      Type: "win_condition",
      BadgeName: "../evil",
      NumAwardedHardcore: 10,
      DisplayOrder: 5,
    },
  ],
};

describe("safeIcon", () => {
  it.each([
    ["https://steamcdn-a.akamaihd.net/a.jpg", true],
    ["https://cdn.akamai.steamstatic.com/x/y.jpg", true],
    ["https://media.retroachievements.org/Badge/100.png", true],
    ["https://images-eds-ssl.xboxlive.com/image?url=a", true],
    ["https://store-images.s-microsoft.com/image/a", true],
    ["http://images-eds-ssl.xboxlive.com/image?url=a", false],
    ["http://steamcdn-a.akamaihd.net/a.jpg", false],
    ["https://evil.example/a.jpg", false],
    ["https://steamstatic.com.evil.example/a.jpg", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s → allowed %s", (url, ok) => {
    expect(safeIcon(url)).toBe(ok ? url : null);
  });
  it("handles missing values", () => {
    expect(safeIcon(null)).toBeNull();
    expect(safeIcon(undefined)).toBeNull();
  });
});

describe("normaliseSteam", () => {
  const r = normaliseSteam("1000001", steamData);

  it("summarises totals", () => {
    expect(r).toMatchObject({
      source: "steam",
      id: "1000001",
      title: "Test Game",
      total: 3,
      unlocked: 1,
      stale: false,
    });
  });

  it("maps an unlocked achievement", () => {
    expect(r.achievements[0]).toEqual({
      id: "ACH_01",
      name: "First",
      description: "Do the first thing",
      icon: "https://steamcdn-a.akamaihd.net/a.jpg",
      unlocked: true,
      unlockedAt: new Date(1700000000 * 1000).toISOString(),
      unlockPercent: 92.7,
      hidden: false,
      missable: false,
      kind: null,
    });
  });

  it("never sets a kind on a Steam achievement", () => {
    expect(r.achievements.map((a) => a.kind)).toEqual([null, null, null]);
  });

  it("marks hidden achievements, which have no description, and uses the grey icon when locked", () => {
    expect(r.achievements[1]).toMatchObject({
      name: "Secret",
      description: null,
      hidden: true,
      unlocked: false,
      unlockedAt: null,
      unlockPercent: 12.3,
      icon: "https://steamcdn-a.akamaihd.net/b_g.jpg",
    });
  });

  it("drops icons from hosts that are not allowed and leaves an unknown percentage null", () => {
    expect(r.achievements[2]).toMatchObject({ name: "Third", icon: null, unlockPercent: null });
  });

  it("skips player entries that the schema no longer lists", () => {
    expect(r.achievements.map((a) => a.id)).toEqual(["ACH_01", "ACH_02", "ACH_03"]);
  });
});

describe("normaliseRa", () => {
  const r = normaliseRa("30002", raData);

  it("counts only hardcore unlocks", () => {
    expect(r).toMatchObject({
      source: "ra",
      id: "30002",
      title: "Test Quest",
      total: 5,
      unlocked: 1,
    });
    expect(r.achievements[1]).toMatchObject({
      name: "Soft Only",
      unlocked: false,
      unlockedAt: null,
    });
  });

  it("maps an unlocked achievement with a UTC time and the hardcore rate", () => {
    expect(r.achievements[0]).toEqual({
      id: "1",
      name: "Opening",
      description: "Win the first battle",
      icon: "https://media.retroachievements.org/Badge/100.png",
      unlocked: true,
      unlockedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString(),
      unlockPercent: 90,
      hidden: false,
      missable: false,
      kind: null,
    });
  });

  it("maps RetroAchievements' own label to kind", () => {
    expect(r.achievements.map((a) => a.kind)).toEqual([null, null, "progression", null, "win"]);
  });

  it("uses the locked badge for locked achievements", () => {
    expect(r.achievements[1]?.icon).toBe("https://media.retroachievements.org/Badge/101_lock.png");
  });

  it("hides progression and win-condition achievements and flags missables", () => {
    expect(r.achievements[2]).toMatchObject({ hidden: true, missable: false });
    expect(r.achievements[3]).toMatchObject({ hidden: false, missable: true, unlockPercent: 4.1 });
    expect(r.achievements[4]).toMatchObject({ hidden: true });
  });

  it("refuses a badge name that is not a plain token", () => {
    expect(r.achievements[4]?.icon).toBeNull();
  });

  it("leaves the percentage null when there are no players", () => {
    expect(
      normaliseRa("1", { ...raData, distinctPlayers: 0 }).achievements[0]?.unlockPercent,
    ).toBeNull();
  });

  it("caps the percentage at 100", () => {
    expect(
      normaliseRa("1", { ...raData, distinctPlayers: 100 }).achievements[0]?.unlockPercent,
    ).toBe(100);
  });
});

describe("AchievementService", () => {
  const NOW = 1_000_000;

  it("caches within the TTL and refetches after it", async () => {
    let calls = 0;
    const clock = { t: NOW };
    const svc = new AchievementService({
      steam: {
        gameData: async () => {
          calls += 1;
          return steamData;
        },
      },
      ra: { gameProgress: async () => null },
      now: () => clock.t,
    });
    await svc.get("steam", "10");
    await svc.get("steam", "10");
    expect(calls).toBe(1);
    clock.t += 61_000;
    await svc.get("steam", "10");
    expect(calls).toBe(2);
  });

  it("returns null for a game with no achievements", async () => {
    const svc = new AchievementService({
      steam: { gameData: async () => null },
      ra: { gameProgress: async () => null },
    });
    expect(await svc.get("steam", "5")).toBeNull();
    expect(await svc.get("ra", "5")).toBeNull();
  });

  it("caches a no-achievements answer too", async () => {
    let calls = 0;
    const svc = new AchievementService({
      steam: {
        gameData: async () => {
          calls += 1;
          return null;
        },
      },
      ra: { gameProgress: async () => null },
    });
    await svc.get("steam", "5");
    await svc.get("steam", "5");
    expect(calls).toBe(1);
  });

  it("serves the last copy marked stale when a refresh fails", async () => {
    let fail = false;
    const clock = { t: NOW };
    const svc = new AchievementService({
      steam: {
        gameData: async () => {
          if (fail) throw new Error("down");
          return steamData;
        },
      },
      ra: { gameProgress: async () => null },
      now: () => clock.t,
    });
    expect((await svc.get("steam", "10"))?.stale).toBe(false);
    fail = true;
    clock.t += 61_000;
    expect((await svc.get("steam", "10"))?.stale).toBe(true);
  });

  it("throws when the first fetch fails and there is no copy", async () => {
    const svc = new AchievementService({
      steam: {
        gameData: async () => {
          throw new Error("down");
        },
      },
      ra: { gameProgress: async () => null },
    });
    await expect(svc.get("steam", "10")).rejects.toThrow();
  });

  it("shares one upstream call between concurrent requests", async () => {
    let calls = 0;
    const svc = new AchievementService({
      steam: {
        gameData: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 5));
          return steamData;
        },
      },
      ra: { gameProgress: async () => null },
    });
    await Promise.all([svc.get("steam", "10"), svc.get("steam", "10"), svc.get("steam", "10")]);
    expect(calls).toBe(1);
  });

  it("evicts the oldest entry beyond the cap", async () => {
    const seen: string[] = [];
    const svc = new AchievementService({
      steam: {
        gameData: async (id) => {
          seen.push(id);
          return steamData;
        },
      },
      ra: { gameProgress: async () => null },
      maxEntries: 2,
    });
    await svc.get("steam", "1");
    await svc.get("steam", "2");
    await svc.get("steam", "3");
    await svc.get("steam", "1");
    expect(seen).toEqual(["1", "2", "3", "1"]);
  });

  describe("xbox", () => {
    const list = JSON.parse(fixture("xbox-achievements.json")) as XboxAchievementList;
    const info: XboxTitleInfo = {
      id: "20",
      name: "Test Quest: Moon Edition",
      isXboxLive: true,
      image: null,
      totalGamerscore: 1000,
    };
    const idle = {
      steam: { gameData: async () => null },
      ra: { gameProgress: async () => null },
    };

    it("achievement service xbox branch caches like steam", async () => {
      const calls = { list: 0, info: 0 };
      const clock = { t: NOW };
      const svc = new AchievementService({
        ...idle,
        xbox: {
          achievements: async () => {
            calls.list += 1;
            return list;
          },
          titleInfo: async () => {
            calls.info += 1;
            return info;
          },
        },
        now: () => clock.t,
      });
      const first = await svc.get("xbox", "20");
      expect(first).toMatchObject({
        source: "xbox",
        id: "20",
        title: "Test Quest: Moon Edition",
        total: 3,
        unlocked: 1,
        stale: false,
      });
      await svc.get("xbox", "20");
      expect(calls).toEqual({ list: 1, info: 1 });
      clock.t += 46_000;
      await svc.get("xbox", "20");
      expect(calls.list).toBe(2);
    });

    it("serves the last copy marked stale when a refresh fails", async () => {
      let fail = false;
      const clock = { t: NOW };
      const svc = new AchievementService({
        ...idle,
        xbox: {
          achievements: async () => {
            if (fail) throw new Error("down");
            return list;
          },
          titleInfo: async () => info,
        },
        now: () => clock.t,
      });
      expect((await svc.get("xbox", "20"))?.stale).toBe(false);
      fail = true;
      clock.t += 61_000;
      expect((await svc.get("xbox", "20"))?.stale).toBe(true);
    });

    it("is null when Xbox is off or the game has no achievements", async () => {
      expect(await new AchievementService(idle).get("xbox", "20")).toBeNull();
      const empty = new AchievementService({
        ...idle,
        xbox: { achievements: async () => ({ achievements: [] }), titleInfo: async () => null },
      });
      expect(await empty.get("xbox", "20")).toBeNull();
    });

    it("keeps the cached list, marked stale, when the sign-in goes away", async () => {
      // A real client: the sign-in answers a session, then none (lost or disconnected).
      let session: { headers: Record<string, string>; xuid: string } | null = {
        headers: { Authorization: "XBL3.0 x=fake-uhs;fake-xsts" },
        xuid: "2535000000001",
      };
      const fetchFn = (async (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (u.includes("titlehub")) return new Response(fixture("xbox-titlehub.json"));
        if (u.includes("achievements")) return new Response(fixture("xbox-achievements.json"));
        return new Response("not routed", { status: 599 });
      }) as typeof fetch;
      const xbox = new XboxClient({ auth: { session: async () => session }, fetch: fetchFn });
      const clock = { t: NOW };
      const svc = new AchievementService({ ...idle, xbox, now: () => clock.t });

      const fresh = await svc.get("xbox", "2000000002");
      expect(fresh).toMatchObject({ source: "xbox", total: 3, stale: false });
      session = null;
      clock.t += 61_000;
      const after = await svc.get("xbox", "2000000002");
      expect(after).toMatchObject({ source: "xbox", total: 3, stale: true });
      expect(after?.achievements).toEqual(fresh?.achievements);
    });

    it("reports a game never fetched as unavailable, not as none, when signed out", async () => {
      const xbox = new XboxClient({ auth: { session: async () => null }, fetch: fetch });
      const svc = new AchievementService({ ...idle, xbox });
      await expect(svc.get("xbox", "20")).rejects.toThrow();
    });

    it("keeps an empty list for a title with Gamerscore, marked noList", async () => {
      const svc = new AchievementService({
        ...idle,
        xbox: { achievements: async () => ({ achievements: [] }), titleInfo: async () => info },
      });
      expect(await svc.get("xbox", "20")).toMatchObject({ total: 0, noList: true });
    });

    it("names an unlisted title by its ID", async () => {
      const svc = new AchievementService({
        ...idle,
        xbox: { achievements: async () => list, titleInfo: async () => null },
      });
      expect((await svc.get("xbox", "77"))?.title).toBe("Xbox game 77");
    });

    it("draws a playing game's fetch from the priority budget", async () => {
      const svc = new AchievementService({
        ...idle,
        xbox: { achievements: async () => list, titleInfo: async () => info },
        maxFetchesPerMinute: 0,
      });
      await expect(svc.get("xbox", "20")).rejects.toThrow("upstream fetch limit reached");
      expect(await svc.get("xbox", "20", { priority: true })).toMatchObject({ source: "xbox" });
    });
  });

  describe("failures and stale copies", () => {
    function flaky(initialFail: boolean) {
      const state = { fail: initialFail, calls: 0, t: NOW };
      const svc = new AchievementService({
        steam: {
          gameData: async () => {
            state.calls += 1;
            if (state.fail) throw new Error("down");
            return steamData;
          },
        },
        ra: { gameProgress: async () => null },
        now: () => state.t,
      });
      return { state, svc };
    }

    it("uses a 45 second cache TTL by default", async () => {
      const { state, svc } = flaky(false);
      await svc.get("steam", "10");
      state.t += 44_000;
      await svc.get("steam", "10");
      expect(state.calls).toBe(1);
      state.t += 2_000;
      await svc.get("steam", "10");
      expect(state.calls).toBe(2);
    });

    it("does not retry a failed first fetch within failTtlMs, then retries", async () => {
      const { state, svc } = flaky(true);
      await expect(svc.get("steam", "10")).rejects.toThrow();
      state.t += 29_000;
      await expect(svc.get("steam", "10")).rejects.toThrow();
      expect(state.calls).toBe(1);
      state.t += 2_000;
      await expect(svc.get("steam", "10")).rejects.toThrow();
      expect(state.calls).toBe(2);
      state.fail = false;
      state.t += 31_000;
      expect((await svc.get("steam", "10"))?.stale).toBe(false);
      expect(state.calls).toBe(3);
    });

    it("honours a custom failTtlMs and remembers failures per key", async () => {
      let calls = 0;
      const clock = { t: NOW };
      const svc = new AchievementService({
        steam: {
          gameData: async () => {
            calls += 1;
            throw new Error("down");
          },
        },
        ra: { gameProgress: async () => null },
        now: () => clock.t,
        failTtlMs: 1_000,
      });
      await expect(svc.get("steam", "1")).rejects.toThrow();
      await expect(svc.get("steam", "2")).rejects.toThrow();
      expect(calls).toBe(2);
      clock.t += 1_001;
      await expect(svc.get("steam", "1")).rejects.toThrow();
      expect(calls).toBe(3);
    });

    it("serves the stale copy without calling upstream again within staleRetryMs", async () => {
      const { state, svc } = flaky(false);
      await svc.get("steam", "10");
      state.fail = true;
      state.t += 46_000;
      expect((await svc.get("steam", "10"))?.stale).toBe(true);
      expect(state.calls).toBe(2);
      state.t += 29_000;
      expect((await svc.get("steam", "10"))?.stale).toBe(true);
      expect(state.calls).toBe(2);
      state.t += 2_000;
      expect((await svc.get("steam", "10"))?.stale).toBe(true);
      expect(state.calls).toBe(3);
    });

    it("replaces the stale copy and clears stale once upstream recovers", async () => {
      const { state, svc } = flaky(false);
      await svc.get("steam", "10");
      state.fail = true;
      state.t += 46_000;
      await svc.get("steam", "10");
      state.fail = false;
      state.t += 31_000;
      expect((await svc.get("steam", "10"))?.stale).toBe(false);
      expect(state.calls).toBe(3);
      expect((await svc.get("steam", "10"))?.stale).toBe(false);
      expect(state.calls).toBe(3);
    });
  });

  describe("upstream fetch ceiling", () => {
    function limited(
      opts: {
        maxFetchesPerMinute?: number;
        maxPriorityFetchesPerMinute?: number;
        maxEntries?: number;
      } = {},
    ) {
      const state = { calls: 0, t: NOW, fail: false };
      const svc = new AchievementService({
        steam: {
          gameData: async () => {
            state.calls += 1;
            if (state.fail) throw new Error("down");
            return steamData;
          },
        },
        ra: { gameProgress: async () => null },
        now: () => state.t,
        ...opts,
      });
      return { state, svc };
    }

    it("allows six fetches for different keys in a minute and refuses the seventh", async () => {
      const { state, svc } = limited();
      for (let i = 1; i <= 6; i += 1) await svc.get("steam", String(i));
      expect(state.calls).toBe(6);
      await expect(svc.get("steam", "7")).rejects.toThrow();
      expect(state.calls).toBe(6);
    });

    it("lets a fetch through again once the window slides, and refusals use no slot", async () => {
      const { state, svc } = limited();
      for (let i = 1; i <= 6; i += 1) {
        await svc.get("steam", String(i));
        state.t += 1_000;
      }
      for (let i = 0; i < 5; i += 1) await expect(svc.get("steam", "7")).rejects.toThrow();
      expect(state.calls).toBe(6);
      // The first fetch was at NOW; it leaves the window at NOW + 60 s.
      state.t = NOW + 59_999;
      await expect(svc.get("steam", "7")).rejects.toThrow();
      state.t = NOW + 60_000;
      expect((await svc.get("steam", "7"))?.stale).toBe(false);
      expect(state.calls).toBe(7);
      await expect(svc.get("steam", "8")).rejects.toThrow();
      expect(state.calls).toBe(7);
    });

    it("serves an expired cached copy as stale when refused, without re-stamping it", async () => {
      const { state, svc } = limited({ maxFetchesPerMinute: 2 });
      await svc.get("steam", "1");
      await svc.get("steam", "2");
      state.t += 46_000;
      const first = await svc.get("steam", "1");
      expect(first?.stale).toBe(true);
      expect(state.calls).toBe(2);
      // Not re-stamped: the next call is still refused and still stale, with no stale window.
      state.t += 1_000;
      expect((await svc.get("steam", "1"))?.stale).toBe(true);
      expect(state.calls).toBe(2);
      // Once the window has slid the very next call fetches, which a re-stamp would have blocked.
      state.t = NOW + 60_000;
      expect((await svc.get("steam", "1"))?.stale).toBe(false);
      expect(state.calls).toBe(3);
    });

    it("does not count cached, failure-window or stale-window answers", async () => {
      const { state, svc } = limited({ maxFetchesPerMinute: 2 });
      await svc.get("steam", "1");
      for (let i = 0; i < 10; i += 1) await svc.get("steam", "1");
      expect(state.calls).toBe(1);
      state.fail = true;
      await expect(svc.get("steam", "2")).rejects.toThrow();
      for (let i = 0; i < 10; i += 1) await expect(svc.get("steam", "2")).rejects.toThrow();
      expect(state.calls).toBe(2);
      state.t += 46_000;
      expect((await svc.get("steam", "1"))?.stale).toBe(true);
      for (let i = 0; i < 10; i += 1) await svc.get("steam", "1");
      expect(state.calls).toBe(2);
    });

    it("counts a failed fetch against the ceiling", async () => {
      const { state, svc } = limited({ maxFetchesPerMinute: 2 });
      state.fail = true;
      await expect(svc.get("steam", "1")).rejects.toThrow();
      await expect(svc.get("steam", "2")).rejects.toThrow();
      await expect(svc.get("steam", "3")).rejects.toThrow();
      expect(state.calls).toBe(2);
    });

    it("keeps a separate budget for priority fetches", async () => {
      const { state, svc } = limited();
      for (let i = 1; i <= 6; i += 1) await svc.get("steam", String(i));
      await expect(svc.get("steam", "7")).rejects.toThrow();
      expect(state.calls).toBe(6);
      expect((await svc.get("steam", "100", { priority: true }))?.stale).toBe(false);
      expect(state.calls).toBe(7);
    });

    it("does not let priority fetches use up the general budget", async () => {
      const { state, svc } = limited();
      for (let i = 1; i <= 6; i += 1) await svc.get("steam", String(i), { priority: true });
      expect(state.calls).toBe(6);
      expect((await svc.get("steam", "50"))?.stale).toBe(false);
      expect(state.calls).toBe(7);
    });

    it("refuses a seventh priority fetch within the minute, serving a copy stale if it has one", async () => {
      const { state, svc } = limited();
      for (let i = 1; i <= 6; i += 1) await svc.get("steam", String(i), { priority: true });
      await expect(svc.get("steam", "7", { priority: true })).rejects.toThrow();
      expect(state.calls).toBe(6);
      state.t += 46_000;
      expect((await svc.get("steam", "1", { priority: true }))?.stale).toBe(true);
      expect(state.calls).toBe(6);
      state.t = NOW + 60_000;
      expect((await svc.get("steam", "7", { priority: true }))?.stale).toBe(false);
    });

    it("honours a custom maxPriorityFetchesPerMinute and shares the cache between kinds", async () => {
      const { state, svc } = limited({ maxPriorityFetchesPerMinute: 1 });
      await svc.get("steam", "1", { priority: true });
      await expect(svc.get("steam", "2", { priority: true })).rejects.toThrow();
      expect((await svc.get("steam", "1"))?.stale).toBe(false);
      expect(state.calls).toBe(1);
    });

    it("caches 300 entries by default", async () => {
      const { state, svc } = limited({ maxFetchesPerMinute: 1_000 });
      for (let i = 0; i < 60; i += 1) await svc.get("steam", String(i));
      expect(state.calls).toBe(60);
      for (let i = 0; i < 60; i += 1) await svc.get("steam", String(i));
      expect(state.calls).toBe(60);
    });
  });
});

describe("trustworthy RA metadata", () => {
  it.each([
    "2026-02-30 00:00:00",
    "2026-13-01 00:00:00",
    "2026-01-01 24:00:00",
    "2026-01-01 00:60:00",
    "2026-01-01 00:00:60",
  ])("never normalizes invalid raw date %s into an unlock", (raw) => {
    const result = normaliseRa("724", {
      ...raData,
      achievements: [{ ...raData.achievements[0]!, DateEarnedHardcore: raw }],
    });
    expect(result.unlocked).toBe(0);
    expect(result.achievements[0]?.unlockedAt).toBeNull();
  });
  it("keeps last successful upstream time across a failed refresh and retry cache", async () => {
    let time = Date.UTC(2026, 9, 11),
      failed = false;
    const service = new AchievementService({
      now: () => time,
      ttlMs: 10,
      staleRetryMs: 10,
      steam: { gameData: async () => steamData },
      ra: {
        gameProgress: async () => {
          if (failed) throw new Error("down");
          return { ...raData, accountIdentity: "tester" };
        },
      },
    });
    const initial = await service.get("ra", "724");
    expect(initial).toMatchObject({
      accountIdentity: "tester",
      fetchedAt: "2026-10-11T00:00:00.000Z",
      stale: false,
    });
    time += 11;
    failed = true;
    expect(await service.get("ra", "724")).toMatchObject({
      fetchedAt: initial?.fetchedAt,
      stale: true,
    });
    time += 1;
    expect(await service.get("ra", "724")).toMatchObject({
      fetchedAt: initial?.fetchedAt,
      stale: true,
    });
    time += 11;
    failed = false;
    expect(await service.get("ra", "724")).toMatchObject({
      fetchedAt: new Date(time).toISOString(),
      stale: false,
    });
    const steam = await service.get("steam", "10");
    expect(steam).not.toHaveProperty("fetchedAt");
    expect(steam).not.toHaveProperty("accountIdentity");
  });
});

describe("normaliseSteam achievement groups", () => {
  const group = (
    groupId: number,
    name: string,
    over: Partial<{ order: number; isPublic: boolean; developerOnly: boolean }> = {},
  ) => ({ groupId, name, order: 0, isPublic: true, developerOnly: false, ...over });
  const withGroups = (
    byName: [string, number][],
    groups: ReturnType<typeof group>[],
  ): SteamGameData => ({ ...steamData, groups: { byName: new Map(byName), groups } });
  const fh5Like = withGroups(
    [
      ["ACH_01", 0],
      ["ACH_02", 1],
      ["ACH_03", 2],
    ],
    [group(0, ""), group(1, "Test Game: Hot Wheels"), group(2, "Test Game: Rally Adventure")],
  );

  it("lists the base game first, then each DLC in order, with their counts", () => {
    const r = normaliseSteam("1000001", fh5Like);
    expect(r.groups).toEqual([
      { key: "steam:0", name: "Base game", dlc: false, total: 1, unlocked: 1 },
      { key: "steam:1", name: "Test Game: Hot Wheels", dlc: true, total: 1, unlocked: 0 },
      { key: "steam:2", name: "Test Game: Rally Adventure", dlc: true, total: 1, unlocked: 0 },
    ]);
    expect(r.achievements.map((a) => a.group)).toEqual(["steam:0", "steam:1", "steam:2"]);
    expect(r).toMatchObject({ total: 3, unlocked: 1 });
  });

  it("keeps everything else about each achievement as it was", () => {
    const plain = normaliseSteam("1000001", steamData);
    const grouped = normaliseSteam("1000001", fh5Like);
    expect(grouped.achievements.map(({ group: _g, ...rest }) => rest)).toEqual(plain.achievements);
  });

  it("follows Steam's order field, then the order Steam lists the groups in", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 2],
          ["ACH_02", 1],
          ["ACH_03", 3],
        ],
        [group(3, "C", { order: 1 }), group(2, "B"), group(1, "A"), group(0, "")],
      ),
    );
    // No achievement is in group 0 here, so the base group is left out like any empty group.
    expect(r.groups?.map((g) => g.key)).toEqual(["steam:2", "steam:1", "steam:3"]);
  });

  it("names a DLC group with no name by its id", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 0],
          ["ACH_02", 4],
        ],
        [group(0, ""), group(4, "")],
      ),
    );
    expect(r.groups?.[1]).toEqual({
      key: "steam:4",
      name: "DLC 4",
      dlc: true,
      total: 1,
      unlocked: 0,
    });
  });

  it("names the base group Base game whatever Steam calls group 0, even when Steam omits it", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 0],
          ["ACH_02", 1],
        ],
        [group(1, "Extra")],
      ),
    );
    expect(r.groups?.[0]).toMatchObject({ key: "steam:0", name: "Base game", dlc: false });
    expect(r.groups?.[0]?.total).toBe(2);
  });

  it("adds no group fields for a game with only the base group", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 0],
          ["ACH_02", 0],
          ["ACH_03", 0],
        ],
        [group(0, "")],
      ),
    );
    expect(r).toEqual(normaliseSteam("1000001", steamData));
    expect("groups" in r).toBe(false);
    expect(r.achievements.some((a) => "group" in a)).toBe(false);
  });

  it("adds no group fields when the only DLC group has none of the achievements", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 0],
          ["ACH_02", 0],
          ["ACH_03", 0],
        ],
        [group(0, ""), group(1, "Empty DLC")],
      ),
    );
    expect("groups" in r).toBe(false);
    expect(r.achievements.some((a) => "group" in a)).toBe(false);
  });

  it("adds no group fields without group data, as before", () => {
    const r = normaliseSteam("1000001", steamData);
    expect("groups" in r).toBe(false);
    expect(r.achievements.some((a) => "group" in a)).toBe(false);
  });

  it("puts achievements of a hidden or developer-only group in the base group", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_01", 1],
          ["ACH_02", 2],
          ["ACH_03", 3],
        ],
        [
          group(0, ""),
          group(1, "Not public", { isPublic: false }),
          group(2, "Developers", { developerOnly: true }),
          group(3, "Real DLC"),
        ],
      ),
    );
    expect(r.groups?.map((g) => [g.key, g.total])).toEqual([
      ["steam:0", 2],
      ["steam:3", 1],
    ]);
    expect(r.achievements.map((a) => a.group)).toEqual(["steam:0", "steam:0", "steam:3"]);
  });

  it("puts an achievement missing from the map, or in a group Steam does not list, in the base group", () => {
    const r = normaliseSteam(
      "1000001",
      withGroups(
        [
          ["ACH_02", 9],
          ["ACH_03", 1],
        ],
        [group(0, ""), group(1, "DLC One")],
      ),
    );
    expect(r.achievements.map((a) => a.group)).toEqual(["steam:0", "steam:0", "steam:1"]);
    expect(r.groups?.map((g) => [g.key, g.total, g.unlocked])).toEqual([
      ["steam:0", 2, 1],
      ["steam:1", 1, 0],
    ]);
  });
});

describe("AchievementService xbox achievement groups", () => {
  const GAME = "11111111-aaaa-4000-8000-000000000001";
  const DLC = "22222222-bbbb-4000-8000-000000000002";
  const idle = {
    steam: { gameData: async () => null },
    ra: { gameProgress: async () => null },
  };
  const twoProducts: XboxAchievementList = {
    achievements: [
      { id: "1", name: "Base one", progressState: "Achieved", productId: GAME },
      { id: "2", name: "DLC one", progressState: "NotStarted", productId: DLC },
    ],
  };

  it("names the groups from the client's catalog lookup", async () => {
    const asked: string[][] = [];
    const svc = new AchievementService({
      ...idle,
      xbox: {
        achievements: async () => twoProducts,
        titleInfo: async () => null,
        products: async (ids) => {
          asked.push([...ids]);
          return new Map([
            [GAME, { kind: "Game", title: "Test Quest" }],
            [DLC, { kind: "Durable", title: "Far Side" }],
          ]);
        },
      },
    });
    const r = await svc.get("xbox", "20");
    expect(asked).toEqual([[GAME, DLC]]);
    expect(r?.groups?.map((g) => [g.name, g.dlc, g.total, g.unlocked])).toEqual([
      ["Base game", false, 1, 1],
      ["Far Side", true, 1, 0],
    ]);
  });

  it("does not look anything up for a list with one product", async () => {
    let asked = 0;
    const svc = new AchievementService({
      ...idle,
      xbox: {
        achievements: async () => ({
          achievements: [{ id: "1", name: "Only", productId: GAME }],
        }),
        titleInfo: async () => null,
        products: async () => {
          asked += 1;
          return new Map();
        },
      },
    });
    const r = await svc.get("xbox", "20");
    expect(asked).toBe(0);
    expect(r && "groups" in r).toBe(false);
  });

  it("still answers, with fallback names, when the lookup rejects or the client has none", async () => {
    const failing = new AchievementService({
      ...idle,
      xbox: {
        achievements: async () => twoProducts,
        titleInfo: async () => null,
        products: async () => {
          throw new Error("catalog down");
        },
      },
    });
    const without = new AchievementService({
      ...idle,
      xbox: { achievements: async () => twoProducts, titleInfo: async () => null },
    });
    for (const svc of [failing, without]) {
      const r = await svc.get("xbox", "20");
      expect(r?.stale).toBe(false);
      expect(r?.groups?.map((g) => g.name)).toEqual(["Base game", "Add-on 1"]);
    }
  });
});

const SESSION_FOR_SERVICE = {
  headers: { Authorization: "XBL3.0 x=fake-uhs;fake-xsts" },
  xuid: "2535000000001",
};

describe("AchievementService xbox: a slow catalog lookup", () => {
  const GAME = "11111111-aaaa-4000-8000-000000000001";
  const DLC = "22222222-bbbb-4000-8000-000000000002";
  const idle = {
    steam: { gameData: async () => null },
    ra: { gameProgress: async () => null },
  };
  const list: XboxAchievementList = {
    achievements: [
      { id: "1", name: "Base one", productId: GAME },
      { id: "2", name: "Base two", productId: GAME },
      { id: "3", name: "DLC one", productId: DLC },
    ],
  };

  it("answers after about a second with fallback names when the lookup never finishes", async () => {
    vi.useFakeTimers();
    try {
      let cacheReads = 0;
      const svc = new AchievementService({
        ...idle,
        xbox: {
          achievements: async () => list,
          titleInfo: async () => null,
          products: () => new Promise(() => {}),
          cachedProducts: () => {
            cacheReads += 1;
            return new Map();
          },
        },
      });
      let settled = false;
      const pending = svc.get("xbox", "20").finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await pending;
      expect(cacheReads).toBe(1);
      expect(r?.groups?.map((g) => g.name)).toEqual(["Base game", "Add-on 1"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the names a lookup still running fills in on the next refresh", async () => {
    vi.useFakeTimers();
    try {
      const clock = { t: 1_000_000 };
      let releaseCatalog: (() => void) | null = null;
      const fetchFn = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("achievements.xboxlive")) return new Response(JSON.stringify(list));
        if (url.includes("titlehub")) return new Response('{"titles":[]}');
        const body = url.includes(GAME)
          ? fixture("xbox-catalog-game.json")
          : fixture("xbox-catalog-dlc.json");
        // The catalog answers only once released, after the service has stopped waiting.
        await new Promise<void>((resolve) => {
          const previous = releaseCatalog;
          releaseCatalog = () => {
            previous?.();
            resolve();
          };
        });
        return new Response(body);
      }) as typeof fetch;
      const xbox = new XboxClient({
        auth: { session: async () => SESSION_FOR_SERVICE },
        fetch: fetchFn,
        now: () => clock.t,
      });
      const svc = new AchievementService({ ...idle, xbox, now: () => clock.t });
      const first = svc.get("xbox", "20");
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await first)?.groups?.map((g) => g.name)).toEqual(["Base game", "Add-on 1"]);

      (releaseCatalog as (() => void) | null)?.();
      await vi.advanceTimersByTimeAsync(0);
      clock.t += 46_000;
      const second = await svc.get("xbox", "20");
      expect(second?.groups?.map((g) => [g.key, g.name])).toEqual([
        [`xbox:${GAME}`, "Base game"],
        [`xbox:${DLC}`, "Test Quest: Far Side Expansion"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
