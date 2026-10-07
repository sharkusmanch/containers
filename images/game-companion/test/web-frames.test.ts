// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrames } from "../src/web/frames.js";

/** What the browser does when a framed page has finished loading. */
function loaded(frame: HTMLIFrameElement | undefined): void {
  frame?.dispatchEvent(new Event("load"));
}

/** jsdom does not load a framed page, so give the frame a document of known content. */
function showing(frame: HTMLIFrameElement | undefined, text: string): void {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${text}</body>`, "text/html");
  Object.defineProperty(frame, "contentDocument", { value: doc, configurable: true });
}

describe("createFrames", () => {
  it("creates a frame lazily and shows only the requested one", () => {
    const f = createFrames(document, 4);
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
    f.show(0, "/doc/a");
    f.show(1, "/doc/b");
    const frames = [...f.element.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    expect(frames[0]?.classList.contains("inactive")).toBe(true);
    expect(frames[1]?.classList.contains("inactive")).toBe(false);
    expect(frames.every((fr) => !fr.hidden)).toBe(true);
    expect(frames[1]?.getAttribute("src")).toBe("/doc/b");
  });

  it("keeps a frame alive and untouched when it is shown again with the same page", () => {
    const f = createFrames(document, 4);
    f.show(0, "/doc/a");
    const first = f.element.querySelector("iframe");
    f.show(1, "/doc/b");
    f.show(0, "/doc/a");
    expect(f.element.querySelector("iframe")).toBe(first);
    expect(first?.classList.contains("inactive")).toBe(false);
  });

  it("does not reload a frame that is shown again, which would lose its scroll position", () => {
    const f = createFrames(document, 4);
    f.show(0, "/doc/a");
    const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
    const setAttribute = vi.spyOn(frame, "setAttribute");
    const setSrc = vi.spyOn(HTMLIFrameElement.prototype, "src", "set");
    f.show(1, "/doc/b");
    setSrc.mockClear();
    f.show(0, "/doc/a");
    expect(setSrc).not.toHaveBeenCalled();
    expect(setAttribute).not.toHaveBeenCalledWith("src", expect.anything());
    setSrc.mockRestore();
  });

  it("reloads a slot when its page changes", () => {
    const f = createFrames(document, 4);
    f.show(0, "/doc/a");
    f.show(0, "/doc/c");
    expect(f.element.querySelectorAll("iframe")).toHaveLength(1);
    expect(f.element.querySelector("iframe")?.getAttribute("src")).toBe("/doc/c");
  });

  it.each([
    "https://evil.example/doc/a",
    "//evil.example/doc/a",
    "javascript:alert(1)",
    "/collection/x",
  ])("refuses to frame %s", (url) => {
    const f = createFrames(document, 4);
    f.show(0, url);
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("ignores an out-of-range slot", () => {
    const f = createFrames(document, 4);
    f.show(7, "/doc/a");
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("hides every frame and can drop them all", () => {
    const f = createFrames(document, 4);
    f.show(0, "/doc/a");
    f.hideAll();
    expect(f.element.querySelector("iframe")?.classList.contains("inactive")).toBe(true);
    f.reset();
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("re-keys frames to new slots without reloading them, and removes the rest", () => {
    const f = createFrames(document, 4);
    f.show(0, "/doc/a");
    f.show(1, "/doc/b");
    f.show(2, "/doc/c");
    const [a, b, c] = [...f.element.querySelectorAll("iframe")];
    const setSrc = vi.spyOn(HTMLIFrameElement.prototype, "src", "set");
    const setAttr = vi.spyOn(HTMLIFrameElement.prototype, "setAttribute");
    f.sync(["/doc/a", "/doc/c", null, null]);
    expect([...f.element.querySelectorAll("iframe")]).toEqual([a, c]);
    expect(b?.isConnected).toBe(false);
    f.show(1, "/doc/c");
    expect(setSrc).not.toHaveBeenCalled();
    expect(setAttr).not.toHaveBeenCalledWith("src", expect.anything());
    expect(c?.classList.contains("inactive")).toBe(false);
    expect(a?.classList.contains("inactive")).toBe(true);
    setSrc.mockRestore();
    setAttr.mockRestore();
    f.show(2, "/doc/b");
    expect(f.element.querySelectorAll("iframe")).toHaveLength(3);
    expect([...f.element.querySelectorAll("iframe")].includes(b as HTMLIFrameElement)).toBe(false);
  });

  it("creates nothing in sync and tolerates empty, unknown and extra entries", () => {
    const f = createFrames(document, 4);
    f.sync(["/doc/a", null, null, null]);
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
    f.show(0, "/doc/a");
    f.sync([null, "/doc/a", null, null, "/doc/zzz", "/doc/yyy"]);
    expect(f.element.querySelectorAll("iframe")).toHaveLength(1);
    f.sync([]);
    expect(f.element.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("locate reports gone for a slot with no frame, and for a slot out of range", async () => {
    const f = createFrames(document, 4);
    expect(await f.locate(0, "Sample Boss")).toBe("gone");
    f.show(1, "/doc/b");
    expect(await f.locate(0, "Sample Boss")).toBe("gone");
    expect(await f.locate(9, "Sample Boss")).toBe("gone");
    expect(await f.locate(-1, "Sample Boss")).toBe("gone");
  });

  it("locate delegates to the frame of that slot, not to another one", async () => {
    document.body.innerHTML = "";
    const f = createFrames(document, 4);
    document.body.append(f.element);
    f.show(0, "/doc/a");
    f.show(1, "/doc/b");
    const [a, b] = [...f.element.querySelectorAll("iframe")] as HTMLIFrameElement[];
    showing(a, "Nothing relevant");
    showing(b, "Here is the Sample Boss");
    loaded(a);
    loaded(b);
    expect(await f.locate(1, "sample boss")).toBe("found");
    vi.useFakeTimers();
    try {
      const other = f.locate(0, "sample boss");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await other).toBe("not-found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("locate follows the frame when slots are re-keyed", async () => {
    document.body.innerHTML = "";
    const f = createFrames(document, 4);
    document.body.append(f.element);
    f.show(0, "/doc/a");
    f.show(1, "/doc/b");
    const b = f.element.querySelectorAll("iframe")[1] as HTMLIFrameElement;
    showing(b, "Here is the Sample Boss");
    loaded(b);
    f.sync([null, "/doc/b", null, null]);
    expect(await f.locate(0, "sample boss")).toBe("gone");
    expect(await f.locate(1, "sample boss")).toBe("found");
  });

  it("locate passes the heading on to choose the occurrence", async () => {
    document.body.innerHTML = "";
    const f = createFrames(document, 4);
    document.body.append(f.element);
    f.show(0, "/doc/a");
    const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
    showing(frame, "<h2>One</h2><p id='x'>Sample Boss</p><h2>Two</h2><p id='y'>Sample Boss</p>");
    loaded(frame);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      expect(await f.locate(0, "sample boss", "Two")).toBe("found");
      expect((scroll.mock.contexts[0] as Element).id).toBe("y");
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  describe("locate while a slot is being re-pointed", () => {
    afterEach(() => vi.useRealTimers());

    /** A frame showing page A, loaded, then re-pointed to page B; reads of A's document are counted. */
    function repointed() {
      document.body.innerHTML = "";
      const f = createFrames(document, 4);
      document.body.append(f.element);
      f.show(0, "/doc/a");
      const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
      const docA = new DOMParser().parseFromString(
        "<!doctype html><body><p>The Sample Boss is on page A</p></body>",
        "text/html",
      );
      const reads = { a: 0 };
      Object.defineProperty(frame, "contentDocument", {
        get() {
          reads.a += 1;
          return docA;
        },
        configurable: true,
      });
      loaded(frame);
      f.show(0, "/doc/b");
      return { f, frame, reads };
    }

    it("does not touch the old page, stays pending, then searches the new page once it loads", async () => {
      const { f, frame, reads } = repointed();
      reads.a = 0;
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        let settled: string | null = null;
        const result = f.locate(0, "sample boss").then((r) => (settled = r));
        await new Promise((r) => setTimeout(r, 50));
        expect(reads.a).toBe(0);
        expect(scroll).not.toHaveBeenCalled();
        expect(settled).toBeNull();
        showing(frame, "<p id='b'>Page B has the Sample Boss</p>");
        loaded(frame);
        expect(await result).toBe("found");
        expect(scroll).toHaveBeenCalledTimes(1);
        expect((scroll.mock.contexts[0] as Element).id).toBe("b");
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });

    it("resolves not-found at the deadline when the load never comes", async () => {
      vi.useFakeTimers();
      const { f, reads } = repointed();
      reads.a = 0;
      const result = f.locate(0, "sample boss");
      await vi.advanceTimersByTimeAsync(9_900);
      expect(reads.a).toBe(0);
      await vi.advanceTimersByTimeAsync(400);
      expect(await result).toBe("not-found");
      expect(reads.a).toBe(0);
    });

    it("waits for the first load of a frame it has just created", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = "";
      const f = createFrames(document, 4);
      document.body.append(f.element);
      f.show(0, "/doc/a");
      const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
      showing(frame, "<p>The Sample Boss</p>");
      let settled: string | null = null;
      const result = f.locate(0, "sample boss").then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBeNull();
      loaded(frame);
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe("found");
    });

    it("resolves gone when the page is unpinned or the frames are reset meanwhile", async () => {
      vi.useFakeTimers();
      const first = repointed();
      const unpinned = first.f.locate(0, "sample boss");
      first.f.sync([null, null, null, null]);
      await vi.advanceTimersByTimeAsync(400);
      expect(await unpinned).toBe("gone");

      const second = repointed();
      const reset = second.f.locate(0, "sample boss");
      second.f.reset();
      await vi.advanceTimersByTimeAsync(400);
      expect(await reset).toBe("gone");
    });
  });

  describe("a locate that is superseded", () => {
    afterEach(() => vi.useRealTimers());

    function fullSlot() {
      document.body.innerHTML = "";
      const f = createFrames(document, 4);
      document.body.append(f.element);
      f.show(3, "/doc/a");
      const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
      showing(frame, "<p>Page A has the Alpha Boss</p>");
      loaded(frame);
      return { f, frame };
    }

    it("resolves gone when its slot is re-pointed, and never reports not-found", async () => {
      vi.useFakeTimers();
      const { f, frame } = fullSlot();
      f.show(3, "/doc/b");
      const first = f.locate(3, "alpha boss");
      f.show(3, "/doc/c");
      const second = f.locate(3, "beta boss");
      // The first search ends at once, long before its own deadline.
      expect(await first).toBe("gone");
      showing(frame, "<p>Page C has the Beta Boss</p>");
      loaded(frame);
      expect(await second).toBe("found");
      await vi.advanceTimersByTimeAsync(11_000);
    });

    it("is unaffected for a locate started by the show that re-pointed the slot", async () => {
      vi.useFakeTimers();
      const { f, frame } = fullSlot();
      f.show(3, "/doc/b");
      const only = f.locate(3, "beta boss");
      showing(frame, "<p>Page B has the Beta Boss</p>");
      loaded(frame);
      expect(await only).toBe("found");
    });

    it("lets one locate per frame live: a new one ends the previous as gone", async () => {
      vi.useFakeTimers();
      const { f } = fullSlot();
      const first = f.locate(3, "no such text");
      const second = f.locate(3, "alpha boss");
      expect(await first).toBe("gone");
      expect(await second).toBe("found");
    });

    it("still reports not-found for the one locate that runs to its deadline", async () => {
      vi.useFakeTimers();
      const { f } = fullSlot();
      const only = f.locate(3, "no such text");
      await vi.advanceTimersByTimeAsync(10_500);
      expect(await only).toBe("not-found");
    });

    it("does not let the earlier search's clean-up touch the later one's highlight", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = "";
      const f = createFrames(document, 4);
      document.body.append(f.element);
      f.show(0, "/doc/a");
      const frame = f.element.querySelector("iframe") as HTMLIFrameElement;
      const holder = document.createElement("iframe");
      document.body.append(holder);
      const real = holder.contentDocument as Document;
      real.body.innerHTML = "<p>Sample Boss</p><p>Hidden Key</p>";
      Object.defineProperty(frame, "contentDocument", { value: real, configurable: true });
      const highlights = new Map<string, { ranges: Range[] }>();
      const win = holder.contentWindow as unknown as Record<string, unknown>;
      Object.defineProperty(win, "CSS", { value: { highlights }, configurable: true });
      Object.defineProperty(win, "Highlight", {
        value: class {
          readonly ranges: Range[];
          constructor(...ranges: Range[]) {
            this.ranges = ranges;
          }
        },
        configurable: true,
      });
      loaded(frame);
      expect(await f.locate(0, "sample boss")).toBe("found");
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Sample Boss");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await f.locate(0, "hidden key")).toBe("found");
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Hidden Key");
      // the first highlight's own six seconds are over: the second one stays
      await vi.advanceTimersByTimeAsync(5100);
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Hidden Key");
      await vi.advanceTimersByTimeAsync(1000);
      expect(highlights.has("gc-find")).toBe(false);
    });
  });

  describe("hiding the wiki's bars", () => {
    const style = (frame: HTMLIFrameElement | undefined): Element | null =>
      frame?.contentDocument?.getElementById("gc-chrome-style") ?? null;

    /** Frames whose repeating timer is driven by the test. */
    function withTimer() {
      const ticks: { fn: () => void; ms: number }[] = [];
      const fake = ((fn: () => void, ms: number) => {
        ticks.push({ fn, ms });
        return ticks.length;
      }) as unknown as typeof setInterval;
      document.body.innerHTML = "";
      const f = createFrames(document, 4, { setInterval: fake });
      document.body.append(f.element);
      return { f, tick: () => ticks.forEach((t) => t.fn()), ticks };
    }
    const frameAt = (f: { element: HTMLElement }, i: number): HTMLIFrameElement =>
      f.element.querySelectorAll("iframe")[i] as HTMLIFrameElement;

    it("applies when a frame loads, while hiding is on", () => {
      const { f } = withTimer();
      f.setHideChrome(true);
      f.show(0, "/doc/a");
      showing(frameAt(f, 0), "<p>Sample page</p>");
      expect(style(frameAt(f, 0))).toBeNull();
      loaded(frameAt(f, 0));
      expect(style(frameAt(f, 0))?.textContent).toContain("#sidebar{display:none!important}");
    });

    it("does not touch a frame that loads while hiding is off", () => {
      const { f } = withTimer();
      f.show(0, "/doc/a");
      showing(frameAt(f, 0), "<p>Sample page</p>");
      loaded(frameAt(f, 0));
      expect(style(frameAt(f, 0))).toBeNull();
    });

    it("re-applies on the repeating timer, every 1500 ms, to the frame on screen", () => {
      const { f, tick, ticks } = withTimer();
      expect(ticks.map((t) => t.ms)).toEqual([1500]);
      f.setHideChrome(true);
      f.show(0, "/doc/a");
      f.show(1, "/doc/b");
      showing(frameAt(f, 0), "<p>A</p>");
      showing(frameAt(f, 1), "<p>B</p>");
      loaded(frameAt(f, 0));
      loaded(frameAt(f, 1));
      style(frameAt(f, 0))?.remove();
      style(frameAt(f, 1))?.remove();
      tick();
      expect(style(frameAt(f, 1))).not.toBeNull();
      // the wiki re-rendered the page and dropped our style: the timer puts it back
      style(frameAt(f, 1))?.remove();
      tick();
      expect(style(frameAt(f, 1))).not.toBeNull();
    });

    it("does nothing on the timer while hiding is off", () => {
      const { f, tick } = withTimer();
      f.show(0, "/doc/a");
      showing(frameAt(f, 0), "<p>A</p>");
      tick();
      expect(style(frameAt(f, 0))).toBeNull();
    });

    it("applies at once to every existing frame when the setting is switched on", () => {
      const { f } = withTimer();
      f.show(0, "/doc/a");
      f.show(1, "/doc/b");
      showing(frameAt(f, 0), "<p>A</p>");
      showing(frameAt(f, 1), "<p>B</p>");
      f.setHideChrome(true);
      expect(style(frameAt(f, 0))).not.toBeNull();
      expect(style(frameAt(f, 1))).not.toBeNull();
    });

    it("restores every frame at once when it is switched off, and stops applying", () => {
      const { f, tick } = withTimer();
      f.show(0, "/doc/a");
      f.show(1, "/doc/b");
      showing(frameAt(f, 0), "<p>A</p>");
      showing(frameAt(f, 1), "<p>B</p>");
      const before = [0, 1].map((i) => frameAt(f, i).contentDocument?.documentElement.outerHTML);
      f.setHideChrome(true);
      f.setHideChrome(false);
      expect(style(frameAt(f, 0))).toBeNull();
      expect(style(frameAt(f, 1))).toBeNull();
      expect([0, 1].map((i) => frameAt(f, i).contentDocument?.documentElement.outerHTML)).toEqual(
        before,
      );
      tick();
      loaded(frameAt(f, 0));
      expect(style(frameAt(f, 0))).toBeNull();
    });

    it("applies to a frame created after the setting was switched on, once it loads", () => {
      const { f } = withTimer();
      f.setHideChrome(true);
      f.show(2, "/doc/c");
      showing(frameAt(f, 0), "<p>C</p>");
      loaded(frameAt(f, 0));
      expect(style(frameAt(f, 0))).not.toBeNull();
    });

    it("skips a frame whose document cannot be read, and carries on with the others", () => {
      const { f, tick } = withTimer();
      f.setHideChrome(true);
      f.show(0, "/doc/a");
      f.show(1, "/doc/b");
      Object.defineProperty(frameAt(f, 0), "contentDocument", {
        get() {
          throw new Error("Blocked a frame from another origin");
        },
      });
      showing(frameAt(f, 1), "<p>B</p>");
      expect(() => tick()).not.toThrow();
      expect(() => f.setHideChrome(false)).not.toThrow();
      expect(() => f.setHideChrome(true)).not.toThrow();
      expect(style(frameAt(f, 1))).not.toBeNull();
    });

    describe("sweeping only the frame on screen", () => {
      afterEach(() => {
        Reflect.deleteProperty(document, "visibilityState");
      });

      /** Two loaded frames, both styled, then both stripped of the style again; slot 1 is showing. */
      function two() {
        const t = withTimer();
        t.f.setHideChrome(true);
        t.f.show(0, "/doc/a");
        t.f.show(1, "/doc/b");
        showing(frameAt(t.f, 0), "<p>A</p>");
        showing(frameAt(t.f, 1), "<p>B</p>");
        loaded(frameAt(t.f, 0));
        loaded(frameAt(t.f, 1));
        for (const i of [0, 1]) style(frameAt(t.f, i))?.remove();
        return t;
      }

      it("touches the active frame only on a tick", () => {
        const { f, tick } = two();
        tick();
        expect(style(frameAt(f, 1))).not.toBeNull();
        expect(style(frameAt(f, 0))).toBeNull();
      });

      it("touches no frame on a tick while every frame is hidden", () => {
        const { f, tick } = two();
        f.hideAll();
        tick();
        expect(style(frameAt(f, 0))).toBeNull();
        expect(style(frameAt(f, 1))).toBeNull();
      });

      it("applies to a frame the moment it becomes active, without waiting for a tick", () => {
        const { f } = two();
        f.show(0, "/doc/a");
        expect(style(frameAt(f, 0))).not.toBeNull();
        expect(style(frameAt(f, 1))).toBeNull();
      });

      it("leaves a frame that is still navigating to its load handler", () => {
        const { f } = two();
        f.show(0, "/doc/c");
        expect(style(frameAt(f, 0))).toBeNull();
        showing(frameAt(f, 0), "<p>C</p>");
        loaded(frameAt(f, 0));
        expect(style(frameAt(f, 0))).not.toBeNull();
      });

      it("does not touch a frame it shows while hiding is off", () => {
        const { f } = two();
        f.setHideChrome(false);
        f.show(0, "/doc/a");
        expect(style(frameAt(f, 0))).toBeNull();
      });

      it("does no work on a tick while the companion's own document is hidden", () => {
        const { f, tick } = two();
        Object.defineProperty(document, "visibilityState", {
          get: () => "hidden",
          configurable: true,
        });
        tick();
        expect(style(frameAt(f, 1))).toBeNull();
        Reflect.deleteProperty(document, "visibilityState");
        tick();
        expect(style(frameAt(f, 1))).not.toBeNull();
      });

      it("still applies a changed setting to every frame at once", () => {
        const { f } = two();
        f.setHideChrome(true);
        expect(style(frameAt(f, 0))).not.toBeNull();
        expect(style(frameAt(f, 1))).not.toBeNull();
      });
    });

    it("leaves the find highlight's style element alone", () => {
      const { f, tick } = withTimer();
      f.setHideChrome(true);
      f.show(0, "/doc/a");
      showing(frameAt(f, 0), "<p>A</p>");
      const doc = frameAt(f, 0).contentDocument as Document;
      doc.head.insertAdjacentHTML("beforeend", '<style id="gc-find-style">x{}</style>');
      tick();
      f.setHideChrome(false);
      expect(doc.getElementById("gc-find-style")?.textContent).toBe("x{}");
    });
  });
});

describe("onInteract", () => {
  const click = (frame: HTMLIFrameElement | undefined): void => {
    const doc = frame?.contentDocument;
    doc?.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  const frameAt = (f: ReturnType<typeof createFrames>, i: number): HTMLIFrameElement =>
    f.element.querySelectorAll("iframe")[i] as HTMLIFrameElement;

  it("is called with the slot index for a click inside a loaded frame", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    f.show(2, "/doc/b");
    showing(frameAt(f, 0), "<p>a</p>");
    showing(frameAt(f, 1), "<p>b</p>");
    loaded(frameAt(f, 0));
    loaded(frameAt(f, 1));
    click(frameAt(f, 1));
    expect(onInteract.mock.calls).toEqual([[2]]);
    click(frameAt(f, 0));
    expect(onInteract.mock.calls).toEqual([[2], [0]]);
  });

  it("follows the slot when sync re-keys the frames", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    f.show(1, "/doc/b");
    showing(frameAt(f, 0), "<p>a</p>");
    showing(frameAt(f, 1), "<p>b</p>");
    loaded(frameAt(f, 0));
    loaded(frameAt(f, 1));
    f.sync([null, "/doc/a"]);
    click(frameAt(f, 0));
    expect(onInteract.mock.calls).toEqual([[1]]);
  });

  it("listens again after the frame loads a new document, and not on the old one", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    const frame = frameAt(f, 0);
    showing(frame, "<p>first</p>");
    loaded(frame);
    const first = frame.contentDocument as Document;
    showing(frame, "<p>second</p>");
    f.show(0, "/doc/c");
    loaded(frame);
    click(frame);
    expect(onInteract.mock.calls).toEqual([[0]]);
    first.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onInteract).toHaveBeenCalledTimes(2);
  });

  it("does not listen twice when the same document reports a load twice", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    showing(frameAt(f, 0), "<p>a</p>");
    loaded(frameAt(f, 0));
    loaded(frameAt(f, 0));
    click(frameAt(f, 0));
    expect(onInteract).toHaveBeenCalledTimes(1);
  });

  it("is never called for a frame without a document, and a missing handler is fine", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    expect(() => loaded(frameAt(f, 0))).not.toThrow();
    expect(onInteract).not.toHaveBeenCalled();
    const plain = createFrames(document, 4);
    plain.show(0, "/doc/a");
    showing(frameAt(plain, 0), "<p>a</p>");
    expect(() => loaded(frameAt(plain, 0))).not.toThrow();
    expect(() => click(frameAt(plain, 0))).not.toThrow();
  });

  it("survives a document it cannot reach", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    Object.defineProperty(frameAt(f, 0), "contentDocument", {
      get() {
        throw new Error("cross-origin");
      },
      configurable: true,
    });
    expect(() => loaded(frameAt(f, 0))).not.toThrow();
    expect(onInteract).not.toHaveBeenCalled();
  });

  it("a throwing handler breaks neither the click nor the frame", () => {
    const onInteract = vi.fn(() => {
      throw new Error("boom");
    });
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    showing(frameAt(f, 0), "<a id='x' href='#'>go</a>");
    loaded(frameAt(f, 0));
    const doc = frameAt(f, 0).contentDocument as Document;
    const seen = vi.fn();
    doc.getElementById("x")?.addEventListener("click", seen);
    expect(() =>
      doc.getElementById("x")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
    expect(onInteract).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(frameAt(f, 0).classList.contains("inactive")).toBe(false);
    f.show(0, "/doc/z");
    expect(frameAt(f, 0).getAttribute("src")).toBe("/doc/z");
  });

  it("still hears a click the page stops from propagating", () => {
    const onInteract = vi.fn();
    const f = createFrames(document, 4, { onInteract });
    f.show(0, "/doc/a");
    showing(frameAt(f, 0), "<button id='x'>go</button>");
    loaded(frameAt(f, 0));
    const doc = frameAt(f, 0).contentDocument as Document;
    doc.getElementById("x")?.addEventListener("click", (e) => e.stopPropagation());
    doc.getElementById("x")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onInteract).toHaveBeenCalledTimes(1);
  });
});
