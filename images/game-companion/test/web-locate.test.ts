// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { findTextRange, locateInFrame } from "../src/web/locate.js";

function page(bodyHtml: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${bodyHtml}</body>`, "text/html");
}

describe("findTextRange", () => {
  it("finds text ignoring case and covers exactly that text", () => {
    const range = findTextRange(page("<p>Defeat the Sample Boss twice</p>"), "sample boss");
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe("Sample Boss");
    expect(range?.startContainer.nodeType).toBe(3);
    expect(range?.startContainer).toBe(range?.endContainer);
  });

  it("returns a range whose text equals the needle when the case matches", () => {
    const range = findTextRange(page("<p>Open the Red Door.</p>"), "Red Door");
    expect(range?.toString()).toBe("Red Door");
  });

  it("trims the needle", () => {
    expect(findTextRange(page("<p>Open the Red Door.</p>"), "  Red Door \n")?.toString()).toBe(
      "Red Door",
    );
  });

  it("returns null when the text is absent", () => {
    expect(findTextRange(page("<p>Nothing here</p>"), "Sample Boss")).toBeNull();
  });

  it("returns null for an empty or blank needle", () => {
    const doc = page("<p>Something</p>");
    expect(findTextRange(doc, "")).toBeNull();
    expect(findTextRange(doc, "   ")).toBeNull();
  });

  it("returns null when the document has no body", () => {
    const doc = page("<p>Something</p>");
    doc.body.remove();
    expect(findTextRange(doc, "Something")).toBeNull();
  });

  it("ignores text inside script, style and noscript", () => {
    const doc = page(
      "<script>var s = 'Sample Boss';</script><style>.x::after{content:'Sample Boss'}</style>" +
        "<noscript>Sample Boss</noscript><p>other</p>",
    );
    expect(findTextRange(doc, "sample boss")).toBeNull();
    const withReal = page("<script>Sample Boss</script><div><p>the SAMPLE BOSS</p></div>");
    const range = withReal.body.querySelector("p");
    expect(findTextRange(withReal, "sample boss")?.startContainer.parentElement).toBe(range);
  });

  it("picks the first occurrence in document order, and the first within a node", () => {
    const doc = page("<p id='a'>one Gem two gem</p><p id='b'>gem</p>");
    const range = findTextRange(doc, "gem");
    expect(range?.startContainer.parentElement?.id).toBe("a");
    expect(range?.startOffset).toBe(4);
    expect(range?.endOffset).toBe(7);
  });

  it("treats the needle as plain text, not as a pattern", () => {
    const doc = page("<p>Score 100% (bonus) [x] a+b a.b</p>");
    expect(findTextRange(doc, "(bonus) [x]")?.toString()).toBe("(bonus) [x]");
    expect(findTextRange(doc, "a+b")?.toString()).toBe("a+b");
    expect(findTextRange(doc, "a.b")?.toString()).toBe("a.b");
    expect(findTextRange(doc, "a.+")).toBeNull();
    expect(findTextRange(doc, ".*")).toBeNull();
  });

  it("does not match across two text nodes", () => {
    expect(findTextRange(page("<p>Sample <b>Boss</b></p>"), "Sample Boss")).toBeNull();
  });
});

function makeFrame(bodyHtml = ""): HTMLIFrameElement {
  document.body.innerHTML = "";
  const frame = document.createElement("iframe");
  document.body.append(frame);
  (frame.contentDocument as Document).body.innerHTML = bodyHtml;
  return frame;
}
const frameDoc = (f: HTMLIFrameElement): Document => f.contentDocument as Document;
const frameWin = (f: HTMLIFrameElement): Window & typeof globalThis =>
  f.contentWindow as Window & typeof globalThis;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("locateInFrame", () => {
  it("resolves true at once when the text is already there", async () => {
    const frame = makeFrame("<p>Find the Sample Boss</p>");
    expect(await locateInFrame(frame, "sample boss", { intervalMs: 5, timeoutMs: 100 })).toBe(true);
  });

  it("resolves true once the text appears after a delay", async () => {
    const frame = makeFrame("<p>loading</p>");
    setTimeout(() => {
      frameDoc(frame).body.insertAdjacentHTML("beforeend", "<p>The Sample Boss</p>");
    }, 25);
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 1000 })).toBe(
      true,
    );
  });

  it("resolves false when the text never appears before the timeout", async () => {
    const frame = makeFrame("<p>nothing</p>");
    const started = Date.now();
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 40 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("resolves false for an empty text without waiting for the timeout", async () => {
    const frame = makeFrame("<p>nothing</p>");
    expect(await locateInFrame(frame, "  ", { intervalMs: 5, timeoutMs: 40 })).toBe(false);
  });

  it("resolves false, without rejecting, when the frame cannot be read", async () => {
    const frame = makeFrame("<p>Sample Boss</p>");
    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new Error("Blocked a frame from another origin");
      },
    });
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 30 })).toBe(false);
  });

  it("keeps polling after a read throws and succeeds once the frame is readable", async () => {
    const frame = makeFrame("<p>Sample Boss</p>");
    const real = frameDoc(frame);
    let reads = 0;
    Object.defineProperty(frame, "contentDocument", {
      get() {
        reads += 1;
        if (reads < 3) throw new Error("cross-origin");
        return real;
      },
    });
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 1000 })).toBe(
      true,
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("keeps polling when the frame has no document yet", async () => {
    const frame = makeFrame("<p>Sample Boss</p>");
    const real = frameDoc(frame);
    let reads = 0;
    Object.defineProperty(frame, "contentDocument", {
      get() {
        reads += 1;
        return reads < 3 ? null : real;
      },
    });
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 1000 })).toBe(
      true,
    );
  });

  it("scrolls the element holding the text to the centre, when the browser can", async () => {
    const frame = makeFrame("<p>intro</p><p id='t'>The Sample Boss</p>");
    const scroll = vi.fn();
    frameWin(frame).Element.prototype.scrollIntoView = scroll;
    await locateInFrame(frame, "sample boss", { intervalMs: 5, timeoutMs: 100 });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect((scroll.mock.contexts[0] as Element).id).toBe("t");
  });

  it("works where scrollIntoView does not exist", async () => {
    const frame = makeFrame("<p>The Sample Boss</p>");
    expect(
      (frameDoc(frame).querySelector("p") as unknown as Record<string, unknown>)["scrollIntoView"],
    ).toBeUndefined();
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 100 })).toBe(true);
  });

  describe("without the CSS Custom Highlight API", () => {
    it("selects the range in the frame, adds nothing to the frame, then clears it", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<p>The Sample Boss waits</p>");
      const before = frameDoc(frame).body.innerHTML;
      const headBefore = frameDoc(frame).head.innerHTML;
      const result = locateInFrame(frame, "sample boss", { intervalMs: 5, highlightMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe(true);
      expect(frameWin(frame).getSelection()?.toString()).toBe("Sample Boss");
      expect(frameDoc(frame).body.innerHTML).toBe(before);
      expect(frameDoc(frame).head.innerHTML).toBe(headBefore);
      expect(frameDoc(frame).getElementById("gc-find-style")).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frameWin(frame).getSelection()?.toString()).toBe("");
    });

    it("leaves a selection the reader made later alone", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<p>The Sample Boss waits</p><p>Other words</p>");
      await locateInFrame(frame, "Sample Boss", { intervalMs: 5, highlightMs: 1000 });
      const other = frameDoc(frame).createRange();
      other.selectNodeContents(frameDoc(frame).querySelectorAll("p")[1] as Element);
      const selection = frameWin(frame).getSelection();
      selection?.removeAllRanges();
      selection?.addRange(other);
      await vi.advanceTimersByTimeAsync(1000);
      expect(selection?.toString()).toBe("Other words");
    });
  });

  describe("with the CSS Custom Highlight API", () => {
    class FakeHighlight {
      readonly ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    function stub(frame: HTMLIFrameElement): Map<string, FakeHighlight> {
      const highlights = new Map<string, FakeHighlight>();
      Object.defineProperty(frameWin(frame), "CSS", { value: { highlights }, configurable: true });
      Object.defineProperty(frameWin(frame), "Highlight", {
        value: FakeHighlight,
        configurable: true,
      });
      return highlights;
    }

    it("registers the highlight, adds one fixed style element to the head, and removes the highlight", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<p>The Sample Boss waits</p>");
      const highlights = stub(frame);
      const before = frameDoc(frame).body.innerHTML;
      const result = locateInFrame(frame, "sample boss", { intervalMs: 5, highlightMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe(true);
      const found = highlights.get("gc-find");
      expect(found).toBeInstanceOf(FakeHighlight);
      expect(found?.ranges).toHaveLength(1);
      expect(found?.ranges[0]?.toString()).toBe("Sample Boss");
      const styles = frameDoc(frame).head.querySelectorAll("style#gc-find-style");
      expect(styles).toHaveLength(1);
      expect(styles[0]?.textContent).toBe("::highlight(gc-find){background:#ffd54a;color:#111}");
      expect(frameDoc(frame).body.innerHTML).toBe(before);
      expect(frameWin(frame).getSelection()?.toString()).toBe("");
      await vi.advanceTimersByTimeAsync(1000);
      expect(highlights.has("gc-find")).toBe(false);
      // The fixed rule stays for the next search.
      expect(frameDoc(frame).head.querySelectorAll("#gc-find-style")).toHaveLength(1);
    });

    it("adds the style element only once across searches and keeps a newer highlight", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<p>Sample Boss</p><p>Hidden Key</p>");
      const highlights = stub(frame);
      await locateInFrame(frame, "Sample Boss", { intervalMs: 5, highlightMs: 1000 });
      await vi.advanceTimersByTimeAsync(500);
      await locateInFrame(frame, "Hidden Key", { intervalMs: 5, highlightMs: 1000 });
      expect(frameDoc(frame).head.querySelectorAll("#gc-find-style")).toHaveLength(1);
      // The first search's timer fires while the second highlight is showing.
      await vi.advanceTimersByTimeAsync(600);
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Hidden Key");
      await vi.advanceTimersByTimeAsync(500);
      expect(highlights.has("gc-find")).toBe(false);
    });
  });

  it("does not change the frame body's markup on any path", async () => {
    const frame = makeFrame("<div><p>The <b>Sample</b> Boss</p><p>Sample Boss again</p></div>");
    const before = frameDoc(frame).body.innerHTML;
    expect(await locateInFrame(frame, "Sample Boss", { intervalMs: 5, timeoutMs: 100 })).toBe(true);
    expect(frameDoc(frame).body.innerHTML).toBe(before);
    expect(await locateInFrame(frame, "No Such Text", { intervalMs: 5, timeoutMs: 20 })).toBe(
      false,
    );
    expect(frameDoc(frame).body.innerHTML).toBe(before);
  });
});
