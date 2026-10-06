// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFrames } from "../src/web/frames.js";

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
});
