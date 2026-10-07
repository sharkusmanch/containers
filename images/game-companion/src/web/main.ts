import type {
  Achievement,
  AchievementsResponse,
  FindMatch,
  GameRef,
  GuideHub,
  GuidePage,
  NowResponse,
  Source,
} from "../shared/types.js";
import type { Api } from "./api.js";
import { createAchievementsView } from "./achievements-view.js";
import {
  createWakeLock,
  displayModeFullscreen,
  fullscreenSupported,
  isFullscreen,
  loadSettings,
  saveSettings,
  toggleFullscreen,
  type WakeLockLike,
} from "./device.js";
import { createFrames } from "./frames.js";
import { createPicker } from "./picker.js";
import { createRail } from "./rail.js";
import {
  ACHIEVEMENTS,
  SLOT_COUNT,
  activate,
  assignSlot,
  defaultLayout,
  flattenPages,
  gameKey,
  isSafeDocUrl,
  loadLayout,
  reconcileLayout,
  removeSlot,
  saveLayout,
  type Layout,
  type StorageLike,
} from "./state.js";

export interface AppOptions {
  doc: Document;
  api: Api;
  storage: StorageLike;
  setInterval?: typeof setInterval;
  setTimeout?: typeof setTimeout;
  /** The browser's navigator, for the screen wake lock. Without it the lock is unsupported. */
  nav?: { wakeLock?: WakeLockLike };
  /** The browser window, to tell whether the page runs as an installed full-screen app. */
  win?: { matchMedia?: (query: string) => { matches: boolean } };
  nowPollMs?: number;
  achievementsPollMs?: number;
}

export interface App {
  ready: Promise<void>;
  tick(): Promise<void>;
}

interface Current {
  game: GameRef | null;
  hub: GuideHub | null;
  pages: GuidePage[];
  layout: Layout;
  key: string;
  persist: boolean;
}

type Pending =
  { kind: "hub"; game: GameRef | null; hub: GuideHub | null } | { kind: "adopt"; now: NowResponse };

function keyFor(game: GameRef | null, hub: GuideHub | null): string {
  if (game !== null) return gameKey(game);
  if (hub === null) return "";
  return hub.source !== null && hub.gameId !== null
    ? `${hub.source}:${hub.gameId}`
    : `hub:${hub.hubId}`;
}

/** The most the server accepts as a search text, in characters. */
const FIND_MAX = 100;
const FIND_MIN = 2;

/** The text of the notice for achievements that just unlocked. */
function unlockText(names: string[]): string {
  const [first, second] = names;
  if (names.length <= 3) return `Unlocked: ${names.join(", ")}`;
  return `Unlocked: ${first}, ${second} and ${names.length - 2} more`;
}

function achievementsSource(c: Current): { source: Source; id: string } | null {
  const { hub, game } = c;
  if (hub !== null && hub.source !== null && hub.gameId !== null) {
    return { source: hub.source, id: hub.gameId };
  }
  if (game !== null && game.id !== null) return { source: game.source, id: game.id };
  return null;
}

export function startApp(opts: AppOptions): App {
  const { doc, api, storage } = opts;
  const afterDelay = opts.setTimeout ?? setTimeout;
  const nowPollMs = opts.nowPollMs ?? 30_000;
  const achievementsPollMs = opts.achievementsPollMs ?? 60_000;

  const root = doc.getElementById("app");
  if (root === null) throw new Error("#app is missing");

  const el = (tag: string, className: string, text = ""): HTMLElement => {
    const e = doc.createElement(tag);
    e.classList.add(className);
    e.textContent = text;
    return e;
  };
  const buttonEl = (className: string, text: string): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.classList.add(className);
    b.textContent = text;
    return b;
  };

  // ---- DOM, built once ----
  const title = el("span", "game-title", "Game Companion");
  const presence = el("span", "game-presence");
  presence.hidden = true;
  const note = el("span", "game-note");
  const topbar = doc.createElement("header");
  topbar.classList.add("topbar");
  topbar.append(title, presence, note);

  const bannerLabel = el("span", "switch-label");
  const accept = buttonEl("switch-accept", "Switch");
  const dismiss = buttonEl("switch-dismiss", "Dismiss");
  const banner = doc.createElement("div");
  banner.classList.add("switch-banner");
  banner.hidden = true;
  banner.append(bannerLabel, accept, dismiss);

  const view = createAchievementsView(doc, { storage, onFind: (a) => void findInGuide(a) });
  const frames = createFrames(
    doc,
    SLOT_COUNT,
    opts.setInterval === undefined ? {} : { setInterval: opts.setInterval },
  );
  const toastText = el("span", "toast-text");
  const toast = doc.createElement("div");
  toast.classList.add("toast");
  toast.hidden = true;
  toast.append(toastText);
  toast.addEventListener("click", () => {
    toastSeq += 1;
    toast.hidden = true;
  });
  const stage = doc.createElement("div");
  stage.classList.add("stage");
  stage.append(view.element, frames.element, toast);

  const rail = createRail(doc, {
    onSelect(index) {
      if (current === null) return;
      current.layout = activate(current.layout, index);
      save();
      render();
    },
    onMore() {
      picker.setPages(current?.pages ?? [], current?.layout ?? emptyLayout());
      picker.open(current?.hub ? "pages" : "games");
      // Pick up guides that appeared since the page started; a pending chooser keeps its list.
      if (choosingFor === null) void refreshGuides();
    },
  });

  const picker = createPicker(doc, {
    onPage(page) {
      if (current === null) return;
      current.layout = assignSlot(current.layout, page);
      save();
      render();
    },
    onHub(hub) {
      pending = { kind: "hub", game: choosingFor, hub };
      setChoosingFor(null);
      picker.setHubs(allHubs, available);
      loadingLabel = hub.title;
      renderHeader();
      void tick();
    },
    onMatch(match) {
      if (findFor === null) return;
      openMatch(findFor.current, findFor.name, match);
    },
    onSetting(name) {
      if (name === "fullscreen") {
        void toggleFullscreen(doc).then(showSettings);
        return;
      }
      settings = { ...settings, [name]: !settings[name] };
      saveSettings(storage, settings);
      applySettings();
      showSettings();
    },
    onUnpin(page) {
      if (current === null) return;
      current.layout = removeSlot(current.layout, page.url);
      frames.sync(current.layout.slots.map((s) => s?.url ?? null));
      save();
      render();
      picker.setPages(current.pages, current.layout);
    },
    onClose() {
      if (choosingFor === null) return;
      // No guide chosen: show the detected game's achievements without one.
      declinedKey = gameKey(choosingFor);
      pending = { kind: "hub", game: choosingFor, hub: null };
      setChoosingFor(null);
      picker.setHubs(allHubs, available);
      void tick();
    },
  });

  root.replaceChildren(rail.element, topbar, banner, stage, picker.element);

  // ---- state ----
  let current: Current | null = null;
  let allHubs: GuideHub[] = [];
  let available = false;
  let pending: Pending | null = null;
  let choosingFor: GameRef | null = null;
  let declinedKey = "";
  let dismissedKey = "";
  let offered: NowResponse | null = null;
  let liveNow: NowResponse | null = null;
  // The newest successful answer, whatever game it is about; null after a failed poll.
  let lastNow: NowResponse | null = null;
  let unlockedCount: number | null = null;
  let lastAchievementsAt = 0;
  let lastAchievements: AchievementsResponse | null = null;
  let savedScroll = 0;
  let loadingLabel: string | null = null;
  let adoptedFirst = false;
  let everReached = false;
  let nowFailed = false;
  let achievementsStale = false;
  // Lower-cased names the open guide marks as missable; empty until its marks arrive.
  let marks: ReadonlySet<string> = new Set();
  let marksEpoch = 0;
  // Ids unlocked as of the first fetch for this game, plus those announced since.
  let seenUnlocked: Set<string> | null = null;
  let findEnabled = false;
  let settings = loadSettings(storage);
  const wakeLock = createWakeLock(opts.nav ?? {}, doc);
  // The search a list of matches in the picker belongs to.
  let findFor: { current: Current; name: string } | null = null;
  let findSeq = 0;
  let toastSeq = 0;

  function showToast(text: string, ms = 6000): void {
    toastSeq += 1;
    const mine = toastSeq;
    toastText.textContent = text;
    toast.hidden = false;
    afterDelay(() => {
      if (toastSeq === mine) toast.hidden = true;
    }, ms);
  }

  function withMarks(data: AchievementsResponse): AchievementsResponse {
    if (marks.size === 0) return data;
    return {
      ...data,
      achievements: data.achievements.map((a) =>
        marks.has(a.name.toLowerCase()) ? { ...a, missable: true } : a,
      ),
    };
  }

  /** Hands the last good achievements, with the guide's marks, to the panel. */
  function showAchievements(): void {
    if (lastAchievements === null) return;
    view.update(
      withMarks(achievementsStale ? { ...lastAchievements, stale: true } : lastAchievements),
    );
  }

  async function loadMarks(c: Current): Promise<void> {
    if (c.hub === null) return;
    const epoch = marksEpoch;
    let missable: unknown;
    try {
      missable = (await api.marks(c.hub.hubId))?.missable;
    } catch {
      return;
    }
    if (!Array.isArray(missable) || epoch !== marksEpoch) return;
    marks = new Set(
      missable
        .filter((name): name is string => typeof name === "string")
        .map((n) => n.toLowerCase()),
    );
    showAchievements();
  }

  async function findInGuide(a: Achievement): Promise<void> {
    const c = current;
    if (c === null || c.hub === null) return;
    findSeq += 1;
    const mine = findSeq;
    // The server takes 2 to 100 characters; never cut a surrogate pair in half.
    const query = [...a.name].slice(0, FIND_MAX).join("");
    if ([...query.trim()].length < FIND_MIN) {
      showToast("Not found in this guide");
      return;
    }
    let found;
    let failed = false;
    try {
      found = await api.find(c.hub.hubId, query);
    } catch {
      failed = true;
    }
    // Only the newest tap counts, and only while the game it was for is still the one on screen
    // and nothing else (a guide choice, a queued load) has taken over the picker.
    if (mine !== findSeq || current !== c || choosingFor !== null || pending !== null) return;
    if (failed) {
      showToast("Could not search the guide");
      return;
    }
    const matches = found?.matches ?? [];
    const [only] = matches;
    if (only === undefined || found === null || found === undefined) {
      showToast("Not found in this guide");
    } else if (matches.length === 1) {
      openMatch(c, query, only);
    } else {
      findFor = { current: c, name: query };
      picker.showMatches(a.name, matches, found.truncated);
    }
  }

  function openMatch(c: Current, name: string, match: FindMatch): void {
    if (current !== c || !isSafeDocUrl(match.pageUrl)) return;
    if (!flattenPages(c.pages).some((p) => p.url === match.pageUrl)) {
      showToast("Could not open that page");
      return;
    }
    c.layout = assignSlot(c.layout, { title: match.pageTitle, url: match.pageUrl });
    save();
    render();
    picker.setPages(c.pages, c.layout);
    void frames.locate(c.layout.active, name, match.heading).then((result) => {
      if (result === "not-found" && current === c) {
        showToast("Opened the page, but could not find the text");
      }
    });
  }

  function announceUnlocks(data: AchievementsResponse): void {
    // A held copy says nothing about what unlocked just now.
    if (data.stale) return;
    const unlockedNow = data.achievements.filter((a) => a.unlocked);
    if (seenUnlocked === null) {
      seenUnlocked = new Set(unlockedNow.map((a) => a.id));
      return;
    }
    const fresh = unlockedNow.filter((a) => !(seenUnlocked as Set<string>).has(a.id));
    if (fresh.length === 0) return;
    for (const a of fresh) seenUnlocked.add(a.id);
    rail.pulse();
    showToast(unlockText(fresh.map((a) => a.name)), 10_000);
  }

  function applySettings(): void {
    wakeLock.setEnabled(settings.keepAwake);
    frames.setHideChrome(settings.hideChrome);
  }

  function showSettings(): void {
    picker.setSettings({
      ...settings,
      fullscreen: isFullscreen(doc),
      wakeLockSupported: wakeLock.supported,
      fullscreenSupported: fullscreenSupported(doc) && !displayModeFullscreen(opts.win ?? {}),
    });
  }

  function setChoosingFor(game: GameRef | null): void {
    choosingFor = game;
    picker.setChoosing(game !== null);
  }

  async function refreshGuides(): Promise<void> {
    try {
      const guides = await api.guides();
      allHubs = guides.hubs;
      available = guides.available;
      if (choosingFor === null) picker.setHubs(allHubs, available);
    } catch {
      // A failed re-fetch changes nothing.
    }
  }

  function emptyLayout(): Layout {
    return defaultLayout([], []);
  }

  function save(): void {
    if (current !== null && current.persist && current.hub !== null) {
      saveLayout(storage, current.hub.hubId, current.layout);
    }
  }

  function noteText(): string {
    if (nowFailed) {
      return everReached
        ? "Connection lost · showing older data"
        : "Cannot reach the companion service";
    }
    if (current !== null && current.hub === null && current.game !== null) {
      return declinedKey === current.key ? "No guide selected" : "No guide found";
    }
    if (current !== null && liveNow !== null && gameKey(liveNow.game) === current.key) {
      const parts: string[] = [];
      if (liveNow.state === "last-played") parts.push("Last played");
      if (liveNow.stale) parts.push("showing older data");
      return parts.join(" · ");
    }
    return "";
  }

  function renderHeader(): void {
    renderPresence();
    if (loadingLabel !== null) {
      title.textContent = loadingLabel;
      note.textContent = "Loading…";
      return;
    }
    title.textContent = current?.hub?.title ?? current?.game?.title ?? "Game Companion";
    note.textContent = noteText();
  }

  // The game's own status line, only while the game on screen is the one being played now.
  function renderPresence(): void {
    const shown = current === null ? null : achievementsSource(current);
    const game = lastNow?.game ?? null;
    const text = lastNow?.presence;
    // While another game's title is shown as loading, no earlier status line may sit under it.
    const show =
      loadingLabel === null &&
      typeof text === "string" &&
      text !== "" &&
      lastNow?.state === "playing" &&
      shown !== null &&
      game !== null &&
      game.id === shown.id &&
      game.source === shown.source;
    presence.textContent = show ? text : "";
    presence.hidden = !show;
  }

  function render(): void {
    const layout = current?.layout ?? emptyLayout();
    rail.render(layout, unlockedCount);
    renderHeader();
    const canFind = current !== null && current.hub !== null && current.pages.length > 0;
    if (canFind !== findEnabled) {
      findEnabled = canFind;
      view.setFindEnabled(canFind);
    }
    const slot = layout.active === ACHIEVEMENTS ? null : (layout.slots[layout.active] ?? null);
    if (slot === null) {
      if (view.element.hidden) {
        view.element.hidden = false;
        view.element.scrollTop = savedScroll;
      }
      frames.hideAll();
    } else {
      // A browser may reset the scroll position of an element that is not rendered.
      if (!view.element.hidden) savedScroll = view.element.scrollTop;
      view.element.hidden = true;
      frames.show(layout.active, slot.url);
    }
  }

  async function refreshAchievements(first: boolean): Promise<void> {
    if (current === null) return;
    lastAchievementsAt = Date.now();
    const src = achievementsSource(current);
    if (src === null) {
      view.update(null, "No achievement data for this game");
      unlockedCount = null;
    } else {
      try {
        const data = await api.achievements(src.source, src.id);
        lastAchievements = data;
        achievementsStale = false;
        if (data === null) {
          view.update(null, "No achievements for this game");
          unlockedCount = null;
        } else {
          showAchievements();
          unlockedCount = data.unlocked;
          announceUnlocks(data);
        }
      } catch {
        if (first) {
          view.update(null, "Achievements unavailable");
          unlockedCount = null;
        } else if (lastAchievements !== null) {
          achievementsStale = true;
          showAchievements();
        }
      }
    }
    rail.render(current.layout, unlockedCount);
  }

  async function load(game: GameRef | null, hub: GuideHub | null): Promise<void> {
    frames.reset();
    hideBanner();
    picker.close();
    view.update(null, "Loading…");
    unlockedCount = null;
    lastAchievements = null;
    achievementsStale = false;
    savedScroll = 0;
    const key = keyFor(game, hub);
    // A change of game drops the guide's marks and the record of what was unlocked.
    marks = new Set();
    marksEpoch += 1;
    if (key !== current?.key) {
      seenUnlocked = null;
      // The notice is about the game that was on screen; the pulse stops with it.
      toastSeq += 1;
      toast.hidden = true;
      rail.stopPulse();
    }
    findFor = null;
    // A load ends any pending choice, even one a poll in flight has just reopened.
    if (choosingFor !== null) {
      setChoosingFor(null);
      picker.setHubs(allHubs, available);
    }
    if (key !== declinedKey) declinedKey = "";
    current = { game, hub, pages: [], layout: emptyLayout(), key, persist: false };
    renderPresence();
    picker.setPages(current.pages, current.layout);
    render();

    if (hub !== null) {
      const stored = loadLayout(storage, hub.hubId);
      try {
        const { pages, defaultPins } = await api.hubTree(hub.hubId);
        const layout = reconcileLayout(stored ?? defaultLayout(pages, defaultPins), pages);
        current = { game, hub, pages, layout, key, persist: true };
        void loadMarks(current);
      } catch {
        // A transient error must never overwrite stored pins, so nothing is persisted.
        current = { game, hub, pages: [], layout: stored ?? emptyLayout(), key, persist: false };
      }
      picker.setPages(current.pages, current.layout);
      render();
    }
    await refreshAchievements(true);
  }

  function showBanner(now: NowResponse): void {
    offered = now;
    bannerLabel.textContent = `Switch to ${now.game?.title ?? ""}`;
    banner.hidden = false;
  }

  function hideBanner(): void {
    offered = null;
    banner.hidden = true;
  }

  async function adopt(now: NowResponse): Promise<void> {
    liveNow = now;
    hideBanner();
    if (now.game === null) {
      setChoosingFor(null);
      picker.setHubs(allHubs, available);
      picker.open("games");
      renderHeader();
      return;
    }
    const [only, ...rest] = now.hubs;
    if (only === undefined) {
      await load(now.game, null);
    } else if (rest.length === 0) {
      await load(now.game, only);
    } else {
      setChoosingFor(now.game);
      picker.setHubs(now.hubs, true);
      picker.open("games");
      renderHeader();
    }
  }

  async function runTick(): Promise<void> {
    if (pending !== null) {
      const p = pending;
      pending = null;
      loadingLabel = null;
      if (p.kind === "hub") await load(p.game, p.hub);
      else await adopt(p.now);
      return;
    }

    if (!available) await refreshGuides();
    await retryPageTree();

    let now: NowResponse;
    try {
      now = await api.now();
    } catch {
      nowFailed = true;
      lastNow = null;
      renderPresence();
      renderHeader();
      return;
    }
    nowFailed = false;
    everReached = true;
    lastNow = now;
    renderPresence();
    if (!adoptedFirst) {
      adoptedFirst = true;
      // Only when nothing is on screen: a game the user picked by hand during an outage stays.
      if (current === null && choosingFor === null) {
        await adopt(now);
        return;
      }
    }

    const k = gameKey(now.game);
    const currentKey = current?.key ?? "";
    if (k === "") dismissedKey = "";
    if (k !== "" && current === null && choosingFor === null) {
      // Nothing is on screen (the picker is open), so a banner would be hidden behind it.
      await adopt(now);
      return;
    }
    if (k !== "" && k === currentKey) {
      liveNow = now;
      dismissedKey = "";
      hideBanner();
      renderHeader();
      if (
        current !== null &&
        current.hub === null &&
        now.hubs.length > 0 &&
        choosingFor === null &&
        declinedKey !== k
      ) {
        // The guide index became available after the page loaded.
        await adopt(now);
        return;
      }
    } else {
      renderHeader();
      // The banner always describes the game detected now, or is hidden.
      if (k !== "" && k !== currentKey && k !== dismissedKey && choosingFor === null) {
        showBanner(now);
      } else {
        hideBanner();
      }
    }

    if (
      current !== null &&
      doc.visibilityState === "visible" &&
      Date.now() - lastAchievementsAt >= achievementsPollMs
    ) {
      await refreshAchievements(false);
    }
  }

  // A page tree that failed to load is retried on every tick until it succeeds.
  async function retryPageTree(): Promise<void> {
    const c = current;
    if (c === null || c.hub === null || c.persist) return;
    let pages: GuidePage[];
    let defaultPins: string[];
    try {
      ({ pages, defaultPins } = await api.hubTree(c.hub.hubId));
    } catch {
      return;
    }
    const untouched = c.layout.active === ACHIEVEMENTS && c.layout.slots.every((s) => s === null);
    const base =
      untouched && loadLayout(storage, c.hub.hubId) === null
        ? defaultLayout(pages, defaultPins)
        : c.layout;
    c.pages = pages;
    c.layout = reconcileLayout(base, pages);
    c.persist = true;
    void loadMarks(c);
    frames.sync(c.layout.slots.map((s) => s?.url ?? null));
    picker.setPages(c.pages, c.layout);
    render();
  }

  // Ticks run one after another. `inflight` counts running plus queued calls.
  let chain: Promise<void> = Promise.resolve();
  let inflight = 0;
  function tick(): Promise<void> {
    inflight += 1;
    const run = chain.then(runTick).finally(() => {
      inflight -= 1;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  accept.addEventListener("click", () => {
    if (offered === null) return;
    declinedKey = "";
    pending = { kind: "adopt", now: offered };
    loadingLabel = offered.game?.title ?? "";
    hideBanner();
    renderHeader();
    void tick();
  });
  dismiss.addEventListener("click", () => {
    if (offered !== null) dismissedKey = gameKey(offered.game);
    hideBanner();
  });

  applySettings();
  showSettings();
  doc.addEventListener("fullscreenchange", showSettings);

  render();

  const ready = (async () => {
    try {
      const guides = await api.guides(true);
      allHubs = guides.hubs;
      available = guides.available;
    } catch {
      allHubs = [];
      available = false;
    }
    picker.setHubs(allHubs, available);
    await tick();
    const schedule = opts.setInterval ?? setInterval;
    schedule(() => {
      if (inflight === 0) void tick();
    }, nowPollMs);
  })();

  return { ready, tick };
}
