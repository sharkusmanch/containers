// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { startApp } from "../src/web/main.js";
import type { Api } from "../src/web/api.js";
import type {
  Achievement,
  AchievementsResponse,
  FindMatch,
  FindResponse,
  GuideHub,
  GuideMarksResponse,
  GuideProgressResponse,
  GuideWhereResponse,
  HubTreeResponse,
  NowResponse,
  WhereMatch,
} from "../src/shared/types.js";

// Records every call to frames.locate (and still runs it), so tests can pin the exact arguments.
const locateCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../src/web/frames.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/web/frames.js")>();
  return {
    ...real,
    createFrames: (...args: Parameters<typeof real.createFrames>) => {
      const frames = real.createFrames(...args);
      const locate = frames.locate.bind(frames);
      frames.locate = (...a) => {
        locateCalls.push(a);
        return locate(...a);
      };
      return frames;
    },
  };
});

const hubA: GuideHub = {
  hubId: "hA",
  title: "Alpha",
  url: "/doc/alpha",
  source: "ra",
  gameId: "20",
  platformLabel: "RA · PS2",
  nowPlaying: false,
};
const hubZ: GuideHub = {
  hubId: "hZ",
  title: "Zeta",
  url: "/doc/zeta",
  source: "steam",
  gameId: "10",
  platformLabel: "Steam",
  nowPlaying: false,
};
const tree = (hub: GuideHub): HubTreeResponse => ({
  hub,
  pages: [
    { title: "Achievement Checklist", url: `/doc/${hub.hubId}-checklist`, children: [] },
    { title: "Collectibles", url: `/doc/${hub.hubId}-coll`, children: [] },
  ],
  defaultPins: ["Achievement Checklist"],
});
const ach = (id: string, unlocked: number): AchievementsResponse => ({
  source: "ra",
  id,
  title: "t",
  total: 5,
  unlocked,
  stale: false,
  achievements: [],
});

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

interface Fake extends Api {
  nowValue: NowResponse;
  achCalls: string[];
  markCalls: string[];
  findCalls: [string, string][];
  whereCalls: string[];
  progressCalls: [string, boolean | undefined][];
  whereValue: GuideWhereResponse | null;
  progressValue: GuideProgressResponse | null;
  failNow: boolean;
}

function fakeApi(nowValue: NowResponse): Fake {
  const f: Fake = {
    nowValue,
    achCalls: [],
    markCalls: [],
    findCalls: [],
    whereCalls: [],
    progressCalls: [],
    whereValue: { matches: [] },
    progressValue: { pages: [] },
    failNow: false,
    now: async () => {
      if (f.failNow) throw new Error("down");
      return f.nowValue;
    },
    guides: async () => ({ available: true, hubs: [hubA, hubZ] }),
    hubTree: async (id) => tree(id === "hA" ? hubA : hubZ),
    achievements: async (source, id) => {
      f.achCalls.push(`${source}:${id}`);
      return ach(id, 2);
    },
    find: async (hubId, query) => {
      f.findCalls.push([hubId, query]);
      return null;
    },
    marks: async (hubId) => {
      f.markCalls.push(hubId);
      return null;
    },
    where: async (hubId) => {
      f.whereCalls.push(hubId);
      return f.whereValue;
    },
    progress: async (hubId, refresh) => {
      f.progressCalls.push([hubId, refresh]);
      return f.progressValue;
    },
  };
  return f;
}

const playing = (hub: GuideHub): NowResponse => ({
  game: { source: hub.source as "steam" | "ra", id: hub.gameId, title: hub.title },
  state: "playing",
  stale: false,
  observedAt: "2026-10-06T18:00:00.000Z",
  presence: null,
  hubs: [hub],
});

const noTimers = (() => 0) as unknown as typeof setInterval;
const $ = (sel: string): HTMLElement | null => document.querySelector(sel);

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  locateCalls.length = 0;
});

describe("startApp", () => {
  it("loads the detected game: title, achievements and default pins", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect(api.achCalls).toEqual(["ra:20"]);
    expect($(".rail .rail-count")?.textContent).toBe("2");
    expect(
      [...document.querySelectorAll(".rail button")].slice(1, 3).map((b) => b.textContent),
    ).toEqual(["AC", ""]);
    expect($(".ach")?.hidden).toBe(false);
  });

  it("pins nothing for a freshly loaded game when the server configures no default pins", async () => {
    const api = fakeApi(playing(hubA));
    api.hubTree = async () => ({ ...tree(hubA), defaultPins: [] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect(
      [...document.querySelectorAll(".rail button")].slice(1, 5).map((b) => b.textContent),
    ).toEqual(["", "", "", ""]);
    expect(document.querySelectorAll(".picker-pages .picker-item")).toHaveLength(2);
  });

  it("shows a guide page in a frame when its rail slot is tapped, and returns to achievements", async () => {
    const app = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage: memory(),
      setInterval: noTimers,
    });
    await app.ready;
    (document.querySelectorAll(".rail button")[1] as HTMLElement).click();
    expect($("iframe")?.getAttribute("src")).toBe("/doc/hA-checklist");
    expect($(".ach")?.hidden).toBe(true);
    (document.querySelectorAll(".rail button")[0] as HTMLElement).click();
    expect($(".ach")?.hidden).toBe(false);
    expect($("iframe")?.classList.contains("inactive")).toBe(true);
  });

  it("remembers pins and the active slot per game", async () => {
    const storage = memory();
    const first = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await first.ready;
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    expect($(".picker")?.hidden).toBe(false);
    expect(($(".picker-pages") as HTMLElement).hidden).toBe(false);
    (document.querySelectorAll(".picker-pages .picker-item")[1] as HTMLElement).click();
    expect($(".picker")?.hidden).toBe(true);
    expect($("iframe:not(.inactive)")?.getAttribute("src")).toBe("/doc/hA-coll");

    document.body.innerHTML = '<main id="app"></main>';
    const second = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await second.ready;
    expect(
      [...document.querySelectorAll(".rail button")].slice(1, 3).map((b) => b.textContent),
    ).toEqual(["AC", "CO"]);
    expect($("iframe:not(.inactive)")?.getAttribute("src")).toBe("/doc/hA-coll");
  });

  it("offers a banner instead of switching when the detected game changes", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect($(".switch-banner")?.hidden).toBe(false);
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Zeta");
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect($(".switch-banner")?.hidden).toBe(true);
    expect(api.achCalls).toContain("steam:10");
  });

  it("does not re-offer a game the user dismissed until the detection changes again", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-dismiss") as HTMLElement).click();
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(true);
  });

  it("opens the game picker when nothing is detected, and loads a hand-picked game", async () => {
    const api = fakeApi({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".picker")?.hidden).toBe(false);
    expect(($(".picker-games") as HTMLElement).hidden).toBe(false);
    (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(api.achCalls).toContain("steam:10");
  });

  it("shows achievements only, with an explanation, for a detected game that has no guide", async () => {
    const api = fakeApi({
      game: { source: "steam", id: "77", title: "Guideless" },
      state: "playing",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".game-title")?.textContent).toBe("Guideless");
    expect($(".game-note")?.textContent).toBe("No guide found");
    expect(api.achCalls).toEqual(["steam:77"]);
    expect(
      [...document.querySelectorAll(".rail button")]
        .slice(1, 5)
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("skips achievements for a game with no id", async () => {
    const api = fakeApi({
      game: { source: "steam", id: null, title: "Emulator" },
      state: "playing",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect(api.achCalls).toEqual([]);
    expect($(".ach-message")?.textContent).toBe("No achievement data for this game");
  });

  it("labels a last-played game and stale data", async () => {
    const api = fakeApi({ ...playing(hubA), state: "last-played", stale: true });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".game-note")?.textContent).toBe("Last played · showing older data");
  });

  it("asks the user to choose when a game has more than one guide, then restores the full list", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    const titles = (): (string | null | undefined)[] =>
      [...document.querySelectorAll(".picker-games .picker-item")].map(
        (i) => i.querySelector(".picker-title")?.textContent,
      );
    expect($(".picker")?.hidden).toBe(false);
    expect(titles()).toEqual(["Alpha", "Alpha DLC"]);
    (document.querySelectorAll(".picker-games .picker-item")[0] as HTMLElement).click();
    await app.tick();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    // The game whose guide was just chosen is the detected one: no offer to switch to it.
    expect($(".switch-banner")?.hidden).toBe(true);
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    ($('[data-tab="games"]') as HTMLElement).click();
    expect(titles()).toEqual(["Alpha", "Zeta"]);
  });

  it("keeps stored pins when the page tree fails to load", async () => {
    const storage = memory();
    const first = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await first.ready;
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    (document.querySelectorAll(".picker-pages .picker-item")[1] as HTMLElement).click();
    const saved = storage.getItem("game-companion:v1:layout:hA");
    expect(saved).not.toBeNull();

    document.body.innerHTML = '<main id="app"></main>';
    const api = fakeApi(playing(hubA));
    api.hubTree = async () => {
      throw new Error("down");
    };
    const second = startApp({ doc: document, api, storage, setInterval: noTimers });
    await second.ready;
    expect(
      [...document.querySelectorAll(".rail button")].slice(1, 3).map((b) => b.textContent),
    ).toEqual(["AC", "CO"]);
    (document.querySelectorAll(".rail button")[0] as HTMLElement).click();
    expect(storage.getItem("game-companion:v1:layout:hA")).toBe(saved);
  });

  it("never shows the previous game's achievements under a new title", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".rail .rail-count")?.textContent).toBe("2");
    api.achievements = async () => {
      throw new Error("down");
    };
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect($(".rail .rail-count")?.textContent).toBe("");
    expect($(".ach-message")?.textContent).toBe("Achievements unavailable");
  });

  it("picks up the guide when the index becomes available after the page loaded", async () => {
    const api = fakeApi({ ...playing(hubA), hubs: [] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".game-note")?.textContent).toBe("No guide found");
    api.nowValue = playing(hubA);
    await app.tick();
    expect($(".game-note")?.textContent).toBe("");
    expect(document.querySelectorAll(".rail button")[1]?.textContent).toBe("AC");
  });

  it("refreshes achievements on later ticks once the interval has passed", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      achievementsPollMs: 0,
    });
    await app.ready;
    const before = api.achCalls.length;
    await app.tick();
    expect(api.achCalls.length).toBe(before + 1);
  });

  describe("rich presence", () => {
    const withPresence = (hub: GuideHub, text: string | null): NowResponse => ({
      ...playing(hub),
      presence: text,
    });
    const text = (): string | null | undefined => $(".game-presence")?.textContent;
    const hidden = (): unknown => $(".presence-row")?.hidden;
    const button = (): HTMLElement => $(".game-presence") as HTMLElement;
    const expanded = (): boolean => button().classList.contains("expanded");
    const ariaExpanded = (): string | null => button().getAttribute("aria-expanded");

    it("sits in its own row between the header and the switch banner, hidden until it has text", async () => {
      const app = startApp({
        doc: document,
        api: fakeApi(playing(hubA)),
        storage: memory(),
        setInterval: noTimers,
      });
      await app.ready;
      expect([...document.querySelectorAll(".topbar > *")].map((e) => e.className)).toEqual([
        "game-title",
        "game-note",
      ]);
      const row = $(".presence-row") as HTMLElement;
      expect(row.previousElementSibling).toBe($(".topbar"));
      expect(row.nextElementSibling).toBe($(".switch-banner"));
      expect([...row.children]).toEqual([button(), $(".presence-jump")]);
      expect(button().tagName).toBe("BUTTON");
      expect(button().getAttribute("type")).toBe("button");
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
      expect(ariaExpanded()).toBe("false");
      expect(expanded()).toBe(false);
    });

    describe("expanding", () => {
      const long = "Chapter 2: Sample Caves, a deliberately long line for the sample game";
      async function started(line: string | null = long) {
        const api = fakeApi(withPresence(hubA, line));
        const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
        await app.ready;
        return { api, app };
      }

      it("starts collapsed, expands on a click and collapses on a second click", async () => {
        await started();
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
        button().click();
        expect(expanded()).toBe(true);
        expect(ariaExpanded()).toBe("true");
        expect(text()).toBe(long);
        button().click();
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
      });

      it("stays expanded across a poll that brings new text for the same game", async () => {
        const { api, app } = await started();
        button().click();
        api.nowValue = withPresence(hubA, "Chapter 3: Sample Keep");
        await app.tick();
        expect(text()).toBe("Chapter 3: Sample Keep");
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(true);
        expect(ariaExpanded()).toBe("true");
      });

      it("collapses when the line clears, and starts collapsed when it returns", async () => {
        const { api, app } = await started();
        button().click();
        api.nowValue = withPresence(hubA, null);
        await app.tick();
        expect(hidden()).toBe(true);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
        api.nowValue = withPresence(hubA, long);
        await app.tick();
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
      });

      it("collapses when the state leaves playing", async () => {
        const { api, app } = await started();
        button().click();
        api.nowValue = { ...withPresence(hubA, long), state: "last-played" };
        await app.tick();
        expect(hidden()).toBe(true);
        expect(expanded()).toBe(false);
        api.nowValue = withPresence(hubA, long);
        await app.tick();
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
      });

      it("collapses when a now request fails", async () => {
        const { api, app } = await started();
        button().click();
        api.failNow = true;
        await app.tick();
        expect(hidden()).toBe(true);
        expect(expanded()).toBe(false);
        api.failNow = false;
        await app.tick();
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
      });

      it("collapses when another game is picked by hand", async () => {
        const { app } = await started();
        button().click();
        (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
        ($('[data-tab="games"]') as HTMLElement).click();
        (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
        await app.tick();
        expect($(".game-title")?.textContent).toBe("Zeta");
        expect(hidden()).toBe(true);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
      });

      it("does nothing else: no request, no picker, no slot change", async () => {
        const { api } = await started();
        const now = vi.spyOn(api, "now");
        const guides = vi.spyOn(api, "guides");
        const hubTree = vi.spyOn(api, "hubTree");
        const before = [api.achCalls.length, api.markCalls.length, api.findCalls.length];
        const active = (): number[] =>
          [...document.querySelectorAll(".rail button")].flatMap((b, i) =>
            b.classList.contains("active") ? [i] : [],
          );
        const slots = active();
        button().click();
        button().click();
        await new Promise((r) => setTimeout(r, 0));
        expect(now).not.toHaveBeenCalled();
        expect(guides).not.toHaveBeenCalled();
        expect(hubTree).not.toHaveBeenCalled();
        expect([api.achCalls.length, api.markCalls.length, api.findCalls.length]).toEqual(before);
        expect(($(".picker") as HTMLElement).hidden).toBe(true);
        expect(active()).toEqual(slots);
      });
    });

    it("shows the status line of the detected game that is being played and on screen", async () => {
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(text()).toBe("Chapter 2: Sample Caves");
      expect(hidden()).toBe(false);
    });

    it("hides it when the state is last-played", async () => {
      const api = fakeApi({
        ...withPresence(hubA, "Chapter 2: Sample Caves"),
        state: "last-played",
      });
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
    });

    it("hides it when a different game was picked by hand while the detected one is playing", async () => {
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(hidden()).toBe(false);
      (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
      ($('[data-tab="games"]') as HTMLElement).click();
      (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
      await app.tick();
      expect($(".game-title")?.textContent).toBe("Zeta");
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
      await app.tick();
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
    });

    it("follows the next poll: new text replaces the old, null clears it", async () => {
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      api.nowValue = withPresence(hubA, "Chapter 3: Sample Keep");
      await app.tick();
      expect(text()).toBe("Chapter 3: Sample Keep");
      expect(hidden()).toBe(false);
      api.nowValue = withPresence(hubA, null);
      await app.tick();
      expect(text()).toBe("");
      expect(hidden()).toBe(true);
    });

    it("clears at once when the game on screen changes, before the new game's data arrives", async () => {
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(hidden()).toBe(false);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      api.hubTree = async (id) => {
        await gate;
        return tree(id === "hA" ? hubA : hubZ);
      };
      (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
      ($('[data-tab="games"]') as HTMLElement).click();
      (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
      const switching = app.tick();
      await new Promise((r) => setTimeout(r, 0));
      // The new game's guide is still loading: nothing of the old game's status may remain.
      expect(text()).toBe("");
      expect(hidden()).toBe(true);
      release();
      await switching;
      expect(text()).toBe("");
    });

    describe("with a poll in flight", () => {
      const hubB: GuideHub = { ...hubA, hubId: "hB", title: "Beta", gameId: "21" };
      const hubSameId: GuideHub = {
        ...hubA,
        hubId: "hS",
        title: "Sigma",
        source: "steam",
        platformLabel: "Steam",
      };
      const treeOf = (id: string): HubTreeResponse =>
        tree([hubA, hubB, hubSameId, hubZ].find((h) => h.hubId === id) ?? hubA);

      async function start(detected: NowResponse, listed: GuideHub[]) {
        const api = fakeApi(detected);
        api.guides = async () => ({ available: true, hubs: listed });
        api.hubTree = async (id) => treeOf(id);
        const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
        await app.ready;
        let release: () => void = () => {};
        const hold = (): void => {
          const gate = new Promise<void>((r) => {
            release = r;
          });
          api.now = async () => {
            await gate;
            return api.nowValue;
          };
        };
        return { api, app, hold, release: () => release() };
      }
      const pickByHand = (index: number): void => {
        (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
        ($('[data-tab="games"]') as HTMLElement).click();
        (document.querySelectorAll(".picker-games .picker-item")[index] as HTMLElement).click();
      };

      it("keeps the old game's line away from the new title while a hand-picked game waits", async () => {
        const t = await start(withPresence(hubA, "Chapter 2: Sample Caves"), [hubA, hubB]);
        expect(text()).toBe("Chapter 2: Sample Caves");
        t.hold();
        const polling = t.app.tick();
        await new Promise((r) => setTimeout(r, 0)); // the poll is now waiting on the held request
        pickByHand(1);
        expect($(".game-title")?.textContent).toBe("Beta");
        expect($(".game-note")?.textContent).toBe("Loading…");
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
        t.api.nowValue = withPresence(hubA, "Chapter 3: Sample Keep");
        t.release();
        await polling;
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
        await t.app.tick();
        expect($(".game-title")?.textContent).toBe("Beta");
        // The detected game is still Alpha, so Beta shows nothing.
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
      });

      it("collapses while a queued load's title is showing, and starts collapsed afterwards", async () => {
        const t = await start(withPresence(hubA, "Chapter 2: Sample Caves"), [hubA, hubB]);
        button().click();
        expect(expanded()).toBe(true);
        t.hold();
        const polling = t.app.tick();
        await new Promise((r) => setTimeout(r, 0));
        pickByHand(1);
        expect($(".game-note")?.textContent).toBe("Loading…");
        expect(hidden()).toBe(true);
        expect(expanded()).toBe(false);
        expect(ariaExpanded()).toBe("false");
        t.release();
        await polling;
        pickByHand(0);
        t.api.nowValue = withPresence(hubA, "Chapter 3: Sample Keep");
        await t.app.tick();
        expect(hidden()).toBe(false);
        expect(expanded()).toBe(false);
      });

      it("keeps it hidden while the banner's Switch waits, then applies the rule to the new game", async () => {
        const t = await start(withPresence(hubA, "Chapter 2: Sample Caves"), [hubA, hubB]);
        t.api.nowValue = withPresence(hubB, "Area 1: Sample Shore");
        await t.app.tick();
        expect($(".switch-banner")?.hidden).toBe(false);
        expect(hidden()).toBe(true);
        t.hold();
        const polling = t.app.tick();
        await new Promise((r) => setTimeout(r, 0)); // the poll is now waiting on the held request
        ($(".switch-banner .switch-accept") as HTMLElement).click();
        expect($(".game-title")?.textContent).toBe("Beta");
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
        // The poll in flight comes back about the old game, with a fresh status line.
        t.api.nowValue = withPresence(hubA, "Chapter 3: Sample Keep");
        t.release();
        await polling;
        expect($(".game-title")?.textContent).toBe("Beta");
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
        await t.app.tick();
        // Beta is on screen but the newest answer is about Alpha.
        expect(text()).toBe("");
        expect(hidden()).toBe(true);
        t.api.nowValue = withPresence(hubB, "Area 2: Sample Cliffs");
        await t.app.tick();
        expect(text()).toBe("Area 2: Sample Cliffs");
        expect(hidden()).toBe(false);
      });

      it("shows the line again once a hand-picked game that is the detected one has loaded", async () => {
        const t = await start(withPresence(hubB, "Area 1: Sample Shore"), [hubB, hubA]);
        expect(text()).toBe("Area 1: Sample Shore");
        pickByHand(1);
        await t.app.tick();
        expect($(".game-title")?.textContent).toBe("Alpha");
        expect(hidden()).toBe(true);
        pickByHand(0);
        await t.app.tick();
        expect($(".game-title")?.textContent).toBe("Beta");
        expect(text()).toBe("Area 1: Sample Shore");
      });
    });

    it("hides it for another RetroAchievements game with a different id", async () => {
      const hubB: GuideHub = { ...hubA, hubId: "hB", title: "Beta", gameId: "21" };
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      api.guides = async () => ({ available: true, hubs: [hubA, hubB] });
      api.hubTree = async (id) => tree(id === "hB" ? hubB : hubA);
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(hidden()).toBe(false);
      (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
      (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
      await app.tick();
      expect($(".game-title")?.textContent).toBe("Beta");
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
    });

    it("hides it for the same game id under the other source", async () => {
      const sameId: GuideHub = {
        ...hubA,
        hubId: "hS",
        title: "Sigma",
        source: "steam",
        platformLabel: "Steam",
      };
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      api.guides = async () => ({ available: true, hubs: [hubA, sameId] });
      api.hubTree = async (id) => tree(id === "hS" ? sameId : hubA);
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(hidden()).toBe(false);
      (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
      (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
      await app.tick();
      expect($(".game-title")?.textContent).toBe("Sigma");
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
    });

    it("is cleared when a poll fails and shown again when the next one succeeds", async () => {
      const api = fakeApi(withPresence(hubA, "Chapter 2: Sample Caves"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      api.failNow = true;
      await app.tick();
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
      api.failNow = false;
      await app.tick();
      expect(text()).toBe("Chapter 2: Sample Caves");
    });

    it("shows nothing, and throws nothing, when the server sends no presence field", async () => {
      const old = playing(hubA) as Partial<NowResponse>;
      delete old.presence;
      const api = fakeApi(old as NowResponse);
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      await app.tick();
      expect(hidden()).toBe(true);
      expect(text()).toBe("");
    });

    it("shows markup in the text literally and creates no element", async () => {
      const api = fakeApi(withPresence(hubA, "<b>x</b> & <img src=x>"));
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      expect(text()).toBe("<b>x</b> & <img src=x>");
      expect($(".game-presence")?.children).toHaveLength(0);
      expect(
        document.querySelector(".topbar b, .topbar img, .presence-row b, .presence-row img"),
      ).toBeNull();
    });
  });

  it("keeps the current game on screen when a poll fails", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.failNow = true;
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect($(".game-note")?.textContent).toBe("Connection lost · showing older data");
  });

  it("shows an error state when the very first load fails", async () => {
    const api = fakeApi(playing(hubA));
    api.failNow = true;
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".game-note")?.textContent).toBe("Cannot reach the companion service");
  });

  it("adopts a game that appears while nothing was loaded, closing the picker without a banner", async () => {
    const api = fakeApi({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".picker")?.hidden).toBe(false);
    api.nowValue = playing(hubA);
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect($(".picker")?.hidden).toBe(true);
    expect($(".switch-banner")?.hidden).toBe(true);
    expect(api.achCalls).toContain("ra:20");
  });

  it("does not raise a banner while the guide chooser is open", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".picker")?.hidden).toBe(false);
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(true);
    expect($(".picker")?.hidden).toBe(false);
  });

  it("loads the detected game without a guide when the chooser is closed without choosing", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    ($(".picker-close") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect(api.achCalls).toEqual(["ra:20"]);
    expect($(".game-note")?.textContent).toBe("No guide selected");
    expect($(".picker")?.hidden).toBe(true);
    await app.tick();
    await app.tick();
    expect($(".picker")?.hidden).toBe(true);
    expect($(".switch-banner")?.hidden).toBe(true);
    expect($(".game-note")?.textContent).toBe("No guide selected");
    // The guide can still be chosen from the games list.
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    ($('[data-tab="games"]') as HTMLElement).click();
    expect(document.querySelectorAll(".picker-games .picker-item")).toHaveLength(2);
  });

  it("offers a dismissed game again after the game has stopped and started", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-dismiss") as HTMLElement).click();
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(true);
    api.nowValue = {
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    };
    await app.tick();
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(false);
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Zeta");
  });

  it("fills the picker with the new game's pages as soon as it loads", async () => {
    const api = fakeApi(playing(hubA));
    api.hubTree = async (id) =>
      id === "hA"
        ? tree(hubA)
        : {
            hub: hubZ,
            pages: [{ title: "Zeta Walkthrough", url: "/doc/z-walk", children: [] }],
            defaultPins: [],
          };
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    ($('[data-tab="pages"]') as HTMLElement).click();
    const titles = [...document.querySelectorAll(".picker-pages .picker-item")].map(
      (i) => i.querySelector(".picker-title")?.textContent,
    );
    expect(titles).toEqual(["Zeta Walkthrough"]);
  });

  it("removes a pinned page from the sidebar and remembers that across a reload", async () => {
    const storage = memory();
    const app = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await app.ready;
    (document.querySelectorAll(".rail button")[1] as HTMLElement).click();
    expect($("iframe:not(.inactive)")?.getAttribute("src")).toBe("/doc/hA-checklist");
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    const remove = $(".picker-pages .picker-unpin") as HTMLElement;
    expect(remove.getAttribute("aria-label")).toBe("Remove Achievement Checklist from the sidebar");
    remove.click();
    expect($(".picker")?.hidden).toBe(false);
    expect($(".picker-pages .picker-unpin")).toBeNull();
    expect($(".picker-pages .picker-item.pinned")).toBeNull();
    const slot = document.querySelectorAll(".rail button")[1] as HTMLButtonElement;
    expect(slot.textContent).toBe("");
    expect(slot.disabled).toBe(true);
    expect(slot.hidden).toBe(true);
    expect($(".ach")?.hidden).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    const stored = JSON.parse(storage.getItem("game-companion:v1:layout:hA") as string) as {
      slots: unknown[];
    };
    expect(stored.slots[0]).toBeNull();

    document.body.innerHTML = '<main id="app"></main>';
    const again = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await again.ready;
    expect((document.querySelectorAll(".rail button")[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes the gap when an earlier page is removed, without reloading the page being read", async () => {
    const storage = memory();
    const app = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await app.ready;
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    (document.querySelectorAll(".picker-pages .picker-item")[1] as HTMLElement).click(); // pin + show Collectibles in slot 1
    const reading = $("iframe:not(.inactive)");
    expect(reading?.getAttribute("src")).toBe("/doc/hA-coll");
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    ($(".picker-pages .picker-unpin") as HTMLElement).click(); // removes Achievement Checklist (slot 0)
    const rail = [...document.querySelectorAll<HTMLButtonElement>(".rail button")];
    expect(rail.slice(1, 5).map((b) => b.textContent)).toEqual(["CO", "", "", ""]);
    expect(rail.slice(1, 5).map((b) => b.hidden)).toEqual([false, true, true, true]);
    expect(rail[1]?.classList.contains("active")).toBe(true);
    expect($("iframe:not(.inactive)")).toBe(reading);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const stored = JSON.parse(storage.getItem("game-companion:v1:layout:hA") as string) as {
      slots: ({ url: string } | null)[];
      active: number;
    };
    expect(stored.slots.map((s) => s?.url ?? null)).toEqual(["/doc/hA-coll", null, null, null]);
    expect(stored.active).toBe(0);
  });

  it("clears the chooser when a poll that was in flight reopens it and a load then closes it", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".picker")?.hidden).toBe(false);
    let release: (now: NowResponse) => void = () => undefined;
    api.now = () => new Promise<NowResponse>((resolve) => (release = resolve));
    const inFlight = app.tick();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the poll reach the server
    // The user closes the chooser while that poll is still waiting for the server.
    ($(".picker-close") as HTMLElement).click();
    release({ ...playing(hubA), hubs: [hubA, twin] });
    api.now = async () => api.nowValue;
    await inFlight;
    await app.tick();
    expect($(".picker")?.hidden).toBe(true);
    // A new game must still be offered: nothing may be left waiting on a choice.
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(false);
    // And the games list is the full list again, not the two guides of that chooser.
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    ($('[data-tab="games"]') as HTMLElement).click();
    expect(
      [...document.querySelectorAll(".picker-games .picker-item .picker-title")].map(
        (i) => i.textContent,
      ),
    ).toEqual(["Alpha", "Zeta"]);
  });

  it("forgets a declined guide choice once another game has been shown", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    ($(".picker-close") as HTMLElement).click();
    await app.tick();
    expect($(".game-note")?.textContent).toBe("No guide selected");

    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");

    api.nowValue = { ...playing(hubA), hubs: [] };
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect($(".game-note")?.textContent).toBe("No guide found");

    // The guide appears later: it is adopted rather than ignored.
    api.nowValue = playing(hubA);
    await app.tick();
    expect(document.querySelectorAll(".rail button")[1]?.textContent).toBe("AC");
    expect($(".game-note")?.textContent).toBe("");
  });

  // ---- final-review fixes ----

  const achWithRow = (unlocked: number, stale = false): AchievementsResponse => ({
    source: "ra",
    id: "20",
    title: "t",
    total: 1,
    unlocked,
    stale,
    achievements: [
      {
        id: "a1",
        name: "First Steps",
        description: "d",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: 50,
        hidden: false,
        missable: false,
        kind: null,
      },
    ],
  });

  it("marks the panel as older data when a later refresh fails, and clears it on success", async () => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () => achWithRow(0);
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      achievementsPollMs: 0,
    });
    await app.ready;
    expect($(".ach-stale")).toBeNull();
    api.achievements = async () => {
      throw new Error("down");
    };
    await app.tick();
    expect($(".ach-stale")).not.toBeNull();
    expect(document.querySelectorAll(".ach-row")).toHaveLength(1);
    api.achievements = async () => achWithRow(0);
    await app.tick();
    expect($(".ach-stale")).toBeNull();
    expect(document.querySelectorAll(".ach-row")).toHaveLength(1);
  });

  it("re-fetches the guide list on ticks while it is unavailable, and when the picker opens", async () => {
    const api = fakeApi({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const calls: (boolean | undefined)[] = [];
    let list = { available: false, hubs: [] as GuideHub[] };
    api.guides = async (refresh) => {
      calls.push(refresh);
      return list;
    };
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect($(".picker-games .picker-empty")?.textContent).toBe("Guides are unavailable right now");
    list = { available: true, hubs: [hubA, hubZ] };
    await app.tick();
    expect(document.querySelectorAll(".picker-games .picker-item")).toHaveLength(2);
    // Available now: ticks stop re-fetching.
    const before = calls.length;
    await app.tick();
    expect(calls.length).toBe(before);
    // Opening the picker asks again, so a guide added since start shows up.
    const hubC: GuideHub = { ...hubZ, hubId: "hC", title: "Gamma", gameId: "30" };
    list = { available: true, hubs: [hubA, hubC, hubZ] };
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)).toBeUndefined();
    expect(document.querySelectorAll(".picker-games .picker-item")).toHaveLength(3);
  });

  it("keeps the guide list when a re-fetch fails", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.guides = async () => {
      throw new Error("down");
    };
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ($('[data-tab="games"]') as HTMLElement).click();
    expect(document.querySelectorAll(".picker-games .picker-item")).toHaveLength(2);
  });

  it("keeps the banner describing the game that is detected now", async () => {
    const hubC: GuideHub = { ...hubZ, hubId: "hC", title: "Gamma", gameId: "30" };
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-dismiss") as HTMLElement).click();
    api.nowValue = playing(hubC);
    await app.tick();
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Gamma");
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(true);
  });

  it("offers the game that is detected again, and accepting it loads that game", async () => {
    const hubC: GuideHub = { ...hubZ, hubId: "hC", title: "Gamma", gameId: "30" };
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    api.nowValue = playing(hubC);
    await app.tick();
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Gamma");
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Zeta");
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
  });

  it("hides the banner when nothing is detected any more", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(false);
    api.nowValue = {
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    };
    await app.tick();
    expect($(".switch-banner")?.hidden).toBe(true);
  });

  it("shows only the Games tab while a guide choice is pending", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    expect(($('[data-tab="pages"]') as HTMLElement).hidden).toBe(true);
    (document.querySelectorAll(".picker-games .picker-item")[0] as HTMLElement).click();
    await app.tick();
    expect(($('[data-tab="pages"]') as HTMLElement).hidden).toBe(false);
  });

  it("restores the Pages tab when the chooser is closed without a choice", async () => {
    const twin: GuideHub = { ...hubA, hubId: "hA2", title: "Alpha DLC" };
    const api = fakeApi({ ...playing(hubA), hubs: [hubA, twin] });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    ($(".picker-close") as HTMLElement).click();
    await app.tick();
    expect(($('[data-tab="pages"]') as HTMLElement).hidden).toBe(false);
  });

  it("keeps a hand-picked game when the first poll only succeeds afterwards", async () => {
    const api = fakeApi(playing(hubA));
    api.failNow = true;
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    api.failNow = false;
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect($(".picker")?.hidden).toBe(true);
    expect($(".switch-banner")?.hidden).toBe(false);
    expect($(".switch-banner .switch-label")?.textContent).toBe("Switch to Alpha");
  });

  it("retries a failed page tree on later ticks and then saves pins", async () => {
    const storage = memory();
    const api = fakeApi(playing(hubA));
    let fail = true;
    let treeCalls = 0;
    api.hubTree = async (id) => {
      treeCalls += 1;
      if (fail) throw new Error("down");
      return tree(id === "hA" ? hubA : hubZ);
    };
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    expect(treeCalls).toBe(1);
    expect(document.querySelectorAll(".picker-pages .picker-item")).toHaveLength(0);
    await app.tick();
    expect(treeCalls).toBe(2);
    fail = false;
    await app.tick();
    expect(treeCalls).toBe(3);
    expect(document.querySelectorAll(".picker-pages .picker-item")).toHaveLength(2);
    expect(
      [...document.querySelectorAll(".rail button")].slice(1, 3).map((b) => b.textContent),
    ).toEqual(["AC", ""]);
    // Loaded now: no more retries, and a pin is saved.
    await app.tick();
    expect(treeCalls).toBe(3);
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    (document.querySelectorAll(".picker-pages .picker-item")[1] as HTMLElement).click();
    expect(storage.getItem("game-companion:v1:layout:hA")).not.toBeNull();
  });

  it("does not reset the page being read, or the achievements, when the page tree is retried", async () => {
    const storage = memory();
    const first = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage,
      setInterval: noTimers,
    });
    await first.ready;
    (document.querySelectorAll(".rail button")[1] as HTMLElement).click(); // Achievement Checklist
    document.body.innerHTML = '<main id="app"></main>';
    const api = fakeApi(playing(hubA));
    let fail = true;
    api.hubTree = async (id) => {
      if (fail) throw new Error("down");
      return tree(id === "hA" ? hubA : hubZ);
    };
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    const reading = $("iframe:not(.inactive)");
    expect(reading?.getAttribute("src")).toBe("/doc/hA-checklist");
    const calls = api.achCalls.length;
    fail = false;
    await app.tick();
    expect($("iframe:not(.inactive)")).toBe(reading);
    expect(api.achCalls.length).toBe(calls);
    expect(document.querySelectorAll(".picker-pages .picker-item")).toHaveLength(2);
  });

  it("keeps a pin when its guide page was retitled, since only the slug of its path changed", async () => {
    const storage = memory();
    storage.setItem(
      "game-companion:v1:layout:hA",
      JSON.stringify({
        slots: [{ title: "Old Name", url: "/doc/old-name-ID1" }, null, null, null],
        active: 0,
      }),
    );
    const api = fakeApi(playing(hubA));
    api.hubTree = async () => ({
      hub: hubA,
      pages: [
        { title: "Achievement Checklist", url: "/doc/achievement-checklist-ID1", children: [] },
      ],
      defaultPins: ["Achievement Checklist"],
    });
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    expect(document.querySelectorAll(".rail button")[1]?.textContent).toBe("AC");
    expect($("iframe:not(.inactive)")?.getAttribute("src")).toBe("/doc/achievement-checklist-ID1");
  });

  it("shows the chosen game and Loading… at once when a poll is still running", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    let release: (now: NowResponse) => void = () => undefined;
    api.now = () => new Promise<NowResponse>((resolve) => (release = resolve));
    const inFlight = app.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.querySelectorAll(".rail button")[5] as HTMLElement).click();
    ($('[data-tab="games"]') as HTMLElement).click();
    (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect($(".game-note")?.textContent).toBe("Loading…");
    api.now = async () => api.nowValue;
    release(playing(hubA));
    await inFlight;
    // The finished poll must not undo the feedback while the load is still queued.
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(api.achCalls).toContain("steam:10");
    expect($(".game-note")?.textContent).not.toBe("Loading…");
  });

  it("shows the offered game and Loading… at once when the banner is accepted during a poll", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    let release: (now: NowResponse) => void = () => undefined;
    api.now = () => new Promise<NowResponse>((resolve) => (release = resolve));
    const inFlight = app.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect($(".game-note")?.textContent).toBe("Loading…");
    api.now = async () => api.nowValue;
    release(playing(hubZ));
    await inFlight;
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
  });

  it("restores the achievements scroll position after a guide page was opened and closed", async () => {
    const app = startApp({
      doc: document,
      api: fakeApi(playing(hubA)),
      storage: memory(),
      setInterval: noTimers,
    });
    await app.ready;
    const ach = $(".ach") as HTMLElement;
    Object.defineProperty(ach, "scrollTop", { value: 0, writable: true, configurable: true });
    ach.scrollTop = 120;
    (document.querySelectorAll(".rail button")[1] as HTMLElement).click();
    expect(ach.hidden).toBe(true);
    ach.scrollTop = 0; // what a browser may do to an element that is not rendered
    (document.querySelectorAll(".rail button")[0] as HTMLElement).click();
    expect(ach.scrollTop).toBe(120);
  });

  it("starts the achievements list at the top for a different game", async () => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    const ach = $(".ach") as HTMLElement;
    Object.defineProperty(ach, "scrollTop", { value: 0, writable: true, configurable: true });
    ach.scrollTop = 120;
    (document.querySelectorAll(".rail button")[1] as HTMLElement).click();
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    ach.scrollTop = 0;
    (document.querySelectorAll(".rail button")[0] as HTMLElement).click();
    expect(ach.scrollTop).toBe(0);
  });
});

// ---- find in guide, guide-marked missables, unlock notice ----

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const mk = (id: string, name: string, unlocked = false): Achievement => ({
  id,
  name,
  description: null,
  icon: null,
  unlocked,
  unlockedAt: null,
  unlockPercent: 10,
  hidden: false,
  missable: false,
  kind: null,
});
const board = (list: Achievement[]): AchievementsResponse => ({
  source: "ra",
  id: "20",
  title: "t",
  total: list.length,
  unlocked: list.filter((a) => a.unlocked).length,
  stale: false,
  achievements: list,
});
const boardZ = (list: Achievement[]): AchievementsResponse => ({
  ...board(list),
  source: "steam",
  id: "10",
});

interface Timers {
  set: typeof setTimeout;
  calls: { fn: () => void; ms: number }[];
}
function timers(): Timers {
  const calls: Timers["calls"] = [];
  const set = ((fn: () => void, ms: number) => {
    calls.push({ fn, ms });
    return calls.length;
  }) as unknown as typeof setTimeout;
  return { set, calls };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const missableToggle = (): HTMLElement => $(".ach-missable-only") as HTMLElement;
const toast = (): HTMLElement => $(".toast") as HTMLElement;
const railButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(".rail button"),
];

describe("guide marks", () => {
  const start = async (
    api: Fake,
    resp: AchievementsResponse,
    extra: Partial<Parameters<typeof startApp>[0]> = {},
  ) => {
    api.achievements = async () => resp;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      ...extra,
    });
    await app.ready;
    await flush();
    return app;
  };

  it("makes a named achievement missable, ignoring case, without changing the response", async () => {
    const api = fakeApi(playing(hubA));
    api.marks = async (hubId) => {
      api.markCalls.push(hubId);
      return { missable: ["first steps", "no such name"] };
    };
    const resp = board([mk("a1", "First Steps"), mk("a2", "Other")]);
    const snapshot = JSON.stringify(resp);
    await start(api, resp);
    expect(api.markCalls).toEqual(["hA"]);
    expect(missableToggle().hidden).toBe(false);
    const missable = [...document.querySelectorAll(".ach-locked .ach-row")].filter(
      (r) => r.querySelector(".ach-missable") !== null,
    );
    expect(missable.map((r) => r.querySelector(".ach-name")?.textContent)).toEqual(["First Steps"]);
    expect(JSON.stringify(resp)).toBe(snapshot);
    expect(resp.achievements[0]?.missable).toBe(false);
  });

  it("leaves the response alone even when it is frozen", async () => {
    const api = fakeApi(playing(hubA));
    api.marks = async () => ({ missable: ["first steps"] });
    const resp = board([mk("a1", "First Steps")]);
    resp.achievements.forEach((a) => Object.freeze(a));
    Object.freeze(resp.achievements);
    Object.freeze(resp);
    await start(api, resp);
    expect(missableToggle().hidden).toBe(false);
  });

  it("applies marks that arrive after the achievements are already shown", async () => {
    const api = fakeApi(playing(hubA));
    const late = deferred<GuideMarksResponse | null>();
    api.marks = () => late.promise;
    const resp = board([mk("a1", "First Steps")]);
    await start(api, resp);
    expect(missableToggle().hidden).toBe(true);
    expect(document.querySelectorAll(".ach-row")).toHaveLength(1);
    late.resolve({ missable: ["first steps"] });
    await flush();
    expect(missableToggle().hidden).toBe(false);
    expect(document.querySelector(".ach-row .ach-missable")).not.toBeNull();
    expect(resp.achievements[0]?.missable).toBe(false);
  });

  it("keeps the older-data marker when marks arrive after a failed refresh", async () => {
    const api = fakeApi(playing(hubA));
    const late = deferred<GuideMarksResponse | null>();
    api.marks = () => late.promise;
    const app = await start(api, board([mk("a1", "First Steps")]), { achievementsPollMs: 0 });
    api.achievements = async () => {
      throw new Error("down");
    };
    await app.tick();
    expect($(".ach-stale")).not.toBeNull();
    late.resolve({ missable: ["first steps"] });
    await flush();
    expect($(".ach-stale")).not.toBeNull();
    expect(missableToggle().hidden).toBe(false);
  });

  it("keeps the marks across later refreshes of the same game", async () => {
    const api = fakeApi(playing(hubA));
    api.marks = async () => ({ missable: ["first steps"] });
    const resp = board([mk("a1", "First Steps")]);
    let fetched = 0;
    const app = await start(api, resp, { achievementsPollMs: 0 });
    api.achievements = async () => {
      fetched += 1;
      return resp;
    };
    await app.tick();
    expect(fetched).toBe(1);
    expect(missableToggle().hidden).toBe(false);
  });

  it.each([
    ["is null", async () => null],
    [
      "fails",
      async (): Promise<GuideMarksResponse | null> => {
        throw new Error("down");
      },
    ],
  ])("shows no marks when the marks request %s", async (_name, marks) => {
    const api = fakeApi(playing(hubA));
    api.marks = marks;
    await start(api, board([mk("a1", "First Steps")]));
    expect(missableToggle().hidden).toBe(true);
    expect(document.querySelector(".ach-missable")).toBeNull();
    expect(document.querySelectorAll(".ach-row")).toHaveLength(1);
  });

  it("asks only after the page tree has loaded, and again once a failed tree is retried", async () => {
    const api = fakeApi(playing(hubA));
    let fail = true;
    api.hubTree = async () => {
      if (fail) throw new Error("down");
      return tree(hubA);
    };
    api.marks = async (hubId) => {
      api.markCalls.push(hubId);
      return { missable: ["first steps"] };
    };
    const app = await start(api, board([mk("a1", "First Steps")]));
    expect(api.markCalls).toEqual([]);
    expect(missableToggle().hidden).toBe(true);
    fail = false;
    await app.tick();
    await flush();
    expect(api.markCalls).toEqual(["hA"]);
    expect(missableToggle().hidden).toBe(false);
  });

  it("ignores entries that are not strings", async () => {
    const api = fakeApi(playing(hubA));
    api.marks = async () =>
      ({
        missable: [5, null, { a: 1 }, ["first steps"], "first steps"],
      }) as unknown as GuideMarksResponse;
    await start(api, board([mk("a1", "First Steps"), mk("a2", "Other")]));
    expect(missableToggle().hidden).toBe(false);
    expect(document.querySelectorAll(".ach-locked .ach-row .ach-missable")).toHaveLength(1);
  });

  it("does not ask for a game without a guide", async () => {
    const api = fakeApi({ ...playing(hubA), hubs: [] });
    await start(api, board([mk("a1", "First Steps")]));
    expect(api.markCalls).toEqual([]);
  });

  it("discards the marks when the game changes, and ignores a late answer for the old game", async () => {
    const api = fakeApi(playing(hubA));
    const lateForZ = deferred<GuideMarksResponse | null>();
    api.marks = async (hubId) => {
      api.markCalls.push(hubId);
      return hubId === "hA" ? { missable: ["shared name"] } : lateForZ.promise;
    };
    const app = await start(api, board([mk("a1", "Shared Name")]));
    expect(missableToggle().hidden).toBe(false);
    api.achievements = async () => boardZ([mk("z1", "Shared Name")]);
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    await flush();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(api.markCalls).toEqual(["hA", "hZ"]);
    expect(missableToggle().hidden).toBe(true);
    expect(document.querySelector(".ach-missable")).toBeNull();
    lateForZ.resolve({ missable: ["shared name"] });
    await flush();
    expect(missableToggle().hidden).toBe(false);
  });

  it("ignores marks of the previous game that arrive after the next game has loaded", async () => {
    const api = fakeApi(playing(hubA));
    const lateForA = deferred<GuideMarksResponse | null>();
    api.marks = async (hubId) => (hubId === "hA" ? lateForA.promise : null);
    const app = await start(api, board([mk("a1", "Shared Name")]));
    api.achievements = async () => boardZ([mk("z1", "Shared Name")]);
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    await flush();
    lateForA.resolve({ missable: ["shared name"] });
    await flush();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(missableToggle().hidden).toBe(true);
  });
});

describe("find in guide: enabling", () => {
  const expandFirst = (): void => {
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
  };
  const start = async (api: Fake) => {
    api.achievements = async () => board([mk("a1", "First Steps")]);
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    return app;
  };

  it("offers the action while a guide with pages is loaded", async () => {
    await start(fakeApi(playing(hubA)));
    expandFirst();
    expect(document.querySelectorAll(".ach-find")).toHaveLength(1);
  });

  it("does not offer it for a game without a guide", async () => {
    await start(fakeApi({ ...playing(hubA), hubs: [] }));
    expandFirst();
    expect(document.querySelectorAll(".ach-row.expanded")).toHaveLength(1);
    expect(document.querySelector(".ach-find")).toBeNull();
  });

  it("does not offer it when the guide has no pages", async () => {
    const api = fakeApi(playing(hubA));
    api.hubTree = async () => ({ hub: hubA, pages: [], defaultPins: [] });
    await start(api);
    expandFirst();
    expect(document.querySelector(".ach-find")).toBeNull();
  });

  it("offers it only once a page tree that failed has loaded", async () => {
    const api = fakeApi(playing(hubA));
    let fail = true;
    api.hubTree = async () => {
      if (fail) throw new Error("down");
      return tree(hubA);
    };
    const app = await start(api);
    expandFirst();
    expect(document.querySelector(".ach-find")).toBeNull();
    fail = false;
    await app.tick();
    expect(document.querySelectorAll(".ach-find")).toHaveLength(1);
  });

  it("withdraws it when the game changes to one without a guide", async () => {
    const api = fakeApi(playing(hubA));
    const app = await start(api);
    api.nowValue = { ...playing(hubZ), hubs: [] };
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expandFirst();
    expect(document.querySelector(".ach-find")).toBeNull();
  });
});

describe("find in guide", () => {
  const page = (hub: GuideHub, suffix: string): string => `/doc/${hub.hubId}-${suffix}`;
  const match = (url: string, over: Partial<FindMatch> = {}): FindMatch => ({
    pageTitle: "Collectibles",
    pageUrl: url,
    heading: "Chapter One",
    snippet: "the First Steps are here",
    ...over,
  });
  const frameDocs = new Map<string, Document>();
  const docWith = (text: string): Document =>
    new DOMParser().parseFromString(`<!doctype html><body><p>${text}</p></body>`, "text/html");

  beforeEach(() => {
    frameDocs.clear();
    vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      return frameDocs.get(this.getAttribute("src") ?? "") ?? null;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const loadFrames = (): void => {
    for (const f of document.querySelectorAll("iframe")) f.dispatchEvent(new Event("load"));
  };
  const sectioned = (): Document =>
    new DOMParser().parseFromString(
      "<!doctype html><body><h2>Chapter One</h2><p id='one'>the First Steps, one</p>" +
        "<h2>Chapter Two</h2><p id='two'>the First Steps, two</p></body>",
      "text/html",
    );

  const start = async (
    answer: FindResponse | null | Error,
    tm = timers(),
    achievementName = "First Steps",
    storage = memory(),
  ) => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () => board([mk("a1", achievementName)]);
    api.find = async (hubId, query) => {
      api.findCalls.push([hubId, query]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const app = startApp({
      doc: document,
      api,
      storage,
      setInterval: noTimers,
      setTimeout: tm.set,
    });
    await app.ready;
    return { api, app, tm, storage };
  };
  const find = async (): Promise<void> => {
    if (document.querySelector(".ach-find") === null) {
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    }
    (document.querySelector(".ach-find") as HTMLElement).click();
    await flush();
  };
  const shown = (): string[] =>
    [...document.querySelectorAll("iframe:not(.inactive)")].map((f) => f.getAttribute("src") ?? "");

  it("asks the server for the achievement's name in the loaded guide", async () => {
    const { api } = await start({ matches: [], truncated: false });
    await find();
    expect(api.findCalls).toEqual([["hA", "First Steps"]]);
  });

  it("tells the user when the search fails", async () => {
    await start(new Error("down"));
    await find();
    expect(toast().hidden).toBe(false);
    expect(toast().querySelector(".toast-text")?.textContent).toBe("Could not search the guide");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it.each([
    ["the guide is unknown", null],
    ["there are no matches", { matches: [], truncated: false }],
  ])("says so when %s", async (_name, answer) => {
    await start(answer);
    await find();
    expect(toast().hidden).toBe(false);
    expect(toast().querySelector(".toast-text")?.textContent).toBe("Not found in this guide");
    expect(document.querySelector("iframe")).toBeNull();
    expect($(".picker")?.hidden).toBe(true);
  });

  it("opens a single match in a slot and finds the text in it", async () => {
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith("Get the first steps trophy"));
    await start({ matches: [match(url)], truncated: false });
    await find();
    await flush();
    // Find passes the match's heading as a hint and searches as text, never as a heading.
    expect(locateCalls.map((c) => c.slice(1))).toEqual([["First Steps", "Chapter One", "text"]]);
    expect(shown()).toEqual([url]);
    expect($(".ach")?.hidden).toBe(true);
    expect($(".picker")?.hidden).toBe(true);
    expect(toast().hidden).toBe(true);
    // The page is pinned under the title the match gave it.
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Collectibles");
  });

  it("switches to the slot of a page that is already pinned instead of pinning it twice", async () => {
    const url = page(hubA, "checklist");
    frameDocs.set(url, docWith("first steps"));
    await start({
      matches: [match(url, { pageTitle: "Achievement Checklist" })],
      truncated: false,
    });
    await find();
    await flush();
    expect(shown()).toEqual([url]);
    expect(railButtons()[1]?.classList.contains("active")).toBe(true);
    expect(
      railButtons()
        .slice(1, 5)
        .filter((b) => !b.hidden),
    ).toHaveLength(1);
  });

  it("saves the pinned page", async () => {
    const storage = memory();
    const api = fakeApi(playing(hubA));
    api.achievements = async () => board([mk("a1", "First Steps")]);
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith("first steps"));
    api.find = async () => ({ matches: [match(url)], truncated: false });
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    await find();
    const saved = JSON.parse(storage.getItem("game-companion:v1:layout:hA") as string) as {
      slots: ({ url: string } | null)[];
    };
    expect(saved.slots.map((s) => s?.url ?? null)).toContain(url);
  });

  it("tells the user when the page opened but the text is not in it", async () => {
    vi.useFakeTimers();
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith("nothing relevant"));
    const { tm } = await start({ matches: [match(url)], truncated: false });
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual([url]);
    loadFrames();
    expect(toast().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(toast().hidden).toBe(false);
    expect(toast().querySelector(".toast-text")?.textContent).toBe(
      "Opened the page, but could not find the text",
    );
    expect(tm.calls.at(-1)?.ms).toBe(6000);
  });

  it("offers several matches in the picker, and opens the one chosen", async () => {
    const one = page(hubA, "coll");
    const two = page(hubA, "checklist");
    frameDocs.set(two, docWith("first steps"));
    await start({
      matches: [
        match(one, { pageTitle: "Collectibles", snippet: "first" }),
        match(two, { pageTitle: "Achievement Checklist", heading: null, snippet: "second" }),
      ],
      truncated: true,
    });
    await find();
    expect($(".picker")?.hidden).toBe(false);
    expect($(".picker-matches-title")?.textContent).toBe("In the guide: First Steps");
    const items = [...document.querySelectorAll(".picker-matches .picker-item")];
    expect(items).toHaveLength(2);
    expect($(".picker-matches .picker-empty")?.textContent).toBe("More matches not shown");
    expect(document.querySelector("iframe")).toBeNull();
    (items[1] as HTMLElement).click();
    await flush();
    expect($(".picker")?.hidden).toBe(true);
    expect(shown()).toEqual([two]);
    expect(toast().hidden).toBe(true);
  });

  it("restores the picker's tabs afterwards", async () => {
    const one = page(hubA, "coll");
    await start({ matches: [match(one), match(page(hubA, "checklist"))], truncated: false });
    await find();
    (document.querySelector(".picker-close") as HTMLElement).click();
    railButtons().at(-1)?.click();
    expect([...document.querySelectorAll<HTMLElement>(".picker-tab")].every((t) => !t.hidden)).toBe(
      true,
    );
    expect(($(".picker-pages") as HTMLElement).hidden).toBe(false);
  });

  it.each([
    ["an unsafe address", "https://evil.example/doc/hA-coll"],
    ["a protocol-relative address", "//evil.example/doc/hA-coll"],
    ["an address outside /doc/", "/collection/hA-coll"],
  ])("ignores a match with %s", async (_name, url) => {
    await start({ matches: [match(url)], truncated: false });
    await find();
    await flush();
    expect(document.querySelector("iframe")).toBeNull();
    expect($(".ach")?.hidden).toBe(false);
    expect(toast().hidden).toBe(true);
    expect(
      railButtons()
        .slice(1, 5)
        .filter((b) => !b.hidden)
        .map((b) => b.textContent),
    ).toEqual(["AC"]);
  });

  it("ignores a match for a page whose own address is unsafe, even though the guide lists it", async () => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () => board([mk("a1", "First Steps")]);
    api.hubTree = async () => ({
      hub: hubA,
      pages: [{ title: "Odd", url: "https://evil.example/doc/odd", children: [] }],
      defaultPins: [],
    });
    api.find = async () => ({
      matches: [match("https://evil.example/doc/odd")],
      truncated: false,
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    await find();
    await flush();
    expect(document.querySelector("iframe")).toBeNull();
    expect(toast().hidden).toBe(true);
  });

  it("ignores an unsafe match chosen from several, and still opens a valid one", async () => {
    const good = page(hubA, "coll");
    frameDocs.set(good, docWith("first steps"));
    await start({
      matches: [match("javascript:alert(1)"), match(good)],
      truncated: false,
    });
    await find();
    const items = [...document.querySelectorAll(".picker-matches .picker-item")] as HTMLElement[];
    items[0]?.click();
    await flush();
    expect(document.querySelector("iframe")).toBeNull();
    await find();
    (document.querySelectorAll(".picker-matches .picker-item")[1] as HTMLElement).click();
    await flush();
    expect(shown()).toEqual([good]);
  });

  it.each([
    ["a missing guide", null],
    ["a match", { matches: [match("/doc/hA-coll")], truncated: false }],
    [
      "several matches",
      { matches: [match("/doc/hA-coll"), match("/doc/hA-checklist")], truncated: false },
    ],
    ["an error", new Error("down")],
  ])("drops %s when the game changed while the search was running", async (_name, answer) => {
    const late = deferred<FindResponse | null>();
    const { api, app, storage } = await start(null);
    api.find = () => late.promise;
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    if (answer instanceof Error) late.reject(answer);
    else late.resolve(answer);
    await flush();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(document.querySelector("iframe")).toBeNull();
    // Nothing of the old game's search may reach the new game: no pin saved for either game,
    // the achievements panel still showing, no frame for the old game's page.
    expect(storage.getItem("game-companion:v1:layout:hZ")).toBeNull();
    expect(storage.getItem("game-companion:v1:layout:hA")).toBeNull();
    expect(document.querySelector('iframe[src="/doc/hA-coll"]')).toBeNull();
    expect($(".ach")?.hidden).toBe(false);
    expect(railButtons()[0]?.classList.contains("active")).toBe(true);
    expect(toast().hidden).toBe(true);
    expect($(".picker")?.hidden).toBe(true);
    expect(document.querySelectorAll(".picker-matches .picker-item")).toHaveLength(0);
  });

  it("gives no could-not-find notice when a second find re-points the same full slot", async () => {
    vi.useFakeTimers();
    const pages = ["One", "Two", "Three", "Four", "Five", "Six"].map((title) => ({
      title,
      url: `/doc/hA-${title.toLowerCase()}`,
      children: [],
    }));
    const api = fakeApi(playing(hubA));
    api.achievements = async () => board([mk("a1", "First Steps"), mk("a2", "Second Quest")]);
    api.hubTree = async () => ({
      hub: hubA,
      pages,
      defaultPins: ["One", "Two", "Three", "Four"],
    });
    const answers = [pages[4] as (typeof pages)[number], pages[5] as (typeof pages)[number]];
    api.find = async () => ({
      matches: [match((answers.shift() as (typeof pages)[number]).url, { pageTitle: "Next" })],
      truncated: false,
    });
    frameDocs.set("/doc/hA-five", docWith("nothing relevant"));
    frameDocs.set("/doc/hA-six", docWith("the Second Quest is here"));
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: timers().set,
    });
    await app.ready;
    expect(
      railButtons()
        .slice(1, 5)
        .every((b) => !b.hidden),
    ).toBe(true);
    const tapFind = async (id: string): Promise<void> => {
      (document.querySelector(`.ach-row[data-id="${id}"]`) as HTMLElement).click();
      (
        document.querySelector(`.ach-row[data-id="${id}"] + .ach-actions .ach-find`) as HTMLElement
      ).click();
      await vi.advanceTimersByTimeAsync(0);
    };
    await tapFind("a1");
    expect(shown()).toEqual(["/doc/hA-five"]);
    await tapFind("a2");
    expect(shown()).toEqual(["/doc/hA-six"]);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    loadFrames();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(toast().hidden).toBe(true);
  });

  it("finds the text in the opened page without a notice", async () => {
    vi.useFakeTimers();
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith("Get the first steps trophy"));
    await start({ matches: [match(url)], truncated: false });
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    loadFrames();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(shown()).toEqual([url]);
    expect(toast().hidden).toBe(true);
  });

  describe("which occurrence on the page", () => {
    let scroll: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    const scrolledTo = (n: number): string => (scroll.mock.contexts[n] as Element).id;

    it("scrolls to the occurrence under the chosen match's heading, for a single match", async () => {
      vi.useFakeTimers();
      const url = page(hubA, "coll");
      frameDocs.set(url, sectioned());
      await start({ matches: [match(url, { heading: "Chapter Two" })], truncated: false });
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
      (document.querySelector(".ach-find") as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      loadFrames();
      await vi.advanceTimersByTimeAsync(0);
      expect(scrolledTo(0)).toBe("two");
    });

    it("uses the heading of the match picked from the list", async () => {
      vi.useFakeTimers();
      const url = page(hubA, "coll");
      frameDocs.set(url, sectioned());
      await start({
        matches: [
          match(url, { heading: "Chapter One", snippet: "one" }),
          match(url, { heading: "Chapter Two", snippet: "two" }),
        ],
        truncated: false,
      });
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
      (document.querySelector(".ach-find") as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      (document.querySelectorAll(".picker-matches .picker-item")[1] as HTMLElement).click();
      loadFrames();
      await vi.advanceTimersByTimeAsync(0);
      expect(scrolledTo(0)).toBe("two");
    });

    it("takes the first occurrence when the match has an empty or no heading", async () => {
      vi.useFakeTimers();
      const url = page(hubA, "coll");
      frameDocs.set(url, sectioned());
      await start({ matches: [match(url, { heading: "" })], truncated: false });
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
      (document.querySelector(".ach-find") as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      loadFrames();
      await vi.advanceTimersByTimeAsync(0);
      expect(scrolledTo(0)).toBe("one");
    });
  });

  it("shows no notice when the page is unpinned while the text is still being looked for", async () => {
    vi.useFakeTimers();
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith("nothing relevant"));
    await start({ matches: [match(url)], truncated: false });
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toEqual([url]);
    railButtons().at(-1)?.click();
    const unpin = [...document.querySelectorAll<HTMLElement>(".picker-pages .picker-item.pinned")]
      .map((i) => i.nextElementSibling as HTMLElement)
      .find((b) => b.getAttribute("aria-label") === "Remove Collectibles from the sidebar");
    (unpin as HTMLElement).click();
    expect(document.querySelector("iframe")).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(toast().hidden).toBe(true);
  });

  it("says the page could not be opened when the match is for a page the guide does not list", async () => {
    await start({ matches: [match("/doc/other-guide-page")], truncated: false });
    await find();
    expect(document.querySelector("iframe")).toBeNull();
    expect(toast().hidden).toBe(false);
    expect(toast().querySelector(".toast-text")?.textContent).toBe("Could not open that page");
  });

  it("says the same for such a match chosen from the list", async () => {
    await start({
      matches: [match("/doc/other-guide-page"), match(page(hubA, "coll"))],
      truncated: false,
    });
    await find();
    (document.querySelectorAll(".picker-matches .picker-item")[0] as HTMLElement).click();
    expect(toast().querySelector(".toast-text")?.textContent).toBe("Could not open that page");
  });

  it("keeps a guide chooser that opened while the search was running", async () => {
    const twin: GuideHub = { ...hubZ, hubId: "hZ2", title: "Zeta DLC" };
    const late = deferred<FindResponse | null>();
    const { api, app } = await start(null);
    api.find = () => late.promise;
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    api.nowValue = { ...playing(hubZ), hubs: [hubZ, twin] };
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect($(".picker")?.hidden).toBe(false);
    expect(($('[data-tab="pages"]') as HTMLElement).hidden).toBe(true);
    late.resolve({
      matches: [match(page(hubA, "coll")), match(page(hubA, "checklist"))],
      truncated: false,
    });
    await flush();
    expect(($(".picker-matches") as HTMLElement).hidden).toBe(true);
    expect(($(".picker-games") as HTMLElement).hidden).toBe(false);
    expect(
      [...document.querySelectorAll(".picker-games .picker-item .picker-title")].map(
        (i) => i.textContent,
      ),
    ).toEqual(["Zeta", "Zeta DLC"]);
    expect(($('[data-tab="pages"]') as HTMLElement).hidden).toBe(true);
    (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta DLC");
    expect($(".picker")?.hidden).toBe(true);
  });

  it("drops an answer that arrives while a load is queued behind a running poll", async () => {
    const late = deferred<FindResponse | null>();
    const { api, app } = await start(null);
    api.find = () => late.promise;
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    const poll = deferred<NowResponse>();
    api.now = () => poll.promise;
    const inFlight = app.tick();
    await flush();
    railButtons().at(-1)?.click();
    ($('[data-tab="games"]') as HTMLElement).click();
    (document.querySelectorAll(".picker-games .picker-item")[1] as HTMLElement).click();
    expect($(".game-title")?.textContent).toBe("Zeta");
    late.resolve({ matches: [], truncated: false });
    await flush();
    expect(toast().hidden).toBe(true);
    api.now = async () => api.nowValue;
    poll.resolve(playing(hubA));
    await inFlight;
    await app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
  });

  it("acts only on the answer to the most recent Find tap", async () => {
    const first = deferred<FindResponse | null>();
    const second = deferred<FindResponse | null>();
    const answers = [first, second];
    const { api } = await start(null);
    api.find = () => (answers.shift() as typeof first).promise;
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    const wanted = page(hubA, "coll");
    second.resolve({ matches: [match(wanted)], truncated: false });
    await flush();
    expect(shown()).toEqual([wanted]);
    first.resolve({ matches: [match(page(hubA, "checklist"))], truncated: false });
    await flush();
    expect(shown()).toEqual([wanted]);
    expect(toast().hidden).toBe(true);
  });

  it("drops an older error and an older none once a newer tap has been answered", async () => {
    const first = deferred<FindResponse | null>();
    const second = deferred<FindResponse | null>();
    const answers = [first, second];
    const { api } = await start(null);
    api.find = () => (answers.shift() as typeof first).promise;
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    second.resolve({ matches: [match(page(hubA, "coll"))], truncated: false });
    await flush();
    first.reject(new Error("down"));
    await flush();
    expect(toast().hidden).toBe(true);
  });

  it("does not call the server for a name shorter than two characters", async () => {
    const { api } = await start({ matches: [], truncated: false }, timers(), "Z");
    await find();
    expect(api.findCalls).toEqual([]);
    expect(toast().querySelector(".toast-text")?.textContent).toBe("Not found in this guide");
    expect(toast().hidden).toBe(false);
  });

  it("sends at most the first 100 characters, never splitting a surrogate pair, and looks for the same text", async () => {
    vi.useFakeTimers();
    const name = `${"x".repeat(99)}\u{1F600}tail`;
    const sent = `${"x".repeat(99)}\u{1F600}`;
    const url = page(hubA, "coll");
    frameDocs.set(url, docWith(`before ${sent} after`));
    const { api } = await start({ matches: [match(url)], truncated: false }, timers(), name);
    (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    (document.querySelector(".ach-find") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.findCalls).toEqual([["hA", sent]]);
    expect([...sent]).toHaveLength(100);
    loadFrames();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(shown()).toEqual([url]);
    // found: the shortened text, not the whole name, was looked for
    expect(toast().hidden).toBe(true);
  });

  it("leaves a name of exactly 100 characters whole", async () => {
    const name = "y".repeat(100);
    const { api } = await start({ matches: [], truncated: false }, timers(), name);
    await find();
    expect(api.findCalls).toEqual([["hA", name]]);
  });
});

describe("toast", () => {
  const start = async (tm = timers()) => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () => board([mk("a1", "First Steps")]);
    api.find = async () => null;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: tm.set,
    });
    await app.ready;
    return { tm, api, app };
  };
  const notFound = async (): Promise<void> => {
    if (document.querySelector(".ach-find") === null) {
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
    }
    (document.querySelector(".ach-find") as HTMLElement).click();
    await flush();
  };

  it("is one hidden element with a text child, inside the shell and not on the rail", async () => {
    await start();
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(toast().tagName).toBe("DIV");
    expect(toast().hidden).toBe(true);
    expect(toast().querySelector(".toast-text")).not.toBeNull();
    expect($("#app")?.contains(toast())).toBe(true);
    expect($(".rail")?.contains(toast())).toBe(false);
  });

  it("shows for six seconds by default through the injected timer, then hides", async () => {
    const { tm } = await start();
    await notFound();
    expect(toast().hidden).toBe(false);
    expect(tm.calls).toHaveLength(1);
    expect(tm.calls[0]?.ms).toBe(6000);
    tm.calls[0]?.fn();
    expect(toast().hidden).toBe(true);
  });

  it("is replaced by a newer toast, and the older timer then no longer hides it", async () => {
    const { tm } = await start();
    await notFound();
    await notFound();
    expect(tm.calls).toHaveLength(2);
    tm.calls[0]?.fn();
    expect(toast().hidden).toBe(false);
    tm.calls[1]?.fn();
    expect(toast().hidden).toBe(true);
  });

  it("hides when tapped, and a later toast shows again", async () => {
    const { tm } = await start();
    await notFound();
    toast().click();
    expect(toast().hidden).toBe(true);
    await notFound();
    expect(toast().hidden).toBe(false);
    // the timer of the tapped toast must not hide the new one
    tm.calls[0]?.fn();
    expect(toast().hidden).toBe(false);
  });

  it("renders its text as text", async () => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () =>
      board([mk("a1", "<img src=x onerror=alert(1)>"), mk("a2", "Done", true)]);
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: timers().set,
      achievementsPollMs: 0,
    });
    await app.ready;
    api.achievements = async () =>
      board([mk("a1", "<img src=x onerror=alert(1)>", true), mk("a2", "Done", true)]);
    await app.tick();
    expect(toast().querySelector(".toast-text")?.textContent).toBe(
      "Unlocked: <img src=x onerror=alert(1)>",
    );
    expect(toast().querySelector("img")).toBeNull();
  });
});

describe("unlock notice", () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
  const list = (unlockedNames: string[]): Achievement[] =>
    names.map((n, i) => mk(`a${i}`, n, unlockedNames.includes(n)));

  const start = async (initial: string[], extra: { tm?: Timers; failFirst?: boolean } = {}) => {
    const tm = extra.tm ?? timers();
    const api = fakeApi(playing(hubA));
    let current = board(list(initial));
    api.achievements = async () => current;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: tm.set,
      achievementsPollMs: 0,
    });
    await app.ready;
    return {
      api,
      app,
      tm,
      set(unlockedNames: string[]) {
        current = board(list(unlockedNames));
      },
    };
  };
  const text = (): string => toast().querySelector(".toast-text")?.textContent ?? "";
  const pulsing = (): boolean => railButtons()[0]?.classList.contains("pulse") ?? false;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing for the first fetch, even with achievements already unlocked", async () => {
    await start(["Alpha", "Bravo"]);
    expect(toast().hidden).toBe(true);
    expect(pulsing()).toBe(false);
  });

  it("names a single new unlock, pulses the rail and shows for ten seconds", async () => {
    const t = await start(["Alpha"]);
    t.set(["Alpha", "Bravo"]);
    await t.app.tick();
    expect(toast().hidden).toBe(false);
    expect(text()).toBe("Unlocked: Bravo");
    expect(pulsing()).toBe(true);
    expect(t.tm.calls.at(-1)?.ms).toBe(10_000);
    t.tm.calls.at(-1)?.fn();
    expect(toast().hidden).toBe(true);
  });

  it("lists three new unlocks joined by commas, in the order of the list", async () => {
    const t = await start([]);
    t.set(["Delta", "Bravo", "Charlie"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Bravo, Charlie, Delta");
  });

  it("lists two new unlocks joined by a comma", async () => {
    const t = await start([]);
    t.set(["Alpha", "Echo"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Alpha, Echo");
  });

  it("names two and counts the rest beyond three", async () => {
    const t = await start([]);
    t.set(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Alpha, Bravo and 3 more");
    const four = await (async () => {
      document.body.innerHTML = '<main id="app"></main>';
      return start([]);
    })();
    four.set(["Alpha", "Bravo", "Charlie", "Delta"]);
    await four.app.tick();
    expect(text()).toBe("Unlocked: Alpha, Bravo and 2 more");
  });

  it("does not announce the same unlock twice", async () => {
    const t = await start([]);
    t.set(["Alpha"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Alpha");
    t.tm.calls.at(-1)?.fn();
    await t.app.tick();
    expect(toast().hidden).toBe(true);
    t.set(["Alpha", "Bravo"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Bravo");
  });

  it("shows nothing when a fetch fails, and compares against the last good one afterwards", async () => {
    const t = await start(["Alpha"]);
    t.api.achievements = async () => {
      throw new Error("down");
    };
    await t.app.tick();
    expect(toast().hidden).toBe(true);
    expect(pulsing()).toBe(false);
    t.api.achievements = async () => board(list(["Alpha", "Bravo"]));
    await t.app.tick();
    expect(text()).toBe("Unlocked: Bravo");
  });

  it("shows nothing for the first fetch of a new game, even when it differs from the old one", async () => {
    const t = await start(["Alpha"]);
    let zeta = boardZ(list(["Alpha", "Bravo", "Charlie"]));
    t.api.achievements = async (source) => (source === "steam" ? zeta : board(list(["Alpha"])));
    t.api.nowValue = playing(hubZ);
    await t.app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await t.app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(toast().hidden).toBe(true);
    expect(pulsing()).toBe(false);
    zeta = boardZ(list(["Alpha", "Bravo", "Charlie", "Delta"]));
    await t.app.tick();
    expect(text()).toBe("Unlocked: Delta");
  });

  it("starts again from a new baseline when returning to the first game", async () => {
    const t = await start(["Alpha"]);
    let alpha = board(list(["Alpha"]));
    t.api.achievements = async (source) => (source === "steam" ? boardZ(list([])) : alpha);
    t.api.nowValue = playing(hubZ);
    await t.app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await t.app.tick();
    alpha = board(list(["Alpha", "Bravo"]));
    t.api.nowValue = playing(hubA);
    await t.app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await t.app.tick();
    expect($(".game-title")?.textContent).toBe("Alpha");
    expect(toast().hidden).toBe(true);
  });

  it("ignores a game that has no achievements", async () => {
    const api = fakeApi(playing(hubA));
    api.achievements = async () => null;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: timers().set,
      achievementsPollMs: 0,
    });
    await app.ready;
    await app.tick();
    expect(toast().hidden).toBe(true);
  });

  it("removes the pulse after ten seconds", async () => {
    vi.useFakeTimers();
    const t = await start(["Alpha"]);
    t.set(["Alpha", "Bravo"]);
    await t.app.tick();
    expect(pulsing()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(pulsing()).toBe(false);
  });

  it("takes no baseline from a stale response, and does not announce against one", async () => {
    const tm = timers();
    const api = fakeApi(playing(hubA));
    let next: AchievementsResponse = { ...board(list(["Alpha"])), stale: true };
    api.achievements = async () => next;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: tm.set,
      achievementsPollMs: 0,
    });
    await app.ready;
    next = board(list(["Alpha", "Bravo"]));
    await app.tick();
    expect(toast().hidden).toBe(true);
    expect(pulsing()).toBe(false);
    next = { ...board(list(["Alpha", "Bravo", "Charlie"])), stale: true };
    await app.tick();
    expect(toast().hidden).toBe(true);
    next = board(list(["Alpha", "Bravo", "Charlie"]));
    await app.tick();
    expect(text()).toBe("Unlocked: Charlie");
  });

  it("hides the notice and stops the pulse when the game on screen changes", async () => {
    const t = await start(["Alpha"]);
    t.api.achievements = async (source) =>
      source === "steam" ? boardZ(list([])) : board(list(["Alpha", "Bravo"]));
    await t.app.tick();
    expect(toast().hidden).toBe(false);
    expect(pulsing()).toBe(true);
    t.api.nowValue = playing(hubZ);
    await t.app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await t.app.tick();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(toast().hidden).toBe(true);
    expect(pulsing()).toBe(false);
  });

  it("keeps the notice when the same game is reloaded", async () => {
    const t = await start(["Alpha"]);
    t.set(["Alpha", "Bravo"]);
    await t.app.tick();
    expect(text()).toBe("Unlocked: Bravo");
    t.api.nowValue = { ...playing(hubA), hubs: [] };
    await t.app.tick();
    expect(toast().hidden).toBe(false);
  });

  it("keeps the baseline when the same game is reloaded", async () => {
    const api = fakeApi({ ...playing(hubA), hubs: [] });
    let current = board(list(["Alpha"]));
    api.achievements = async () => current;
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      setTimeout: timers().set,
    });
    await app.ready;
    expect($(".game-note")?.textContent).toBe("No guide found");
    expect(toast().hidden).toBe(true);
    // The guide appears later: the same game is loaded again, now with one more unlock.
    current = board(list(["Alpha", "Bravo"]));
    api.nowValue = playing(hubA);
    await app.tick();
    expect(document.querySelectorAll(".rail button")[1]?.textContent).toBe("AC");
    expect(text()).toBe("Unlocked: Bravo");
  });
});

// ---- display settings: keep awake, wiki bars, full screen ----

describe("display settings", () => {
  const KEY = "game-companion:v1:settings";

  interface Sentinel {
    release: Mock<() => Promise<void>>;
    addEventListener: (type: "release", cb: () => void) => void;
  }
  function wakeLockStub() {
    const sentinels: Sentinel[] = [];
    const request = vi.fn(async () => {
      const sentinel: Sentinel = {
        release: vi.fn(async () => undefined),
        addEventListener: () => {},
      };
      sentinels.push(sentinel);
      return sentinel;
    });
    return { nav: { wakeLock: { request } }, request, sentinels };
  }

  const frameDocs = new Map<string, Document>();
  const framed = (url: string): Document => {
    const doc = new DOMParser().parseFromString(
      "<!doctype html><body><div id='sidebar'>s</div><div role='main'><p>Sample</p></div></body>",
      "text/html",
    );
    frameDocs.set(url, doc);
    return doc;
  };
  beforeEach(() => {
    frameDocs.clear();
    vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      return frameDocs.get(this.getAttribute("src") ?? "") ?? null;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ["exitFullscreen", "fullscreenElement", "fullscreenEnabled"]) {
      Reflect.deleteProperty(document, name);
    }
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
  });

  const start = async (storage = memory(), extra: Partial<Parameters<typeof startApp>[0]> = {}) => {
    const api = fakeApi(playing(hubA));
    const app = startApp({ doc: document, api, storage, setInterval: noTimers, ...extra });
    await app.ready;
    return { app, api, storage };
  };
  const openDisplay = (): void => {
    railButtons().at(-1)?.click();
    ($('[data-tab="settings"]') as HTMLElement).click();
  };
  const row = (name: string): HTMLButtonElement =>
    $(`.picker-settings .${name}`) as HTMLButtonElement;
  const stored = (storage: ReturnType<typeof memory>): unknown =>
    JSON.parse(storage.getItem(KEY) as string);
  const showChecklist = (): HTMLIFrameElement => {
    framed("/doc/hA-checklist");
    railButtons()[1]?.click();
    const frame = $("iframe") as HTMLIFrameElement;
    frame.dispatchEvent(new Event("load"));
    return frame;
  };

  it("starts with keep-awake on and the wiki bars hidden, and requests a screen lock", async () => {
    const lock = wakeLockStub();
    await start(memory(), { nav: lock.nav });
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(lock.request).toHaveBeenCalledWith("screen");
    openDisplay();
    expect(row("setting-keep-awake").textContent).toBe("Keep screen on: on");
    expect(row("setting-keep-awake").hidden).toBe(false);
    expect(row("setting-hide-chrome").textContent).toBe("Outline bars: hidden");
  });

  it("loads the saved settings and applies them", async () => {
    const lock = wakeLockStub();
    const storage = memory();
    storage.setItem(KEY, JSON.stringify({ keepAwake: false, hideChrome: false }));
    await start(storage, { nav: lock.nav });
    await flush();
    expect(lock.request).not.toHaveBeenCalled();
    openDisplay();
    expect(row("setting-keep-awake").textContent).toBe("Keep screen on: off");
    expect(row("setting-hide-chrome").textContent).toBe("Outline bars: shown");
    document.querySelector<HTMLElement>(".picker-close")?.click();
    const frame = showChecklist();
    expect(frame.contentDocument?.getElementById("gc-chrome-style")).toBeNull();
  });

  it("hides the wiki's bars in a frame that loads, by default", async () => {
    await start();
    const frame = showChecklist();
    expect(frame.contentDocument?.getElementById("gc-chrome-style")).not.toBeNull();
  });

  it("flips the wiki bars setting: saves it, applies it at once and relabels", async () => {
    const { storage } = await start();
    const frame = showChecklist();
    const doc = frame.contentDocument as Document;
    expect(doc.getElementById("gc-chrome-style")).not.toBeNull();
    openDisplay();
    row("setting-hide-chrome").click();
    expect(doc.getElementById("gc-chrome-style")).toBeNull();
    expect(row("setting-hide-chrome").textContent).toBe("Outline bars: shown");
    expect(row("setting-hide-chrome").getAttribute("aria-pressed")).toBe("false");
    expect(stored(storage)).toEqual({
      keepAwake: true,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
    });
    expect($(".picker")?.hidden).toBe(false);
    row("setting-hide-chrome").click();
    expect(doc.getElementById("gc-chrome-style")).not.toBeNull();
    expect(row("setting-hide-chrome").textContent).toBe("Outline bars: hidden");
    expect(stored(storage)).toEqual({
      keepAwake: true,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
    });
  });

  const zoomClasses = (): string[] =>
    [...($(".frames") as HTMLElement).classList].filter((c) => c.startsWith("zoom-"));

  it("applies the stored guide text size at start, to a frame that loads", async () => {
    const storage = memory();
    storage.setItem(
      KEY,
      JSON.stringify({ keepAwake: true, hideChrome: true, guideJump: true, guideZoom: 80 }),
    );
    await start(storage);
    const frame = showChecklist();
    expect(zoomClasses()).toEqual(["zoom-80"]);
    expect(frame.contentDocument?.getElementById("gc-zoom-style")).toBeNull();
    openDisplay();
    expect(row("setting-guide-zoom").textContent).toBe("Guide text size: 80%");
    expect(row("setting-guide-zoom").hasAttribute("aria-pressed")).toBe(false);
  });

  it("starts at 100% when the stored guide text size is corrupt", async () => {
    const storage = memory();
    storage.setItem(KEY, JSON.stringify({ guideZoom: "90" }));
    await start(storage);
    showChecklist();
    expect(zoomClasses()).toEqual([]);
    openDisplay();
    expect(row("setting-guide-zoom").textContent).toBe("Guide text size: 100%");
  });

  it("steps the guide text size 100, 90, 80, 70, 100: saved, applied at once and relabelled", async () => {
    const { storage } = await start();
    showChecklist();
    openDisplay();
    expect(row("setting-guide-zoom").textContent).toBe("Guide text size: 100%");
    expect(zoomClasses()).toEqual([]);
    const steps: [number, string[]][] = [
      [90, ["zoom-90"]],
      [80, ["zoom-80"]],
      [70, ["zoom-70"]],
      [100, []],
    ];
    for (const [percent, expected] of steps) {
      row("setting-guide-zoom").click();
      expect(zoomClasses()).toEqual(expected);
      expect(row("setting-guide-zoom").textContent).toBe(`Guide text size: ${percent}%`);
      expect(stored(storage)).toEqual({
        keepAwake: true,
        hideChrome: true,
        guideJump: true,
        guideZoom: percent,
      });
      expect($(".picker")?.hidden).toBe(false);
    }
    expect(document.getElementById("gc-zoom-style")).toBeNull();
  });

  it("flips keep-awake: off releases the lock, on asks again, saved and relabelled", async () => {
    const lock = wakeLockStub();
    const { storage } = await start(memory(), { nav: lock.nav });
    await flush();
    expect(lock.sentinels).toHaveLength(1);
    openDisplay();
    row("setting-keep-awake").click();
    await flush();
    expect(lock.sentinels[0]?.release).toHaveBeenCalledTimes(1);
    expect(row("setting-keep-awake").textContent).toBe("Keep screen on: off");
    expect(row("setting-keep-awake").getAttribute("aria-pressed")).toBe("false");
    expect(stored(storage)).toEqual({
      keepAwake: false,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
    });
    row("setting-keep-awake").click();
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(2);
    expect(row("setting-keep-awake").textContent).toBe("Keep screen on: on");
    expect(stored(storage)).toEqual({
      keepAwake: true,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
    });
  });

  it("hides the keep-awake and full-screen rows where the browser has neither", async () => {
    await start();
    openDisplay();
    expect(row("setting-keep-awake").hidden).toBe(true);
    expect(row("setting-fullscreen").hidden).toBe(true);
    expect(row("setting-hide-chrome").hidden).toBe(false);
  });

  it("hides the full-screen row in an installed app that already fills the screen", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    const win = {
      matchMedia: (q: string) => ({ matches: q === "(display-mode: fullscreen)" }),
    };
    await start(memory(), { win });
    openDisplay();
    expect(row("setting-fullscreen").hidden).toBe(true);
    expect(row("setting-hide-chrome").hidden).toBe(false);
  });

  it("keeps the full-screen row in a browser tab", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    await start(memory(), { win: { matchMedia: () => ({ matches: false }) } });
    openDisplay();
    expect(row("setting-fullscreen").hidden).toBe(false);
  });

  it("toggles full screen, and keeps the label right when the browser changes it", async () => {
    const enter = vi.fn(async () => undefined);
    const exit = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: enter,
      configurable: true,
    });
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
    await start();
    openDisplay();
    expect(row("setting-fullscreen").hidden).toBe(false);
    expect(row("setting-fullscreen").textContent).toBe("Full screen: off");
    row("setting-fullscreen").click();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect($(".picker")?.hidden).toBe(false);
    Object.defineProperty(document, "fullscreenElement", {
      value: document.documentElement,
      configurable: true,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(row("setting-fullscreen").textContent).toBe("Full screen: on");
    expect(row("setting-fullscreen").getAttribute("aria-pressed")).toBe("true");
    row("setting-fullscreen").click();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(row("setting-fullscreen").textContent).toBe("Full screen: off");
  });

  it("does not save anything for the full-screen toggle", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: async () => undefined,
      configurable: true,
    });
    const { storage } = await start();
    openDisplay();
    row("setting-fullscreen").click();
    await flush();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("keeps working when storage refuses the settings", async () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    await start(storage);
    openDisplay();
    row("setting-hide-chrome").click();
    expect(row("setting-hide-chrome").textContent).toBe("Outline bars: shown");
  });
});

// ---- guide jump from the status line ----

describe("guide jump", () => {
  const SETTINGS_KEY = "game-companion:v1:settings";
  const wm = (over: Partial<WhereMatch> = {}): WhereMatch => ({
    pageTitle: "Collectibles",
    pageUrl: "/doc/hA-coll",
    heading: "Chapter Two: Sample Keep",
    phrase: "Sample Keep",
    ...over,
  });
  const line = "Chapter Two: Sample Keep";
  const nowWith = (hub: GuideHub, presence: string | null): NowResponse => ({
    ...playing(hub),
    presence,
  });
  const jump = (): HTMLButtonElement => $(".presence-jump") as HTMLButtonElement;
  const settle = async (): Promise<void> => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await flush();
  };
  const frameDocs = new Map<string, Document>();
  const sectioned = (): Document =>
    new DOMParser().parseFromString(
      "<!doctype html><body><p id='mention'>Rumour: Chapter Two: Sample Keep is near, " +
        "and so is Chapter One: Sample Caves.</p>" +
        "<h2 id='one'>Chapter One: Sample Caves</h2><p>cave notes</p>" +
        "<h2 id='two'>Chapter Two: Sample Keep</h2><p>keep notes</p></body>",
      "text/html",
    );
  const shown = (): string[] =>
    [...document.querySelectorAll("iframe:not(.inactive)")].map((f) => f.getAttribute("src") ?? "");
  const loadFrames = (): void => {
    for (const f of document.querySelectorAll("iframe")) f.dispatchEvent(new Event("load"));
  };
  let scroll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    frameDocs.clear();
    vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      return frameDocs.get(this.getAttribute("src") ?? "") ?? null;
    });
    scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  async function started(
    over: {
      presence?: string | null;
      matches?: WhereMatch[];
      storage?: ReturnType<typeof memory>;
      tweak?: (api: Fake) => void;
    } = {},
  ) {
    const api = fakeApi(nowWith(hubA, over.presence === undefined ? line : over.presence));
    api.whereValue = { matches: over.matches ?? [wm()] };
    over.tweak?.(api);
    const app = startApp({
      doc: document,
      api,
      storage: over.storage ?? memory(),
      setInterval: noTimers,
    });
    await app.ready;
    await settle();
    return { api, app };
  }
  const settingsStorage = (guideJump: boolean) => {
    const storage = memory();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ keepAwake: true, hideChrome: true, guideJump }));
    return storage;
  };
  const toggleSetting = (): void => ($(".setting-guide-jump") as HTMLElement).click();

  it("is a hidden button after the status line, and stays hidden with no status row", async () => {
    const { api } = await started({ presence: null });
    const row = $(".presence-row") as HTMLElement;
    expect([...row.children].map((c) => c.className)).toEqual(["game-presence", "presence-jump"]);
    expect(jump().tagName).toBe("BUTTON");
    expect(jump().getAttribute("type")).toBe("button");
    expect(jump().hidden).toBe(true);
    expect(api.whereCalls).toEqual([]);
  });

  it("asks once when the status row shows and offers the best match", async () => {
    const { api } = await started({
      matches: [
        wm({ phrase: "Sample Keep", heading: "Chapter Two: Sample Keep" }),
        wm({ phrase: "Sample Caves", heading: "Chapter One: Sample Caves" }),
      ],
    });
    expect(api.whereCalls).toEqual(["hA"]);
    expect(($(".presence-row") as HTMLElement).hidden).toBe(false);
    expect(jump().hidden).toBe(false);
    expect(jump().textContent).toBe("↪ Sample Keep");
    expect(jump().getAttribute("aria-label")).toBe("Open the guide at Chapter Two: Sample Keep");
  });

  it("does not ask again while the status text is unchanged, and asks when it changes", async () => {
    const { api, app } = await started();
    await app.tick();
    await app.tick();
    expect(api.whereCalls).toEqual(["hA"]);
    api.nowValue = nowWith(hubA, "Chapter One: Sample Caves");
    api.whereValue = {
      matches: [wm({ phrase: "Sample Caves", heading: "Chapter One: Sample Caves" })],
    };
    await app.tick();
    await settle();
    expect(api.whereCalls).toEqual(["hA", "hA"]);
    expect(jump().textContent).toBe("↪ Sample Caves");
    expect(jump().getAttribute("aria-label")).toBe("Open the guide at Chapter One: Sample Caves");
  });

  it("is hidden when the answer has no matches or the guide is unknown", async () => {
    const { api, app } = await started({ matches: [] });
    expect(api.whereCalls).toEqual(["hA"]);
    expect(jump().hidden).toBe(true);
    api.nowValue = nowWith(hubA, "Another line");
    api.whereValue = null;
    await app.tick();
    await settle();
    expect(api.whereCalls).toHaveLength(2);
    expect(jump().hidden).toBe(true);
  });

  it("hides with the status row and comes back with it, without asking again", async () => {
    const { api, app } = await started();
    api.nowValue = nowWith(hubA, null);
    await app.tick();
    expect(jump().hidden).toBe(true);
    api.nowValue = nowWith(hubA, line);
    await app.tick();
    expect(jump().hidden).toBe(false);
    expect(api.whereCalls).toEqual(["hA"]);
  });

  it("makes no request without a guide", async () => {
    const api = fakeApi({ ...nowWith(hubA, line), hubs: [] });
    api.whereValue = { matches: [wm()] };
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    await settle();
    expect(($(".presence-row") as HTMLElement).hidden).toBe(false);
    expect(api.whereCalls).toEqual([]);
    expect(jump().hidden).toBe(true);
  });

  it("does nothing while the setting is off, and asks when it is turned on", async () => {
    const { api, app } = await started({ storage: settingsStorage(false) });
    await app.tick();
    expect(api.whereCalls).toEqual([]);
    expect(jump().hidden).toBe(true);
    toggleSetting();
    await settle();
    expect(api.whereCalls).toEqual(["hA"]);
    expect(jump().hidden).toBe(false);
  });

  it("hides at once when the setting is turned off, and asks again when it is turned on", async () => {
    const { api } = await started();
    expect(jump().hidden).toBe(false);
    toggleSetting();
    expect(jump().hidden).toBe(true);
    toggleSetting();
    await settle();
    expect(api.whereCalls).toEqual(["hA", "hA"]);
    expect(jump().hidden).toBe(false);
  });

  it("is cleared at once when the game changes, and asks about the new game", async () => {
    const { api, app } = await started();
    expect(jump().hidden).toBe(false);
    const zeta = deferred<GuideWhereResponse | null>();
    api.where = (hubId) => {
      api.whereCalls.push(hubId);
      return zeta.promise;
    };
    api.nowValue = nowWith(hubZ, line);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    expect(jump().hidden).toBe(true);
    await app.tick();
    expect(api.whereCalls).toEqual(["hA", "hZ"]);
    expect(jump().hidden).toBe(true);
    expect(jump().textContent).toBe("");
    zeta.resolve({ matches: [wm({ pageUrl: "/doc/hZ-coll", phrase: "Zeta Hall" })] });
    await settle();
    expect(jump().textContent).toBe("↪ Zeta Hall");
  });

  describe("an answer that arrives late", () => {
    const lateOne = async () => {
      const first = deferred<GuideWhereResponse | null>();
      const api = fakeApi(nowWith(hubA, line));
      let n = 0;
      api.where = (hubId) => {
        api.whereCalls.push(hubId);
        n += 1;
        return n === 1 ? first.promise : Promise.resolve(api.whereValue);
      };
      const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
      await app.ready;
      await settle();
      return { api, app, first };
    };

    it("is dropped after a game change", async () => {
      const { api, app, first } = await lateOne();
      api.nowValue = nowWith(hubZ, line);
      await app.tick();
      ($(".switch-banner .switch-accept") as HTMLElement).click();
      await app.tick();
      await settle();
      first.resolve({ matches: [wm({ phrase: "Old Game" })] });
      await settle();
      expect(jump().hidden).toBe(true);
      expect(jump().textContent).toBe("");
    });

    it("is dropped after the setting was turned off", async () => {
      const { first } = await lateOne();
      toggleSetting();
      first.resolve({ matches: [wm({ phrase: "Too Late" })] });
      await settle();
      expect(jump().hidden).toBe(true);
      expect(jump().textContent).toBe("");
    });

    it("is dropped after the status text changed, in favour of the newer answer", async () => {
      const { api, app, first } = await lateOne();
      api.nowValue = nowWith(hubA, "Chapter One: Sample Caves");
      api.whereValue = { matches: [wm({ phrase: "Newer" })] };
      await app.tick();
      await settle();
      expect(jump().textContent).toBe("↪ Newer");
      first.resolve({ matches: [wm({ phrase: "Older" })] });
      await settle();
      expect(jump().textContent).toBe("↪ Newer");
    });
  });

  it("stays hidden after a failed request and asks again at the next poll", async () => {
    const api = fakeApi(nowWith(hubA, line));
    let fail = true;
    api.where = async (hubId) => {
      api.whereCalls.push(hubId);
      if (fail) throw new Error("down");
      return { matches: [wm()] };
    };
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    await settle();
    expect(api.whereCalls).toEqual(["hA"]);
    expect(jump().hidden).toBe(true);
    fail = false;
    await app.tick();
    await settle();
    expect(api.whereCalls).toEqual(["hA", "hA"]);
    expect(jump().hidden).toBe(false);
  });

  describe("tapping it", () => {
    it("opens the page of a single match in a slot and locates its heading without a hint", async () => {
      vi.useFakeTimers();
      frameDocs.set("/doc/hA-coll", sectioned());
      await started();
      jump().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()).toEqual(["/doc/hA-coll"]);
      expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Collectibles");
      expect($(".ach")?.hidden).toBe(true);
      loadFrames();
      await vi.advanceTimersByTimeAsync(0);
      expect((scroll.mock.contexts[0] as Element).id).toBe("two");
      expect(($(".toast") as HTMLElement).hidden).toBe(true);
      // The heading's text, no heading hint, and the heading mode: exactly this.
      expect(locateCalls.map((c) => c.slice(1))).toEqual([
        ["Chapter Two: Sample Keep", null, "heading", "Sample Keep"],
      ]);
    });

    it("says so when the page opens but the heading is not in it", async () => {
      vi.useFakeTimers();
      frameDocs.set("/doc/hA-coll", sectioned());
      await started({ matches: [wm({ heading: "Chapter Nine: Nowhere", phrase: "Nowhere" })] });
      jump().click();
      await vi.advanceTimersByTimeAsync(0);
      loadFrames();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(($(".toast") as HTMLElement).hidden).toBe(false);
      expect($(".toast-text")?.textContent).toBe("Opened the page, but could not find the text");
    });

    it("says it could not open a page the guide does not list", async () => {
      await started({ matches: [wm({ pageUrl: "/doc/hA-unlisted" })] });
      jump().click();
      expect(document.querySelector("iframe")).toBeNull();
      expect($(".toast-text")?.textContent).toBe("Could not open that page");
    });

    it("lists several matches in the picker and opens the one picked", async () => {
      vi.useFakeTimers();
      frameDocs.set("/doc/hA-checklist", sectioned());
      await started({
        matches: [
          wm({ phrase: "Sample Keep", heading: "Chapter Two: Sample Keep" }),
          wm({
            pageTitle: "Achievement Checklist",
            pageUrl: "/doc/hA-checklist",
            phrase: "Sample Caves",
            heading: "Chapter One: Sample Caves",
          }),
        ],
      });
      jump().click();
      expect($(".picker")?.hidden).toBe(false);
      expect($(".picker-matches-title")?.textContent).toBe("In the guide: Sample Keep");
      const items = [...document.querySelectorAll(".picker-matches .picker-item")];
      expect(items.map((i) => i.querySelector(".picker-title")?.textContent)).toEqual([
        "Collectibles",
        "Achievement Checklist",
      ]);
      expect(items.map((i) => i.querySelector(".picker-snippet")?.textContent)).toEqual([
        "Chapter Two: Sample Keep",
        "Chapter One: Sample Caves",
      ]);
      (items[1] as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(0);
      expect($(".picker")?.hidden).toBe(true);
      expect(shown()).toEqual(["/doc/hA-checklist"]);
      loadFrames();
      await vi.advanceTimersByTimeAsync(0);
      expect((scroll.mock.contexts[0] as Element).id).toBe("one");
      expect(locateCalls.map((c) => c.slice(1))).toEqual([
        ["Chapter One: Sample Caves", null, "heading", "Sample Caves"],
      ]);
    });

    it("is ignored while a load is queued", async () => {
      const { api, app } = await started();
      api.nowValue = nowWith(hubZ, line);
      await app.tick();
      ($(".switch-banner .switch-accept") as HTMLElement).click();
      jump().click();
      expect(document.querySelector("iframe")).toBeNull();
      expect($(".picker")?.hidden).toBe(true);
    });

    it("is ignored while a guide choice is pending", async () => {
      const { api, app } = await started();
      api.nowValue = { ...nowWith(hubZ, line), hubs: [hubZ, hubA] };
      await app.tick();
      ($(".switch-banner .switch-accept") as HTMLElement).click();
      await app.tick();
      expect($(".picker")?.hidden).toBe(false);
      const before = document.querySelectorAll(".picker-matches .picker-item").length;
      jump().click();
      expect(document.querySelectorAll(".picker-matches .picker-item")).toHaveLength(before);
      expect(document.querySelector("iframe")).toBeNull();
    });
  });

  describe("beside Find in guide", () => {
    const first = { ...mk("a1", "First Steps") };
    const findMatch = (url: string, over: Partial<FindMatch> = {}): FindMatch => ({
      pageTitle: "Collectibles",
      pageUrl: url,
      heading: "Chapter One",
      snippet: "the First Steps are here",
      ...over,
    });
    const tapFind = async (): Promise<void> => {
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
      (document.querySelector(".ach-find") as HTMLElement).click();
      await settle();
    };

    it("drops a Find answer still in flight when a guide jump is started", async () => {
      const late = deferred<FindResponse | null>();
      await started({
        tweak: (api) => {
          api.achievements = async () => board([first]);
          api.find = () => late.promise;
        },
      });
      await tapFind();
      jump().click();
      expect($(".picker")?.hidden).toBe(true);
      late.resolve({
        matches: [findMatch("/doc/hA-coll"), findMatch("/doc/hA-checklist")],
        truncated: false,
      });
      await settle();
      expect($(".picker")?.hidden).toBe(true);
      expect(document.querySelectorAll(".picker-matches .picker-item")).toHaveLength(0);
      expect(shown()).toEqual(["/doc/hA-coll"]);
    });

    it("lets a Find started later show its own list over an open where-list, and a pick from it searches as text", async () => {
      const two = [
        wm(),
        wm({ pageTitle: "Achievement Checklist", pageUrl: "/doc/hA-checklist", phrase: "Caves" }),
      ];
      await started({
        matches: two,
        tweak: (api) => {
          api.achievements = async () => board([first]);
          api.find = async () => ({
            matches: [
              findMatch("/doc/hA-coll"),
              findMatch("/doc/hA-checklist", { pageTitle: "Achievement Checklist" }),
            ],
            truncated: false,
          });
        },
      });
      jump().click();
      expect($(".picker-matches-title")?.textContent).toBe("In the guide: Sample Keep");
      await tapFind();
      expect($(".picker-matches-title")?.textContent).toBe("In the guide: First Steps");
      (document.querySelectorAll(".picker-matches .picker-item")[1] as HTMLElement).click();
      await settle();
      expect(locateCalls.map((c) => c.slice(1))).toEqual([["First Steps", "Chapter One", "text"]]);
    });
  });

  it("is hidden while the game has no page list, and offered once the list arrives", async () => {
    let treeUp = false;
    const { app } = await started({
      tweak: (api) => {
        api.hubTree = async (id) => {
          if (!treeUp) throw new Error("down");
          return tree(id === "hA" ? hubA : hubZ);
        };
      },
    });
    expect(($(".presence-row") as HTMLElement).hidden).toBe(false);
    expect(jump().hidden).toBe(true);
    treeUp = true;
    await app.tick();
    await settle();
    expect(jump().hidden).toBe(false);
  });

  it("drops an answer that arrives while the status row is hidden, and asks again when the same text returns", async () => {
    const held = deferred<GuideWhereResponse | null>();
    let n = 0;
    const { api, app } = await started({
      tweak: (a) => {
        a.where = (hubId) => {
          a.whereCalls.push(hubId);
          n += 1;
          return n === 1 ? held.promise : Promise.resolve({ matches: [wm({ phrase: "Again" })] });
        };
      },
    });
    api.nowValue = { ...nowWith(hubA, line), state: "last-played" };
    await app.tick();
    expect(($(".presence-row") as HTMLElement).hidden).toBe(true);
    held.resolve({ matches: [wm({ phrase: "Held" })] });
    await settle();
    expect(jump().hidden).toBe(true);
    api.nowValue = nowWith(hubA, line);
    await app.tick();
    await settle();
    expect(api.whereCalls).toEqual(["hA", "hA"]);
    expect(jump().textContent).toBe("↪ Again");
  });
});

// ---- checklist progress on the sidebar ----

describe("checklist progress", () => {
  const frameDocs = new Map<string, Document>();
  const pageDoc = (): Document =>
    new DOMParser().parseFromString("<!doctype html><body><p id='p'>notes</p></body>", "text/html");
  const slotCount = (i: number): string | null | undefined =>
    railButtons()[i]?.querySelector(".rail-count")?.textContent;
  const progressOf = (url: string, completed: number, total: number) => ({
    pages: [{ url, completed, total }],
  });

  beforeEach(() => {
    frameDocs.clear();
    vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      return frameDocs.get(this.getAttribute("src") ?? "") ?? null;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const started = async (
    over: {
      poll?: number;
      now?: NowResponse;
      progress?: GuideProgressResponse | null;
      tweak?: (api: Fake) => void;
    } = {},
  ) => {
    const api = fakeApi(over.now ?? playing(hubA));
    api.progressValue =
      over.progress === undefined ? progressOf("/doc/hA-checklist", 3, 7) : over.progress;
    over.tweak?.(api);
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      achievementsPollMs: over.poll ?? 60_000,
    });
    await app.ready;
    await (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : flush());
    return { api, app };
  };

  it("is fetched when the game loads and shown on the pinned page's button", async () => {
    const { api } = await started();
    expect(api.progressCalls).toEqual([["hA", undefined]]);
    expect(slotCount(1)).toBe("3/7");
    expect(railButtons()[1]?.getAttribute("aria-label")).toBe("Achievement Checklist, 3 of 7 done");
    expect(slotCount(2)).toBe("");
  });

  it("matches a page by its document id, not the whole path", async () => {
    await started({ progress: progressOf("/doc/an-older-slug-checklist", 1, 40) });
    expect(slotCount(1)).toBe("1/40");
  });

  it("ignores progress for a page that is not pinned, and a malformed answer", async () => {
    await started({ progress: progressOf("/doc/hA-other", 1, 4) });
    expect(slotCount(1)).toBe("");
    const bad = {
      pages: [{ url: 7, completed: "x", total: null }, null],
    } as unknown as GuideProgressResponse;
    document.body.innerHTML = '<main id="app"></main>';
    await started({ progress: bad });
    expect(slotCount(1)).toBe("");
    document.body.innerHTML = '<main id="app"></main>';
    await started({ progress: { pages: "nope" } as unknown as GuideProgressResponse });
    expect(slotCount(1)).toBe("");
  });

  it("is fetched again with the achievements refresh and shows the new numbers", async () => {
    const { api, app } = await started({ poll: 0 });
    api.progressValue = progressOf("/doc/hA-checklist", 5, 7);
    await app.tick();
    expect(api.progressCalls).toEqual([
      ["hA", undefined],
      ["hA", undefined],
    ]);
    expect(slotCount(1)).toBe("5/7");
  });

  it("is not fetched on a tick when the achievements are not due", async () => {
    const { api, app } = await started();
    await app.tick();
    expect(api.progressCalls).toHaveLength(1);
  });

  it("keeps the last good numbers when a request fails or the guide is unknown", async () => {
    const { api, app } = await started({ poll: 0 });
    api.progress = async (hubId, refresh) => {
      api.progressCalls.push([hubId, refresh]);
      throw new Error("down");
    };
    await app.tick();
    expect(api.progressCalls).toHaveLength(2);
    expect(slotCount(1)).toBe("3/7");
    api.progress = async () => null;
    await app.tick();
    expect(slotCount(1)).toBe("3/7");
  });

  it("is cleared at once when the game changes", async () => {
    const { api, app } = await started();
    const never = new Promise<GuideProgressResponse | null>(() => undefined);
    api.progress = async (hubId, refresh) => {
      api.progressCalls.push([hubId, refresh]);
      return never;
    };
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    expect(api.progressCalls.at(-1)).toEqual(["hZ", undefined]);
    expect(slotCount(1)).toBe("");
    expect(railButtons()[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
  });

  it("drops an answer for the old game that arrives after a game change", async () => {
    const late = deferred<GuideProgressResponse | null>();
    const api = fakeApi(playing(hubA));
    api.progress = (hubId, refresh) => {
      api.progressCalls.push([hubId, refresh]);
      return hubId === "hA" ? late.promise : Promise.resolve({ pages: [] });
    };
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    late.resolve(progressOf("/doc/hZ-checklist", 9, 9));
    await flush();
    expect(slotCount(1)).toBe("");
  });

  it("is not requested for a game without a guide", async () => {
    const { api, app } = await started({ poll: 0, now: { ...playing(hubA), hubs: [] } });
    await app.tick();
    expect(api.progressCalls).toEqual([]);
  });

  describe("after a click inside a guide page", () => {
    const startedWithFrame = async (tweak?: (api: Fake) => void, poll?: number) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      const url = "/doc/hA-checklist";
      frameDocs.set(url, pageDoc());
      const run = await started({
        ...(tweak === undefined ? {} : { tweak }),
        ...(poll === undefined ? {} : { poll }),
      });
      railButtons()[1]?.click();
      const frame = document.querySelector("iframe") as HTMLIFrameElement;
      frame.dispatchEvent(new Event("load"));
      const clickInFrame = (): void =>
        void (frameDocs.get(url) as Document).body.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      const fresh = (): number => run.api.progressCalls.filter(([, r]) => r === true).length;
      return { ...run, clickInFrame, fresh };
    };

    it("asks for fresh numbers 4 and 12 seconds later and shows them", async () => {
      const { api, clickInFrame, fresh } = await startedWithFrame();
      api.progressValue = progressOf("/doc/hA-checklist", 4, 7);
      clickInFrame();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(fresh()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.progressCalls.at(-1)).toEqual(["hA", true]);
      expect(slotCount(1)).toBe("4/7");
      api.progressValue = progressOf("/doc/hA-checklist", 5, 7);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(fresh()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fresh()).toBe(2);
      expect(slotCount(1)).toBe("5/7");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fresh()).toBe(2);
    });

    it("keeps the newer counts when an older ordinary answer arrives after a fresh one", async () => {
      const held = deferred<GuideProgressResponse | null>();
      const { api, clickInFrame } = await startedWithFrame((a) => {
        a.progress = (hubId, refresh) => {
          a.progressCalls.push([hubId, refresh]);
          return refresh === true
            ? Promise.resolve(progressOf("/doc/hA-checklist", 5, 7))
            : held.promise;
        };
      });
      expect(api.progressCalls).toEqual([["hA", undefined]]);
      clickInFrame();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(slotCount(1)).toBe("5/7");
      held.resolve(progressOf("/doc/hA-checklist", 3, 7));
      await vi.advanceTimersByTimeAsync(0);
      expect(slotCount(1)).toBe("5/7");
    });

    describe("while a fresh read is in flight", () => {
      const setup = async () => {
        const fresh = deferred<GuideProgressResponse | null>();
        let ordinary = 0;
        const run = await startedWithFrame((a) => {
          a.progress = (hubId, refresh) => {
            a.progressCalls.push([hubId, refresh]);
            if (refresh === true) return fresh.promise;
            ordinary += 1;
            // The load gets the counts as they are; later polls get the server's older held copy.
            return Promise.resolve(progressOf("/doc/hA-checklist", ordinary === 1 ? 3 : 2, 7));
          };
        }, 0);
        run.clickInFrame();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(run.fresh()).toBe(1);
        return { ...run, fresh: fresh };
      };

      it("does not apply an ordinary answer, and applies the fresh one when it arrives", async () => {
        const { app, fresh } = await setup();
        expect(slotCount(1)).toBe("3/7");
        await app.tick();
        await vi.advanceTimersByTimeAsync(0);
        expect(slotCount(1)).toBe("3/7");
        fresh.resolve(progressOf("/doc/hA-checklist", 6, 7));
        await vi.advanceTimersByTimeAsync(0);
        expect(slotCount(1)).toBe("6/7");
      });

      it("applies the next ordinary answer as usual when the fresh read fails", async () => {
        const { app, fresh } = await setup();
        await app.tick();
        await vi.advanceTimersByTimeAsync(0);
        expect(slotCount(1)).toBe("3/7");
        fresh.reject(new Error("down"));
        await vi.advanceTimersByTimeAsync(0);
        expect(slotCount(1)).toBe("3/7");
        await app.tick();
        await vi.advanceTimersByTimeAsync(0);
        expect(slotCount(1)).toBe("2/7");
      });
    });

    it("restarts both timers on a second click", async () => {
      const { clickInFrame, fresh } = await startedWithFrame();
      clickInFrame();
      await vi.advanceTimersByTimeAsync(3_000);
      clickInFrame();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(fresh()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fresh()).toBe(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fresh()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fresh()).toBe(2);
    });

    it("is cancelled by a game change", async () => {
      const { api, app, clickInFrame, fresh } = await startedWithFrame();
      clickInFrame();
      api.nowValue = playing(hubZ);
      await app.tick();
      ($(".switch-banner .switch-accept") as HTMLElement).click();
      await app.tick();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fresh()).toBe(0);
    });
  });
});

// ---- refresh on wake ----

describe("refresh on wake", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const hidden = (state: "visible" | "hidden"): void => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  };
  const countingNow = (api: Fake) => {
    const gate = { now: 0, active: 0, max: 0, release: null as (() => void) | null };
    const inner = api.now.bind(api);
    api.now = async () => {
      gate.now += 1;
      gate.active += 1;
      gate.max = Math.max(gate.max, gate.active);
      try {
        if (gate.release !== null) await new Promise<void>((r) => (gate.release = r));
        return await inner();
      } finally {
        gate.active -= 1;
      }
    };
    return gate;
  };
  const started = async (win?: EventTarget) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = fakeApi(playing(hubA));
    const gate = countingNow(api);
    const app = startApp({
      doc: document,
      api,
      storage: memory(),
      setInterval: noTimers,
      ...(win === undefined
        ? {}
        : {
            win: {
              addEventListener: (type: string, cb: () => void) => win.addEventListener(type, cb),
            },
          }),
    });
    await app.ready;
    await flush();
    gate.now = 0;
    api.achCalls.length = 0;
    api.progressCalls.length = 0;
    return { api, app, gate };
  };
  const wake = async (): Promise<void> => {
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
  };

  it("runs a tick at once when the page becomes visible", async () => {
    const { gate } = await started();
    await wake();
    expect(gate.now).toBe(1);
  });

  it("refreshes achievements and progress when the last refresh is older than 15 seconds", async () => {
    const { api } = await started();
    vi.setSystemTime(Date.now() + 16_000);
    await wake();
    expect(api.achCalls).toEqual(["ra:20"]);
    // A wake asks for a fresh read, not the ordinary poll.
    expect(api.progressCalls).toEqual([["hA", true]]);
  });

  it("leaves them alone when the last refresh is newer than 15 seconds", async () => {
    const { api, gate } = await started();
    vi.setSystemTime(Date.now() + 14_000);
    await wake();
    expect(gate.now).toBe(1);
    expect(api.achCalls).toEqual([]);
    expect(api.progressCalls).toEqual([]);
  });

  it("does nothing when the page becomes hidden", async () => {
    const { api, gate } = await started();
    vi.setSystemTime(Date.now() + 60_000);
    hidden("hidden");
    await wake();
    expect(gate.now).toBe(0);
    expect(api.achCalls).toEqual([]);
  });

  it("does the same when the browser comes back online and the window reports it", async () => {
    const win = new EventTarget();
    const { api, gate } = await started(win);
    vi.setSystemTime(Date.now() + 16_000);
    win.dispatchEvent(new Event("online"));
    await flush();
    expect(gate.now).toBe(1);
    expect(api.achCalls).toEqual(["ra:20"]);
    expect(api.progressCalls).toEqual([["hA", true]]);
  });

  it("runs no tick on the online event when no window listener is given", async () => {
    const { gate } = await started();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(gate.now).toBe(0);
  });

  it("starts at most one tick beyond the one already queued for events arriving together", async () => {
    const win = new EventTarget();
    const { gate } = await started(win);
    document.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    await flush();
    expect(gate.now).toBe(2);
  });

  it("keeps the refresh due after a failed now request, so the next good tick refreshes", async () => {
    const { api, app } = await started();
    vi.setSystemTime(Date.now() + 16_000);
    api.failNow = true;
    await wake();
    expect(api.achCalls).toEqual([]);
    api.failNow = false;
    await app.tick();
    expect(api.achCalls).toEqual(["ra:20"]);
    expect(api.progressCalls).toEqual([["hA", true]]);
    await app.tick();
    expect(api.achCalls).toEqual(["ra:20"]);
  });

  it("spends the refresh on a tick that only loads a queued game", async () => {
    const { api, app } = await started();
    api.nowValue = playing(hubZ);
    await app.tick();
    vi.setSystemTime(Date.now() + 16_000);
    api.achCalls.length = 0;
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    await flush();
    // The load fetched the new game's achievements itself; the later tick has nothing left due.
    expect(api.achCalls).toEqual(["steam:10"]);
    await app.tick();
    expect(api.achCalls).toEqual(["steam:10"]);
  });

  it("spends the refresh on a tick that finds nothing on screen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = fakeApi({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    const app = startApp({ doc: document, api, storage: memory(), setInterval: noTimers });
    await app.ready;
    await flush();
    vi.setSystemTime(Date.now() + 16_000);
    await wake();
    (document.querySelectorAll(".picker-games .picker-item")[0] as HTMLElement).click();
    await app.tick();
    await flush();
    const before = api.achCalls.length;
    expect(before).toBe(1);
    await app.tick();
    expect(api.achCalls).toHaveLength(before);
  });

  it("does not run two ticks at once for two events in a row", async () => {
    const win = new EventTarget();
    const { gate } = await started(win);
    gate.release = () => undefined;
    document.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    await flush();
    expect(gate.active).toBe(1);
    const open = gate.release;
    gate.release = null;
    open?.();
    await flush();
    await flush();
    expect(gate.max).toBe(1);
  });
});

describe("your links", () => {
  const MAP = "https://links.example.test/map";
  const PLAN = "https://links.example.test/plan";
  const frameDocs = new Map<string, Document>();
  const noGuide = (over: Partial<NowResponse> = {}): NowResponse => ({
    ...playing(hubA),
    hubs: [],
    ...over,
  });
  const noId: NowResponse = {
    ...playing(hubA),
    hubs: [],
    game: { source: "steam", id: null, title: "Sample Shortcut" },
  };

  beforeEach(() => {
    frameDocs.clear();
    vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      return frameDocs.get(this.getAttribute("src") ?? "") ?? null;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = async (
    now: NowResponse = playing(hubA),
    storage: ReturnType<typeof memory> = memory(),
    tweak?: (api: Fake) => void,
  ) => {
    const api = fakeApi(now);
    tweak?.(api);
    store = storage;
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    await flush();
    return { api, app, storage };
  };
  const restart = async (now: NowResponse, storage: ReturnType<typeof memory>) => {
    document.body.innerHTML = '<main id="app"></main>';
    return start(now, storage);
  };
  const more = (): void => railButtons()[5]?.click();
  const section = (): HTMLElement => $(".picker-links") as HTMLElement;
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".picker-link")];
  const titles = (): (string | null | undefined)[] =>
    rows().map((r) => r.querySelector(".picker-title")?.textContent);
  const errorText = (): string | null | undefined => $(".picker-link-error")?.textContent;
  const add = (name: string, url: string): void => {
    (document.querySelector(".picker-link-name") as HTMLInputElement).value = name;
    (document.querySelector(".picker-link-url") as HTMLInputElement).value = url;
    ($(".picker-link-add") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true }),
    );
  };
  const tap = (index: number): void =>
    (rows()[index]?.querySelector(".picker-item") as HTMLElement).click();
  const shown = (): HTMLIFrameElement[] => [
    ...document.querySelectorAll<HTMLIFrameElement>("iframe:not(.inactive)"),
  ];
  let store = memory();
  const stored = (key: string): unknown => JSON.parse(store.getItem(key) ?? "null");

  it("adds a link under the hub's scope and lists it, without pinning it", async () => {
    await start();
    more();
    expect(section().hidden).toBe(false);
    expect(rows()).toHaveLength(0);
    add("Sample Map", MAP);
    expect(errorText()).toBe("");
    expect(titles()).toEqual(["Sample Map"]);
    expect(stored("game-companion:v1:links:hA")).toEqual([{ title: "Sample Map", url: MAP }]);
    expect(rows()[0]?.querySelector("a")?.getAttribute("href")).toBe(MAP);
    expect(($(".picker-link-name") as HTMLInputElement).value).toBe("");
    expect(
      railButtons()
        .slice(1, 5)
        .filter((b) => !b.hidden),
    ).toHaveLength(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("stores the normalised address and a default title", async () => {
    await start();
    more();
    add("  ", "  HTTPS://Links.Example.Test/Plan  ");
    expect(titles()).toEqual(["links.example.test"]);
    expect(stored("game-companion:v1:links:hA")).toEqual([
      { title: "links.example.test", url: "https://links.example.test/Plan" },
    ]);
  });

  it("explains each way an addition can fail", async () => {
    await start();
    more();
    for (const bad of ["", "nonsense", "http://links.example.test/x", "javascript:alert(1)"]) {
      add("x", bad);
      expect(errorText()).toBe("Enter an address that starts with https://");
    }
    expect(rows()).toHaveLength(0);
    add("Sample Map", MAP);
    add("Again", MAP);
    expect(errorText()).toBe("That link is already in the list");
    expect(rows()).toHaveLength(1);
    for (let i = 1; i < 12; i++) add(`L${i}`, `https://links.example.test/${i}`);
    expect(rows()).toHaveLength(12);
    expect(errorText()).toBe("");
    add("One more", "https://links.example.test/extra");
    expect(errorText()).toBe("That is the most links a game can have (12)");
    expect(rows()).toHaveLength(12);
    add("Again", MAP);
    expect(errorText()).toBe("That link is already in the list");
    expect((stored("game-companion:v1:links:hA") as unknown[]).length).toBe(12);
  });

  it("pins a tapped link and shows it in a sandboxed link frame", async () => {
    await start();
    more();
    add("Sample Map", MAP);
    tap(0);
    expect($(".picker")?.hidden).toBe(true);
    const frame = shown();
    expect(frame).toHaveLength(1);
    expect(frame[0]?.getAttribute("src")).toBe(MAP);
    expect(frame[0]?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame[0]?.getAttribute("sandbox")).not.toContain("top-navigation");
    expect(frame[0]?.getAttribute("title")).toBe("Link");
    expect($(".ach")?.hidden).toBe(true);
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Sample Map");
    expect(railButtons()[2]?.textContent).toBe("SM");
    expect(railButtons()[2]?.querySelector(".rail-count")?.textContent).toBe("");
    expect(railButtons()[2]?.classList.contains("active")).toBe(true);
    const layout = stored("game-companion:v1:layout:hA") as { slots: ({ url: string } | null)[] };
    expect(layout.slots.map((s) => s?.url ?? null)).toEqual(["/doc/hA-checklist", MAP, null, null]);
    // Pages still open as documents beside it.
    railButtons()[1]?.click();
    expect(shown().map((f) => f.hasAttribute("sandbox"))).toEqual([false]);
    more();
    expect(rows()[0]?.querySelector(".picker-item")?.classList.contains("pinned")).toBe(true);
  });

  it("keeps the link and its pin when the same game is loaded again", async () => {
    const first = await start();
    more();
    add("Sample Map", MAP);
    tap(0);
    await restart(playing(hubA), first.storage);
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Sample Map");
    expect(shown().map((f) => f.getAttribute("src"))).toEqual([MAP]);
    expect(shown()[0]?.getAttribute("sandbox")).toContain("allow-scripts");
    more();
    expect(titles()).toEqual(["Sample Map"]);
  });

  it("removing a link unpins it, removes its frame and forgets it", async () => {
    await start();
    more();
    add("Sample Map", MAP);
    add("Planner", PLAN);
    tap(0);
    more();
    (rows()[0]?.querySelector(".picker-link-remove") as HTMLElement).click();
    expect(titles()).toEqual(["Planner"]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect($(".ach")?.hidden).toBe(false);
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Empty slot");
    expect(stored("game-companion:v1:links:hA")).toEqual([{ title: "Planner", url: PLAN }]);
    const layout = stored("game-companion:v1:layout:hA") as { slots: ({ url: string } | null)[] };
    expect(layout.slots.map((s) => s?.url ?? null)).toEqual([
      "/doc/hA-checklist",
      null,
      null,
      null,
    ]);
    expect($(".picker")?.hidden).toBe(false);
  });

  it("unpinning a link from the list leaves it listed", async () => {
    await start();
    more();
    add("Sample Map", MAP);
    tap(0);
    more();
    (rows()[0]?.querySelector(".picker-unpin") as HTMLElement).click();
    expect(titles()).toEqual(["Sample Map"]);
    expect(rows()[0]?.querySelector(".picker-item")?.classList.contains("pinned")).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("drops a pinned link that is no longer in the stored list", async () => {
    const first = await start();
    more();
    add("Sample Map", MAP);
    tap(0);
    first.storage.setItem("game-companion:v1:links:hA", "[]");
    await restart(playing(hubA), first.storage);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Empty slot");
  });

  it("keeps links per game", async () => {
    const api = fakeApi(playing(hubA));
    const storage = memory();
    store = storage;
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    more();
    add("Sample Map", MAP);
    tap(0);
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    await flush();
    expect($(".game-title")?.textContent).toBe("Zeta");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    more();
    expect(section().hidden).toBe(false);
    expect(rows()).toHaveLength(0);
    add("Planner", PLAN);
    expect(stored("game-companion:v1:links:hZ")).toEqual([{ title: "Planner", url: PLAN }]);
    api.nowValue = playing(hubA);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    await app.tick();
    await flush();
    more();
    expect(titles()).toEqual(["Sample Map"]);
    expect(shown().map((f) => f.getAttribute("src"))).toEqual([MAP]);
  });

  it("clears the previous game's links from the picker at once on a change of game", async () => {
    const api = fakeApi(playing(hubA));
    const storage = memory();
    store = storage;
    const app = startApp({ doc: document, api, storage, setInterval: noTimers });
    await app.ready;
    more();
    add("Sample Map", MAP);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    api.hubTree = async (id) => {
      await gate;
      return tree(id === "hA" ? hubA : hubZ);
    };
    api.nowValue = playing(hubZ);
    await app.tick();
    ($(".switch-banner .switch-accept") as HTMLElement).click();
    const ticking = app.tick();
    await flush();
    expect(rows()).toHaveLength(0);
    release();
    await ticking;
  });

  it("gives a game without a guide but with an id its own links, layout and pins", async () => {
    const first = await start(noGuide());
    expect($(".game-note")?.textContent).toBe("No guide found");
    more();
    (document.querySelector('[data-tab="pages"]') as HTMLElement).click();
    expect(section().hidden).toBe(false);
    add("Sample Map", MAP);
    expect(stored("game-companion:v1:links:game:ra:20")).toEqual([
      { title: "Sample Map", url: MAP },
    ]);
    tap(0);
    expect(shown().map((f) => f.getAttribute("src"))).toEqual([MAP]);
    expect(stored("game-companion:v1:layout:game:ra:20")).toEqual({
      slots: [{ title: "Sample Map", url: MAP }, null, null, null],
      active: 0,
    });
    await restart(noGuide(), first.storage);
    expect(railButtons()[1]?.getAttribute("aria-label")).toBe("Sample Map");
    expect(shown().map((f) => f.getAttribute("src"))).toEqual([MAP]);
    more();
    (document.querySelector('[data-tab="pages"]') as HTMLElement).click();
    expect(titles()).toEqual(["Sample Map"]);
  });

  it("removing a link of a game without a guide empties its slot", async () => {
    await start(noGuide());
    more();
    (document.querySelector('[data-tab="pages"]') as HTMLElement).click();
    add("Sample Map", MAP);
    tap(0);
    more();
    (document.querySelector('[data-tab="pages"]') as HTMLElement).click();
    (rows()[0]?.querySelector(".picker-link-remove") as HTMLElement).click();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect((stored("game-companion:v1:layout:game:ra:20") as { active: number }).active).toBe(-1);
  });

  it("offers no links for a game that has neither a guide nor an id", async () => {
    const storage = memory();
    const write = vi.spyOn(storage, "setItem");
    await start(noId, storage);
    expect($(".game-title")?.textContent).toBe("Sample Shortcut");
    more();
    (document.querySelector('[data-tab="pages"]') as HTMLElement).click();
    expect(section().hidden).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not offer links until a game is on screen", async () => {
    await start({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
    });
    expect(section().hidden).toBe(true);
  });

  it("gives a link no progress count even when a page has the same trailing id", async () => {
    const lookalike = "https://links.example.test/notes-checklist";
    await start(playing(hubA), memory(), (api) => {
      api.progressValue = { pages: [{ url: "/doc/hA-checklist", completed: 3, total: 7 }] };
    });
    expect(railButtons()[1]?.querySelector(".rail-count")?.textContent).toBe("3/7");
    more();
    add("Notes", lookalike);
    tap(0);
    expect(railButtons()[2]?.querySelector(".rail-count")?.textContent).toBe("");
    expect(railButtons()[2]?.getAttribute("aria-label")).toBe("Notes");
    expect(railButtons()[1]?.querySelector(".rail-count")?.textContent).toBe("3/7");
  });

  describe("beside find and the guide jump", () => {
    const COLL = "/doc/hA-coll";
    const matchOf = (): FindMatch => ({
      pageTitle: "Collectibles",
      pageUrl: COLL,
      heading: "Chapter One",
      snippet: "the First Steps are here",
    });

    it("find opens its page in a new slot and leaves the link frame alone", async () => {
      frameDocs.set(
        COLL,
        new DOMParser().parseFromString("<body><p>first steps</p></body>", "text/html"),
      );
      await start(playing(hubA), memory(), (api) => {
        api.achievements = async () => board([mk("a1", "First Steps")]);
        api.find = async () => ({ matches: [matchOf()], truncated: false });
      });
      more();
      add("Sample Map", MAP);
      tap(0);
      const linkFrame = shown()[0];
      railButtons()[0]?.click();
      (document.querySelector(".ach-locked .ach-row") as HTMLElement).click();
      (document.querySelector(".ach-find") as HTMLElement).click();
      await flush();
      expect(locateCalls.map((c) => c[0])).toEqual([2]);
      expect(shown().map((f) => f.getAttribute("src"))).toEqual([COLL]);
      expect(linkFrame?.isConnected).toBe(true);
      expect(linkFrame?.getAttribute("src")).toBe(MAP);
      expect(linkFrame?.classList.contains("inactive")).toBe(true);
    });

    it("the jump opens its page in a new slot and leaves the link frame alone", async () => {
      frameDocs.set(
        COLL,
        new DOMParser().parseFromString(
          "<body><h2>Chapter Two: Sample Keep</h2></body>",
          "text/html",
        ),
      );
      await start({ ...playing(hubA), presence: "Chapter Two: Sample Keep" }, memory(), (api) => {
        api.whereValue = {
          matches: [
            {
              pageTitle: "Collectibles",
              pageUrl: COLL,
              heading: "Chapter Two: Sample Keep",
              phrase: "Sample Keep",
            },
          ],
        };
      });
      more();
      add("Sample Map", MAP);
      tap(0);
      const linkFrame = shown()[0];
      ($(".presence-jump") as HTMLElement).click();
      await flush();
      expect(locateCalls.map((c) => c[0])).toEqual([2]);
      expect(shown().map((f) => f.getAttribute("src"))).toEqual([COLL]);
      expect(linkFrame?.getAttribute("src")).toBe(MAP);
    });
  });
});
