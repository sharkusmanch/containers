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
  XboxAuthStatus,
} from "../shared/types.js";
import { ApiError, type Api, type XboxAction } from "./api.js";
import {
  createAchievementsView,
  loadPlatformChoice,
  savePlatformChoice,
  type AskState,
  type SwitchPlatform,
} from "./achievements-view.js";
import { createAssistantView } from "./assistant-view.js";
import {
  createWakeLock,
  displayModeFullscreen,
  fullscreenSupported,
  installRow,
  isAppleMobile,
  isFullscreen,
  loadSettings,
  nextGuideZoom,
  saveSettings,
  toggleFullscreen,
  type InstallOffer,
  type WakeLockLike,
} from "./device.js";
import { createFrames, type FrameKind } from "./frames.js";
import { chooseLayout, nextLayoutOverride, type LayoutMode } from "./layout-mode.js";
import type { LocateMode } from "./locate.js";
import type { OutlineApi } from "./outline-api.js";
import { createPicker } from "./picker.js";
import { createRail, type PageProgressLabel } from "./rail.js";
import { createReader } from "./reader.js";
import { choosePanes, createDivider } from "./split.js";
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
  type Slot,
  type StorageLike,
} from "./state.js";

export interface AppOptions {
  doc: Document;
  api: Api;
  storage: StorageLike;
  /** Where the Ask conversation is kept: sessionStorage in the browser; in memory without it. */
  session?: StorageLike;
  setInterval?: typeof setInterval;
  setTimeout?: typeof setTimeout;
  /**
   * The browser's navigator: the screen wake lock (unsupported without it), and what tells an
   * iPhone or iPad, which installs from the Share menu.
   */
  nav?: {
    wakeLock?: WakeLockLike;
    userAgent?: string;
    maxTouchPoints?: number;
    standalone?: boolean;
  };
  /** The browser's install offer, kept since boot; without it there is no Install app button. */
  install?: InstallOffer;
  /** The browser window, to tell whether the page runs as an installed full-screen app. */
  win?: {
    matchMedia?: (query: string) => { matches: boolean };
    /** The window size in CSS pixels, which picks the layout; unknown counts as zero (single). */
    innerWidth?: number;
    innerHeight?: number;
    /** Lets the page refresh when the browser comes back online. */
    addEventListener?: (type: string, listener: () => void) => void;
  };
  nowPollMs?: number;
  achievementsPollMs?: number;
  /** Reloads the page, which signs in again; `location.reload()` by default. */
  reload?: () => void;
  /**
   * The wiki's own API, called from the browser as the signed-in reader. With it a guide page
   * opens in the companion's reader; without it every guide page is framed.
   */
  outline?: OutlineApi;
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
/** How often the Xbox sign-in is checked while a code waits to be entered. */
const XBOX_POLL_MS = 3000;

/** The text of the notice for achievements that just unlocked. */
function unlockText(names: string[]): string {
  const [first, second] = names;
  if (names.length <= 3) return `Unlocked: ${names.join(", ")}`;
  return `Unlocked: ${first}, ${second} and ${names.length - 2} more`;
}

type GameId = { source: Source; id: string };

/**
 * The game a guide's own rows name, else the detected game: what the game's links and Ask
 * conversation are stored under, so they stay put whichever platform the panel shows.
 */
function ownGame(c: Pick<Current, "game" | "hub">): GameId | null {
  const { hub, game } = c;
  if (hub !== null && hub.source !== null && hub.gameId !== null) {
    return { source: hub.source, id: hub.gameId };
  }
  if (game !== null && game.id !== null) return { source: game.source, id: game.id };
  return null;
}

/** The id a guide knows its game by on a platform: its own row's, or its Xbox title. */
function hubGameId(hub: GuideHub, platform: Source): string | null {
  if (hub.source === platform && hub.gameId !== null) return hub.gameId;
  return platform === "xbox" ? hub.xboxTitleId : null;
}

/** Whether a guide knows both a Steam and an Xbox id, so the panel offers the switch. */
function switchable(hub: GuideHub): boolean {
  return hubGameId(hub, "steam") !== null && hubGameId(hub, "xbox") !== null;
}

/** Whether `playing` (the game being played now, if any) is the game on screen. */
function isPlayingHere(c: Pick<Current, "game" | "hub">, playing: GameRef | null): boolean {
  if (playing === null || playing.id === null) return false;
  const { game, hub } = c;
  if (game !== null && game.source === playing.source && game.id === playing.id) return true;
  return hub !== null && hubGameId(hub, playing.source) === playing.id;
}

/**
 * The game whose achievements the panel shows: the game being played, when it is this one; else
 * this device's choice for the guide; else the platform the guide's `Tracked on` row names; else
 * the platform the guide was last detected on; else the guide's own row (or the detected game,
 * without a guide). A platform the guide has no id for is skipped.
 */
function achievementsSource(
  c: Pick<Current, "game" | "hub">,
  playing: GameRef | null,
  choice: Source | null,
): GameId | null {
  if (playing !== null && playing.id !== null && isPlayingHere(c, playing)) {
    return { source: playing.source, id: playing.id };
  }
  const hub = c.hub;
  if (hub !== null) {
    for (const platform of [choice, hub.trackedOn, hub.lastPlatform]) {
      const id = platform === null ? null : hubGameId(hub, platform);
      if (platform !== null && id !== null) return { source: platform, id };
    }
  }
  return ownGame(c);
}

const idKey = (g: GameId | null): string | null => (g === null ? null : `${g.source}:${g.id}`);

/**
 * What a game's links are stored under: the game's own identity so they stay put whichever guide
 * is known; the guide's hub id when it carries no game.
 */
function scopeFor(game: GameRef | null, hub: GuideHub | null): string | null {
  const own = ownGame({ game, hub });
  if (own !== null) return `game:${own.source}:${own.id}`;
  return hub === null ? null : hub.hubId;
}

/** A storage that lasts as long as the page. */
function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
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
  // The Xbox device of the game being played ("Series X", "PC"); only live presence knows it.
  const deviceTag = el("span", "game-device");
  deviceTag.hidden = true;
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
  topbar.append(title, deviceTag, note);

  const bannerLabel = el("span", "switch-label");
  const accept = buttonEl("switch-accept", "Switch");
  const dismiss = buttonEl("switch-dismiss", "Dismiss");
  const banner = doc.createElement("div");
  banner.classList.add("switch-banner");
  banner.hidden = true;
  banner.append(bannerLabel, accept, dismiss);
  // Shown while the server answers 401: the sign-in has lapsed. Reloading the page signs in.
  const signOutBanner = buttonEl("signout-banner", "Signed out \u2014 tap to sign in");
  signOutBanner.hidden = true;
  signOutBanner.addEventListener("click", () => {
    (opts.reload ?? (() => doc.defaultView?.location.reload()))();
  });

  const view = createAchievementsView(doc, {
    storage,
    onFind: (a) => void findInGuide(a),
    onAsk: (a) => askHow(a),
    onPlatform: (platform) => choosePlatform(platform),
  });
  const assistant = createAssistantView(doc, {
    api,
    storage: opts.session ?? memoryStorage(),
    onBusyChange: (busy) => {
      askBusy = busy;
      syncAskHow();
    },
  });
  const outline = opts.outline;
  const frames = createFrames(doc, SLOT_COUNT, {
    ...(opts.setInterval === undefined ? {} : { setInterval: opts.setInterval }),
    onInteract: () => onGuideInteract(),
    ...(outline === undefined
      ? {}
      : {
          reader: (url: string) =>
            createReader(
              {
                doc,
                outline,
                origin: doc.location.origin,
                openPage: (target) => openLinkedPage(target),
                showInOutline: (shown) => {
                  outlineView.add(docId(shown));
                  render();
                },
                onSaved: () => {
                  if (current !== null) void refreshProgress(current, true);
                  // The server answers from a copy under ~5 s old: look again later too.
                  onGuideInteract();
                },
              },
              url,
            ),
        }),
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
  stage.append(view.element, assistant.element, frames.element, toast);

  const rail = createRail(doc, {
    onSelect(index) {
      if (current === null) return;
      // With two panes a page opens on the left, beside the Ask panel.
      if (index === ACHIEVEMENTS || layoutMode !== "split") askOpen = false;
      current.layout = activate(current.layout, index);
      save();
      render();
    },
    onAsk() {
      askOpen = true;
      render();
    },
    onMore() {
      void refreshXbox();
      refreshPicker();
      picker.open(current?.hub ? "pages" : "games");
      // Pick up guides that appeared since the page started; a pending chooser keeps its list.
      if (choosingFor === null) void refreshGuides();
    },
  });

  const picker = createPicker(
    doc,
    {
      onPage(page) {
        openPage(page);
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
        if (name === "guideZoom") {
          settings = { ...settings, guideZoom: nextGuideZoom(settings.guideZoom) };
        } else if (name === "layoutMode") {
          settings = { ...settings, layoutMode: nextLayoutOverride(settings.layoutMode) };
        } else {
          settings = { ...settings, [name]: !settings[name] };
        }
        saveSettings(storage, settings);
        applySettings();
        showSettings();
        renderPresence();
        // Open guide pages switch between the reader and a frame.
        if (name === "guideReader") render();
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
      onInstall() {
        opts.install?.prompt();
        showSettings();
      },
      onDismissSetup() {
        settings = { ...settings, setupDismissed: true };
        saveSettings(storage, settings);
        showSettings();
      },
      onXbox(action) {
        void runXboxAction(action);
      },
      onLink(link) {
        const c = current;
        if (c === null || !c.links.some((l) => l.url === link.url)) return;
        closeAskForPage();
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
    },
    { storage: opts.storage },
  );

  root.replaceChildren(
    rail.element,
    topbar,
    presenceRow,
    banner,
    signOutBanner,
    stage,
    picker.element,
  );

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
  // The game being played as of the last successful poll; kept through a failed one, so an outage
  // does not switch the panel to another platform.
  let playingNow: GameRef | null = null;
  // The game the panel's achievements are for (source:id); null until the first fetch of a game.
  let shownKey: string | null = null;
  // The Xbox sign-in as last reported; null until known.
  let xboxStatus: XboxAuthStatus | null = null;
  let xboxSeq = 0;
  let xboxPollDue = false;
  /** The code-entry poll stopped while signed out; it resumes once when the sign-in returns. */
  let xboxPollPaused = false;
  // While an action is on its way no status is read: its own answer is newer.
  let xboxActing = false;
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
  // The window's size and the arrangement chosen for it; kept current on every resize.
  let windowSize = { width: 0, height: 0 };
  let layoutMode: LayoutMode = "single";
  // Titles of the open guide's pages that are for typing in; empty without a page tree.
  let editableTitles: readonly string[] = [];
  // Pages (by document id) the person asked to see in Outline itself, for this session.
  const outlineView = new Set<string>();
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
  // Whether the server offers the assistant, from the last successful status poll.
  let assistantOn = false;
  // Set by a 401 from any request and cleared by any success; polling waits while it is set.
  let signedOut = false;
  // The Ask panel covers the stage while open (with two panes, the right pane). Never part of the
  // layout, so never stored.
  let askOpen = false;
  // Whether an answer is streaming, which disables "Ask how" (no queueing).
  let askBusy = false;
  let askHowState: AskState = "hidden";
  // The address of the pinned page shown last, for the left pane while 🏆 or 💬 is chosen.
  let lastShownUrl: string | null = null;

  // The bar between the two panes; it starts where this device last left it.
  const setSplitLeft = (fraction: number): void => {
    root.style.setProperty("--split-left", String(fraction));
  };
  const divider = createDivider(doc, {
    fraction: settings.splitFraction,
    measure: () => {
      const area = stage.getBoundingClientRect();
      return { left: area.left, width: area.width };
    },
    onMove: setSplitLeft,
    onCommit(fraction) {
      settings = { ...settings, splitFraction: fraction };
      saveSettings(storage, settings);
    },
  });
  stage.insertBefore(divider.element, toast);

  /** Opening a page closes the Ask panel, except beside it in the second pane. */
  function closeAskForPage(): void {
    if (layoutMode !== "split") askOpen = false;
  }

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
    closeAskForPage();
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

  // Whether `node` is somewhere to type text: a text-like input, a textarea, or an editable region.
  const NON_TEXT_INPUTS = /^(button|checkbox|color|file|image|radio|range|reset|submit)$/i;
  const isTextEntry = (node: unknown): boolean => {
    if (node === null || typeof node !== "object" || !("matches" in node)) return false;
    const element = node as Element;
    if (element.matches("textarea, [contenteditable='' i], [contenteditable='true' i]"))
      return true;
    return element.matches("input") && !NON_TEXT_INPUTS.test(element.getAttribute("type") ?? "");
  };

  // Picks the arrangement from the window size and the person's choice, and marks #app with it.
  // With `resized`, a window that only got shorter while a text field has focus is the on-screen
  // keyboard, not a new shape of screen: the arrangement stays until focus leaves or the width moves.
  const applyLayoutMode = (resized = false): void => {
    const size = (value: unknown): number => (typeof value === "number" ? value : 0);
    const previous = windowSize;
    windowSize = { width: size(opts.win?.innerWidth), height: size(opts.win?.innerHeight) };
    if (
      resized &&
      windowSize.width > 0 &&
      windowSize.width === previous.width &&
      windowSize.height <= previous.height &&
      isTextEntry(doc.activeElement)
    ) {
      return;
    }
    const before = layoutMode;
    layoutMode = chooseLayout({ ...windowSize, override: settings.layoutMode });
    for (const mode of ["single", "tabs", "split"] as const) {
      root.classList.toggle(`layout-${mode}`, mode === layoutMode);
    }
    // What the stage shows depends on the arrangement: two panes route pages to the left.
    if (layoutMode !== before) render();
  };

  function applySettings(): void {
    setSplitLeft(settings.splitFraction);
    applyLayoutMode();
    wakeLock.setEnabled(settings.keepAwake);
    frames.setHideChrome(settings.hideChrome);
    frames.setZoom(settings.guideZoom);
    applyReader();
  }

  // Whether the page framed at `url` is one of the open guide's pages meant for typing in; matched
  // by document id, so a retitled address still counts. With no page tree nothing is editable.
  function isEditable(url: string): boolean {
    if (current === null || editableTitles.length === 0) return false;
    const id = docId(url);
    return flattenPages(current.pages).some(
      (page) => docId(page.url) === id && editableTitles.includes(page.title),
    );
  }

  // The strings of a list from the server; an older server sends none.
  const titlesIn = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];

  function applyReader(): void {
    frames.setReader(settings.readerMode, isEditable);
  }

  function showSettings(): void {
    picker.setSettings({
      ...settings,
      fullscreen: isFullscreen(doc),
      wakeLockSupported: wakeLock.supported,
      fullscreenSupported: fullscreenSupported(doc) && !displayModeFullscreen(opts.win ?? {}),
      install: installRow({
        installed: displayModeFullscreen(opts.win ?? {}),
        offered: opts.install?.available() ?? false,
        apple: isAppleMobile(opts.nav ?? {}),
      }),
      window: { ...windowSize, layout: layoutMode },
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
    renderDevice();
    renderSwitch();
    if (loadingLabel !== null) {
      title.textContent = loadingLabel;
      note.textContent = "Loading…";
      return;
    }
    title.textContent = current?.hub?.title ?? current?.game?.title ?? "Game Companion";
    note.textContent = noteText();
  }

  /** This device's platform choice for the open guide, when it offers the switch. */
  function platformChoice(c: Current): SwitchPlatform | null {
    return c.hub === null || !switchable(c.hub) ? null : loadPlatformChoice(storage, c.hub.hubId);
  }

  function shownFor(c: Current): GameId | null {
    return achievementsSource(c, playingNow, platformChoice(c));
  }

  /** Whether the last answer says the game on screen is being played now, on the platform shown. */
  function playingShown(): boolean {
    const shown = current === null ? null : shownFor(current);
    const game = lastNow?.game ?? null;
    // While another game's title is shown as loading, nothing live may sit under it.
    return (
      loadingLabel === null &&
      lastNow?.state === "playing" &&
      shown !== null &&
      game !== null &&
      game.id === shown.id &&
      game.source === shown.source
    );
  }

  function renderDevice(): void {
    const device = lastNow?.device;
    const show = typeof device === "string" && device !== "" && playingShown();
    deviceTag.textContent = show ? device : "";
    deviceTag.hidden = !show;
  }

  /** The switch shows the platform on screen, except while the game is played (that decides). */
  function renderSwitch(): void {
    const c = current;
    const shown = c === null ? null : shownFor(c);
    const offer =
      c !== null &&
      c.hub !== null &&
      switchable(c.hub) &&
      !isPlayingHere(c, playingNow) &&
      shown !== null &&
      (shown.source === "steam" || shown.source === "xbox");
    view.setPlatformSwitch(offer ? (shown.source as SwitchPlatform) : null);
  }

  /** Another platform picked on the switch: remembered on this device, then shown. */
  function choosePlatform(platform: SwitchPlatform): void {
    const c = current;
    if (c === null || c.hub === null || !switchable(c.hub)) return;
    savePlatformChoice(storage, c.hub.hubId, platform);
    renderSwitch();
    if (inflight < 2) void tick();
  }

  // The game's own status line, only while the game on screen is the one being played now.
  function renderPresence(): void {
    const text = lastNow?.presence;
    const show = typeof text === "string" && text !== "" && playingShown();
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

  /** Ask needs the assistant and a game to ask about; otherwise the panel closes. */
  function canAsk(): boolean {
    return assistantOn && current !== null && current.scope !== null;
  }

  function syncAskHow(): void {
    const state: AskState = !canAsk() ? "hidden" : askBusy ? "disabled" : "enabled";
    if (state === askHowState) return;
    askHowState = state;
    view.setAskState(state);
  }

  /** Sends the question for an achievement at once, then opens Ask as 💬 does; nothing changes if refused. */
  function askHow(a: Achievement): void {
    if (!canAsk()) return;
    const description = a.description === null ? "" : a.description.trim();
    const question = `How do I get "${a.name}"?${description === "" ? "" : ` ${description}`}`;
    if (!assistant.ask(question, "hint")) return;
    askOpen = true;
    render();
  }

  // A browser may reset the scroll position of an element that is not rendered, so it is kept.
  function showAchievementsPanel(shown: boolean): void {
    if (shown) {
      if (view.element.hidden) {
        view.element.hidden = false;
        view.element.scrollTop = savedScroll;
      }
    } else {
      if (!view.element.hidden) savedScroll = view.element.scrollTop;
      view.element.hidden = true;
    }
  }

  // With the Guide reader setting on, a guide page opens in the reader, unless it is for typing
  // in or was asked for in Outline.
  function slotKind(url: string): FrameKind {
    if (isLinkUrl(url)) return "link";
    if (!settings.guideReader || outline === undefined) return "doc";
    if (isEditable(url) || outlineView.has(docId(url))) return "doc";
    return "reader";
  }

  function showSlot(index: number, url: string): void {
    frames.show(index, url, slotKind(url));
    lastShownUrl = url;
  }

  // Opens a page of the guide in a slot, as picked from the list; choosing it shows the reader again.
  function openPage(page: Slot): boolean {
    if (current === null || !isSafeDocUrl(page.url)) return false;
    outlineView.delete(docId(page.url));
    closeAskForPage();
    current.layout = assignSlot(current.layout, page);
    save();
    render();
    return true;
  }

  // A page the reader links to opens like a picked page, when it is one of the open guide's pages.
  function openLinkedPage(url: string): boolean {
    if (current === null || !isSafeDocUrl(url)) return false;
    const id = docId(url);
    const page = flattenPages(current.pages).find((p) => docId(p.url) === id);
    return page === undefined ? false : openPage({ title: page.title, url: page.url });
  }

  function render(): void {
    if (!canAsk()) askOpen = false;
    const layout = current?.layout ?? emptyLayout();
    // A slot the frames would refuse (an address that is neither a page nor a listed link) shows
    // the achievements rather than leaving the stage empty.
    const showable = (index: number): Slot | null => {
      const slot = layout.slots[index] ?? null;
      return slot !== null && (isLinkUrl(slot.url) || isSafeDocUrl(slot.url)) ? slot : null;
    };
    const lastSlot = layout.slots.findIndex((s) => s !== null && s.url === lastShownUrl);
    const panes =
      layoutMode === "split"
        ? choosePanes({
            active: layout.active,
            usable: layout.slots.map((_, index) => showable(index) !== null),
            lastSlot: lastSlot < 0 ? null : lastSlot,
            askOpen,
          })
        : null;
    stage.classList.toggle("two-panes", panes !== null);
    rail.setPanes(panes);
    renderRail(layout);
    renderHeader();
    const canFind = current !== null && current.hub !== null && current.pages.length > 0;
    if (canFind !== findEnabled) {
      findEnabled = canFind;
      view.setFindEnabled(canFind);
    }
    syncAskHow();
    const left = panes === null ? null : showable(panes.left);
    if (panes !== null && left !== null) {
      // Two panes: a page on the left, the achievements or the Ask panel on the right.
      assistant.element.hidden = panes.right !== "ask";
      showAchievementsPanel(panes.right === "achievements");
      showSlot(panes.left, left.url);
      return;
    }
    const slot = layout.active === ACHIEVEMENTS ? null : showable(layout.active);
    assistant.element.hidden = !askOpen;
    if (askOpen) {
      showAchievementsPanel(false);
      frames.hideAll();
    } else if (slot === null) {
      showAchievementsPanel(true);
      frames.hideAll();
    } else {
      showAchievementsPanel(false);
      showSlot(layout.active, slot.url);
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
    rail.setAsk(assistantOn ? (canAsk() ? "enabled" : "disabled") : "hidden", askOpen);
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
        if (interactGen === mine && current === c && !signedOut) void refreshProgress(c, true);
      }, ms);
    }
  }

  async function refreshAchievements(first: boolean): Promise<void> {
    if (current === null) return;
    lastAchievementsAt = Date.now();
    const c = current;
    const src = shownFor(c);
    const key = idKey(src);
    if (key !== shownKey) {
      if (shownKey !== null) {
        // The same guide on another platform: another list, so nothing carries over from the last.
        first = true;
        seenUnlocked = null;
        lastAchievements = null;
        achievementsStale = false;
        unlockedCount = null;
        view.update(null, "Loading…");
      }
      shownKey = key;
      assistant.setScope(
        c.scope,
        c.scope === null ? null : { hubId: c.hub?.hubId ?? null, game: src },
      );
      // The status line and device tag follow the platform shown.
      renderHeader();
    }
    if (src === null) {
      view.update(null, "No achievement data for this game");
      unlockedCount = null;
    } else {
      try {
        const data = await api.achievements(src.source, src.id);
        // A switch to the other platform while this was on its way: its answer is not wanted.
        if (current !== c || shownKey !== key) return;
        lastAchievements = data;
        achievementsStale = false;
        if (data === null) {
          view.update(null, "No achievements for this game");
          unlockedCount = null;
        } else {
          showAchievements();
          unlockedCount = data.noList === true ? null : data.unlocked;
          announceUnlocks(data);
        }
      } catch {
        if (current !== c || shownKey !== key) return;
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
    lastShownUrl = null;
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
      shownKey = null;
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
    const choice = hub !== null && switchable(hub) ? loadPlatformChoice(storage, hub.hubId) : null;
    const shown = achievementsSource({ game, hub }, playingNow, choice);
    assistant.setScope(scope, scope === null ? null : { hubId: hub?.hubId ?? null, game: shown });
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
    editableTitles = [];
    applyReader();
    renderPresence();
    refreshPicker();
    render();

    if (hub !== null) {
      const stored = loadLayout(storage, hub.hubId);
      try {
        const { pages, defaultPins, editablePages } = await api.hubTree(hub.hubId);
        // The links, and any link pinned, added or removed while the tree loaded, are on `waiting`.
        const layout = withPinsFrom(
          reconcileLayout(stored ?? defaultLayout(pages, defaultPins), pages, waiting.links),
          waiting,
        );
        current = { ...waiting, pages, layout, persist: true };
        editableTitles = titlesIn(editablePages);
        void loadMarks(current);
      } catch {
        // A transient error must never overwrite stored pins, so nothing is persisted.
        current = {
          ...waiting,
          layout: withPinsFrom(withoutStrayLinks(stored ?? emptyLayout(), waiting.links), waiting),
        };
      }
      frames.sync(current.layout.slots.map((s) => s?.url ?? null));
      applyReader();
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
    // The signed-out banner takes the same place.
    if (signedOut) return;
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
    // Nothing is polled while signed out; the next tick after a sign-in catches up.
    if (signedOut) return;
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
    // A platform picked on the switch shows at once, whatever the poll below finds.
    await syncShownSource();

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
    playingNow = now.state === "playing" ? now.game : null;
    if (assistantOn !== (now.assistant === true)) {
      assistantOn = now.assistant === true;
      render();
    }
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

    // The open guide as the server knows it now: an Xbox title found for it, the platform it was
    // last detected on.
    const openHub = current?.hub ?? null;
    const freshHub = openHub === null ? undefined : now.hubs.find((h) => h.hubId === openHub.hubId);
    if (current !== null && freshHub !== undefined) current.hub = freshHub;
    // The detected game is the open guide's own game on another platform (a Steam guide's game
    // played on Xbox): there is nothing to switch to.
    const sameGame = current !== null && freshHub !== undefined && isPlayingHere(current, now.game);

    const k = gameKey(now.game);
    const currentKey = current?.key ?? "";
    if (k === "") dismissedKey = "";
    if (k !== "" && current === null && choosingFor === null) {
      // Nothing is on screen (the picker is open), so a banner would be hidden behind it.
      await adopt(now);
      return;
    }
    if (k !== "" && (k === currentKey || sameGame)) {
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

    // The game may have started or stopped being played, which can change the platform shown.
    await syncShownSource();
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

  /** Fetches the achievements again when the panel's game has changed platform. */
  async function syncShownSource(): Promise<void> {
    const c = current;
    if (c === null || shownKey === null || idKey(shownFor(c)) === shownKey) return;
    await refreshAchievements(false);
  }

  // ---- Xbox sign-in ----

  /** Whether a code waiting to be entered can still be used, as far as this device can tell. */
  function codeLive(status: XboxAuthStatus | null): boolean {
    if (status?.state !== "connecting") return false;
    const expires = status.expiresAt === null ? NaN : Date.parse(status.expiresAt);
    return Number.isNaN(expires) || Date.now() < expires;
  }

  function applyXbox(status: XboxAuthStatus): void {
    xboxStatus = status;
    picker.setXbox(status);
    // While a code waits to be entered the status is checked every few seconds; one check at a
    // time, and none once the state moves on, the code expires or the page is signed out.
    if (codeLive(status) && !xboxPollDue) {
      xboxPollDue = true;
      afterDelay(() => {
        xboxPollDue = false;
        if (!codeLive(xboxStatus)) return;
        if (signedOut) {
          xboxPollPaused = true;
          return;
        }
        void refreshXbox();
      }, XBOX_POLL_MS);
    }
  }

  async function refreshXbox(): Promise<void> {
    if (xboxActing) return;
    xboxSeq += 1;
    const mine = xboxSeq;
    let status: XboxAuthStatus;
    try {
      status = await api.xbox();
    } catch (err) {
      if (mine !== xboxSeq || xboxStatus === null) return;
      // Signed out: nothing more is asked until the sign-in comes back.
      if (signedOut || (err instanceof ApiError && err.status === 401)) {
        xboxPollPaused = codeLive(xboxStatus);
        return;
      }
      // Keeps what is showing; a code being entered is checked again.
      applyXbox(xboxStatus);
      return;
    }
    if (mine === xboxSeq) applyXbox(status);
  }

  /** The sign-in is back: a code-entry poll stopped meanwhile runs once more, if still live. */
  function resumeXboxPoll(): void {
    if (!xboxPollPaused) return;
    xboxPollPaused = false;
    if (codeLive(xboxStatus) && !xboxPollDue) void refreshXbox();
  }

  async function runXboxAction(action: XboxAction): Promise<void> {
    // A status read already on its way may predate the action, so its answer is dropped.
    xboxSeq += 1;
    xboxActing = true;
    let status: XboxAuthStatus | null;
    let failure: unknown = null;
    try {
      status = await api.xboxAction(action);
    } catch (err) {
      status = null;
      failure = err;
    } finally {
      xboxActing = false;
    }
    if (status !== null) {
      applyXbox(status);
      return;
    }
    // The server answered that removing the stored sign-in failed: it is still connected.
    showToast(
      action === "disconnect" && failure instanceof ApiError && failure.status >= 500
        ? "Couldn't disconnect"
        : "Could not reach the Xbox sign-in",
    );
    await refreshXbox();
  }

  // A page tree that failed to load is retried on every tick until it succeeds.
  async function retryPageTree(): Promise<void> {
    const c = current;
    if (c === null || c.hub === null || c.persist) return;
    let pages: GuidePage[];
    let defaultPins: string[];
    let editablePages: unknown;
    try {
      ({ pages, defaultPins, editablePages } = await api.hubTree(c.hub.hubId));
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
    editableTitles = titlesIn(editablePages);
    void loadMarks(c);
    frames.sync(c.layout.slots.map((s) => s?.url ?? null));
    applyReader();
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

  function setSignedOut(value: boolean): void {
    if (signedOut === value) return;
    signedOut = value;
    signOutBanner.hidden = !value;
    if (value) hideBanner();
    else resumeXboxPoll();
  }
  api.onAuth?.((signedIn) => setSignedOut(!signedIn));

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
  opts.install?.onChange(showSettings);
  opts.win?.addEventListener?.("resize", () => {
    applyLayoutMode(true);
    showSettings();
  });
  // Putting the keyboard away (focus leaving every text field) settles the arrangement it held.
  doc.addEventListener("focusout", (event) => {
    if (isTextEntry(event.relatedTarget)) return;
    applyLayoutMode();
    showSettings();
  });

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
    // In the background: the first status poll never waits on it.
    void refreshXbox();
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
