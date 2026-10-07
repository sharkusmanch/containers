import { describe, expect, it } from "vitest";
import {
  AchievementService,
  normaliseRa,
  normaliseSteam,
  safeIcon,
} from "../src/server/achievements.js";
import type { RaGameProgress } from "../src/server/ra.js";
import type { SteamGameData } from "../src/server/steam.js";

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
