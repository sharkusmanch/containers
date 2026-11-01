import { applyChrome, applyReader } from "./chrome.js";
import type { GuideZoom } from "./device.js";
import { locateInFrame, type LocateMode } from "./locate.js";
import type { Reader } from "./reader.js";
import { isSafeDocUrl, isSafeLinkUrl } from "./state.js";

export interface Frames {
  element: HTMLElement;
  /**
   * Shows `url` in slot `index`. A "doc" is a wiki page (`isSafeDocUrl`); a "link" is an address the
   * person added (`isSafeLinkUrl`) and is framed sandboxed. A "reader" is a wiki page the companion
   * renders itself (a "doc" without the `reader` option). A slot that changes kind gets a new element.
   */
  show(index: number, url: string, kind?: FrameKind): void;
  hideAll(): void;
  /**
   * Re-keys the kept iframes and readers so slot i holds the one showing urls[i]; those for URLs not
   * listed are removed (a reader is disposed). Never reloads one and never creates one.
   */
  sync(urls: (string | null)[]): void;
  reset(): void;
  /**
   * Asks every kept reader, the hidden slots' too, to read its page again in the background (see
   * Reader.refresh). A hidden reader is refreshed now rather than when next shown, so it is
   * current the moment its tab is chosen; there are only a few slots.
   */
  refreshReaders(): void;
  /** Hides (or restores) the wiki's sidebar and top bar in every frame, now and as they load. */
  setHideChrome(hide: boolean): void;
  /**
   * Draws the framed pages smaller by a class on the container, for the stylesheet to enlarge and
   * scale the iframe elements. Touches no frame and writes nothing into a framed document.
   */
  setZoom(zoom: GuideZoom): void;
  /**
   * Reader mode: while `on`, the editable elements of every wiki-page frame whose address
   * `isEditable` does not accept get no on-screen keyboard (see applyReader). Otherwise it is taken
   * off that frame. Applied now, on each frame's load, when a frame becomes active and on the sweep.
   * Never touches a link frame.
   */
  setReader(on: boolean, isEditable: (url: string) => boolean): void;
  /**
   * Finds `text` (preferably under `heading`) in the page framed in slot `index` and highlights it.
   * In "heading" mode it looks for the section heading carrying `text` instead (see findTextRange);
   * `fallback` is then tried once, at the deadline, if the heading text has drifted.
   * Waits for a navigation this module started to finish first. A reader slot asks its reader.
   * "gone" when the slot has no frame or its frame (or reader page) was dropped meanwhile.
   */
  locate(
    index: number,
    text: string,
    heading?: string | null,
    mode?: LocateMode,
    fallback?: string,
  ): Promise<LocateResult>;
}

export type FrameKind = "doc" | "link" | "reader";

export type LocateResult = "found" | "not-found" | "gone";

interface Entry {
  /** What is in the container: the iframe, or the reader's element. Carries `.inactive`. */
  node: HTMLElement;
  frame: HTMLIFrameElement | null;
  reader: Reader | null;
  url: string;
  /** A link frame shows another origin's page: nothing here ever reaches into its document. */
  kind: FrameKind;
  /** True from the moment this module starts a navigation until that frame's load event (never for a reader). */
  loading: boolean;
  /** Counts the navigations this module has started in the frame (creating it counts as one). */
  generation: number;
  /** The search now running in this frame; starting another ends it. */
  live: AbortController | null;
}

/** What a link frame may do: everything a page needs except navigating the companion's own window. */
const LINK_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** The part of a wiki path that names a document; a suffix such as /edit does not count. */
const DOC_PATH = /^\/doc\/[A-Za-z0-9_-]+/;

/** The container class for each size below 100; none at 100. */
const ZOOM_CLASS: Record<GuideZoom, string | null> = {
  100: null,
  90: "zoom-90",
  80: "zoom-80",
  70: "zoom-70",
};

/**
 * One keep-alive iframe per slot. A frame that is not showing stays in the layout and is only
 * made invisible by class: removing it from rendering (hidden, display: none) makes some
 * browsers reset its scroll position.
 */
export function createFrames(
  doc: Document,
  slotCount: number,
  options: {
    setInterval?: typeof setInterval;
    /** Called with the slot index when the reader clicks inside a framed page. Never throws into the page. */
    onInteract?: (index: number) => void;
    /** Makes the reader for a "reader" slot; without it a "reader" slot is framed as a "doc". */
    reader?: (url: string) => Reader;
  } = {},
): Frames {
  const element = doc.createElement("div");
  element.classList.add("frames");
  const entries: (Entry | null)[] = Array.from({ length: slotCount }, () => null);

  // The wiki navigates inside a frame without a load event, so the page shown is read from the
  // frame's own window; the slot's address is the fallback.
  const shownPath = (entry: Entry): string => {
    try {
      const path = entry.frame?.contentWindow?.location.pathname;
      return (typeof path === "string" ? DOC_PATH.exec(path)?.[0] : undefined) ?? entry.url;
    } catch {
      return entry.url;
    }
  };

  let hideChrome = false;
  let reader = false;
  let isEditable: (url: string) => boolean = () => false;
  const applyTo = (entry: Entry): void => {
    if (entry.kind !== "doc" || entry.frame === null) return;
    try {
      const framed = entry.frame.contentDocument;
      if (framed === null) return;
      applyChrome(framed, hideChrome);
      applyReader(framed, reader && !isEditable(shownPath(entry)));
    } catch {
      // The frame is on another origin.
    }
  };
  // Documents already listened to, so a repeated load event does not stack listeners.
  const listened = new WeakSet<Document>();
  const watchClicks = (entry: Entry): void => {
    const onInteract = options.onInteract;
    if (onInteract === undefined || entry.kind !== "doc" || entry.frame === null) return;
    try {
      const framed = entry.frame.contentDocument;
      if (framed === null || listened.has(framed)) return;
      listened.add(framed);
      // Capturing and passive: the page cannot hide a click from it, and it never holds one up.
      framed.addEventListener(
        "click",
        () => {
          try {
            const index = entries.indexOf(entry);
            if (index >= 0) onInteract(index);
          } catch {
            // A failing handler must not reach the page.
          }
        },
        { capture: true, passive: true },
      );
    } catch {
      // The frame is on another origin.
    }
  };
  // The wiki redraws its bars, and rebuilds its editor, when the reader follows a link inside the
  // frame. Only the frame on screen is swept, and not while the companion itself is in the
  // background.
  (options.setInterval ?? setInterval)(() => {
    if (!(hideChrome || reader) || doc.visibilityState === "hidden") return;
    for (const entry of entries) {
      if (entry !== null && !entry.node.classList.contains("inactive")) applyTo(entry);
    }
  }, 1500);

  const hideAll = (): void => {
    for (const entry of entries) entry?.node.classList.add("inactive");
  };

  /** Takes an entry out of the container for good: its search stops and its reader is disposed. */
  const drop = (entry: Entry): void => {
    entry.live?.abort();
    entry.reader?.dispose();
    entry.node.remove();
  };

  return {
    element,
    show(index, url, wanted = "doc") {
      if (!Number.isInteger(index) || index < 0 || index >= slotCount) return;
      const makeReader = options.reader;
      const kind: FrameKind = wanted === "reader" && makeReader === undefined ? "doc" : wanted;
      if (!(kind === "link" ? isSafeLinkUrl(url) : isSafeDocUrl(url))) return;
      hideAll();
      let entry = entries[index] ?? null;
      // A sandbox only counts at the next navigation, so a frame never changes kind: it is replaced.
      if (entry !== null && entry.kind !== kind) {
        drop(entry);
        entries[index] = null;
        entry = null;
      }
      if (entry === null && kind === "reader" && makeReader !== undefined) {
        const made = makeReader(url);
        entry = {
          node: made.element,
          frame: null,
          reader: made,
          url,
          kind,
          loading: false,
          generation: 1,
          live: null,
        };
        element.append(made.element);
        entries[index] = entry;
      } else if (entry === null) {
        const frame = doc.createElement("iframe");
        frame.classList.add("frame");
        if (kind === "link") {
          frame.setAttribute("sandbox", LINK_SANDBOX);
          frame.setAttribute("referrerpolicy", "no-referrer");
          frame.setAttribute("title", "Link");
        } else {
          frame.setAttribute("title", "Guide page");
        }
        const created: Entry = {
          node: frame,
          frame,
          reader: null,
          url,
          kind,
          loading: true,
          generation: 1,
          live: null,
        };
        frame.addEventListener("load", () => {
          created.loading = false;
          if (hideChrome || reader) applyTo(created);
          watchClicks(created);
        });
        frame.setAttribute("src", url);
        element.append(frame);
        entry = created;
        entries[index] = entry;
      } else if (entry.url !== url) {
        entry.generation += 1;
        // A search on the page being left would only ever look at the page that replaces it.
        entry.live?.abort();
        if (entry.reader !== null) {
          entry.reader.load(url);
        } else if (entry.frame !== null) {
          entry.loading = true;
          entry.frame.setAttribute("src", url);
        }
        entry.url = url;
      }
      entry.node.classList.remove("inactive");
      // A frame that is still navigating is applied by its load handler.
      if ((hideChrome || reader) && !entry.loading) applyTo(entry);
    },
    hideAll,
    sync(urls) {
      const old = entries.filter((e): e is Entry => e !== null);
      const used = new Set<Entry>();
      for (let i = 0; i < slotCount; i++) {
        const url = urls[i];
        const kept = url == null ? undefined : old.find((e) => e.url === url && !used.has(e));
        entries[i] = kept ?? null;
        if (kept !== undefined) used.add(kept);
      }
      for (const e of old) if (!used.has(e)) drop(e);
    },
    refreshReaders() {
      for (const entry of entries) entry?.reader?.refresh();
    },
    reset() {
      for (const entry of entries) if (entry !== null) drop(entry);
      element.replaceChildren();
      entries.fill(null);
    },
    setHideChrome(hide) {
      hideChrome = hide;
      for (const entry of entries) if (entry !== null) applyTo(entry);
    },
    setReader(on, editable) {
      reader = on;
      isEditable = editable;
      for (const entry of entries) if (entry !== null) applyTo(entry);
    },
    setZoom(zoom) {
      const wanted = ZOOM_CLASS[zoom];
      for (const name of Object.values(ZOOM_CLASS)) {
        if (name !== null && name !== wanted && element.classList.contains(name)) {
          element.classList.remove(name);
        }
      }
      if (wanted !== null && !element.classList.contains(wanted)) element.classList.add(wanted);
    },
    async locate(index, text, heading, mode = "text", fallback) {
      const entry = Number.isInteger(index) ? (entries[index] ?? null) : null;
      if (entry === null || entry.kind === "link") return "gone";
      const generation = entry.generation;
      const dropped = (): boolean => !entries.includes(entry) || entry.generation !== generation;
      if (entry.reader !== null) {
        const found = await (fallback === undefined
          ? entry.reader.locate(text, heading ?? null, mode)
          : entry.reader.locate(text, heading ?? null, mode, fallback));
        if (dropped()) return "gone";
        return found ? "found" : "not-found";
      }
      if (entry.frame === null) return "gone";
      entry.live?.abort();
      const mine = new AbortController();
      entry.live = mine;
      const found = await locateInFrame(entry.frame, text, heading, {
        ready: () => !entry.loading,
        gone: dropped,
        signal: mine.signal,
        mode,
        ...(fallback === undefined ? {} : { fallback }),
      });
      if (entry.live === mine) entry.live = null;
      if (found) return "found";
      return mine.signal.aborted || dropped() ? "gone" : "not-found";
    },
  };
}
