import type {
  Achievement,
  AchievementsResponse,
  FindMatch,
  GameRef,
  GuideHub,
  GuidePage,
  NowResponse,
  PageProgress,
  Source,
  WhereMatch,
} from "../shared/types.js";
import type { Api } from "./api.js";
import { createAchievementsView } from "./achievements-view.js";
import {
  createWakeLock,
  displayModeFullscreen,
  fullscreenSupported,
  isFullscreen,
  loadSettings,
  nextGuideZoom,
  saveSettings,
  toggleFullscreen,
  type WakeLockLike,
} from "./device.js";
import { createFrames } from "./frames.js";
import type { LocateMode } from "./locate.js";
import { createPicker } from "./picker.js";
import { createRail, type PageProgressLabel } from "./rail.js";
import {
  ACHIEVEMENTS,
  SLOT_COUNT,
  activate,
  addLink,
  assignSlot,
  defaultLayout,
  docId,
  flattenPages,
  gameKey,
  isSafeDocUrl,
  loadLayout,
  loadLinks,
  normaliseLink,
  reconcileLayout,
  removeLink,
  removeSlot,
  saveLayout,
  saveLinks,
  LINKS_MAX,
  type GameLink,
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
  win?: {
    matchMedia?: (query: string) => { matches: boolean };
    /** Lets the page refresh when the browser comes back online. */
    addEventListener?: (type: string, listener: () => void) => void;
  };
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
  /** What the game's links and layout are stored under; null when nothing identifies the game. */
  scope: string | null;
  links: GameLink[];
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
/** Waking after longer than this since the last refresh refreshes achievements and progress too. */
const WAKE_REFRESH_MS = 15_000;

/** The text of the notice for achievements that just unlocked. */
function unlockText(names: string[]): string {
  const [first, second] = names;
  if (names.length <= 3) return `Unlocked: ${names.join(", ")}`;
  return `Unlocked: ${first}, ${second} and ${names.length - 2} more`;
}

function achievementsSource(c: Pick<Current, "game" | "hub">): {
  source: Source;
  id: string;
} | null {
  const { hub, game } = c;
  if (hub !== null && hub.source !== null && hub.gameId !== null) {
    return { source: hub.source, id: hub.gameId };
  }
  if (game !== null && game.id !== null) return { source: game.source, id: game.id };
  return null;
}

/**
 * What a game's links are stored under: the game's own identity (the one the achievements panel
 * uses) so they stay put whichever guide is known; the guide's hub id when it carries no game.
 */
function scopeFor(game: GameRef | null, hub: GuideHub | null): string | null {
  const shown = achievementsSource({ game, hub });
  if (shown !== null) return `game:${shown.source}:${shown.id}`;
  return hub === null ? null : hub.hubId;
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
  const presence = buttonEl("game-presence", "");
  presence.setAttribute("aria-expanded", "false");
  const presenceRow = doc.createElement("div");
  presenceRow.classList.add("presence-row");
  presenceRow.hidden = true;
  const jump = buttonEl("presence-jump", "");
  jump.hidden = true;
  presenceRow.append(presence, jump);
  presence.addEventListener("click", () => {
    setPresenceExpanded(!presence.classList.contains("expanded"));
  });
  jump.addEventListener("click", () => jumpToGuide());
  const note = el("span", "game-note");
  const topbar = doc.createElement("header");
  topbar.classList.add("topbar");
  topbar.append(title, note);

  const bannerLabel = el("span", "switch-label");
  const accept = buttonEl("switch-accept", "Switch");
  const dismiss = buttonEl("switch-dismiss", "Dismiss");
  const banner = doc.createElement("div");
  banner.classList.add("switch-banner");
  banner.hidden = true;
  banner.append(bannerLabel, accept, dismiss);

  const view = createAchievementsView(doc, { storage, onFind: (a) => void findInGuide(a) });
  const frames = createFrames(doc, SLOT_COUNT, {
    ...(opts.setInterval === undefined ? {} : { setInterval: opts.setInterval }),
    onInteract: () => onGuideInteract(),
  });
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
      refreshPicker();
      picker.open(current?.hub ? "pages" : "games");
      // Pick up guides that appeared since the page started; a pending chooser keeps its list.
      if (choosingFor === null) void refreshGuides();
    },
  });

  const picker = createPicker(doc, {
    onPage(page) {
      if (current === null || !isSafeDocUrl(page.url)) return;
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
      openMatch(
        findFor.current,
        findFor.locate(match),
        match,
        findFor.mode,
        findFor.fallback?.(match),
      );
    },
    onSetting(name) {
      if (name === "fullscreen") {
        void toggleFullscreen(doc).then(showSettings);
        return;
      }
      settings =
        name === "guideZoom"
          ? { ...settings, guideZoom: nextGuideZoom(settings.guideZoom) }
          : { ...settings, [name]: !settings[name] };
      saveSettings(storage, settings);
      applySettings();
      showSettings();
      renderPresence();
    },
    onUnpin(page) {
      if (current === null) return;
      current.layout = removeSlot(current.layout, page.url);
      frames.sync(current.layout.slots.map((s) => s?.url ?? null));
      save();
      render();
      refreshPicker();
    },
    onAddLink(title, url) {
      const c = current;
      const link = normaliseLink(title, url);
      // The form is only reachable while a game with a scope is on screen.
      if (c === null || c.scope === null || link === null) {
        return "Enter an address that starts with https://";
      }
      if (c.links.some((l) => l.url === link.url)) return "That link is already in the list";
      if (c.links.length >= LINKS_MAX) {
        return `That is the most links a game can have (${LINKS_MAX})`;
      }
      const next = addLink(c.links, link);
      if (!saveLinks(storage, c.scope, next)) return "Could not save the link on this device";
      c.links = next;
      refreshPicker();
      return null;
    },
    onLink(link) {
      const c = current;
      if (c === null || !c.links.some((l) => l.url === link.url)) return;
      c.layout = assignSlot(c.layout, link);
      save();
      render();
    },
    onRemoveLink(url) {
      const c = current;
      if (c === null || c.scope === null) return;
      c.links = removeLink(c.links, url);
      saveLinks(storage, c.scope, c.links);
      c.layout = removeSlot(c.layout, url);
      frames.sync(c.layout.slots.map((s) => s?.url ?? null));
      save();
      render();
      refreshPicker();
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

  root.replaceChildren(rail.element, topbar, presenceRow, banner, stage, picker.element);

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
  // Set when the page wakes and the last refresh is old: the next tick refreshes at once.
  let refreshDue = false;
  // Checklist progress of the open guide's pages, by document id; empty until it arrives.
  let progress: ReadonlyMap<string, PageProgressLabel> = new Map();
  let progressEpoch = 0;
  // Numbers the progress requests; an answer older than the last one applied is ignored.
  let progressSeq = 0;
  let progressApplied = 0;
  // Fresh (refresh) reads in flight for the game on screen; ordinary answers wait them out.
  let freshPending = 0;
  // Bumped by every tap in a guide page and every load, so older follow-up timers do nothing.
  let interactGen = 0;
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
  // The search (or status line) a list of matches in the picker belongs to, and the text to look
  // for on the page of the one picked.
  let findFor: {
    current: Current;
    locate: (match: FindMatch) => string;
    mode: LocateMode;
    /** The text to settle for if the heading has drifted (guide jump only). */
    fallback?: (match: FindMatch) => string | undefined;
  } | null = null;
  let findSeq = 0;
  // The guide-jump answer for the status text it was asked about, for the game on screen.
  let whereFor: { load: number; text: string; failed: boolean } | null = null;
  let whereMatches: WhereMatch[] = [];
  let whereSeq = 0;
  // Counts the games loaded; a load replaces the game on screen even when its key is unchanged.
  let loadCount = 0;
  // The status text now showing, or null while the row is hidden.
  let presenceShown: string | null = null;
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
      findFor = { current: c, locate: () => query, mode: "text" };
      picker.showMatches(a.name, matches, found.truncated);
    }
  }

  function renderJump(): void {
    const [best] = whereMatches;
    const offer =
      presenceShown !== null &&
      settings.guideJump &&
      best !== undefined &&
      whereFor !== null &&
      whereFor.load === loadCount &&
      // As with Find, nothing to open until the page list is there.
      current !== null &&
      current.pages.length > 0;
    jump.textContent = offer ? `↪ ${best.phrase}` : "";
    if (offer) jump.setAttribute("aria-label", `Open the guide at ${best.heading}`);
    else jump.removeAttribute("aria-label");
    jump.hidden = !offer;
  }

  function forgetWhere(): void {
    whereSeq += 1;
    whereFor = null;
    whereMatches = [];
  }

  // Asks the server where in the guide the status line points, once per status text.
  function syncJump(): void {
    const c = current;
    if (whereFor !== null && (whereFor.load !== loadCount || !settings.guideJump)) forgetWhere();
    const text = presenceShown;
    if (text === null || c === null || c.hub === null || !settings.guideJump) {
      renderJump();
      return;
    }
    if (whereFor === null || whereFor.text !== text) {
      const hubId = c.hub.hubId;
      whereSeq += 1;
      const mine = whereSeq;
      const load = loadCount;
      whereFor = { load, text, failed: false };
      whereMatches = [];
      void api.where(hubId).then(
        (answer) => {
          // Only the newest question counts, and only while it is still about what is on screen.
          if (mine !== whereSeq) return;
          if (load !== loadCount || !settings.guideJump || presenceShown !== text) {
            forgetWhere();
          } else {
            whereMatches = Array.isArray(answer?.matches) ? answer.matches : [];
          }
          renderJump();
        },
        () => {
          if (mine !== whereSeq) return;
          // Kept as a failure, so only the next status poll asks again.
          whereMatches = [];
          if (whereFor !== null) whereFor.failed = true;
          renderJump();
        },
      );
    }
    renderJump();
  }

  function jumpToGuide(): void {
    const c = current;
    const [best, ...rest] = whereMatches;
    if (c === null || best === undefined || whereFor?.load !== loadCount) return;
    if (choosingFor !== null || pending !== null) return;
    // A Find answer still in flight must not replace what the jump shows.
    findSeq += 1;
    // The jump reuses the find flow: a match whose heading is the text to look for.
    const phrases = new Map<FindMatch, string>();
    const asFind = (m: WhereMatch): FindMatch => {
      const match = {
        pageTitle: m.pageTitle,
        pageUrl: m.pageUrl,
        heading: null,
        snippet: m.heading,
      };
      phrases.set(match, m.phrase);
      return match;
    };
    const entries = [best, ...rest].map(asFind);
    if (rest.length === 0) {
      const [only] = entries;
      if (only !== undefined) openMatch(c, best.heading, only, "heading", best.phrase);
    } else {
      findFor = {
        current: c,
        locate: (match) => match.snippet,
        mode: "heading",
        fallback: (match) => phrases.get(match),
      };
      picker.showMatches(best.phrase, entries, false);
    }
  }

  function openMatch(
    c: Current,
    name: string,
    match: FindMatch,
    mode: LocateMode = "text",
    fallback?: string,
  ): void {
    if (current !== c || !isSafeDocUrl(match.pageUrl)) return;
    if (!flattenPages(c.pages).some((p) => p.url === match.pageUrl)) {
      showToast("Could not open that page");
      return;
    }
    c.layout = assignSlot(c.layout, { title: match.pageTitle, url: match.pageUrl });
    save();
    render();
    refreshPicker();
    const located =
      fallback === undefined
        ? frames.locate(c.layout.active, name, match.heading, mode)
        : frames.locate(c.layout.active, name, match.heading, mode, fallback);
    void located.then((result) => {
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
    frames.setZoom(settings.guideZoom);
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
    const key = current === null ? null : (current.hub?.hubId ?? current.scope);
    if (current !== null && current.persist && key !== null) {
      saveLayout(storage, key, current.layout);
    }
  }

  // The Pages tab: the guide's pages and the game's own links, with what is pinned.
  function refreshPicker(): void {
    const layout = current?.layout ?? emptyLayout();
    picker.setPages(current?.pages ?? [], layout);
    picker.setLinks(current?.links ?? [], layout, current?.scope != null);
  }

  // Empties the slots holding an https address that is not in `links`; document slots stay.
  function withoutStrayLinks(layout: Layout, links: GameLink[]): Layout {
    return layout.slots.reduce(
      (acc, slot) =>
        slot !== null && !isSafeDocUrl(slot.url) && !links.some((l) => l.url === slot.url)
          ? removeSlot(acc, slot.url)
          : acc,
      layout,
    );
  }

  // Links pinned while the page tree was loading are on the layout the game had until then.
  function withPinsFrom(layout: Layout, earlier: Current): Layout {
    return earlier.layout.slots.reduce(
      (acc, slot) => (slot === null ? acc : assignSlot(acc, slot)),
      layout,
    );
  }

  // A slot holds a link only while its address is in the game's list; anything else is a document.
  function isLinkUrl(url: string): boolean {
    return current?.links.some((l) => l.url === url) ?? false;
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
    presenceRow.hidden = !show;
    // Expanded survives new text for the same game, but never a hidden row.
    if (!show) setPresenceExpanded(false);
    presenceShown = show ? text : null;
    syncJump();
  }

  function setPresenceExpanded(expanded: boolean): void {
    presence.classList.toggle("expanded", expanded);
    presence.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function render(): void {
    const layout = current?.layout ?? emptyLayout();
    renderRail(layout);
    renderHeader();
    const canFind = current !== null && current.hub !== null && current.pages.length > 0;
    if (canFind !== findEnabled) {
      findEnabled = canFind;
      view.setFindEnabled(canFind);
    }
    const active = layout.active === ACHIEVEMENTS ? null : (layout.slots[layout.active] ?? null);
    // A slot the frames would refuse (an address that is neither a page nor a listed link) shows
    // the achievements rather than leaving the stage empty.
    const slot =
      active !== null && (isLinkUrl(active.url) || isSafeDocUrl(active.url)) ? active : null;
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
      frames.show(layout.active, slot.url, isLinkUrl(slot.url) ? "link" : "doc");
    }
  }

  function renderRail(layout: Layout): void {
    rail.render(
      layout,
      unlockedCount,
      layout.slots.map((slot) =>
        slot === null || isLinkUrl(slot.url) ? null : (progress.get(docId(slot.url)) ?? null),
      ),
    );
  }

  async function refreshProgress(c: Current, fresh = false): Promise<void> {
    if (c.hub === null) return;
    const epoch = progressEpoch;
    progressSeq += 1;
    const mine = progressSeq;
    let pages: unknown;
    if (fresh) freshPending += 1;
    try {
      const hubId = c.hub.hubId;
      pages = (await (fresh ? api.progress(hubId, true) : api.progress(hubId)))?.pages;
    } catch {
      return;
    } finally {
      if (fresh && epoch === progressEpoch) freshPending -= 1;
    }
    if (!Array.isArray(pages) || epoch !== progressEpoch || current === null) return;
    // The server answers an ordinary poll from its held copy, which may predate the fresh read
    // still on its way; that read wins.
    if (!fresh && freshPending > 0) return;
    if (mine < progressApplied) return;
    progressApplied = mine;
    const byDoc = new Map<string, PageProgressLabel>();
    for (const page of pages as Partial<PageProgress>[]) {
      if (
        typeof page?.url === "string" &&
        typeof page.completed === "number" &&
        typeof page.total === "number"
      ) {
        byDoc.set(docId(page.url), { completed: page.completed, total: page.total });
      }
    }
    progress = byDoc;
    renderRail(current.layout);
  }

  // A tap inside a guide page may have ticked a box: look again shortly, and once more later.
  function onGuideInteract(): void {
    const c = current;
    if (c === null || c.hub === null) return;
    interactGen += 1;
    const mine = interactGen;
    for (const ms of [4000, 12_000]) {
      afterDelay(() => {
        if (interactGen === mine && current === c) void refreshProgress(c, true);
      }, ms);
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
    renderRail(current.layout);
  }

  async function load(game: GameRef | null, hub: GuideHub | null): Promise<void> {
    loadCount += 1;
    progress = new Map();
    progressEpoch += 1;
    freshPending = 0;
    interactGen += 1;
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
    const scope = scopeFor(game, hub);
    const waiting: Current = {
      game,
      hub,
      pages: [],
      layout: emptyLayout(),
      key,
      persist: false,
      scope,
      links: scope === null ? [] : loadLinks(storage, scope),
    };
    current = waiting;
    renderPresence();
    refreshPicker();
    render();

    if (hub !== null) {
      const stored = loadLayout(storage, hub.hubId);
      try {
        const { pages, defaultPins } = await api.hubTree(hub.hubId);
        // The links, and any link pinned, added or removed while the tree loaded, are on `waiting`.
        const layout = withPinsFrom(
          reconcileLayout(stored ?? defaultLayout(pages, defaultPins), pages, waiting.links),
          waiting,
        );
        current = { ...waiting, pages, layout, persist: true };
        void loadMarks(current);
      } catch {
        // A transient error must never overwrite stored pins, so nothing is persisted.
        current = {
          ...waiting,
          layout: withPinsFrom(withoutStrayLinks(stored ?? emptyLayout(), waiting.links), waiting),
        };
      }
      frames.sync(current.layout.slots.map((s) => s?.url ?? null));
      refreshPicker();
      render();
    } else if (scope !== null) {
      // A game without a guide keeps a layout of its links only.
      const layout = reconcileLayout(
        loadLayout(storage, scope) ?? emptyLayout(),
        [],
        waiting.links,
      );
      current = { ...waiting, layout, persist: true };
      refreshPicker();
      render();
    }
    void refreshProgress(current);
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

  // The wake's "refresh now" is spent by the tick that sees it, whatever that tick does; only a
  // failed now request keeps it for the next good one.
  let nowLost = false;
  async function runTick(): Promise<void> {
    const due = refreshDue;
    nowLost = false;
    try {
      await runTickBody(due);
    } finally {
      if (due && !nowLost) refreshDue = false;
    }
  }

  async function runTickBody(due: boolean): Promise<void> {
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
      nowLost = true;
      lastNow = null;
      renderPresence();
      renderHeader();
      return;
    }
    nowFailed = false;
    everReached = true;
    lastNow = now;
    if (whereFor?.failed === true) whereFor = null;
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
      (due || Date.now() - lastAchievementsAt >= achievementsPollMs)
    ) {
      // After a wake the numbers may be a minute old: ask for a fresh read.
      void refreshProgress(current, due);
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
    // The links are read now, not before the wait: they may have been edited meanwhile.
    if (current !== c) return;
    c.pages = pages;
    c.layout = reconcileLayout(base, pages, c.links);
    c.persist = true;
    void loadMarks(c);
    frames.sync(c.layout.slots.map((s) => s?.url ?? null));
    refreshPicker();
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
    // Waking up (the page shown again, the network back) asks now instead of waiting for the poll.
    const wake = (): void => {
      if (Date.now() - lastAchievementsAt > WAKE_REFRESH_MS) refreshDue = true;
      // One running and one waiting tick are enough: the waiting one sees everything newer.
      if (inflight < 2) void tick();
    };
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "visible") wake();
    });
    opts.win?.addEventListener?.("online", wake);
  })();

  return { ready, tick };
}
