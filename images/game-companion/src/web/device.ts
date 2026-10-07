import type { StorageLike } from "./state.js";

export interface Settings {
  keepAwake: boolean;
  hideChrome: boolean;
}

export const DEFAULT_SETTINGS: Settings = { keepAwake: true, hideChrome: true };
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
    return {
      keepAwake: flag(parsed["keepAwake"], DEFAULT_SETTINGS.keepAwake),
      hideChrome: flag(parsed["hideChrome"], DEFAULT_SETTINGS.hideChrome),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(storage: StorageLike | null | undefined, s: Settings): void {
  try {
    storage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ keepAwake: s.keepAwake, hideChrome: s.hideChrome }),
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

  const wanted = (): boolean => enabled && doc.visibilityState === "visible";
  const release = (sentinel: Sentinel): void => {
    try {
      sentinel.release().catch(() => undefined);
    } catch {
      // Already released.
    }
  };

  async function acquire(): Promise<void> {
    if (api === undefined || !wanted() || held !== null || requesting) return;
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
