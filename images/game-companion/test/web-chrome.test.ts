// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyChrome } from "../src/web/chrome.js";

const STICKY = "position:sticky;top:0";
const RULES =
  "#sidebar{display:none!important}" +
  '[role="main"]{margin-inline-start:0!important}' +
  '[data-gc-chrome="header"]{display:none!important}';

const PAGE =
  '<div id="sidebar">Sample sidebar</div>' +
  '<div role="main">' +
  `<div id="topbar" style="${STICKY}">Sample top bar</div>` +
  '<div id="plain">Plain block</div>' +
  `<div class="ProseMirror"><p>Body text</p><div id="inner" style="${STICKY}">Inner sticky</div></div>` +
  "</div>";

function makeFrame(body: string): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument as Document;
  doc.body.innerHTML = body;
  return doc;
}

const tagged = (doc: Document): string[] =>
  [...doc.querySelectorAll("[data-gc-chrome]")].map((e) => e.id);
const styles = (doc: Document): NodeListOf<Element> => doc.querySelectorAll("#gc-chrome-style");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("applyChrome", () => {
  it("adds one style element with the fixed rules and tags only the top bar", () => {
    const doc = makeFrame(PAGE);
    applyChrome(doc, true);
    expect(styles(doc)).toHaveLength(1);
    expect(styles(doc)[0]?.parentElement).toBe(doc.head);
    expect(styles(doc)[0]?.textContent).toBe(RULES);
    expect(styles(doc)[0]?.tagName).toBe("STYLE");
    expect(tagged(doc)).toEqual(["topbar"]);
    expect(doc.getElementById("topbar")?.getAttribute("data-gc-chrome")).toBe("header");
  });

  it("changes nothing when applied a second time", () => {
    const doc = makeFrame(PAGE);
    applyChrome(doc, true);
    const once = doc.documentElement.outerHTML;
    let changes = 0;
    const observer = new MutationObserver((records) => (changes += records.length));
    observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    applyChrome(doc, true);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    expect(changes).toBe(0);
    expect(doc.documentElement.outerHTML).toBe(once);
    expect(styles(doc)).toHaveLength(1);
  });

  it("never tags a sticky element inside the document body editor", () => {
    const doc = makeFrame(
      `<div role="main"><div class="ProseMirror"><div id="inner" style="${STICKY}">x</div></div></div>`,
    );
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual([]);
    expect(styles(doc)).toHaveLength(1);
  });

  it("never tags the editor element itself", () => {
    const doc = makeFrame(
      `<div role="main"><div class="ProseMirror" id="ed" style="${STICKY}">x</div></div>`,
    );
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual([]);
  });

  it("tags nothing when no element is sticky at the top", () => {
    const doc = makeFrame(
      '<div role="main"><div id="a" style="position:sticky;top:10px">a</div>' +
        '<div id="b" style="position:relative;top:0">b</div><div id="c">c</div></div>',
    );
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual([]);
  });

  it("ignores a sticky element outside the main region", () => {
    const doc = makeFrame(
      `<div id="outside" style="${STICKY}">o</div><div role="main"><div id="plain">p</div></div>`,
    );
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual([]);
  });

  it("takes the first such element in document order", () => {
    const doc = makeFrame(
      `<div role="main"><div id="one"><span id="deep" style="${STICKY}">d</span></div>` +
        `<div id="two" style="${STICKY}">t</div></div>`,
    );
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual(["deep"]);
  });

  it("finds a bar that a style sheet makes sticky", () => {
    const doc = makeFrame('<div role="main"><div id="bar" class="s">b</div></div>');
    doc.head.insertAdjacentHTML("beforeend", "<style>.s{position:sticky;top:0}</style>");
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual(["bar"]);
  });

  it("moves the tag when a different element is now the top bar, leaving exactly one tagged", () => {
    const doc = makeFrame(PAGE);
    applyChrome(doc, true);
    doc.getElementById("topbar")?.remove();
    doc
      .querySelector('[role="main"]')
      ?.insertAdjacentHTML("afterbegin", `<div id="newbar" style="${STICKY}">new</div>`);
    doc.getElementById("plain")?.setAttribute("data-gc-chrome", "header");
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual(["newbar"]);
    expect(styles(doc)).toHaveLength(1);
  });

  it("drops a stale tag when no top bar exists any more", () => {
    const doc = makeFrame(PAGE);
    applyChrome(doc, true);
    doc.getElementById("topbar")?.remove();
    applyChrome(doc, true);
    expect(tagged(doc)).toEqual([]);
  });

  it("restores the page byte for byte: no style element, no attribute", () => {
    const doc = makeFrame(PAGE);
    const original = doc.documentElement.outerHTML;
    applyChrome(doc, true);
    expect(doc.documentElement.outerHTML).not.toBe(original);
    applyChrome(doc, false);
    expect(doc.documentElement.outerHTML).toBe(original);
    expect(styles(doc)).toHaveLength(0);
    expect(tagged(doc)).toEqual([]);
  });

  it("restoring a page that was never hidden does nothing", () => {
    const doc = makeFrame(PAGE);
    const original = doc.documentElement.outerHTML;
    applyChrome(doc, false);
    expect(doc.documentElement.outerHTML).toBe(original);
  });

  it("changes nothing but the one style element and the one attribute", () => {
    const doc = makeFrame(PAGE);
    const bodyBefore = doc.body.innerHTML;
    applyChrome(doc, true);
    expect(doc.body.innerHTML).toBe(
      bodyBefore.replace('top:0">Sample top bar', 'top:0" data-gc-chrome="header">Sample top bar'),
    );
    expect([...doc.head.children].map((c) => c.id)).toEqual(["gc-chrome-style"]);
  });

  it("leaves the find highlight's own style element alone, and is left alone by it", () => {
    const doc = makeFrame(PAGE);
    doc.head.insertAdjacentHTML(
      "beforeend",
      '<style id="gc-find-style">::highlight(gc-find){background:#ffd54a;color:#111}</style>',
    );
    const withFind = doc.head.innerHTML;
    applyChrome(doc, true);
    expect(doc.getElementById("gc-find-style")?.textContent).toBe(
      "::highlight(gc-find){background:#ffd54a;color:#111}",
    );
    applyChrome(doc, false);
    expect(doc.head.innerHTML).toBe(withFind);
  });

  it("repairs a style element whose text was changed", () => {
    const doc = makeFrame(PAGE);
    applyChrome(doc, true);
    (styles(doc)[0] as Element).textContent = "x{}";
    applyChrome(doc, true);
    expect(styles(doc)).toHaveLength(1);
    expect(styles(doc)[0]?.textContent).toBe(RULES);
  });

  it("does not throw when the document has no head, no main region or no window", () => {
    const doc = makeFrame(PAGE);
    doc.head.remove();
    expect(() => applyChrome(doc, true)).not.toThrow();
    expect(() => applyChrome(doc, false)).not.toThrow();
    const bare = new DOMParser().parseFromString(
      `<!doctype html><body>${PAGE}</body>`,
      "text/html",
    );
    expect(() => applyChrome(bare, true)).not.toThrow();
    expect(() => applyChrome(makeFrame("<p>nothing</p>"), true)).not.toThrow();
  });

  it("does not throw when reading the document fails", () => {
    const hostile = new Proxy({} as Document, {
      get() {
        throw new Error("Blocked a frame from another origin");
      },
    });
    expect(() => applyChrome(hostile, true)).not.toThrow();
    expect(() => applyChrome(hostile, false)).not.toThrow();
  });
});
