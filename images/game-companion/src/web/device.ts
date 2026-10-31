import { clampSplitFraction, DEFAULT_SPLIT_FRACTION, LAYOUT_OVERRIDES } from "./layout-mode.js";
import type { LayoutOverride } from "./layout-mode.js";
import type { StorageLike } from "./state.js";

/** How large the framed wiki pages are drawn, in percent of their normal size. */
export type GuideZoom = 100 | 90 | 80 | 70;
export const GUIDE_ZOOM_STEPS: readonly GuideZoom[] = [100, 90, 80, 70];

/** The next smaller step, wrapping from the smallest back to 100. */
export function nextGuideZoom(z: GuideZoom): GuideZoom {
  const next = GUIDE_ZOOM_STEPS[GUIDE_ZOOM_STEPS.indexOf(z) + 1];
  return next ?? 100;
}

/** The answer depths Ask can default to. */
export type AskDepthSetting = "hint" | "researched";
export const ASK_DEPTH_SETTINGS: readonly AskDepthSetting[] = ["hint", "researched"];

export interface Settings {
  keepAwake: boolean;
  hideChrome: boolean;
  guideJump: boolean;
  guideZoom: GuideZoom;
  /** Stops the on-screen keyboard coming up for the framed wiki pages that are for reading. */
  readerMode: boolean;
  /** Shows guide pages in the companion's own reader (one-tap checkboxes) instead of framing them. */
  guideReader: boolean;
  /** Which arrangement to use: "auto" follows the window size. */
  layoutMode: LayoutOverride;
  /** The share of the width the left pane takes in the two-pane arrangement (0.3 to 0.7). */
  splitFraction: number;
  /** The "Set up this device" card was put away with Got it. */
  setupDismissed: boolean;
  /** The depth Ask sends typed questions, starters and Ask how at; Full answer always asks for "full". */
  askDepth: AskDepthSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  keepAwake: true,
  hideChrome: true,
  guideJump: true,
  guideZoom: 100,
  readerMode: true,
  guideReader: true,
  layoutMode: "auto",
  splitFraction: DEFAULT_SPLIT_FRACTION,
  setupDismissed: false,
  askDepth: "hint",
};
export const SETTINGS_STORAGE_KEY = "game-companion:v1:settings";

export function loadSettings(storage: StorageLike | null | undefined): Settings {
  try {
    const raw = storage?.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null || raw === undefined) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_SETTINGS };
    }
    const flag = (value: unknown, fallback: boolean): boolean =>
      typeof value === "boolean" ? value : fallback;
    const zoom = (value: unknown): GuideZoom =>
      GUIDE_ZOOM_STEPS.find((step) => step === value) ?? DEFAULT_SETTINGS.guideZoom;
    const layout = (value: unknown): LayoutOverride =>
      LAYOUT_OVERRIDES.find((choice) => choice === value) ?? DEFAULT_SETTINGS.layoutMode;
    const askDepth = (value: unknown): AskDepthSetting =>
      ASK_DEPTH_SETTINGS.find((choice) => choice === value) ?? DEFAULT_SETTINGS.askDepth;
    return {
      keepAwake: flag(parsed["keepAwake"], DEFAULT_SETTINGS.keepAwake),
      hideChrome: flag(parsed["hideChrome"], DEFAULT_SETTINGS.hideChrome),
      guideJump: flag(parsed["guideJump"], DEFAULT_SETTINGS.guideJump),
      guideZoom: zoom(parsed["guideZoom"]),
      readerMode: flag(parsed["readerMode"], DEFAULT_SETTINGS.readerMode),
      guideReader: flag(parsed["guideReader"], DEFAULT_SETTINGS.guideReader),
      layoutMode: layout(parsed["layoutMode"]),
      splitFraction: clampSplitFraction(parsed["splitFraction"]),
      setupDismissed: flag(parsed["setupDismissed"], DEFAULT_SETTINGS.setupDismissed),
      askDepth: askDepth(parsed["askDepth"]),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(storage: StorageLike | null | undefined, s: Settings): void {
  try {
    storage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        keepAwake: s.keepAwake,
        hideChrome: s.hideChrome,
        guideJump: s.guideJump,
        guideZoom: s.guideZoom,
        readerMode: s.readerMode,
        guideReader: s.guideReader,
        layoutMode: s.layoutMode,
        splitFraction: clampSplitFraction(s.splitFraction),
        setupDismissed: s.setupDismissed,
        askDepth: s.askDepth,
      }),
    );
  } catch {
    // Storage may be blocked or full; the settings just will not persist.
  }
}

export interface WakeLockLike {
  request(type: "screen"): Promise<{
    release(): Promise<void>;
    addEventListener(type: "release", cb: () => void): void;
  }>;
}

export interface WakeLockController {
  readonly supported: boolean;
  setEnabled(on: boolean): void;
}

type Sentinel = Awaited<ReturnType<WakeLockLike["request"]>>;

/** Holds a screen wake lock while enabled and the document is visible. Every failure is swallowed. */
export function createWakeLock(
  nav: { wakeLock?: WakeLockLike },
  doc: Document,
): WakeLockController {
  const api = nav.wakeLock;
  let enabled = false;
  let held: Sentinel | null = null;
  let requesting = false;
  // A wake-up that arrived while a request was in flight; it is run once when that one settles.
  let skipped = false;

  const wanted = (): boolean => enabled && doc.visibilityState === "visible";
  const release = (sentinel: Sentinel): void => {
    try {
      sentinel.release().catch(() => undefined);
    } catch {
      // Already released.
    }
  };

  async function acquire(): Promise<void> {
    if (api === undefined || !wanted() || held !== null) return;
    if (requesting) {
      skipped = true;
      return;
    }
    requesting = true;
    try {
      const sentinel = await api.request("screen");
      if (!wanted() || held !== null) {
        release(sentinel);
        return;
      }
      held = sentinel;
      sentinel.addEventListener("release", () => {
        if (held !== sentinel) return;
        held = null;
        void acquire();
      });
    } catch {
      // The browser may refuse, for example on low battery.
    } finally {
      requesting = false;
      if (skipped) {
        skipped = false;
        // Still wanted and nothing held: the wake-up that arrived meanwhile gets its turn.
        void acquire();
      }
    }
  }

  if (api !== undefined) doc.addEventListener("visibilitychange", () => void acquire());

  return {
    supported: api !== undefined,
    setEnabled(on) {
      enabled = on;
      if (on) {
        void acquire();
      } else if (held !== null) {
        const sentinel = held;
        held = null;
        release(sentinel);
      }
    },
  };
}

export function fullscreenSupported(doc: Document): boolean {
  return (
    typeof doc.documentElement.requestFullscreen === "function" &&
    typeof doc.exitFullscreen === "function" &&
    doc.fullscreenEnabled !== false
  );
}

/**
 * True when the page is running as an installed app that already fills the screen (or the window),
 * where there is nothing left to enter. False when it cannot be told.
 */
export function displayModeFullscreen(win: {
  matchMedia?: (query: string) => { matches: boolean };
}): boolean {
  try {
    return ["(display-mode: fullscreen)", "(display-mode: standalone)"].some(
      (query) => win.matchMedia?.(query).matches === true,
    );
  } catch {
    return false;
  }
}

export function isFullscreen(doc: Document): boolean {
  return (doc.fullscreenElement ?? null) !== null;
}

export async function toggleFullscreen(doc: Document): Promise<void> {
  try {
    if (isFullscreen(doc)) await doc.exitFullscreen();
    else await doc.documentElement.requestFullscreen();
  } catch {
    // Refused (no gesture, policy) or unsupported: nothing to do.
  }
}

/** Chromium's `beforeinstallprompt` event: the browser's offer to install the page as an app. */
interface InstallPromptEvent {
  preventDefault(): void;
  prompt(): Promise<unknown>;
}

export interface InstallOffer {
  /** Whether the browser has offered to install the page and the offer is still unused. */
  available(): boolean;
  /** Shows the browser's install prompt. It can be shown once, so the offer is then used up. */
  prompt(): void;
  /** Calls `listener` whenever an offer arrives. */
  onChange(listener: () => void): void;
}

/**
 * Keeps the browser's install offer for the Install app button, instead of the browser's own
 * banner. Listen from the start: the offer can arrive at any time after the page loads.
 */
export function captureInstallPrompt(win: {
  addEventListener(type: string, listener: (event: Event) => void): void;
}): InstallOffer {
  let kept: InstallPromptEvent | null = null;
  const listeners: (() => void)[] = [];
  win.addEventListener("beforeinstallprompt", (event) => {
    const offer = event as Event & Partial<InstallPromptEvent>;
    if (typeof offer.prompt !== "function") return;
    event.preventDefault();
    kept = offer as InstallPromptEvent;
    for (const listener of listeners) listener();
  });
  return {
    available: () => kept !== null,
    prompt() {
      const offer = kept;
      kept = null;
      if (offer === null) return;
      try {
        offer.prompt().catch(() => undefined);
      } catch {
        // Refused, for example without a tap: the button just goes away.
      }
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

/**
 * True on an iPhone or iPad, where pages are installed from the Share menu rather than a prompt.
 * iPadOS presents itself as a Mac, so a "Mac" with a touch screen counts too.
 */
export function isAppleMobile(nav: {
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}): boolean {
  if (nav.standalone !== undefined) return true;
  const agent = nav.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(agent)) return true;
  return /Macintosh/.test(agent) && (nav.maxTouchPoints ?? 0) > 1;
}

/** What the Install row shows: the prompt button, the Share menu instructions, or nothing. */
export type InstallRow = "prompt" | "apple" | "hidden";

export function installRow(state: {
  /** Already running as the installed app. */
  installed: boolean;
  /** The browser has offered an install prompt. */
  offered: boolean;
  apple: boolean;
}): InstallRow {
  if (state.installed) return "hidden";
  if (state.offered) return "prompt";
  return state.apple ? "apple" : "hidden";
}

/** Registers the service worker for the page's own directory. Every failure is ignored. */
export function registerServiceWorker(nav: {
  serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
}): void {
  try {
    nav.serviceWorker?.register("sw.js", { scope: "./" }).catch(() => undefined);
  } catch {
    // Not allowed here (for example a private window): the page works without it.
  }
}
