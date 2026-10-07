const SKIPPED = "script, style, noscript";
const HIGHLIGHT_NAME = "gc-find";
const STYLE_ID = "gc-find-style";
const STYLE_TEXT = "::highlight(gc-find){background:#ffd54a;color:#111}";

/**
 * Lower-cases `text` without changing its length, so offsets in the folded copy are offsets in the
 * original. A character whose lower-case form has a different length (for example the dotted
 * capital I) is left unfolded rather than shifting every offset after it.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The page's own text: the editor, else the main region, else the whole body. */
function searchRoot(doc: Document): Element | null {
  return doc.querySelector(".ProseMirror") ?? doc.querySelector('[role="main"]') ?? doc.body;
}

interface Piece {
  node: Text;
  start: number;
  end: number;
}

/**
 * First place `text` occurs in the page text of `doc`, ignoring case, as a Range. The text may
 * span adjacent text nodes. With a `heading`, the first occurrence after the first heading of
 * that name is preferred; the first occurrence anywhere is the fallback. Null when absent.
 */
export function findTextRange(doc: Document, text: string, heading?: string | null): Range | null {
  const needle = fold(text.trim());
  const root = searchRoot(doc);
  if (needle === "" || root === null) return null;

  const pieces: Piece[] = [];
  let all = "";
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(SKIPPED) != null) continue;
    const data = node.nodeValue ?? "";
    if (data === "") continue;
    pieces.push({ node: node as Text, start: all.length, end: all.length + data.length });
    all += fold(data);
  }

  let at = -1;
  const wanted = heading == null ? "" : collapse(heading);
  if (wanted !== "") {
    const title = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(
      (h) => collapse(h.textContent ?? "") === wanted,
    );
    const after =
      title === undefined
        ? undefined
        : pieces.find(
            (p) =>
              !title.contains(p.node) &&
              (title.compareDocumentPosition(p.node) & 4) /* DOCUMENT_POSITION_FOLLOWING */ !== 0,
          );
    if (after !== undefined) at = all.indexOf(needle, after.start);
  }
  if (at === -1) at = all.indexOf(needle);
  if (at === -1) return null;

  const last = at + needle.length;
  const from = pieces.find((p) => at < p.end);
  const to = pieces.find((p) => last <= p.end && last > p.start);
  if (from === undefined || to === undefined) return null;
  const range = doc.createRange();
  range.setStart(from.node, at - from.start);
  range.setEnd(to.node, last - to.start);
  return range;
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

export interface LocateOptions {
  timeoutMs?: number;
  intervalMs?: number;
  highlightMs?: number;
  /** While this returns false the frame is navigating and its document is not read. */
  ready?: () => boolean;
  /** When this returns true the frame has been dropped and the search stops. */
  gone?: () => boolean;
}

/**
 * Waits for `text` (preferably under `heading`) to appear in the frame's document, scrolls to it
 * and highlights it briefly. Resolves false on timeout, when the frame is gone or when it cannot be
 * read. Never rejects.
 */
export function locateInFrame(
  frame: HTMLIFrameElement,
  text: string,
  heading?: string | null,
  opts?: LocateOptions,
): Promise<boolean>;
export function locateInFrame(
  frame: HTMLIFrameElement,
  text: string,
  opts?: LocateOptions,
): Promise<boolean>;
export function locateInFrame(
  frame: HTMLIFrameElement,
  text: string,
  third?: string | null | LocateOptions,
  fourth?: LocateOptions,
): Promise<boolean> {
  const heading = typeof third === "object" && third !== null ? null : (third ?? null);
  const opts: LocateOptions = (typeof third === "object" && third !== null ? third : fourth) ?? {};
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 300;
  const highlightMs = opts.highlightMs ?? 6_000;
  return new Promise<boolean>((resolve) => {
    if (text.trim() === "") {
      resolve(false);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean): void => {
      clearTimeout(timer);
      frame.removeEventListener("load", attempt);
      resolve(result);
    };
    function attempt(): void {
      clearTimeout(timer);
      if (opts.gone?.() === true) {
        finish(false);
        return;
      }
      let found: { doc: Document; range: Range } | null = null;
      // A frame that is still navigating shows the page it is leaving.
      if (opts.ready === undefined || opts.ready()) {
        try {
          // The wiki renders after load; a frame on another origin throws. Both mean "not yet".
          const doc = frame.contentDocument;
          const range = doc === null ? null : findTextRange(doc, text, heading);
          if (doc !== null && range !== null) found = { doc, range };
        } catch {
          found = null;
        }
      }
      if (found !== null) {
        reveal(found.doc, found.range, highlightMs);
        finish(true);
      } else if (Date.now() >= deadline) {
        finish(false);
      } else {
        timer = setTimeout(attempt, intervalMs);
      }
    }
    frame.addEventListener("load", attempt);
    attempt();
  });
}
