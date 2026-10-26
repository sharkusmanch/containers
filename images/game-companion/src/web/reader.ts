/**
 * The guide reader: one slot's view of an Outline page, rendered by the companion from the page's
 * JSON, with checkboxes that save in one tap. A thin DOM layer over `outline-api`, `guide-render`
 * and `guide-tick`.
 */
import { renderGuide } from "./guide-render.js";
import { tick } from "./guide-tick.js";
import { locateInElement, type LocateMode } from "./locate.js";
import { OutlineError, type GuideDocument, type OutlineApi } from "./outline-api.js";
import { docId } from "./state.js";

export interface ReaderDeps {
  doc: Document;
  outline: OutlineApi;
  origin: string;
  /** Opens a guide page in the companion; false when it is not one it knows. */
  openPage(url: string): boolean;
  showInOutline(url: string): void;
  onSaved(): void;
}

export interface Reader {
  element: HTMLElement;
  readonly url: string;
  load(url: string): void;
  locate(
    text: string,
    heading: string | null,
    mode: LocateMode,
    fallback?: string,
  ): Promise<boolean>;
  dispose(): void;
}

const LOADING = "Loading…";
const NOT_FOUND = "This page wasn't found.";
const LOAD_FAILED = "Couldn't load this page. Check your connection.";
const CANT_SHOW = "This page can't be shown here. Use Show in Outline.";
const SIGN_IN_READ = "Sign in to Outline to read this page.";
const SIGN_IN_TICK = "Sign in to Outline to tick boxes.";
const CONFLICT = "This page changed elsewhere and was refreshed. Tap again.";
const REFUSED = "Couldn't match this item safely. Tick it in Outline.";
const FAILED = "Couldn't save. Check your connection and try again.";
const LOCATE_WAIT_MS = 10_000;

/** Reading positions by page id, shared by every reader for the session. */
const positions = new Map<string, number>();

export function createReader(deps: ReaderDeps, url: string): Reader {
  const { doc } = deps;
  const element = doc.createElement("div");
  element.className = "reader";
  const bar = doc.createElement("div");
  bar.className = "reader-bar";
  const outlineButton = doc.createElement("button");
  outlineButton.type = "button";
  outlineButton.className = "reader-outline";
  outlineButton.textContent = "Show in Outline";
  const status = doc.createElement("span");
  status.className = "reader-status";
  status.setAttribute("role", "status");
  bar.append(outlineButton, status);
  const body = doc.createElement("article");
  body.className = "reader-body";
  element.append(bar, body);

  let current = url;
  /** The document on screen; null while loading or after a failed load. */
  let shown: GuideDocument | null = null;
  let loadCtl: AbortController | null = null;
  /** Settles when the latest load has; replaced by every load. */
  let ready: Promise<void> = Promise.resolve();
  /** Bumped on every page change, conflict and dispose: queued taps of an older one are dropped. */
  let generation = 0;
  /** Boxes tapped and not yet answered, by index, with the state asked for. */
  const pending = new Map<number, boolean>();
  let chain: Promise<void> = Promise.resolve();
  let highlightCtl: AbortController | null = null;
  let disposed = false;

  function setStatus(text: string, signIn = false): void {
    status.replaceChildren(text);
    if (!signIn) return;
    const link = doc.createElement("a");
    link.href = "/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Sign in";
    status.append(" ", link);
  }

  const boxAt = (index: number): Element | null => body.querySelector(`.cb[data-cb="${index}"]`);

  function mark(box: Element | null, checked: boolean, busy: boolean): void {
    if (box === null) return;
    box.setAttribute("aria-checked", String(checked));
    if (busy) box.setAttribute("aria-busy", "true");
    else box.removeAttribute("aria-busy");
  }

  /** Shows `next`, or says it can't be shown. True when it rendered. */
  function render(next: GuideDocument): boolean {
    let html: string;
    try {
      html = renderGuide(next.data, { origin: deps.origin });
    } catch {
      shown = null;
      body.replaceChildren();
      setStatus(CANT_SHOW);
      return false;
    }
    shown = next;
    body.innerHTML = html;
    for (const [index, checked] of pending) mark(boxAt(index), checked, true);
    return true;
  }

  /** Shows `next` in place of the shown document, at the same scroll position. */
  function rerender(next: GuideDocument): boolean {
    const top = element.scrollTop;
    if (!render(next)) return false;
    element.scrollTop = top;
    return true;
  }

  /** Leaves the current page: remembers where it was read to and stops its load and ticks. */
  function leave(): void {
    if (shown !== null) positions.set(docId(current), element.scrollTop);
    loadCtl?.abort();
    loadCtl = null;
    highlightCtl?.abort();
    highlightCtl = null;
    generation += 1;
    pending.clear();
  }

  function load(next: string): void {
    if (disposed || (next === current && (shown !== null || loadCtl !== null))) return;
    leave();
    current = next;
    shown = null;
    body.replaceChildren();
    setStatus(LOADING);
    const ctl = new AbortController();
    loadCtl = ctl;
    const id = docId(next);
    ready = deps.outline.document(id, ctl.signal).then(
      (answer) => {
        if (loadCtl !== ctl) return;
        loadCtl = null;
        if (!render(answer)) return;
        setStatus("");
        element.scrollTop = positions.get(id) ?? 0;
      },
      (err: unknown) => {
        if (loadCtl !== ctl) return;
        loadCtl = null;
        const kind = err instanceof OutlineError ? err.kind : "other";
        if (kind === "signed-out") setStatus(SIGN_IN_READ, true);
        else setStatus(kind === "not-found" ? NOT_FOUND : LOAD_FAILED);
      },
    );
  }

  async function runTap(gen: number, index: number, checked: boolean): Promise<void> {
    if (gen !== generation || shown === null) return;
    const result = await tick(deps.outline, shown, index, checked);
    if (gen !== generation) return;
    pending.delete(index);
    switch (result.kind) {
      case "saved":
        rerender(result.doc);
        deps.onSaved();
        return;
      case "conflict":
        generation += 1;
        pending.clear();
        if (rerender(result.doc)) setStatus(CONFLICT);
        return;
      case "refused":
        mark(boxAt(index), !checked, false);
        setStatus(REFUSED);
        return;
      case "signed-out":
        mark(boxAt(index), !checked, false);
        setStatus(SIGN_IN_TICK, true);
        return;
      case "failed":
        if (result.doc === null) mark(boxAt(index), !checked, false);
        else if (!rerender(result.doc)) return;
        setStatus(FAILED);
        return;
    }
  }

  function tap(box: Element): void {
    const index = Number(box.getAttribute("data-cb"));
    if (shown === null || !Number.isInteger(index) || box.getAttribute("aria-busy") === "true") {
      return;
    }
    const checked = box.getAttribute("aria-checked") !== "true";
    setStatus("");
    mark(box, checked, true);
    pending.set(index, checked);
    const gen = generation;
    chain = chain.then(() => runTap(gen, index, checked)).catch(() => undefined);
  }

  function onBodyClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const box = target.closest(".cb");
    if (box !== null && body.contains(box)) {
      tap(box);
      return;
    }
    const link = target.closest("a[data-doc]");
    if (
      link !== null &&
      body.contains(link) &&
      deps.openPage(link.getAttribute("data-doc") ?? "")
    ) {
      event.preventDefault();
    }
  }

  function onOutlineClick(): void {
    deps.showInOutline(current);
  }

  /** Waits for the latest load, following any load started meanwhile. */
  async function loaded(): Promise<void> {
    let waited: Promise<void>;
    do {
      waited = ready;
      await waited;
    } while (waited !== ready);
  }

  body.addEventListener("click", onBodyClick);
  outlineButton.addEventListener("click", onOutlineClick);
  load(url);

  return {
    element,
    get url() {
      return current;
    },
    load,
    async locate(text, heading, mode, fallback) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), LOCATE_WAIT_MS);
      });
      const done = await Promise.race([loaded().then(() => true as const), timeout]);
      clearTimeout(timer);
      if (!done || disposed) return false;
      highlightCtl?.abort();
      const mine = new AbortController();
      highlightCtl = mine;
      return locateInElement(body, text, heading, {
        mode,
        signal: mine.signal,
        ...(fallback === undefined ? {} : { fallback }),
      });
    },
    dispose() {
      if (disposed) return;
      leave();
      disposed = true;
      body.removeEventListener("click", onBodyClick);
      outlineButton.removeEventListener("click", onOutlineClick);
    },
  };
}
