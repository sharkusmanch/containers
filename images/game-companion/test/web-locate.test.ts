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

  it("finds a name split over adjacent text nodes, and the range reads as the whole name", () => {
    const doc = page("<p>Meet Alpha <a href='/x'>One</a> today</p>");
    const range = findTextRange(doc, "alpha one");
    expect(range?.toString()).toBe("Alpha One");
    expect(range?.startContainer.nodeValue).toBe("Meet Alpha ");
    expect(range?.endContainer.nodeValue).toBe("One");
    const emphasis = page("<p>The <em>Sample</em> Boss</p>");
    expect(findTextRange(emphasis, "Sample Boss")?.toString()).toBe("Sample Boss");
  });

  it("matches the text literally, with no pattern characters taking effect", () => {
    const doc = page("<p>x (a) [b] 1.5 2*3 c\\d $5 end</p><p>aXb 25 cd</p>");
    for (const needle of ["(a)", "[b]", "1.5", "2*3", "c\\d", "$5"]) {
      expect(findTextRange(doc, needle)?.toString()).toBe(needle);
    }
    expect(findTextRange(doc, "a.b")).toBeNull();
    expect(findTextRange(doc, "2*")?.toString()).toBe("2*");
    expect(findTextRange(doc, "c\\")?.toString()).toBe("c\\");
    expect(findTextRange(doc, "(")?.toString()).toBe("(");
    expect(findTextRange(doc, "[")?.toString()).toBe("[");
  });

  it("keeps the range right when lower-casing changes the length of earlier text", () => {
    const dotted = "\u0130stanbul \u0130\u0130 ";
    expect(dotted.toLowerCase().length).not.toBe(dotted.length);
    const doc = page(`<p>${dotted}</p><p>Then the Sample Boss</p>`);
    const range = findTextRange(doc, "sample boss");
    expect(range?.toString()).toBe("Sample Boss");
    const inside = page(`<p>${dotted}Sample Boss</p>`);
    expect(findTextRange(inside, "sample boss")?.toString()).toBe("Sample Boss");
    expect(findTextRange(inside, "sample boss")?.startOffset).toBe(dotted.length);
  });

  it("treats a non-breaking space or a line break in the page like a space", () => {
    const nbsp = page("<p>See Alpha&nbsp;One now</p>");
    const range = findTextRange(nbsp, "Alpha One");
    expect(range?.toString()).toBe("Alpha\u00a0One");
    const newline = page("<p>See Alpha\nOne now</p>");
    expect(findTextRange(newline, "alpha one")?.toString()).toBe("Alpha\nOne");
    const tab = page("<p>See Alpha\tOne</p>");
    expect(findTextRange(tab, "Alpha One")?.toString()).toBe("Alpha\tOne");
  });

  it("treats white space in the searched text like a space too", () => {
    const doc = page("<p>Open Alpha One today</p>");
    expect(findTextRange(doc, "Alpha\u00a0One")?.toString()).toBe("Alpha One");
    expect(findTextRange(doc, "Alpha\nOne")?.toString()).toBe("Alpha One");
  });

  it("does not collapse runs of white space, and keeps offsets right after one", () => {
    const doc = page("<p>Alpha  One</p><p>x\u00a0\u00a0y Alpha&nbsp;One</p>");
    expect(findTextRange(doc, "Alpha One")?.startContainer.nodeValue).toBe(
      "x\u00a0\u00a0y Alpha\u00a0One",
    );
    const range = findTextRange(doc, "Alpha One");
    expect(range?.startOffset).toBe(5);
    expect(range?.toString()).toBe("Alpha\u00a0One");
  });

  it("searches only the page text: ProseMirror first, then the main role, then the body", () => {
    const sidebar = "<nav>Sample Boss in the sidebar</nav>";
    const both = page(`${sidebar}<main role="main"><p>Sample Boss in the page</p></main>`);
    expect(findTextRange(both, "sample boss")?.startContainer.nodeValue).toBe(
      "Sample Boss in the page",
    );
    const outsideOnly = page(`${sidebar}<main role="main"><p>nothing</p></main>`);
    expect(findTextRange(outsideOnly, "sample boss")).toBeNull();
    const prose = page(
      `${sidebar}<div role="main"><p>Sample Boss around the editor</p>` +
        `<div class="ProseMirror"><p>Sample Boss in the editor</p></div></div>`,
    );
    expect(findTextRange(prose, "sample boss")?.startContainer.nodeValue).toBe(
      "Sample Boss in the editor",
    );
    const proseOutsideOnly = page(
      `<p>Sample Boss outside</p><div class="ProseMirror"><p>none here</p></div>`,
    );
    expect(findTextRange(proseOutsideOnly, "sample boss")).toBeNull();
    const plain = page("<p>Sample Boss in a plain body</p>");
    expect(findTextRange(plain, "sample boss")).not.toBeNull();
  });

  describe("heading hint", () => {
    const doc = (): Document =>
      page(
        "<div class='ProseMirror'><p>Sample Boss in the intro</p>" +
          "<h2>Chapter One</h2><p>Fight the Sample Boss here</p>" +
          "<h2>Chapter  Two</h2><p>Sample Boss again, and <b>Sample</b> Boss</p></div>",
      );
    const where = (r: Range | null): string | null | undefined =>
      r?.startContainer.parentElement?.closest("p")?.textContent;

    it("takes the first occurrence after the named heading", () => {
      expect(where(findTextRange(doc(), "sample boss", "Chapter Two"))).toBe(
        "Sample Boss again, and Sample Boss",
      );
      expect(where(findTextRange(doc(), "sample boss", "Chapter One"))).toBe(
        "Fight the Sample Boss here",
      );
    });

    it("compares the heading ignoring case and runs of whitespace", () => {
      expect(where(findTextRange(doc(), "sample boss", "  chapter TWO "))).toBe(
        "Sample Boss again, and Sample Boss",
      );
    });

    it("falls back to the first occurrence for an unknown, empty or null heading", () => {
      for (const heading of ["Chapter Nine", "", null, undefined]) {
        expect(where(findTextRange(doc(), "sample boss", heading))).toBe(
          "Sample Boss in the intro",
        );
      }
    });

    it("falls back when nothing follows the heading", () => {
      expect(where(findTextRange(doc(), "intro", "Chapter Two"))).toBe("Sample Boss in the intro");
    });

    it("does not count text inside the heading itself", () => {
      const d = page("<h2>Sample Boss</h2><p>Sample Boss is here</p>");
      expect(findTextRange(d, "sample boss", "Sample Boss")?.startContainer.nodeValue).toBe(
        "Sample Boss is here",
      );
    });
  });
});

describe("findTextRange in heading mode", () => {
  const owner = (r: Range | null): Element | null | undefined => r?.startContainer.parentElement;

  it("selects the heading, where text mode selects the earlier paragraph", () => {
    const doc = page(
      "<p id='intro'>Before you reach Mock Harbour, rest.</p><h2 id='h'>Mock Harbour</h2><p>Docks.</p>",
    );
    expect(owner(findTextRange(doc, "mock harbour", null, "text"))?.id).toBe("intro");
    expect(owner(findTextRange(doc, "mock harbour"))?.id).toBe("intro");
    const range = findTextRange(doc, "mock harbour", null, "heading");
    expect(owner(range)?.id).toBe("h");
    expect(range?.toString()).toBe("Mock Harbour");
  });

  it("prefers an exact heading over an earlier heading that merely contains the text", () => {
    const doc = page("<h2 id='a'>Mock Harbour Docks</h2><p>x</p><h3 id='b'>  mock   HARBOUR </h3>");
    expect(owner(findTextRange(doc, "Mock Harbour", null, "heading"))?.id).toBe("b");
  });

  it("takes the first heading that contains the text when none is exact", () => {
    const doc = page(
      "<p>Mock Harbour</p><h2 id='a'>Around Mock Harbour</h2><h2 id='b'>Mock Harbour Docks</h2>",
    );
    expect(owner(findTextRange(doc, "mock harbour", null, "heading"))?.id).toBe("a");
  });

  it("finds a heading with inner markup and covers all of its text", () => {
    const doc = page("<p id='p'>Mock Harbour</p><h3 id='h'>Mock <a href='#x'>Harbour</a></h3>");
    const range = findTextRange(doc, "Mock Harbour", null, "heading");
    expect(range?.toString()).toBe("Mock Harbour");
    expect(owner(range)?.id).toBe("h");
    expect(range?.startContainer.parentElement?.closest("h3")?.id).toBe("h");
    expect(range?.endContainer.parentElement?.closest("h3")?.id).toBe("h");
  });

  it("falls back to the first text occurrence when no heading has the text", () => {
    const doc = page("<h2>Other</h2><p id='one'>see Mock Harbour</p><p id='two'>Mock Harbour</p>");
    expect(owner(findTextRange(doc, "mock harbour", null, "heading"))?.id).toBe("one");
    expect(findTextRange(doc, "nowhere", null, "heading")).toBeNull();
  });

  it("ignores a heading outside the search root", () => {
    const doc = page(
      "<h1 id='out'>Mock Harbour</h1>" +
        "<div class='ProseMirror'><p id='say'>Go to Mock Harbour</p><h2 id='in'>Mock Harbour</h2></div>",
    );
    // The heading outside the root comes first in the document; the one inside must win.
    expect(owner(findTextRange(doc, "mock harbour", null, "heading"))?.id).toBe("in");
    const plain = page(
      "<h1 id='out'>Mock Harbour</h1><div class='ProseMirror'><p id='in'>x</p></div>",
    );
    expect(findTextRange(plain, "mock harbour", null, "heading")).toBeNull();
  });

  it("does not use the heading hint to choose a heading", () => {
    const doc = page("<h2 id='a'>Mock Harbour</h2><h2>Two</h2><h2 id='b'>Mock Harbour</h2>");
    expect(owner(findTextRange(doc, "mock harbour", "Two", "heading"))?.id).toBe("a");
  });
});

describe.each(["first", "last"] as const)(
  "headings that carry the wiki's anchor button (%s in the heading)",
  (place) => {
    const anchor = "<button class='heading-anchor'>#</button>";
    const h = (level: number, id: string, text: string): string =>
      place === "first"
        ? `<h${level} id='${id}'>${anchor}${text}</h${level}>`
        : `<h${level} id='${id}'>${text}${anchor}</h${level}>`;
    const owner = (r: Range | null): Element | null | undefined => r?.startContainer.parentElement;
    const inButton = (n: Node | undefined): boolean =>
      n?.parentElement?.closest("button, .heading-anchor") != null;

    it("matches a heading by equality, so a later exact heading beats an earlier containing one", () => {
      const doc = page(
        `<p>intro</p>${h(2, "a", "Around Mock Harbour")}<p>x</p>${h(2, "b", "Mock Harbour")}`,
      );
      expect(owner(findTextRange(doc, "mock harbour", null, "heading"))?.id).toBe("b");
    });

    it("covers the heading text without the button, starting and ending outside it", () => {
      const doc = page(`<p id='say'>Go to 4. Mock Harbour.</p>${h(3, "h", "4. Mock Harbour")}`);
      const range = findTextRange(doc, "4. mock harbour", null, "heading");
      expect(range?.toString()).toBe("4. Mock Harbour");
      expect(inButton(range?.startContainer)).toBe(false);
      expect(inButton(range?.endContainer)).toBe(false);
      expect(owner(range)?.id).toBe("h");
    });

    it("keeps the heading text across inner markup next to the button", () => {
      const inner =
        place === "first"
          ? "<h3 id='h'><button class='heading-anchor'>#</button>Mock <a href='#x'>Harbour</a></h3>"
          : "<h3 id='h'>Mock <a href='#x'>Harbour</a><button class='heading-anchor'>#</button></h3>";
      const range = findTextRange(
        page(`<p>Mock Harbour</p>${inner}`),
        "mock harbour",
        null,
        "heading",
      );
      expect(range?.toString()).toBe("Mock Harbour");
      expect(range?.startContainer.parentElement?.closest("h3")?.id).toBe("h");
      expect(inButton(range?.startContainer)).toBe(false);
      expect(inButton(range?.endContainer)).toBe(false);
    });

    it("lets the heading hint (Find) select the occurrence under the chosen heading", () => {
      const doc = page(
        `<p id='intro'>Sample Boss in the intro</p>${h(2, "one", "Chapter One")}` +
          `<p id='p1'>Sample Boss one</p>${h(2, "two", "Chapter Two")}<p id='p2'>Sample Boss two</p>`,
      );
      expect(owner(findTextRange(doc, "sample boss", "Chapter Two"))?.id).toBe("p2");
      expect(owner(findTextRange(doc, "sample boss", "chapter one"))?.id).toBe("p1");
    });

    it("never matches a heading whose only text is the button", () => {
      const only = page(h(2, "h", ""));
      expect(findTextRange(only, "#", null, "heading")).toBeNull();
      expect(findTextRange(only, "#")).toBeNull();
      const withMention = page(`${h(2, "h", "")}<p id='p'>Issue #4 is open</p>`);
      expect(owner(findTextRange(withMention, "#", null, "heading"))?.id).toBe("p");
    });

    it("never selects button text inside a heading in text mode", () => {
      const doc = page(`${h(2, "h", "Mock Harbour")}<p id='p'>and a # sign</p>`);
      expect(owner(findTextRange(doc, "#"))?.id).toBe("p");
      expect(findTextRange(doc, "#mock harbour")).toBeNull();
    });
  },
);

describe("buttons outside headings", () => {
  it("are still searched as ordinary text", () => {
    const doc = page("<button id='b'>Open Gate</button>");
    expect(findTextRange(doc, "open gate")?.startContainer.parentElement?.id).toBe("b");
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

  describe("the last-resort fallback text", () => {
    const heading = "4. Mock Harbour (0/12)";
    const drifted =
      "<p id='say'>Mock Harbour is nice</p><h2 id='right'>4. Mock Harbour (3/12)</h2>";
    const opts = { intervalMs: 5, timeoutMs: 100, mode: "heading" as const };

    afterEach(() => vi.useRealTimers());

    it("is tried only at the deadline, then lands on the first heading containing it", async () => {
      vi.useFakeTimers();
      const frame = makeFrame(drifted);
      const scroll = vi.fn();
      frameWin(frame).Element.prototype.scrollIntoView = scroll;
      let result: boolean | undefined;
      void locateInFrame(frame, heading, null, { ...opts, fallback: "Mock Harbour" }).then(
        (r) => (result = r),
      );
      await vi.advanceTimersByTimeAsync(90);
      expect(result).toBeUndefined();
      expect(scroll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(result).toBe(true);
      expect((scroll.mock.contexts[0] as Element).id).toBe("right");
    });

    it("falls back to the first occurrence in the page when no heading contains it", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<h2>Other</h2><p id='say'>Visit Mock Harbour</p>");
      const scroll = vi.fn();
      frameWin(frame).Element.prototype.scrollIntoView = scroll;
      let result: boolean | undefined;
      void locateInFrame(frame, heading, null, { ...opts, fallback: "Mock Harbour" }).then(
        (r) => (result = r),
      );
      await vi.advanceTimersByTimeAsync(90);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      expect(result).toBe(true);
      expect((scroll.mock.contexts[0] as Element).id).toBe("say");
    });

    it("changes nothing without a fallback text", async () => {
      vi.useFakeTimers();
      const frame = makeFrame(drifted);
      let result: boolean | undefined;
      void locateInFrame(frame, heading, null, opts).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBe(false);
    });

    it("is never used while the right heading could still appear", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<h2 id='early'>Around Mock Harbour</h2>");
      const scroll = vi.fn();
      frameWin(frame).Element.prototype.scrollIntoView = scroll;
      setTimeout(() => {
        frameDoc(frame).body.insertAdjacentHTML("beforeend", `<h2 id='right'>${heading}</h2>`);
      }, 30);
      let result: boolean | undefined;
      void locateInFrame(frame, heading, null, { ...opts, fallback: "Mock Harbour" }).then(
        (r) => (result = r),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect((scroll.mock.contexts[0] as Element).id).toBe("right");
    });

    it("is ignored in text mode", async () => {
      vi.useFakeTimers();
      const frame = makeFrame(drifted);
      let result: boolean | undefined;
      void locateInFrame(frame, heading, null, {
        intervalMs: 5,
        timeoutMs: 100,
        fallback: "Mock Harbour",
      }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBe(false);
    });
  });

  it("in heading mode scrolls to the heading, not an earlier sentence that mentions it", async () => {
    const frame = makeFrame(
      "<p id='mention'>Go to Mock Harbour soon.</p><h2 id='head'>Mock Harbour</h2><p>Docks</p>",
    );
    const scroll = vi.fn();
    frameWin(frame).Element.prototype.scrollIntoView = scroll;
    expect(
      await locateInFrame(frame, "Mock Harbour", null, { intervalMs: 5, mode: "heading" }),
    ).toBe(true);
    expect((scroll.mock.contexts[0] as Element).id).toBe("head");
    expect(await locateInFrame(frame, "Mock Harbour", null, { intervalMs: 5 })).toBe(true);
    expect((scroll.mock.contexts[1] as Element).id).toBe("mention");
  });

  it("scrolls to the occurrence under the given heading", async () => {
    const frame = makeFrame(
      "<h2>One</h2><p id='first'>Sample Boss</p><h2>Two</h2><p id='second'>Sample Boss</p>",
    );
    const scroll = vi.fn();
    frameWin(frame).Element.prototype.scrollIntoView = scroll;
    expect(await locateInFrame(frame, "Sample Boss", "Two", { intervalMs: 5 })).toBe(true);
    expect((scroll.mock.contexts[0] as Element).id).toBe("second");
    expect(await locateInFrame(frame, "Sample Boss", null, { intervalMs: 5 })).toBe(true);
    expect((scroll.mock.contexts[1] as Element).id).toBe("first");
  });

  describe("while the frame is navigating", () => {
    it("does not read the frame until it is ready, then looks as soon as it loads", async () => {
      const frame = makeFrame("<p>Sample Boss</p>");
      const real = frameDoc(frame);
      let reads = 0;
      Object.defineProperty(frame, "contentDocument", {
        get() {
          reads += 1;
          return real;
        },
      });
      let ready = false;
      let settled = false;
      const result = locateInFrame(frame, "Sample Boss", {
        intervalMs: 5,
        timeoutMs: 5000,
        ready: () => ready,
      }).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(reads).toBe(0);
      expect(settled).toBe(false);
      ready = true;
      frame.dispatchEvent(new Event("load"));
      expect(await result).toBe(true);
      expect(reads).toBeGreaterThan(0);
    });

    it("resolves false at the deadline when it never becomes ready", async () => {
      const frame = makeFrame("<p>Sample Boss</p>");
      expect(
        await locateInFrame(frame, "Sample Boss", {
          intervalMs: 5,
          timeoutMs: 40,
          ready: () => false,
        }),
      ).toBe(false);
    });

    it("resolves false at once when told the frame is gone", async () => {
      const frame = makeFrame("<p>Sample Boss</p>");
      const started = Date.now();
      expect(
        await locateInFrame(frame, "Sample Boss", {
          intervalMs: 5,
          timeoutMs: 5000,
          ready: () => false,
          gone: () => true,
        }),
      ).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe("when told to stop", () => {
    it("resolves false at once for a signal that is already aborted, reading nothing", async () => {
      const frame = makeFrame("<p>Sample Boss</p>");
      let reads = 0;
      const real = frameDoc(frame);
      Object.defineProperty(frame, "contentDocument", {
        get() {
          reads += 1;
          return real;
        },
      });
      const controller = new AbortController();
      controller.abort();
      expect(await locateInFrame(frame, "Sample Boss", { signal: controller.signal })).toBe(false);
      expect(reads).toBe(0);
    });

    it("resolves false promptly while waiting, and stops polling", async () => {
      vi.useFakeTimers();
      const frame = makeFrame("<p>nothing</p>");
      let reads = 0;
      const real = frameDoc(frame);
      Object.defineProperty(frame, "contentDocument", {
        get() {
          reads += 1;
          return real;
        },
      });
      const controller = new AbortController();
      const result = locateInFrame(frame, "Sample Boss", { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1000);
      const before = reads;
      expect(before).toBeGreaterThan(1);
      controller.abort();
      expect(await result).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reads).toBe(before);
    });

    it("takes its own highlight down when stopped, and its clean-up never touches a newer one", async () => {
      vi.useFakeTimers();
      class FakeHighlight {
        readonly ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      }
      const frame = makeFrame("<p>Sample Boss</p><p>Hidden Key</p>");
      const highlights = new Map<string, FakeHighlight>();
      Object.defineProperty(frameWin(frame), "CSS", { value: { highlights }, configurable: true });
      Object.defineProperty(frameWin(frame), "Highlight", {
        value: FakeHighlight,
        configurable: true,
      });
      const first = new AbortController();
      await locateInFrame(frame, "Sample Boss", { signal: first.signal, highlightMs: 1000 });
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Sample Boss");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(300);
      first.abort();
      expect(highlights.has("gc-find")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await locateInFrame(frame, "Hidden Key", { highlightMs: 1000 });
      // the first search's original expiry passes: the second highlight is still there
      await vi.advanceTimersByTimeAsync(800);
      expect(highlights.get("gc-find")?.ranges[0]?.toString()).toBe("Hidden Key");
      await vi.advanceTimersByTimeAsync(300);
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
