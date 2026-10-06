import { describe, expect, it } from "vitest";
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
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - MIN },
      lastSteam: null,
      now: NOW,
    });
    expect(p).toEqual({
      game: { source: "steam", id: "10", title: "Steam Game" },
      state: "playing",
      observedAt: NOW,
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
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - MIN },
      lastSteam: null,
      now: NOW,
    });
    expect(p.game).toEqual({ source: "ra", id: "20", title: "RA Game" });
    expect(p.state).toBe("playing");
  });

  it("uses RA when its presence is within ten minutes", () => {
    const p = pickCurrent({
      steam: { appId: null, name: null },
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW - 9 * MIN },
      lastSteam: null,
      now: NOW,
    });
    expect(p).toEqual({
      game: { source: "ra", id: "20", title: "RA Game" },
      state: "playing",
      observedAt: NOW - 9 * MIN,
    });
  });

  it("treats exactly ten minutes as fresh and one millisecond more as not", () => {
    const at = (age: number) =>
      pickCurrent({
        steam: null,
        ra: { gameId: "20", title: "RA Game", presenceAt: NOW - age },
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
    const olderRa = { gameId: "20", title: "RA Game", presenceAt: NOW - 90 * MIN };
    expect(
      pickCurrent({ steam: { appId: null, name: null }, ra: olderRa, lastSteam, now: NOW }),
    ).toEqual({
      game: lastSteam.game,
      state: "last-played",
      observedAt: NOW - 30 * MIN,
    });
    const newerRa = { gameId: "20", title: "RA Game", presenceAt: NOW - 20 * MIN };
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
    });
    expect(
      pickCurrent({
        steam: { appId: null, name: null },
        ra: { gameId: null, title: null, presenceAt: null },
        lastSteam: null,
        now: NOW,
      }).state,
    ).toBe("none");
  });

  it("ignores an RA presence time in the future beyond clock skew", () => {
    const p = pickCurrent({
      steam: null,
      ra: { gameId: "20", title: "RA Game", presenceAt: NOW + 60 * MIN },
      lastSteam: null,
      now: NOW,
    });
    expect(p.state).toBe("last-played");
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
    ra: () => Promise<{ gameId: string | null; title: string | null; presenceAt: number | null }>,
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
      async () => ({ gameId: null, title: null, presenceAt: null }),
    );
    expect(d.current()).toEqual({ game: null, state: "none", observedAt: null, stale: false });
  });

  it("remembers the last Steam game after the player quits", async () => {
    let inGame = true;
    const { d, clock } = make(
      async () => (inGame ? { appId: "10", name: "Steam Game" } : { appId: null, name: null }),
      async () => ({ gameId: null, title: null, presenceAt: null }),
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
      async () => ({ gameId: "20", title: "RA Game", presenceAt: NOW - MIN }),
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
      async () => ({ gameId: null, title: null, presenceAt: null }),
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
      async () => ({ gameId: null, title: null, presenceAt: null }),
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
      async () => ({ gameId: null, title: null, presenceAt: null }),
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
    const noRa = async () => ({ gameId: null, title: null, presenceAt: null });

    it("stops counting as playing after five minutes of failed polls when RA is fresh", async () => {
      let fail = false;
      const { d, clock } = make(
        async () => {
          if (fail) throw new Error("down");
          return { appId: "10", name: "Steam Game" };
        },
        async () => ({ gameId: "20", title: "RA Game", presenceAt: NOW + 5 * MIN }),
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
            return { gameId: null, title: null, presenceAt: null };
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
