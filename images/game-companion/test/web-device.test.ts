// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  createWakeLock,
  fullscreenSupported,
  isFullscreen,
  loadSettings,
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
  it("defaults to keeping the screen on and hiding the wiki bars", () => {
    expect(DEFAULT_SETTINGS).toEqual({ keepAwake: true, hideChrome: true });
    expect(SETTINGS_STORAGE_KEY).toBe("game-companion:v1:settings");
    expect(loadSettings(memory())).toEqual({ keepAwake: true, hideChrome: true });
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
    saveSettings(storage, { keepAwake: false, hideChrome: true });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) as string)).toEqual({
      keepAwake: false,
      hideChrome: true,
    });
    expect(loadSettings(storage)).toEqual({ keepAwake: false, hideChrome: true });
    saveSettings(storage, { keepAwake: true, hideChrome: false });
    expect(loadSettings(storage)).toEqual({ keepAwake: true, hideChrome: false });
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
    });
    expect(load({ keepAwake: 0, hideChrome: false })).toEqual({
      keepAwake: true,
      hideChrome: false,
    });
    expect(load({ keepAwake: null, hideChrome: null })).toEqual(DEFAULT_SETTINGS);
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
