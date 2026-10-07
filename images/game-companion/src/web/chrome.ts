const STYLE_ID = "gc-chrome-style";
const ATTRIBUTE = "data-gc-chrome";
const STYLE_TEXT =
  "#sidebar{display:none!important}" +
  '[role="main"]{margin-inline-start:0!important}' +
  '[data-gc-chrome="header"]{display:none!important}';

/**
 * The first element in document order inside the main region, outside the document body editor,
 * that sticks to the top of the page. Subtrees of the editor are not walked.
 */
function findTopBar(doc: Document): Element | null {
  const view = doc.defaultView;
  if (view === null) return null;
  for (const main of doc.querySelectorAll('[role="main"]')) {
    if (main.closest(".ProseMirror") !== null) continue;
    const walker = doc.createTreeWalker(main, 1 /* NodeFilter.SHOW_ELEMENT */, {
      acceptNode: (node) =>
        (node as Element).classList.contains("ProseMirror") ? 2 /* REJECT */ : 1 /* ACCEPT */,
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const style = view.getComputedStyle(node as Element);
      if (style.position === "sticky" && style.top === "0px") return node as Element;
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
