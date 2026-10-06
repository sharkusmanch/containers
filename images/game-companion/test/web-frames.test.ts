// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFrames } from "../src/web/frames.js";

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

  it("locate reports false for a slot with no frame, and for a slot out of range", async () => {
    const f = createFrames(document, 4);
    expect(await f.locate(0, "Sample Boss")).toBe(false);
    f.show(1, "/doc/b");
    expect(await f.locate(0, "Sample Boss")).toBe(false);
    expect(await f.locate(9, "Sample Boss")).toBe(false);
    expect(await f.locate(-1, "Sample Boss")).toBe(false);
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
    expect(await f.locate(1, "sample boss")).toBe(true);
    vi.useFakeTimers();
    try {
      const other = f.locate(0, "sample boss");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await other).toBe(false);
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
    showing(f.element.querySelectorAll("iframe")[1], "Here is the Sample Boss");
    f.sync([null, "/doc/b", null, null]);
    expect(await f.locate(0, "sample boss")).toBe(false);
    expect(await f.locate(1, "sample boss")).toBe(true);
  });
});
