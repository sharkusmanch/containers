const SKIPPED = "script, style, noscript";
const HIGHLIGHT_NAME = "gc-find";
const STYLE_ID = "gc-find-style";
const STYLE_TEXT = "::highlight(gc-find){background:#ffd54a;color:#111}";

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First place `text` occurs inside one text node of `doc.body`, ignoring case. Null when absent. */
export function findTextRange(doc: Document, text: string): Range | null {
  const needle = text.trim();
  if (needle === "" || doc.body === null) return null;
  const pattern = new RegExp(escapePattern(needle), "i");
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(SKIPPED) != null) continue;
    const data = node.nodeValue ?? "";
    const found = pattern.exec(data);
    if (found === null) continue;
    const range = doc.createRange();
    range.setStart(node, found.index);
    range.setEnd(node, found.index + found[0].length);
    return range;
  }
  return null;
}

interface HighlightRegistry {
  get(name: string): unknown;
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}
interface HighlightWindow {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: new (...ranges: Range[]) => unknown;
  getSelection(): Selection | null;
}

/** Marks the range for `highlightMs`, by the highlight API when the frame has it, else by selection. */
function highlight(doc: Document, range: Range, highlightMs: number): void {
  const win = doc.defaultView as unknown as HighlightWindow | null;
  if (win === null) return;
  const registry = win.CSS?.highlights;
  if (registry !== undefined && typeof win.Highlight === "function") {
    if (doc.getElementById(STYLE_ID) === null && doc.head !== null) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      doc.head.append(style);
    }
    const mark = new win.Highlight(range);
    registry.set(HIGHLIGHT_NAME, mark);
    setTimeout(() => {
      try {
        // A later search may have replaced it.
        if (registry.get(HIGHLIGHT_NAME) === mark) registry.delete(HIGHLIGHT_NAME);
      } catch {
        // The frame is gone.
      }
    }, highlightMs);
    return;
  }
  const selection = win.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
  setTimeout(() => {
    try {
      const now = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
      // Leave a selection the reader made since.
      if (
        now !== null &&
        now.startContainer === range.startContainer &&
        now.startOffset === range.startOffset &&
        now.endContainer === range.endContainer &&
        now.endOffset === range.endOffset
      ) {
        selection.removeAllRanges();
      }
    } catch {
      // The frame is gone.
    }
  }, highlightMs);
}

function reveal(doc: Document, range: Range, highlightMs: number): void {
  try {
    const target = range.startContainer.parentElement;
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
    highlight(doc, range, highlightMs);
  } catch {
    // The text was found; failing to decorate it is not a failure to locate it.
  }
}

/**
 * Waits for `text` to appear in the frame's document, scrolls to it and highlights it briefly.
 * Resolves false on timeout or when the frame cannot be read. Never rejects.
 */
export function locateInFrame(
  frame: HTMLIFrameElement,
  text: string,
  opts: { timeoutMs?: number; intervalMs?: number; highlightMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 300;
  const highlightMs = opts.highlightMs ?? 6_000;
  return new Promise<boolean>((resolve) => {
    if (text.trim() === "") {
      resolve(false);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      let found: { doc: Document; range: Range } | null = null;
      try {
        // The wiki renders after load; a frame on another origin throws. Both mean "not yet".
        const doc = frame.contentDocument;
        const range = doc === null ? null : findTextRange(doc, text);
        if (doc !== null && range !== null) found = { doc, range };
      } catch {
        found = null;
      }
      if (found !== null) {
        reveal(found.doc, found.range, highlightMs);
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(attempt, intervalMs);
      }
    };
    attempt();
  });
}
