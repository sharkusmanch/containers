import type { StorageLike } from "./state.js";

/** How large the framed wiki pages are drawn, in percent of their normal size. */
export type GuideZoom = 100 | 90 | 80 | 70;
export const GUIDE_ZOOM_STEPS: readonly GuideZoom[] = [100, 90, 80, 70];

/** The next smaller step, wrapping from the smallest back to 100. */
export function nextGuideZoom(z: GuideZoom): GuideZoom {
  const next = GUIDE_ZOOM_STEPS[GUIDE_ZOOM_STEPS.indexOf(z) + 1];
  return next ?? 100;
}

export interface Settings {
  keepAwake: boolean;
  hideChrome: boolean;
  guideJump: boolean;
  guideZoom: GuideZoom;
}

export const DEFAULT_SETTINGS: Settings = {
  keepAwake: true,
  hideChrome: true,
  guideJump: true,
  guideZoom: 100,
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
    return {
      keepAwake: flag(parsed["keepAwake"], DEFAULT_SETTINGS.keepAwake),
      hideChrome: flag(parsed["hideChrome"], DEFAULT_SETTINGS.hideChrome),
      guideJump: flag(parsed["guideJump"], DEFAULT_SETTINGS.guideJump),
      guideZoom: zoom(parsed["guideZoom"]),
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
