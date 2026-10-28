/**
 * The guide reader: one slot's view of an Outline page, rendered by the companion from the page's
 * JSON, with checkboxes that save in one tap. A thin DOM layer over `outline-api`, `guide-render`
 * and `guide-tick`.
 */
import { checkboxItems } from "./guide-checkbox.js";
import { renderGuide } from "./guide-render.js";
import { tick, type TickResult } from "./guide-tick.js";
import { locateInElement, type LocateMode } from "./locate.js";
import { OutlineError, type GuideDocument, type OutlineApi } from "./outline-api.js";
import { docId } from "./state.js";

/**
 * A box ignores taps for this long after it is saved. Safari on the iPhone has been seen to
 * deliver a second click to the freshly redrawn box just after a save, which would untick it.
 * A failed save holds nothing back: trying again at once is what the person wants there.
 */
export const SETTLE_MS = 1000;

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

/** A tap waiting its turn, with what it was made on so a moved item is never ticked. */
interface Tap {
  gen: number;
  index: number;
  checked: boolean;
  doc: GuideDocument;
  count: number;
  label: string | null;
}

/** Reading positions by page id, shared by every reader for the session. */
const positions = new Map<string, number>();

/** A heading hash the reader follows: what the renderer puts in `data-hash`. */
const HASH = /^[A-Za-z0-9_-]+$/;
/**
 * The heading a link on another page asked for, by page id, until a reader shows that page:
 * the page may open in this reader, in another slot's, or be on screen already.
 */
const wantedHashes = new Map<string, string>();
/** Each live reader's check for a wanted heading on the page it shows. */
const hashWatchers = new Set<() => void>();

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
  /** When each box was last saved (Date.now()), for SETTLE_MS. */
  const settledAt = new Map<number, number>();
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

  /** Scrolls to the element with id `hash` in the page, opening any toggle it is folded in. */
  function scrollToHash(hash: string): void {
    if (!HASH.test(hash)) return;
    const target = body.querySelector(`[id="${hash}"]`);
    if (target === null) return;
    for (let up = target.parentElement; up !== null && up !== body; up = up.parentElement) {
      if (up.tagName === "DETAILS") up.setAttribute("open", "");
    }
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  }

  /** Follows the heading a link asked for on the page shown, once. */
  function followWanted(): void {
    if (shown === null) return;
    const id = docId(current);
    const hash = wantedHashes.get(id);
    if (hash === undefined) return;
    wantedHashes.delete(id);
    scrollToHash(hash);
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
    settledAt.clear();
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
        followWanted();
      },
      (err: unknown) => {
        if (loadCtl !== ctl) return;
        loadCtl = null;
        wantedHashes.delete(id);
        const kind = err instanceof OutlineError ? err.kind : "other";
        if (kind === "signed-out") setStatus(SIGN_IN_READ, true);
        else if (kind === "not-found") setStatus(NOT_FOUND);
        // An answer that arrived but could not be read is the page, not the connection.
        else setStatus(err instanceof OutlineError && err.status === 200 ? CANT_SHOW : LOAD_FAILED);
      },
    );
  }

  /** Drops every queued tap and shows `fresh` with the conflict copy. */
  function conflict(fresh: GuideDocument): void {
    generation += 1;
    pending.clear();
    settledAt.clear();
    if (rerender(fresh)) setStatus(CONFLICT);
  }

  async function runTap(tapped: Tap): Promise<void> {
    const { gen, index, checked } = tapped;
    if (gen !== generation || shown === null) return;
    // An earlier save's read-back may carry another writer's edit: the same index may now be a
    // different item. Never patch it; refresh instead.
    if (
      shown !== tapped.doc &&
      (checkboxItems(shown.data).length !== tapped.count ||
        boxAt(index)?.getAttribute("aria-label") !== tapped.label)
    ) {
      const before = shown;
      let fresh = before;
      try {
        fresh = await deps.outline.document(before.id);
      } catch {
        // Show what was read last.
      }
      if (gen === generation) conflict(fresh);
      return;
    }
    let result: TickResult;
    try {
      result = await tick(deps.outline, shown, index, checked);
    } catch {
      // tick never throws by contract; if it does, the box must not stay busy.
      result = { kind: "failed", doc: null };
    }
    if (gen !== generation) {
      // The page was left or the reader disposed: nothing to redraw, but progress moved on.
      if (result.kind === "saved") deps.onSaved();
      return;
    }
    pending.delete(index);
    switch (result.kind) {
      case "saved":
        settledAt.set(index, Date.now());
        rerender(result.doc);
        deps.onSaved();
        return;
      case "conflict":
        conflict(result.doc);
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
    const raw = box.getAttribute("data-cb");
    if (shown === null || raw === null || !/^\d+$/.test(raw)) return;
    if (box.getAttribute("aria-busy") === "true") return;
    const index = Number(raw);
    const settled = settledAt.get(index);
    if (settled !== undefined && Date.now() - settled < SETTLE_MS) return;
    const checked = box.getAttribute("aria-checked") !== "true";
    setStatus("");
    mark(box, checked, true);
    pending.set(index, checked);
    const tapped: Tap = {
      gen: generation,
      index,
      checked,
      doc: shown,
      count: checkboxItems(shown.data).length,
      label: box.getAttribute("aria-label"),
    };
    chain = chain.then(() => runTap(tapped)).catch(() => undefined);
  }

  function onBodyClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const box = target.closest(".cb");
    if (box !== null && body.contains(box)) {
      tap(box);
      return;
    }
    const link = target.closest("a[data-doc], a[data-hash]");
    if (link === null || !body.contains(link)) return;
    const path = link.getAttribute("data-doc");
    const raw = link.getAttribute("data-hash");
    const hash = raw !== null && HASH.test(raw) ? raw : null;
    // A bare #hash, or a hash on the page shown: scroll here.
    if (path === null || (hash !== null && docId(path) === docId(current))) {
      event.preventDefault();
      if (hash !== null) scrollToHash(hash);
      return;
    }
    const id = docId(path);
    if (hash === null) wantedHashes.delete(id);
    else wantedHashes.set(id, hash);
    if (deps.openPage(path)) {
      event.preventDefault();
      // The page may be on screen already, in this reader or another.
      for (const watch of hashWatchers) watch();
    } else {
      wantedHashes.delete(id);
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
  hashWatchers.add(followWanted);
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
      hashWatchers.delete(followWanted);
    },
  };
}
