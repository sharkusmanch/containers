import { afterEach, describe, expect, it, vi } from "vitest";
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
