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
});
