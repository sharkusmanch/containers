import type { GuideZoom } from "./device.js";

const STYLE_ID = "gc-chrome-style";
const ATTRIBUTE = "data-gc-chrome";
const STYLE_TEXT =
  "#sidebar{display:none!important}" +
  '[role="main"]{margin-inline-start:0!important}' +
  '[data-gc-chrome="header"]{display:none!important}';

const ZOOM_STYLE_ID = "gc-zoom-style";
/** The only texts the zoom style ever holds, keyed by the validated step. */
const ZOOM_TEXT: Record<Exclude<GuideZoom, 100>, string> = {
  90: "html{zoom:0.9}",
  80: "html{zoom:0.8}",
  70: "html{zoom:0.7}",
};

/** The most elements one pass looks at when searching for the top bar. */
const SEARCH_LIMIT = 300;

const isTopBar = (view: Window, el: Element): boolean => {
  const style = view.getComputedStyle(el);
  return style.position === "sticky" && style.top === "0px";
};

/**
 * The element that is already tagged, if it is still the top bar; else the first element in
 * document order inside the main region, outside the document body editor, that sticks to the top
 * of the page. The editor's subtrees are not walked and at most SEARCH_LIMIT elements are examined.
 */
function findTopBar(doc: Document): Element | null {
  const view = doc.defaultView;
  if (view === null) return null;
  const kept = doc.querySelector(`[${ATTRIBUTE}="header"]`);
  if (
    kept !== null &&
    kept.isConnected &&
    kept.closest('[role="main"]') !== null &&
    kept.closest(".ProseMirror") === null &&
    isTopBar(view, kept)
  ) {
    return kept;
  }
  let examined = 0;
  for (const main of doc.querySelectorAll('[role="main"]')) {
    if (main.closest(".ProseMirror") !== null) continue;
    const walker = doc.createTreeWalker(main, 1 /* NodeFilter.SHOW_ELEMENT */, {
      acceptNode: (node) =>
        (node as Element).classList.contains("ProseMirror") ? 2 /* REJECT */ : 1 /* ACCEPT */,
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (examined === SEARCH_LIMIT) return null;
      examined += 1;
      if (isTopBar(view, node as Element)) return node as Element;
    }
  }
  return null;
}

/** Hides or restores the framed wiki page's sidebar and top bar. Idempotent. Never throws. */
export function applyChrome(frameDoc: Document, hide: boolean): void {
  try {
    if (!hide) {
      frameDoc.getElementById(STYLE_ID)?.remove();
      for (const e of frameDoc.querySelectorAll(`[${ATTRIBUTE}]`)) e.removeAttribute(ATTRIBUTE);
      return;
    }
    const head = frameDoc.head;
    if (head === null) return;
    let style = frameDoc.getElementById(STYLE_ID);
    if (style === null) {
      style = frameDoc.createElement("style");
      style.id = STYLE_ID;
      head.append(style);
    }
    if (style.textContent !== STYLE_TEXT) style.textContent = STYLE_TEXT;

    const bar = findTopBar(frameDoc);
    for (const e of frameDoc.querySelectorAll(`[${ATTRIBUTE}]`)) {
      if (e !== bar) e.removeAttribute(ATTRIBUTE);
    }
    if (bar !== null && bar.getAttribute(ATTRIBUTE) !== "header")
      bar.setAttribute(ATTRIBUTE, "header");
  } catch {
    // The frame navigated to another origin, or has no document yet.
  }
}

/** Draws the framed wiki page smaller (90, 80 or 70) or restores it (100). Idempotent. Never throws. */
export function applyZoom(frameDoc: Document, zoom: GuideZoom): void {
  try {
    if (zoom === 100) {
      frameDoc.getElementById(ZOOM_STYLE_ID)?.remove();
      return;
    }
    const head = frameDoc.head;
    if (head === null) return;
    let style = frameDoc.getElementById(ZOOM_STYLE_ID);
    if (style === null) {
      style = frameDoc.createElement("style");
      style.id = ZOOM_STYLE_ID;
      head.append(style);
    }
    if (style.textContent !== ZOOM_TEXT[zoom]) style.textContent = ZOOM_TEXT[zoom];
  } catch {
    // The frame navigated to another origin, or has no document yet.
  }
}
