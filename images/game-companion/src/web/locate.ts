const SKIPPED = "script, style, noscript";
const HIGHLIGHT_NAME = "gc-find";
const STYLE_ID = "gc-find-style";
const STYLE_TEXT = "::highlight(gc-find){background:#ffd54a;color:#111}";

const plainSpaces = (text: string): string => text.replace(/\s/g, " ");

/**
 * Lower-cases `text` and turns every white-space character (a non-breaking space or a line break
 * included) into a plain space, without changing its length, so offsets in the folded copy are
 * offsets in the original. A character whose lower-case form has a different length (for example
 * the dotted capital I) is left unfolded rather than shifting every offset after it.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return plainSpaces(lower);
  let out = "";
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += plainSpaces(l.length === ch.length ? l : ch);
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

const HEADINGS = "h1, h2, h3, h4, h5, h6";

/**
 * True for text inside a control the wiki puts in a heading (its "#" anchor button): such text
 * is not part of the heading and is never searched.
 */
function inHeadingControl(node: Node): boolean {
  const control = node.parentElement?.closest("button, .heading-anchor");
  return control != null && control.closest(HEADINGS) !== null;
}

/** What a search is for: a piece of text anywhere, or the section heading that carries it. */
export type LocateMode = "text" | "heading";

interface Scan {
  root: Element;
  pieces: Piece[];
  /** The folded text of every piece, joined. */
  all: string;
}

function scan(doc: Document): Scan | null {
  const root = searchRoot(doc);
  if (root === null) return null;
  const pieces: Piece[] = [];
  let all = "";
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(SKIPPED) != null || inHeadingControl(node)) continue;
    const data = node.nodeValue ?? "";
    if (data === "") continue;
    pieces.push({ node: node as Text, start: all.length, end: all.length + data.length });
    all += fold(data);
  }
  return { root, pieces, all };
}

/** A heading's text: its own text nodes, without the controls inside it. */
function headingTexts(found: Scan): { heading: Element; text: string; pieces: Piece[] }[] {
  return [...found.root.querySelectorAll(HEADINGS)].map((heading) => {
    const pieces = found.pieces.filter((p) => heading.contains(p.node));
    return { heading, pieces, text: collapse(pieces.map((p) => p.node.nodeValue ?? "").join("")) };
  });
}

function headingRange(doc: Document, heading: { pieces: Piece[] } | undefined): Range | null {
  const first = heading?.pieces[0];
  const last = heading?.pieces[heading.pieces.length - 1];
  if (first === undefined || last === undefined) return null;
  const range = doc.createRange();
  range.setStart(first.node, 0);
  range.setEnd(last.node, last.node.length);
  return range;
}

function textRange(doc: Document, found: Scan, needle: string, from = 0): Range | null {
  const at = found.all.indexOf(needle, from);
  if (at === -1) return null;
  const last = at + needle.length;
  const start = found.pieces.find((p) => at < p.end);
  const end = found.pieces.find((p) => last <= p.end && last > p.start);
  if (start === undefined || end === undefined) return null;
  const range = doc.createRange();
  range.setStart(start.node, at - start.start);
  range.setEnd(end.node, last - end.start);
  return range;
}

/**
 * First place `text` occurs in the page text of `doc`, ignoring case, as a Range. The text may
 * span adjacent text nodes. With a `heading`, the first occurrence after the first heading of
 * that name is preferred; the first occurrence anywhere is the fallback. Null when absent.
 *
 * In "heading" mode the target is instead the first h1-h6 whose text equals `text` (folded the
 * same way), else the first one that contains it, and the range covers that heading's text; with
 * no such heading it behaves as "text" mode. The `heading` hint is not used then.
 *
 * A heading's text never includes a button (or `.heading-anchor`) inside it, and text in such a
 * control is never matched.
 */
export function findTextRange(
  doc: Document,
  text: string,
  heading?: string | null,
  mode: LocateMode = "text",
): Range | null {
  const needle = fold(text.trim());
  const found = scan(doc);
  if (needle === "" || found === null) return null;

  if (mode === "heading") {
    const wantedTitle = collapse(text);
    const titles = headingTexts(found);
    const range = headingRange(
      doc,
      titles.find((h) => h.text === wantedTitle) ??
        titles.find((h) => h.text.includes(wantedTitle)),
    );
    if (range !== null) return range;
  }

  const wanted = heading == null ? "" : collapse(heading);
  if (wanted !== "") {
    const title = headingTexts(found).find((h) => h.text === wanted)?.heading;
    const after =
      title === undefined
        ? undefined
        : found.pieces.find(
            (p) =>
              !title.contains(p.node) &&
              (title.compareDocumentPosition(p.node) & 4) /* DOCUMENT_POSITION_FOLLOWING */ !== 0,
          );
    if (after !== undefined) {
      const under = textRange(doc, found, needle, after.start);
      if (under !== null) return under;
    }
  }
  return textRange(doc, found, needle);
}

/**
 * The last resort for a heading whose text has drifted from the server's copy: the first heading
 * containing `text`, else the first place `text` occurs in the page.
 */
export function findFallbackRange(doc: Document, text: string): Range | null {
  const needle = fold(text.trim());
  const found = scan(doc);
  if (needle === "" || found === null) return null;
  const wanted = collapse(text);
  return (
    headingRange(
      doc,
      headingTexts(found).find((h) => h.text.includes(wanted)),
    ) ?? textRange(doc, found, needle)
  );
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

/**
 * Marks the range for `highlightMs`, by the highlight API when the frame has it, else by selection.
 * Aborting `signal` takes the mark down at once and cancels the pending clean-up, so a stopped
 * search can never touch a newer one's mark.
 */
function highlight(doc: Document, range: Range, highlightMs: number, signal?: AbortSignal): void {
  const win = doc.defaultView as unknown as HighlightWindow | null;
  if (win === null) return;
  let clear: () => void;
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
    clear = () => {
      try {
        // A later search may have replaced it.
        if (registry.get(HIGHLIGHT_NAME) === mark) registry.delete(HIGHLIGHT_NAME);
      } catch {
        // The frame is gone.
      }
    };
  } else {
    const selection = win.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    selection.addRange(range);
    clear = () => {
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
    };
  }
  const timer = setTimeout(clear, highlightMs);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      clear();
    },
    { once: true },
  );
}

function reveal(doc: Document, range: Range, highlightMs: number, signal?: AbortSignal): void {
  try {
    const target = range.startContainer.parentElement;
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
    highlight(doc, range, highlightMs, signal);
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
  /** "heading" looks for the section heading carrying the text; default "text". */
  mode?: LocateMode;
  /**
   * Heading mode only: when the deadline passes without a match, one last attempt with this
   * text (the first heading containing it, else its first occurrence in the page).
   */
  fallback?: string;
  /** Aborting stops the search (it resolves false) and takes down any highlight it made. */
  signal?: AbortSignal;
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
    if (text.trim() === "" || opts.signal?.aborted === true) {
      resolve(false);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean): void => {
      clearTimeout(timer);
      frame.removeEventListener("load", attempt);
      opts.signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    function stop(): void {
      finish(false);
    }
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
          let range = doc === null ? null : findTextRange(doc, text, heading, opts.mode ?? "text");
          if (doc !== null && range === null && opts.mode === "heading" && Date.now() >= deadline) {
            range = opts.fallback === undefined ? null : findFallbackRange(doc, opts.fallback);
          }
          if (doc !== null && range !== null) found = { doc, range };
        } catch {
          found = null;
        }
      }
      if (found !== null) {
        reveal(found.doc, found.range, highlightMs, opts.signal);
        finish(true);
      } else if (Date.now() >= deadline) {
        finish(false);
      } else {
        timer = setTimeout(attempt, intervalMs);
      }
    }
    frame.addEventListener("load", attempt);
    opts.signal?.addEventListener("abort", stop);
    attempt();
  });
}
