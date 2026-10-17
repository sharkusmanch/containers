// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  captureInstallPrompt,
  createWakeLock,
  displayModeFullscreen,
  installRow,
  isAppleMobile,
  registerServiceWorker,
  fullscreenSupported,
  GUIDE_ZOOM_STEPS,
  isFullscreen,
  loadSettings,
  nextGuideZoom,
  saveSettings,
  toggleFullscreen,
  type WakeLockLike,
} from "../src/web/device.js";

function memory(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("settings", () => {
  it("defaults to keeping the screen on, hiding the wiki bars and offering the guide jump", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      keepAwake: true,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(SETTINGS_STORAGE_KEY).toBe("game-companion:v1:settings");
    expect(loadSettings(memory())).toEqual({
      keepAwake: true,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it("returns a fresh object every time, never the shared default", () => {
    const a = loadSettings(memory());
    expect(a).not.toBe(DEFAULT_SETTINGS);
    a.keepAwake = false;
    expect(DEFAULT_SETTINGS.keepAwake).toBe(true);
    expect(loadSettings(undefined)).not.toBe(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips through storage", () => {
    const storage = memory();
    saveSettings(storage, {
      keepAwake: false,
      hideChrome: true,
      guideJump: false,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string)).toEqual({
      keepAwake: false,
      hideChrome: true,
      guideJump: false,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(loadSettings(storage)).toEqual({
      keepAwake: false,
      hideChrome: true,
      guideJump: false,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    saveSettings(storage, {
      keepAwake: true,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(loadSettings(storage)).toEqual({
      keepAwake: true,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it("gives an older stored object without the guide jump key the default", () => {
    const storage = memory({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ keepAwake: false, hideChrome: false }),
    });
    expect(loadSettings(storage)).toEqual({
      keepAwake: false,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it.each([
    ["not JSON", "{oops"],
    ["null", "null"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["an array", "[true,false]"],
    ["an empty object", "{}"],
  ])("falls back to the defaults for %s", (_name, raw) => {
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back per field for a corrupt value", () => {
    const load = (v: unknown) =>
      loadSettings(memory({ [SETTINGS_STORAGE_KEY]: JSON.stringify(v) }));
    expect(load({ keepAwake: false, hideChrome: "yes" })).toEqual({
      keepAwake: false,
      hideChrome: true,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(load({ keepAwake: 0, hideChrome: false })).toEqual({
      keepAwake: true,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(load({ keepAwake: null, hideChrome: null })).toEqual(DEFAULT_SETTINGS);
    expect(load({ keepAwake: false, hideChrome: false, guideJump: "off" })).toEqual({
      keepAwake: false,
      hideChrome: false,
      guideJump: true,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
    expect(load({ guideJump: false })).toEqual({ ...DEFAULT_SETTINGS, guideJump: false });
  });

  it("never throws when storage does", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(broken, DEFAULT_SETTINGS)).not.toThrow();
    expect(() => saveSettings(undefined, DEFAULT_SETTINGS)).not.toThrow();
    expect(() => saveSettings(null, DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe("guide text size", () => {
  it("offers 100, 90, 80 and 70 and defaults to 100", () => {
    expect(GUIDE_ZOOM_STEPS).toEqual([100, 90, 80, 70]);
    expect(DEFAULT_SETTINGS.guideZoom).toBe(100);
  });

  it.each([100, 90, 80, 70] as const)("round-trips %i through storage", (guideZoom) => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULT_SETTINGS, guideZoom });
    const saved = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string) as {
      guideZoom: number;
    };
    expect(saved.guideZoom).toBe(guideZoom);
    expect(loadSettings(storage).guideZoom).toBe(guideZoom);
  });

  it.each([
    ["a string", "90"],
    ["a number that is not a step", 85],
    ["zero", 0],
    ["null", null],
    ["an object", { value: 90 }],
    ["a boolean", true],
  ])("falls back to 100 for %s", (_name, value) => {
    const raw = JSON.stringify({
      keepAwake: false,
      hideChrome: false,
      guideJump: false,
      guideZoom: value,
    });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      keepAwake: false,
      hideChrome: false,
      guideJump: false,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it("gives an older stored object without the key 100 and keeps its other values", () => {
    const raw = JSON.stringify({ keepAwake: false, hideChrome: true, guideJump: false });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      keepAwake: false,
      hideChrome: true,
      guideJump: false,
      guideZoom: 100,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it("steps to the next smaller size and wraps from 70 back to 100", () => {
    expect(nextGuideZoom(100)).toBe(90);
    expect(nextGuideZoom(90)).toBe(80);
    expect(nextGuideZoom(80)).toBe(70);
    expect(nextGuideZoom(70)).toBe(100);
  });
});

describe("reader mode setting", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.readerMode).toBe(true);
    expect(loadSettings(memory()).readerMode).toBe(true);
  });

  it.each([true, false])("round-trips %s through storage", (readerMode) => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULT_SETTINGS, readerMode });
    const saved = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string) as {
      readerMode: boolean;
    };
    expect(saved.readerMode).toBe(readerMode);
    expect(loadSettings(storage).readerMode).toBe(readerMode);
  });

  it.each([
    ["a string", "off"],
    ["a number", 0],
    ["null", null],
    ["an object", {}],
  ])("falls back to on for %s and keeps the other values", (_name, value) => {
    const raw = JSON.stringify({ keepAwake: false, guideJump: false, readerMode: value });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      ...DEFAULT_SETTINGS,
      keepAwake: false,
      guideJump: false,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });

  it("gives an older stored object without the key on and keeps its other values", () => {
    const raw = JSON.stringify({
      keepAwake: false,
      hideChrome: false,
      guideJump: false,
      guideZoom: 80,
    });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      keepAwake: false,
      hideChrome: false,
      guideJump: false,
      guideZoom: 80,
      readerMode: true,
      layoutMode: "auto",
      splitFraction: 0.55,
      setupDismissed: false,
    });
  });
});

describe("layout settings", () => {
  it("default to automatic with the divider at 0.55", () => {
    expect(DEFAULT_SETTINGS.layoutMode).toBe("auto");
    expect(DEFAULT_SETTINGS.splitFraction).toBe(0.55);
  });

  it.each(["auto", "single", "tabs", "split"] as const)(
    "round-trips the %s layout through storage",
    (layoutMode) => {
      const storage = memory();
      saveSettings(storage, { ...DEFAULT_SETTINGS, layoutMode });
      expect(loadSettings(storage).layoutMode).toBe(layoutMode);
    },
  );

  it.each([
    ["a string that is not a mode", "wide"],
    ["a number", 1],
    ["null", null],
    ["an object", {}],
  ])("falls back to automatic for %s", (_name, value) => {
    const raw = JSON.stringify({ keepAwake: false, layoutMode: value });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      ...DEFAULT_SETTINGS,
      keepAwake: false,
    });
  });

  it("gives an older stored object without the keys the defaults and keeps its other values", () => {
    const raw = JSON.stringify({ keepAwake: false, hideChrome: true, guideZoom: 80 });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw }))).toEqual({
      ...DEFAULT_SETTINGS,
      keepAwake: false,
      guideZoom: 80,
    });
  });

  it.each([
    [0.4, 0.4],
    [0.3, 0.3],
    [0.7, 0.7],
    [0.05, 0.3],
    [0.99, 0.7],
    [-1, 0.3],
    ["0.4", 0.55],
    [null, 0.55],
    [Number.NaN, 0.55],
  ])("loads a stored divider of %s as %s", (value, expected) => {
    const raw = JSON.stringify({ splitFraction: value });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw })).splitFraction).toBe(expected);
  });

  it.each([
    [0.4, 0.4],
    [0.1, 0.3],
    [0.9, 0.7],
    [Number.NaN, 0.55],
  ])("saves a divider of %s as %s", (splitFraction, expected) => {
    const storage = memory();
    saveSettings(storage, { ...DEFAULT_SETTINGS, splitFraction });
    const saved = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string) as {
      splitFraction: number;
    };
    expect(saved.splitFraction).toBe(expected);
  });
});

describe("createWakeLock", () => {
  type Sentinel = ReturnType<typeof makeSentinel>;
  function makeSentinel() {
    const listeners: (() => void)[] = [];
    const s = {
      released: false,
      release: vi.fn(async () => {
        s.released = true;
        for (const l of listeners) l();
      }),
      addEventListener: (_type: "release", cb: () => void) => void listeners.push(cb),
      fire: () => {
        s.released = true;
        for (const l of listeners) l();
      },
    };
    return s;
  }
  function setup(visible = true) {
    const sentinels: Sentinel[] = [];
    const request = vi.fn(async (_type: "screen") => {
      const s = makeSentinel();
      sentinels.push(s);
      return s;
    });
    const nav: { wakeLock?: WakeLockLike } = { wakeLock: { request } };
    let state: "visible" | "hidden" = visible ? "visible" : "hidden";
    Object.defineProperty(document, "visibilityState", { get: () => state, configurable: true });
    const setVisible = (v: boolean): void => {
      state = v ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const held = (): Sentinel[] => sentinels.filter((s) => !s.released);
    return { nav, request, sentinels, setVisible, held, controller: createWakeLock(nav, document) };
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("is supported only when the browser has a wake lock", () => {
    expect(setup().controller.supported).toBe(true);
    expect(createWakeLock({}, document).supported).toBe(false);
  });

  it("requests a screen lock when enabled while visible", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledWith("screen");
    expect(t.held()).toHaveLength(1);
  });

  it("does not request while the document is hidden, and does when it becomes visible", async () => {
    const t = setup(false);
    t.controller.setEnabled(true);
    await settle();
    expect(t.request).not.toHaveBeenCalled();
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("does not request on becoming visible while disabled", async () => {
    const t = setup(false);
    t.controller.setEnabled(false);
    t.setVisible(true);
    await settle();
    expect(t.request).not.toHaveBeenCalled();
  });

  it("asks again when the browser releases the lock while still enabled and visible", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    await settle();
    (t.sentinels[0] as Sentinel).fire();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.held()).toHaveLength(1);
  });

  it("does not ask again after a release while hidden, only when it becomes visible", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    await settle();
    t.setVisible(false);
    (t.sentinels[0] as Sentinel).fire();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it("releases the lock when disabled, and does not ask again for that release", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    await settle();
    t.controller.setEnabled(false);
    await settle();
    expect((t.sentinels[0] as Sentinel).release).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledTimes(1);
    t.setVisible(false);
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("never holds two locks at once", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    t.controller.setEnabled(true);
    t.setVisible(true);
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    t.controller.setEnabled(true);
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.held()).toHaveLength(1);
  });

  it("releases a lock that was granted after the setting was turned off", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    t.controller.setEnabled(false);
    await settle();
    expect(t.held()).toHaveLength(0);
    t.controller.setEnabled(true);
    await settle();
    expect(t.held()).toHaveLength(1);
  });

  it("swallows a refused request and tries again later", async () => {
    const t = setup();
    t.request.mockRejectedValueOnce(new Error("low battery"));
    t.controller.setEnabled(true);
    await settle();
    expect(t.held()).toHaveLength(0);
    t.setVisible(true);
    await settle();
    expect(t.held()).toHaveLength(1);
  });

  it("swallows a request that throws at once, and a release that rejects", async () => {
    const t = setup();
    t.request.mockImplementationOnce(() => {
      throw new Error("not allowed");
    });
    t.controller.setEnabled(true);
    await settle();
    t.setVisible(true);
    await settle();
    const s = t.sentinels[0] as Sentinel;
    s.release.mockRejectedValueOnce(new Error("gone"));
    t.controller.setEnabled(false);
    await settle();
    expect(s.release).toHaveBeenCalled();
  });

  it("retries once when a wake-up arrived while a request was pending and that request fails", async () => {
    const t = setup();
    let fail: (e: Error) => void = () => undefined;
    t.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    t.controller.setEnabled(true);
    // while the first request is still pending the page is shown again, and the setting re-applied
    t.setVisible(true);
    t.controller.setEnabled(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    fail(new Error("low battery"));
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.held()).toHaveLength(1);
  });

  it("follows a skipped wake-up with exactly one more request, never a loop", async () => {
    const t = setup();
    t.request.mockRejectedValue(new Error("refused"));
    t.controller.setEnabled(true);
    t.setVisible(true);
    await settle();
    await settle();
    // one follow-up for the skipped wake-up, which also fails; nothing further
    expect(t.request).toHaveBeenCalledTimes(2);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the pending request ends with the lock held", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    t.setVisible(true);
    t.controller.setEnabled(true);
    await settle();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.held()).toHaveLength(1);
  });

  it("does not retry a skipped wake-up once the setting is off", async () => {
    const t = setup();
    let fail: (e: Error) => void = () => undefined;
    t.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    t.controller.setEnabled(true);
    t.setVisible(true);
    t.controller.setEnabled(false);
    fail(new Error("refused"));
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("ignores a release event from an old lock once a new one is held", async () => {
    const t = setup();
    t.controller.setEnabled(true);
    await settle();
    const old = t.sentinels[0] as Sentinel;
    old.fire();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    const current = t.sentinels[1] as Sentinel;
    old.fire();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(current.released).toBe(false);
    expect(current.release).not.toHaveBeenCalled();
    expect(t.held()).toEqual([current]);
  });

  it("releases a lock granted after the page went hidden, and asks again on becoming visible", async () => {
    const t = setup();
    let grant: (s: Sentinel) => void = () => undefined;
    t.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    t.controller.setEnabled(true);
    t.setVisible(false);
    const late = makeSentinel();
    grant(late);
    await settle();
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledTimes(1);
    t.setVisible(true);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.held()).toHaveLength(1);
  });

  it("does nothing without a wake lock", async () => {
    const controller = createWakeLock({}, document);
    expect(() => controller.setEnabled(true)).not.toThrow();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(() => controller.setEnabled(false)).not.toThrow();
  });
});

describe("full screen", () => {
  afterEach(() => {
    for (const name of ["requestFullscreen"])
      Reflect.deleteProperty(document.documentElement, name);
    for (const name of ["exitFullscreen", "fullscreenElement", "fullscreenEnabled"]) {
      Reflect.deleteProperty(document, name);
    }
  });
  const define = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  };

  it("is unsupported where the methods are missing, and where it is disabled", () => {
    expect(fullscreenSupported(document)).toBe(false);
    define(document.documentElement, "requestFullscreen", async () => undefined);
    expect(fullscreenSupported(document)).toBe(false);
    define(document, "exitFullscreen", async () => undefined);
    expect(fullscreenSupported(document)).toBe(true);
    define(document, "fullscreenEnabled", false);
    expect(fullscreenSupported(document)).toBe(false);
  });

  it("reports whether an element is full screen", () => {
    expect(isFullscreen(document)).toBe(false);
    define(document, "fullscreenElement", document.documentElement);
    expect(isFullscreen(document)).toBe(true);
  });

  it("enters full screen on the document element when not full screen", async () => {
    const enter = vi.fn(async () => undefined);
    const exit = vi.fn(async () => undefined);
    define(document.documentElement, "requestFullscreen", enter);
    define(document, "exitFullscreen", exit);
    await toggleFullscreen(document);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves full screen when it is on", async () => {
    const enter = vi.fn(async () => undefined);
    const exit = vi.fn(async () => undefined);
    define(document.documentElement, "requestFullscreen", enter);
    define(document, "exitFullscreen", exit);
    define(document, "fullscreenElement", document.documentElement);
    await toggleFullscreen(document);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(enter).not.toHaveBeenCalled();
  });

  it("swallows a rejection and a missing method", async () => {
    define(document.documentElement, "requestFullscreen", async () => {
      throw new Error("denied");
    });
    await expect(toggleFullscreen(document)).resolves.toBeUndefined();
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    await expect(toggleFullscreen(document)).resolves.toBeUndefined();
    define(document, "fullscreenElement", document.documentElement);
    define(document, "exitFullscreen", () => {
      throw new Error("sync");
    });
    await expect(toggleFullscreen(document)).resolves.toBeUndefined();
  });
});

describe("displayModeFullscreen", () => {
  const media = (...matching: string[]) => ({
    matchMedia: vi.fn((q: string) => ({ matches: matching.includes(q) })),
  });

  it("is true for an installed app in full-screen display mode", () => {
    const win = media("(display-mode: fullscreen)");
    expect(displayModeFullscreen(win)).toBe(true);
    expect(win.matchMedia).toHaveBeenCalledWith("(display-mode: fullscreen)");
  });

  it("is true for standalone display mode", () => {
    expect(displayModeFullscreen(media("(display-mode: standalone)"))).toBe(true);
  });

  it("is false in a browser tab", () => {
    expect(displayModeFullscreen(media("(display-mode: browser)"))).toBe(false);
    expect(displayModeFullscreen(media())).toBe(false);
  });

  it("is false when matchMedia is missing or throws", () => {
    expect(displayModeFullscreen({})).toBe(false);
    expect(
      displayModeFullscreen({
        matchMedia: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });
});

describe("set-up card setting", () => {
  it("starts not dismissed, and keeps a dismissal", () => {
    expect(DEFAULT_SETTINGS.setupDismissed).toBe(false);
    const storage = memory();
    saveSettings(storage, { ...DEFAULT_SETTINGS, setupDismissed: true });
    expect(
      (JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string) as { setupDismissed: unknown })
        .setupDismissed,
    ).toBe(true);
    expect(loadSettings(storage).setupDismissed).toBe(true);
  });

  it.each([["yes"], [1], [null]])("reads a stored %j as not dismissed", (value) => {
    const raw = JSON.stringify({ setupDismissed: value });
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: raw })).setupDismissed).toBe(false);
  });
});

describe("captureInstallPrompt", () => {
  const offerEvent = () => {
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<unknown>;
    };
    event.prompt = vi.fn(async () => ({ outcome: "accepted" }));
    return event;
  };

  it("keeps the browser's offer, stops the browser's own banner, and tells the listener", () => {
    const target = new EventTarget();
    const offer = captureInstallPrompt(target);
    const changed = vi.fn();
    offer.onChange(changed);
    expect(offer.available()).toBe(false);
    const event = offerEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(offer.available()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shows the prompt once, then the offer is used up", () => {
    const target = new EventTarget();
    const offer = captureInstallPrompt(target);
    const event = offerEvent();
    target.dispatchEvent(event);
    offer.prompt();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(offer.available()).toBe(false);
    offer.prompt();
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it("swallows a prompt that throws or rejects", async () => {
    const target = new EventTarget();
    const offer = captureInstallPrompt(target);
    const sync = offerEvent();
    sync.prompt = () => {
      throw new Error("not allowed");
    };
    target.dispatchEvent(sync);
    expect(() => offer.prompt()).not.toThrow();
    const later = offerEvent();
    later.prompt = vi.fn(async () => {
      throw new Error("dismissed");
    });
    target.dispatchEvent(later);
    offer.prompt();
    await Promise.resolve();
    expect(offer.available()).toBe(false);
  });

  it("ignores an event with no prompt to show", () => {
    const target = new EventTarget();
    const offer = captureInstallPrompt(target);
    target.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true }));
    expect(offer.available()).toBe(false);
  });
});

describe("isAppleMobile", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPAD_DESKTOP =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 15; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

  it("is true for an iPhone or an iPad user agent", () => {
    expect(isAppleMobile({ userAgent: IPHONE })).toBe(true);
    expect(isAppleMobile({ userAgent: IPHONE.replace(/iPhone/g, "iPad") })).toBe(true);
  });

  it("is true for iPadOS presenting as a Mac with a touch screen", () => {
    expect(isAppleMobile({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe(false);
  });

  it("is true wherever navigator.standalone exists", () => {
    expect(isAppleMobile({ userAgent: "", standalone: false })).toBe(true);
  });

  it("is false for Android, a desktop, or nothing known", () => {
    expect(isAppleMobile({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe(false);
    expect(isAppleMobile({ userAgent: IPAD_DESKTOP })).toBe(false);
    expect(isAppleMobile({})).toBe(false);
  });
});

describe("installRow", () => {
  it.each([
    [{ installed: false, offered: true, apple: false }, "prompt"],
    [{ installed: false, offered: true, apple: true }, "prompt"],
    [{ installed: false, offered: false, apple: true }, "apple"],
    [{ installed: false, offered: false, apple: false }, "hidden"],
    [{ installed: true, offered: true, apple: false }, "hidden"],
    [{ installed: true, offered: false, apple: true }, "hidden"],
  ] as const)("%j -> %s", (state, expected) => {
    expect(installRow(state)).toBe(expected);
  });
});

describe("registerServiceWorker", () => {
  it("registers sw.js for the page's own directory", () => {
    const register = vi.fn(async () => ({}));
    registerServiceWorker({ serviceWorker: { register } });
    expect(register).toHaveBeenCalledWith("sw.js", { scope: "./" });
  });

  it("does nothing without service workers, and ignores a refusal", async () => {
    expect(() => registerServiceWorker({})).not.toThrow();
    const register = vi.fn(async () => {
      throw new Error("SecurityError");
    });
    registerServiceWorker({ serviceWorker: { register } });
    expect(() =>
      registerServiceWorker({
        serviceWorker: {
          register: () => {
            throw new Error("sync");
          },
        },
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
  });
});
