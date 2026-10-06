// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { startApp } from "../src/web/main.js";
import type { Api } from "../src/web/api.js";
import type {
  AchievementsResponse,
  GuideHub,
  HubTreeResponse,
  NowResponse,
} from "../src/shared/types.js";

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
  failNow: boolean;
}

function fakeApi(nowValue: NowResponse): Fake {
  const f: Fake = {
    nowValue,
    achCalls: [],
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
  };
  return f;
}

const playing = (hub: GuideHub): NowResponse => ({
  game: { source: hub.source as "steam" | "ra", id: hub.gameId, title: hub.title },
  state: "playing",
  stale: false,
  observedAt: "2026-10-06T18:00:00.000Z",
  hubs: [hub],
});

const noTimers = (() => 0) as unknown as typeof setInterval;
const $ = (sel: string): HTMLElement | null => document.querySelector(sel);

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
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
    const api = fakeApi({ game: null, state: "none", stale: false, observedAt: null, hubs: [] });
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
    const api = fakeApi({ game: null, state: "none", stale: false, observedAt: null, hubs: [] });
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
    api.nowValue = { game: null, state: "none", stale: false, observedAt: null, hubs: [] };
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
    const api = fakeApi({ game: null, state: "none", stale: false, observedAt: null, hubs: [] });
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
    api.nowValue = { game: null, state: "none", stale: false, observedAt: null, hubs: [] };
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
