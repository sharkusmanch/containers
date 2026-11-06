import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Detector, isSteamAppId, pickCurrent } from "../src/server/detector.js";

const NOW = Date.UTC(2026, 9, 6, 18, 0, 0);
const MIN = 60_000;

describe("isSteamAppId", () => {
  it.each([
    ["10", true],
    ["1000001", true],
    ["15564589419463376896", false],
    ["", false],
    ["12a", false],
    ["-1", false],
  ])("%s → %s", (id, ok) => expect(isSteamAppId(id)).toBe(ok));
});

describe("pickCurrent", () => {
  it("prefers the Steam game being played now", () => {
    const p = pickCurrent({
      steam: { appId: "10", name: "Steam Game" },
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: null },
      lastSteam: null,
      now: NOW,
    });
    expect(p).toEqual({
      game: { source: "steam", id: "10", title: "Steam Game" },
      state: "playing",
      observedAt: NOW,
      presence: null,
      device: null,
    });
  });

  it("reports a non-Steam shortcut as a Steam game with no id", () => {
    const p = pickCurrent({
      steam: { appId: "15564589419463376896", name: "Emulator" },
      ra: null,
      lastSteam: null,
      now: NOW,
    });
    expect(p.game).toEqual({ source: "steam", id: null, title: "Emulator" });
    expect(p.state).toBe("playing");
  });

  it("prefers a fresh RA game over a Steam shortcut, which has no id to find a guide by", () => {
    const p = pickCurrent({
      steam: { appId: "15564589419463376896", name: "Emulator" },
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: null },
      lastSteam: null,
      now: NOW,
    });
    expect(p.game).toEqual({ source: "ra", id: "20", title: "RA Game" });
    expect(p.state).toBe("playing");
  });

  it("uses RA when its presence is within ten minutes", () => {
    const p = pickCurrent({
      steam: { appId: null, name: null },
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - 9 * MIN, presence: null },
      lastSteam: null,
      now: NOW,
    });
    expect(p).toEqual({
      game: { source: "ra", id: "20", title: "RA Game" },
      state: "playing",
      observedAt: NOW - 9 * MIN,
      presence: null,
      device: null,
    });
  });

  it("treats exactly ten minutes as fresh and one millisecond more as not", () => {
    const at = (age: number) =>
      pickCurrent({
        steam: null,
        ra: { gameId: "20", title: "RA Game", presenceAt: NOW - age, presence: null },
        lastSteam: null,
        now: NOW,
      }).state;
    expect(at(10 * MIN)).toBe("playing");
    expect(at(10 * MIN + 1)).toBe("last-played");
  });

  it("falls back to the most recent of the last Steam game and the RA game", () => {
    const lastSteam = {
      game: { source: "steam" as const, id: "10", title: "Steam Game" },
      at: NOW - 30 * MIN,
    };
    const olderRa = { gameId: "20", title: "RA Game", presenceAt: NOW - 90 * MIN, presence: null };
    expect(
      pickCurrent({ steam: { appId: null, name: null }, ra: olderRa, lastSteam, now: NOW }),
    ).toEqual({
      game: lastSteam.game,
      state: "last-played",
      observedAt: NOW - 30 * MIN,
      presence: null,
      device: null,
    });
    const newerRa = { gameId: "20", title: "RA Game", presenceAt: NOW - 20 * MIN, presence: null };
    expect(
      pickCurrent({ steam: { appId: null, name: null }, ra: newerRa, lastSteam, now: NOW }).game
        ?.source,
    ).toBe("ra");
  });

  it("reports none when nothing has ever been seen", () => {
    expect(pickCurrent({ steam: null, ra: null, lastSteam: null, now: NOW })).toEqual({
      game: null,
      state: "none",
      observedAt: null,
      presence: null,
      device: null,
    });
    expect(
      pickCurrent({
        steam: { appId: null, name: null },
        ra: { gameId: null, title: null, presenceAt: null, presence: null },
        lastSteam: null,
        now: NOW,
      }).state,
    ).toBe("none");
  });

  it("ignores an RA presence time in the future beyond clock skew", () => {
    const p = pickCurrent({
      steam: null,
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW + 60 * MIN, presence: null },
      lastSteam: null,
      now: NOW,
    });
    expect(p.state).toBe("last-played");
  });

  describe("presence", () => {
    const raGame = { source: "ra" as const, id: "20", title: "RA Game" };
    const withPresence = (presenceAt: number) => ({
      gameId: "20",
      title: "RA Game",
      presenceAt,
      presence: "Chapter 2: Sample Caves",
      device: null,
    });

    it("carries the summary's presence for a fresh RA game", () => {
      const p = pickCurrent({
        steam: null,
        ra: withPresence(NOW - MIN),
        lastSteam: null,
        now: NOW,
      });
      expect(p).toEqual({
        game: raGame,
        state: "playing",
        observedAt: NOW - MIN,
        presence: "Chapter 2: Sample Caves",
        device: null,
      });
    });

    it("drops it for an RA game older than the fresh window", () => {
      const p = pickCurrent({
        steam: null,
        ra: withPresence(NOW - 10 * MIN - 1),
        lastSteam: null,
        now: NOW,
      });
      expect(p).toMatchObject({ game: raGame, state: "last-played", presence: null });
    });

    it("drops it when a Steam game is being played", () => {
      const p = pickCurrent({
        steam: { appId: "10", name: "Steam Game" },
        ra: withPresence(NOW - MIN),
        lastSteam: null,
        now: NOW,
      });
      expect(p).toMatchObject({ game: { source: "steam", id: "10" }, presence: null });
    });

    it("keeps it when a shortcut runs and the fresh RA game wins", () => {
      const p = pickCurrent({
        steam: { appId: "15564589419463376896", name: "Emulator" },
        ra: withPresence(NOW - MIN),
        lastSteam: null,
        now: NOW,
      });
      expect(p).toMatchObject({
        game: raGame,
        state: "playing",
        presence: "Chapter 2: Sample Caves",
        device: null,
      });
    });

    it("drops it for a shortcut with no fresh RA game", () => {
      const p = pickCurrent({
        steam: { appId: "15564589419463376896", name: "Emulator" },
        ra: withPresence(NOW - 30 * MIN),
        lastSteam: null,
        now: NOW,
      });
      expect(p).toMatchObject({ game: { source: "steam", id: null }, presence: null });
    });

    it("is null when nothing is detected", () => {
      expect(pickCurrent({ steam: null, ra: null, lastSteam: null, now: NOW }).presence).toBeNull();
    });
  });

  it("uses a title placeholder when Steam gives an id without a name", () => {
    expect(
      pickCurrent({ steam: { appId: "10", name: null }, ra: null, lastSteam: null, now: NOW }).game
        ?.title,
    ).toBe("Steam app 10");
  });
});

describe("Detector", () => {
  function make(
    steam: () => Promise<{ appId: string | null; name: string | null }>,
    ra: () => Promise<{
      gameId: string | null;
      title: string | null;
      presenceAt: number | null;
      presence: string | null;
    }>,
    clock = { t: NOW },
  ) {
    return {
      clock,
      d: new Detector({ steam: { presence: steam }, ra: { summary: ra }, now: () => clock.t }),
    };
  }

  it("starts with no game and not stale", () => {
    const { d } = make(
      async () => ({ appId: null, name: null }),
      async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    );
    expect(d.current()).toEqual({
      game: null,
      state: "none",
      observedAt: null,
      presence: null,
      device: null,
      stale: false,
    });
  });

  it("carries the presence through current()", async () => {
    const { d, clock } = make(
      async () => ({ appId: null, name: null }),
      async () => ({
        gameId: "20",
        title: "RA Game",
        presenceAt: NOW - MIN,
        presence: "Chapter 2: Sample Caves",
      }),
    );
    await d.pollSteam();
    await d.pollRa();
    expect(d.current()).toMatchObject({ state: "playing", presence: "Chapter 2: Sample Caves" });
    clock.t += 20 * MIN;
    expect(d.current()).toMatchObject({ state: "last-played", presence: null });
  });

  it("remembers the last Steam game after the player quits", async () => {
    let inGame = true;
    const { d, clock } = make(
      async () => (inGame ? { appId: "10", name: "Steam Game" } : { appId: null, name: null }),
      async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    );
    await d.pollSteam();
    expect(d.current().state).toBe("playing");
    inGame = false;
    clock.t += 5 * MIN;
    await d.pollSteam();
    expect(d.current()).toMatchObject({
      state: "last-played",
      game: { source: "steam", id: "10" },
      observedAt: NOW,
    });
  });

  it("does not remember a quit shortcut over a stale RA game", async () => {
    let steam: { appId: string | null; name: string | null } = {
      appId: "15564589419463376896",
      name: "Emulator",
    };
    const { d, clock } = make(
      async () => steam,
      async () => ({ gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: null }),
    );
    await d.pollSteam();
    await d.pollRa();
    expect(d.current().game).toEqual({ source: "ra", id: "20", title: "RA Game" });
    steam = { appId: null, name: null };
    clock.t += 20 * MIN;
    await d.pollSteam();
    expect(d.current()).toMatchObject({ state: "last-played", game: { source: "ra", id: "20" } });
  });

  it("reports none after a shortcut quits when nothing else was seen", async () => {
    let steam: { appId: string | null; name: string | null } = {
      appId: "15564589419463376896",
      name: "Emulator",
    };
    const { d } = make(
      async () => steam,
      async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    );
    await d.pollSteam();
    await d.pollRa();
    steam = { appId: null, name: null };
    await d.pollSteam();
    expect(d.current()).toMatchObject({ game: null, state: "none" });
  });

  it("keeps a real Steam game as last played when a shortcut runs and quits afterwards", async () => {
    let steam: { appId: string | null; name: string | null } = { appId: "10", name: "Steam Game" };
    const { d, clock } = make(
      async () => steam,
      async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    );
    await d.pollSteam();
    steam = { appId: null, name: null };
    clock.t += 5 * MIN;
    await d.pollSteam();
    steam = { appId: "15564589419463376896", name: "Emulator" };
    clock.t += 5 * MIN;
    await d.pollSteam();
    steam = { appId: null, name: null };
    clock.t += 5 * MIN;
    await d.pollSteam();
    expect(d.current()).toMatchObject({
      state: "last-played",
      game: { source: "steam", id: "10" },
      observedAt: NOW,
    });
  });

  it("keeps the last data and marks it stale when a poll fails", async () => {
    let fail = false;
    const { d } = make(
      async () => {
        if (fail) throw new Error("down");
        return { appId: "10", name: "Steam Game" };
      },
      async () => ({ gameId: null, title: null, presenceAt: null, presence: null }),
    );
    await d.pollSteam();
    fail = true;
    await d.pollSteam();
    expect(d.current()).toMatchObject({ state: "playing", game: { id: "10" }, stale: true });
    fail = false;
    await d.pollSteam();
    expect(d.current().stale).toBe(false);
  });

  it("marks stale when only RA fails", async () => {
    const { d } = make(
      async () => ({ appId: null, name: null }),
      async () => {
        throw new Error("down");
      },
    );
    await d.pollSteam();
    await d.pollRa();
    expect(d.current().stale).toBe(true);
  });

  it("never rejects from a poll", async () => {
    const { d } = make(
      async () => {
        throw new Error("down");
      },
      async () => {
        throw new Error("down");
      },
    );
    await expect(d.pollSteam()).resolves.toBeUndefined();
    await expect(d.pollRa()).resolves.toBeUndefined();
  });

  describe("an unrefreshable Steam reading", () => {
    type Presence = { appId: string | null; name: string | null };
    const noRa = async () => ({ gameId: null, title: null, presenceAt: null, presence: null });

    it("stops counting as playing after five minutes of failed polls when RA is fresh", async () => {
      let fail = false;
      const { d, clock } = make(
        async () => {
          if (fail) throw new Error("down");
          return { appId: "10", name: "Steam Game" };
        },
        async () => ({ gameId: "20", title: "RA Game", presenceAt: NOW + 5 * MIN, presence: null }),
      );
      await d.pollSteam();
      await d.pollRa();
      expect(d.current().game).toMatchObject({ source: "steam", id: "10" });
      fail = true;
      clock.t += 4 * MIN;
      await d.pollSteam();
      expect(d.current().game).toMatchObject({ source: "steam", id: "10" });
      clock.t += 2 * MIN;
      await d.pollSteam();
      expect(d.current()).toMatchObject({
        state: "playing",
        game: { source: "ra", id: "20" },
        stale: true,
      });
    });

    it("falls back to last-played with the original time when nothing else is fresh", async () => {
      let fail = false;
      const { d, clock } = make(async () => {
        if (fail) throw new Error("down");
        return { appId: "10", name: "Steam Game" };
      }, noRa);
      await d.pollSteam();
      fail = true;
      clock.t += 6 * MIN;
      await d.pollSteam();
      expect(d.current()).toEqual({
        game: { source: "steam", id: "10", title: "Steam Game" },
        state: "last-played",
        observedAt: NOW,
        presence: null,
        device: null,
        stale: true,
      });
    });

    it("expires even without a further poll, and a successful poll restores playing", async () => {
      let fail = false;
      const { d, clock } = make(async () => {
        if (fail) throw new Error("down");
        return { appId: "10", name: "Steam Game" };
      }, noRa);
      await d.pollSteam();
      fail = true;
      await d.pollSteam();
      clock.t += 5 * MIN;
      expect(d.current().state).toBe("playing");
      clock.t += 1;
      expect(d.current().state).toBe("last-played");
      fail = false;
      await d.pollSteam();
      expect(d.current()).toMatchObject({ state: "playing", stale: false });
    });

    it("honours a custom steamMaxAgeMs", async () => {
      const clock = { t: NOW };
      const d = new Detector({
        steam: {
          presence: async (): Promise<Presence> => {
            throw new Error("down");
          },
        },
        ra: { summary: noRa },
        now: () => clock.t,
        steamMaxAgeMs: 1_000,
      });
      await d.pollSteam();
      expect(d.current().state).toBe("none");
    });
  });

  describe("onStatus", () => {
    it("fires once per working/failing transition, not on every poll", async () => {
      const events: [string, boolean][] = [];
      let steamFail = true;
      let raFail = false;
      const d = new Detector({
        steam: {
          presence: async () => {
            if (steamFail) throw new Error("down");
            return { appId: null, name: null };
          },
        },
        ra: {
          summary: async () => {
            if (raFail) throw new Error("down");
            return { gameId: null, title: null, presenceAt: null, presence: null };
          },
        },
        onStatus: (source, ok) => events.push([source, ok]),
      });
      await d.pollSteam();
      await d.pollSteam();
      await d.pollRa();
      expect(events).toEqual([["steam", false]]);
      steamFail = false;
      await d.pollSteam();
      await d.pollSteam();
      expect(events).toEqual([
        ["steam", false],
        ["steam", true],
      ]);
      raFail = true;
      await d.pollRa();
      await d.pollRa();
      raFail = false;
      await d.pollRa();
      expect(events.slice(2)).toEqual([
        ["ra", false],
        ["ra", true],
      ]);
    });
  });
});

describe("xbox", () => {
  type XboxPresence = import("../src/server/xbox.js").XboxPresence;
  type XboxTitleInfo = import("../src/server/xbox.js").XboxTitleInfo;

  const xboxPresence = (
    id = "1000000001",
    device = "Scarlett",
    richPresence: string | null = "Act 2: Sample Bridge",
  ): XboxPresence => ({
    online: true,
    device,
    title: { id, name: "Sample Wars: E-Day", richPresence },
  });
  const live = (presence = xboxPresence()) => ({ presence, isXboxLive: true });
  const xboxGame = { source: "xbox" as const, id: "1000000001", title: "Sample Wars: E-Day" };
  const freshRa = { gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: "RA status" };

  describe("pickCurrent", () => {
    it("steam beats xbox", () => {
      const p = pickCurrent({
        steam: { appId: "10", name: "Steam Game" },
        ra: freshRa,
        xbox: live(),
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p).toEqual({
        game: { source: "steam", id: "10", title: "Steam Game" },
        state: "playing",
        observedAt: NOW,
        presence: null,
        device: null,
      });
    });

    it("xbox beats fresh RA", () => {
      const p = pickCurrent({
        steam: { appId: null, name: null },
        ra: freshRa,
        xbox: live(),
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p).toEqual({
        game: xboxGame,
        state: "playing",
        observedAt: NOW,
        presence: "Act 2: Sample Bridge",
        device: "Series X",
      });
    });

    it("win32-only xbox title does not beat RA", () => {
      const p = pickCurrent({
        steam: null,
        ra: freshRa,
        xbox: { presence: xboxPresence("2000000002", "WindowsOneCore", null), isXboxLive: false },
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p).toEqual({
        game: { source: "ra", id: "20", title: "RA Game" },
        state: "playing",
        observedAt: NOW - MIN,
        presence: "RA status",
        device: null,
      });
    });

    it("xbox beats a steam shortcut", () => {
      const p = pickCurrent({
        steam: { appId: "15564589419463376896", name: "Emulator" },
        ra: null,
        xbox: live(xboxPresence("1000000001", "WindowsOneCore")),
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p).toMatchObject({ game: xboxGame, state: "playing", device: "PC" });
    });

    it("names an Xbox title without a name by its id, and an unknown device as none", () => {
      const p = pickCurrent({
        steam: null,
        ra: null,
        xbox: {
          presence: {
            online: true,
            device: "SomethingNew",
            title: { id: "7", name: "", richPresence: null },
          },
          isXboxLive: true,
        },
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p).toMatchObject({
        game: { source: "xbox", id: "7", title: "Xbox game 7" },
        device: null,
        presence: null,
      });
    });

    it("last game is the newest of steam/xbox/ra", () => {
      const lastSteam = {
        game: { source: "steam" as const, id: "10", title: "Steam Game" },
        at: NOW - 30 * MIN,
      };
      const lastXbox = { game: xboxGame, at: NOW - 20 * MIN };
      const oldRa = { gameId: "20", title: "RA Game", presenceAt: NOW - 40 * MIN, presence: null };
      const pick = (ra: typeof oldRa, xbox = lastXbox, steam = lastSteam) =>
        pickCurrent({ steam: null, ra, xbox: null, lastSteam: steam, lastXbox: xbox, now: NOW });
      expect(pick(oldRa)).toEqual({
        game: xboxGame,
        state: "last-played",
        observedAt: NOW - 20 * MIN,
        presence: null,
        device: null,
      });
      expect(pick(oldRa, { game: xboxGame, at: NOW - 50 * MIN }).game?.source).toBe("steam");
      expect(pick({ ...oldRa, presenceAt: NOW - 15 * MIN }).game?.source).toBe("ra");
    });

    it("an xbox reading with no game playing falls through to RA", () => {
      const p = pickCurrent({
        steam: null,
        ra: freshRa,
        xbox: { presence: { online: true, device: "Scarlett", title: null }, isXboxLive: false },
        lastSteam: null,
        lastXbox: null,
        now: NOW,
      });
      expect(p.game?.source).toBe("ra");
    });
  });

  describe("Detector", () => {
    const noRa = async () => ({ gameId: null, title: null, presenceAt: null, presence: null });
    const info = (id: string, isXboxLive = true): XboxTitleInfo => ({
      id,
      name: "Sample Wars: E-Day",
      isXboxLive,
      image: null,
    });

    function make(opts: {
      steam?: () => Promise<{ appId: string | null; name: string | null }>;
      ra?: () => Promise<{
        gameId: string | null;
        title: string | null;
        presenceAt: number | null;
        presence: string | null;
      }>;
      presence?: () => Promise<XboxPresence | null>;
      titleInfo?: (id: string) => Promise<XboxTitleInfo | null>;
      connected?: () => boolean;
      withXbox?: boolean;
    }) {
      const clock = { t: NOW };
      const calls = { presence: 0, titleInfo: 0 };
      const events: [string, boolean][] = [];
      const d = new Detector({
        steam: { presence: opts.steam ?? (async () => ({ appId: null, name: null })) },
        ra: { summary: opts.ra ?? noRa },
        ...(opts.withXbox === false
          ? {}
          : {
              xbox: {
                presence: async () => {
                  calls.presence += 1;
                  return (opts.presence ?? (async () => xboxPresence()))();
                },
                titleInfo: async (id: string) => {
                  calls.titleInfo += 1;
                  return (opts.titleInfo ?? (async (i: string) => info(i)))(id);
                },
              },
              xboxConnected: opts.connected ?? (() => true),
            }),
        now: () => clock.t,
        onStatus: (source, ok) => events.push([source, ok]),
      });
      return { d, clock, calls, events };
    }

    async function pollAll(d: Detector) {
      await d.pollSteam();
      await d.pollRa();
      await d.pollXbox();
    }

    it("reports an Xbox Live game as playing, then as the last game after it quits", async () => {
      let playing = true;
      const { d, clock } = make({
        presence: async () =>
          playing ? xboxPresence() : { online: true, device: "Scarlett", title: null },
      });
      await pollAll(d);
      expect(d.current()).toEqual({
        game: xboxGame,
        state: "playing",
        observedAt: NOW,
        presence: "Act 2: Sample Bridge",
        device: "Series X",
        stale: false,
      });
      playing = false;
      clock.t += MIN;
      await d.pollXbox();
      expect(d.current()).toMatchObject({
        game: xboxGame,
        state: "last-played",
        observedAt: NOW,
        presence: null,
        device: null,
      });
    });

    it("counts a title whose info failed as not Xbox Live for that poll", async () => {
      let fail = true;
      const { d } = make({
        ra: async () => ({ gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: null }),
        titleInfo: async (id) => {
          if (fail) throw new Error("titlehub down");
          return info(id);
        },
      });
      await pollAll(d);
      expect(d.current()).toMatchObject({ game: { source: "ra" }, stale: false });
      fail = false;
      await d.pollXbox();
      expect(d.current().game).toEqual(xboxGame);
    });

    it("counts an unlisted title (null info) as not Xbox Live", async () => {
      const { d } = make({ titleInfo: async () => null });
      await pollAll(d);
      expect(d.current()).toMatchObject({ game: null, state: "none" });
    });

    it("xbox failure does not change steam/ra picks", async () => {
      const scenarios = [
        { steam: { appId: "10", name: "Steam Game" }, ra: null },
        {
          steam: { appId: null, name: null },
          ra: { gameId: "20", title: "RA Game", presenceAt: NOW - MIN, presence: "RA status" },
        },
        { steam: { appId: "15564589419463376896", name: "Emulator" }, ra: null },
        { steam: { appId: null, name: null }, ra: null },
      ];
      for (const s of scenarios) {
        const steam = async () => s.steam;
        const ra = async () =>
          s.ra ?? { gameId: null, title: null, presenceAt: null, presence: null };
        const without = make({ steam, ra, withXbox: false });
        await without.d.pollSteam();
        await without.d.pollRa();
        for (const failure of [
          async () => {
            throw new Error("xbox down");
          },
          async () => null,
        ]) {
          const failing = make({ steam, ra, presence: failure });
          await pollAll(failing.d);
          expect(failing.d.current()).toEqual(without.d.current());
        }
      }
    });

    it("marks an Xbox game stale when its polls start failing, then drops it after five minutes", async () => {
      let fail = false;
      const { d, clock, events } = make({
        presence: async () => {
          if (fail) throw new Error("xbox down");
          return xboxPresence();
        },
      });
      await pollAll(d);
      fail = true;
      clock.t += MIN;
      await d.pollXbox();
      expect(d.current()).toMatchObject({ game: xboxGame, state: "playing", stale: true });
      expect(events).toEqual([["xbox", false]]);
      clock.t += 5 * MIN;
      expect(d.current()).toMatchObject({ game: xboxGame, state: "last-played", stale: true });
      fail = false;
      await d.pollXbox();
      expect(d.current()).toMatchObject({ state: "playing", stale: false });
      expect(events).toEqual([
        ["xbox", false],
        ["xbox", true],
      ]);
    });

    it("xbox not polled while disconnected", async () => {
      let connected = false;
      const { d, calls } = make({ connected: () => connected });
      await pollAll(d);
      expect(calls).toEqual({ presence: 0, titleInfo: 0 });
      expect(d.current()).toMatchObject({ game: null, state: "none" });
      connected = true;
      await d.pollXbox();
      expect(calls.presence).toBe(1);
      expect(d.current().game).toEqual(xboxGame);
      // A sign-in that is lost or disconnected stops counting at once, poll or not.
      connected = false;
      expect(d.current()).toMatchObject({ state: "last-played", device: null, presence: null });
    });

    it("a lost sign-in leaves the last Xbox game last-played, not stale", async () => {
      let connected = true;
      let lost = false;
      const { d, clock, events } = make({
        connected: () => connected,
        // The poll that finds the refresh rejected gets no session; the sign-in is then "lost".
        presence: async () => (lost ? null : xboxPresence()),
      });
      await pollAll(d);
      expect(d.current()).toMatchObject({ game: xboxGame, state: "playing", stale: false });
      lost = true;
      clock.t += MIN;
      await d.pollXbox();
      connected = false;
      clock.t += MIN;
      await d.pollXbox();
      expect(d.current()).toMatchObject({ game: xboxGame, state: "last-played", stale: false });
      // The failure was reported once; leaving it behind on disconnect says nothing more.
      expect(events).toEqual([["xbox", false]]);
      // Signing in again and failing reports the failure afresh.
      connected = true;
      await d.pollXbox();
      expect(events).toEqual([
        ["xbox", false],
        ["xbox", false],
      ]);
    });

    it("device and richPresence surface only while xbox is playing", async () => {
      let steam: { appId: string | null; name: string | null } = { appId: "10", name: "Steam" };
      const { d, clock } = make({ steam: async () => steam });
      await pollAll(d);
      expect(d.current()).toMatchObject({
        game: { source: "steam" },
        device: null,
        presence: null,
      });
      steam = { appId: null, name: null };
      await d.pollSteam();
      expect(d.current()).toMatchObject({
        game: xboxGame,
        device: "Series X",
        presence: "Act 2: Sample Bridge",
      });
      clock.t += 6 * MIN;
      expect(d.current()).toMatchObject({
        state: "last-played",
        device: null,
        presence: null,
      });
    });

    describe("polling cadence", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("polls every 30 s while connected and backs off on failure up to five minutes", async () => {
        vi.useFakeTimers();
        let result: () => Promise<XboxPresence | null> = async () => null;
        const { d, calls } = make({ presence: () => result() });
        d.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.presence).toBe(1);
        // Failures: 60 s, 120 s, 240 s, then capped at 300 s.
        for (const [wait, total] of [
          [60_000, 2],
          [120_000, 3],
          [240_000, 4],
          [300_000, 5],
          [300_000, 6],
        ] as const) {
          await vi.advanceTimersByTimeAsync(wait - 1);
          expect(calls.presence).toBe(total - 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(calls.presence).toBe(total);
        }
        result = async () => xboxPresence();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls.presence).toBe(7);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls.presence).toBe(8);
        d.stop();
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(calls.presence).toBe(8);
      });

      it("waits as long as a 429 asks", async () => {
        vi.useFakeTimers();
        const { XboxRateLimitError } = await import("../src/server/xbox.js");
        let limited = true;
        const { d, calls } = make({
          presence: async () => {
            if (limited) throw new XboxRateLimitError(900_000);
            return xboxPresence();
          },
        });
        d.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.presence).toBe(1);
        limited = false;
        await vi.advanceTimersByTimeAsync(899_999);
        expect(calls.presence).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.presence).toBe(2);
        d.stop();
      });

      it("checks the sign-in every 30 s without calling Xbox while disconnected", async () => {
        vi.useFakeTimers();
        let connected = false;
        const { d, calls } = make({ connected: () => connected });
        d.start();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(calls.presence).toBe(0);
        connected = true;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls.presence).toBe(1);
        d.stop();
      });

      it("starts no Xbox timer without an Xbox source", async () => {
        vi.useFakeTimers();
        const { d } = make({ withXbox: false });
        d.start();
        expect(vi.getTimerCount()).toBe(2);
        d.stop();
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
});

describe("last played: remembered across restarts and filled from the platforms' history", () => {
  type XboxPresence = import("../src/server/xbox.js").XboxPresence;
  type Observed = import("../src/server/detector.js").Observed;
  type Steam = { appId: string | null; name: string | null };
  type Ra = {
    gameId: string | null;
    title: string | null;
    presenceAt: number | null;
    presence: null;
  };

  const DAY = 24 * 60 * MIN;
  const raGame = { source: "ra" as const, id: "724", title: "Pokémon Red" };
  const xboxGame = { source: "xbox" as const, id: "2000000002", title: "Oblivion Remastered" };
  const steamGame = { source: "steam" as const, id: "1000001", title: "Test Game" };
  /** RA's last presence: four days ago, as in the report. */
  const oldRa = async (): Promise<Ra> => ({
    gameId: "724",
    title: "Pokémon Red",
    presenceAt: NOW - 4 * DAY,
    presence: null,
  });
  const idle = async (): Promise<Steam> => ({ appId: null, name: null });
  const noXboxGame = async (): Promise<XboxPresence | null> => ({
    online: false,
    device: null,
    title: null,
  });

  /** An in-memory stand-in for LastPlayedStore. */
  function memoryStore(initial: { steam?: Observed; xbox?: Observed } = {}) {
    const slots: Record<"steam" | "xbox", Observed | null> = {
      steam: initial.steam ?? null,
      xbox: initial.xbox ?? null,
    };
    const records: ["steam" | "xbox", Observed][] = [];
    return {
      slots,
      records,
      get: (s: "steam" | "xbox") => slots[s],
      record: (s: "steam" | "xbox", o: Observed) => {
        slots[s] = o;
        records.push([s, o]);
      },
    };
  }

  function make(opts: {
    steam?: () => Promise<Steam>;
    steamLast?: () => Promise<{ appId: string; name: string | null; at: number } | null>;
    ra?: () => Promise<Ra>;
    presence?: () => Promise<XboxPresence | null>;
    xboxLast?: () => Promise<{ id: string; name: string; at: number } | null>;
    connected?: () => boolean;
    store?: ReturnType<typeof memoryStore> | import("../src/server/last-played.js").LastPlayedStore;
    historyIntervalMs?: number;
  }) {
    const clock = { t: NOW };
    const calls = { steamLast: 0, xboxLast: 0 };
    const events: [string, boolean][] = [];
    const d = new Detector({
      steam: {
        presence: opts.steam ?? idle,
        ...(opts.steamLast
          ? {
              lastPlayed: () => {
                calls.steamLast += 1;
                return (opts.steamLast as NonNullable<typeof opts.steamLast>)();
              },
            }
          : {}),
      },
      ra: { summary: opts.ra ?? oldRa },
      xbox: {
        presence: opts.presence ?? noXboxGame,
        titleInfo: async (id: string) => ({ id, name: "x", isXboxLive: true, image: null }),
        ...(opts.xboxLast
          ? {
              lastPlayed: () => {
                calls.xboxLast += 1;
                return (opts.xboxLast as NonNullable<typeof opts.xboxLast>)();
              },
            }
          : {}),
      },
      xboxConnected: opts.connected ?? (() => true),
      ...(opts.store ? { lastPlayed: opts.store } : {}),
      ...(opts.historyIntervalMs ? { historyIntervalMs: opts.historyIntervalMs } : {}),
      now: () => clock.t,
      onStatus: (source, ok) => events.push([source, ok]),
    });
    return { d, clock, calls, events };
  }

  async function pollAll(d: Detector) {
    await d.pollSteam();
    await d.pollRa();
    await d.pollXbox();
  }

  describe("after a restart", () => {
    let dir: string;
    beforeEach(async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      dir = await mkdtemp(`${tmpdir()}/detector-last-`);
    });
    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    });

    it("a remembered Xbox game newer than RA's presence wins, from the first answer on", async () => {
      const { LastPlayedStore } = await import("../src/server/last-played.js");
      const file = `${dir}/last-played.json`;
      // First run: the Xbox game is seen being played, then the pod restarts.
      const before = new LastPlayedStore({ file, now: () => NOW - DAY });
      await before.load();
      const first = make({
        presence: async () => ({
          online: true,
          device: "Scarlett",
          title: { id: xboxGame.id, name: xboxGame.title, richPresence: null },
        }),
        store: before,
      });
      first.clock.t = NOW - DAY;
      await first.d.pollXbox();
      await before.settled();

      const after = new LastPlayedStore({ file });
      await after.load();
      const { d } = make({ store: after });
      expect(d.current()).toMatchObject({
        game: xboxGame,
        state: "last-played",
        observedAt: NOW - DAY,
      });
      await pollAll(d);
      expect(d.current()).toMatchObject({ game: xboxGame, state: "last-played" });
    });

    it("without anything remembered RA wins, which is the reported bug's starting point", async () => {
      const { d } = make({});
      await pollAll(d);
      expect(d.current()).toMatchObject({ game: raGame, state: "last-played" });
    });
  });

  it("nothing remembered, Xbox history newer than RA: the Xbox game wins and is remembered", async () => {
    const store = memoryStore();
    const { d } = make({
      store,
      xboxLast: async () => ({ id: xboxGame.id, name: xboxGame.title, at: NOW - 2 * DAY }),
    });
    await pollAll(d);
    expect(d.current().game).toEqual(raGame);
    await d.pollLastPlayed();
    expect(d.current()).toMatchObject({
      game: xboxGame,
      state: "last-played",
      observedAt: NOW - 2 * DAY,
      stale: false,
    });
    expect(store.slots.xbox).toEqual({ game: xboxGame, at: NOW - 2 * DAY });
  });

  it("RA newer than the Xbox and Steam history: RA wins", async () => {
    const { d } = make({
      xboxLast: async () => ({ id: xboxGame.id, name: xboxGame.title, at: NOW - 5 * DAY }),
      steamLast: async () => ({ appId: steamGame.id, name: steamGame.title, at: NOW - 6 * DAY }),
    });
    await pollAll(d);
    await d.pollLastPlayed();
    expect(d.current()).toMatchObject({ game: raGame, state: "last-played" });
  });

  it("Steam's owned-games history newer than RA: the Steam game wins", async () => {
    const store = memoryStore();
    const { d } = make({
      store,
      steamLast: async () => ({ appId: steamGame.id, name: steamGame.title, at: NOW - DAY }),
    });
    await pollAll(d);
    await d.pollLastPlayed();
    expect(d.current()).toMatchObject({ game: steamGame, observedAt: NOW - DAY });
    expect(store.slots.steam).toEqual({ game: steamGame, at: NOW - DAY });
  });

  it("names a Steam app without a name by its id, and ignores a history entry that is not an app id", async () => {
    let entry = { appId: "15564589419463376896", name: "Shortcut" as string | null, at: NOW - DAY };
    const { d } = make({ steamLast: async () => entry });
    await pollAll(d);
    await d.pollLastPlayed();
    expect(d.current().game).toEqual(raGame);
    entry = { appId: "42", name: null, at: NOW - DAY };
    await d.pollLastPlayed();
    expect(d.current().game).toEqual({ source: "steam", id: "42", title: "Steam app 42" });
  });

  it("a history entry older than what is remembered changes nothing", async () => {
    const remembered = { game: xboxGame, at: NOW - DAY };
    const store = memoryStore({ xbox: remembered });
    const { d } = make({
      store,
      xboxLast: async () => ({ id: "2000000009", name: "Older Game", at: NOW - 3 * DAY }),
    });
    await d.pollLastPlayed();
    expect(d.current()).toMatchObject({ game: xboxGame, observedAt: NOW - DAY });
    expect(store.records).toEqual([]);
  });

  it("remembers games observed live, through the store", async () => {
    const store = memoryStore();
    const { d, clock } = make({
      store,
      steam: async () => ({ appId: steamGame.id, name: steamGame.title }),
    });
    await d.pollSteam();
    clock.t += 30_000;
    await d.pollSteam();
    expect(store.records).toEqual([
      ["steam", { game: steamGame, at: NOW }],
      ["steam", { game: steamGame, at: NOW + 30_000 }],
    ]);
  });

  it("clamps a history time in the future to now, for ordering and for what is remembered", async () => {
    const store = memoryStore();
    const { d } = make({
      store,
      xboxLast: async () => ({ id: xboxGame.id, name: xboxGame.title, at: NOW + 60 * MIN }),
    });
    await d.pollLastPlayed();
    expect(d.current()).toMatchObject({ game: xboxGame, observedAt: NOW });
    expect(store.slots.xbox?.at).toBe(NOW);
  });

  it("orders a remembered time in the future as now, like RA's, and reports it as now", () => {
    const p = pickCurrent({
      steam: null,
      ra: null,
      lastSteam: { game: steamGame, at: NOW + 3 * DAY },
      lastXbox: { game: xboxGame, at: NOW - MIN },
      now: NOW,
    });
    expect(p).toMatchObject({ game: steamGame, state: "last-played", observedAt: NOW });
  });

  describe("a game being played still wins over any history", () => {
    const newest = async () => ({ id: xboxGame.id, name: xboxGame.title, at: NOW });

    it("Steam live", async () => {
      const { d } = make({
        steam: async () => ({ appId: "10", name: "Steam Game" }),
        xboxLast: newest,
      });
      await pollAll(d);
      await d.pollLastPlayed();
      expect(d.current()).toMatchObject({ game: { source: "steam", id: "10" }, state: "playing" });
    });

    it("fresh RA", async () => {
      const { d } = make({
        ra: async () => ({
          gameId: "724",
          title: "Pokémon Red",
          presenceAt: NOW - MIN,
          presence: null,
        }),
        xboxLast: newest,
      });
      await pollAll(d);
      await d.pollLastPlayed();
      expect(d.current()).toMatchObject({ game: raGame, state: "playing" });
    });

    it("Xbox live", async () => {
      const { d } = make({
        presence: async () => ({
          online: true,
          device: "Scarlett",
          title: { id: "2000000003", name: "Live Game", richPresence: null },
        }),
        steamLast: async () => ({ appId: steamGame.id, name: steamGame.title, at: NOW }),
      });
      await pollAll(d);
      await d.pollLastPlayed();
      expect(d.current()).toMatchObject({
        game: { source: "xbox", id: "2000000003" },
        state: "playing",
      });
    });
  });

  it("a failing history keeps what is remembered, without marking anything stale", async () => {
    const remembered = { game: steamGame, at: NOW - DAY };
    const { d, events } = make({
      store: memoryStore({ steam: remembered }),
      steamLast: async () => {
        throw new Error("steam down");
      },
      xboxLast: async () => {
        throw new Error("xbox down");
      },
    });
    await pollAll(d);
    await expect(d.pollLastPlayed()).resolves.toBeUndefined();
    expect(d.current()).toMatchObject({ game: steamGame, observedAt: NOW - DAY, stale: false });
    expect(events).toEqual([]);
  });

  it("does not ask Xbox for its history while signed out", async () => {
    const { d, calls } = make({
      connected: () => false,
      xboxLast: async () => ({ id: xboxGame.id, name: xboxGame.title, at: NOW }),
    });
    await d.pollLastPlayed();
    expect(calls.xboxLast).toBe(0);
    expect(d.current().game).toBeNull();
  });

  describe("cadence", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks both histories once at start and then every 30 minutes, and not after stop", async () => {
      vi.useFakeTimers();
      const { d, calls } = make({
        steamLast: async () => null,
        xboxLast: async () => null,
      });
      d.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual({ steamLast: 1, xboxLast: 1 });
      await vi.advanceTimersByTimeAsync(30 * MIN - 1);
      expect(calls).toEqual({ steamLast: 1, xboxLast: 1 });
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual({ steamLast: 2, xboxLast: 2 });
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(calls).toEqual({ steamLast: 3, xboxLast: 3 });
      d.stop();
      await vi.advanceTimersByTimeAsync(3 * 30 * MIN);
      expect(calls).toEqual({ steamLast: 3, xboxLast: 3 });
    });
  });
});
