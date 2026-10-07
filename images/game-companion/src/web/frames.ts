import { applyChrome } from "./chrome.js";
import { locateInFrame, type LocateMode } from "./locate.js";
import { isSafeDocUrl } from "./state.js";

export interface Frames {
  element: HTMLElement;
  show(index: number, url: string): void;
  hideAll(): void;
  /**
   * Re-keys the kept iframes so slot i holds the frame showing urls[i]; frames for URLs not
   * listed are removed. Never reloads a frame and never creates one.
   */
  sync(urls: (string | null)[]): void;
  reset(): void;
  /** Hides (or restores) the wiki's sidebar and top bar in every frame, now and as they load. */
  setHideChrome(hide: boolean): void;
  /**
   * Finds `text` (preferably under `heading`) in the page framed in slot `index` and highlights it.
   * In "heading" mode it looks for the section heading carrying `text` instead (see findTextRange).
   * Waits for a navigation this module started to finish first. "gone" when the slot has no frame or
   * its frame was dropped meanwhile.
   */
  locate(
    index: number,
    text: string,
    heading?: string | null,
    mode?: LocateMode,
  ): Promise<LocateResult>;
}

export type LocateResult = "found" | "not-found" | "gone";

interface Entry {
  frame: HTMLIFrameElement;
  url: string;
  /** True from the moment this module starts a navigation until that frame's load event. */
  loading: boolean;
  /** Counts the navigations this module has started in the frame (creating it counts as one). */
  generation: number;
  /** The search now running in this frame; starting another ends it. */
  live: AbortController | null;
}

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
  } = {},
): Frames {
  const element = doc.createElement("div");
  element.classList.add("frames");
  const entries: (Entry | null)[] = Array.from({ length: slotCount }, () => null);

  let hideChrome = false;
  const applyTo = (entry: Entry): void => {
    try {
      const framed = entry.frame.contentDocument;
      if (framed !== null) applyChrome(framed, hideChrome);
    } catch {
      // The frame is on another origin.
    }
  };
  // Documents already listened to, so a repeated load event does not stack listeners.
  const listened = new WeakSet<Document>();
  const watchClicks = (entry: Entry): void => {
    const onInteract = options.onInteract;
    if (onInteract === undefined) return;
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
  // The wiki redraws its bars when the reader follows a link inside the frame. Only the frame on
  // screen is swept, and not while the companion itself is in the background.
  (options.setInterval ?? setInterval)(() => {
    if (!hideChrome || doc.visibilityState === "hidden") return;
    for (const entry of entries) {
      if (entry !== null && !entry.frame.classList.contains("inactive")) applyTo(entry);
    }
  }, 1500);

  const hideAll = (): void => {
    for (const entry of entries) entry?.frame.classList.add("inactive");
  };

  return {
    element,
    show(index, url) {
      if (!Number.isInteger(index) || index < 0 || index >= slotCount) return;
      if (!isSafeDocUrl(url)) return;
      hideAll();
      let entry = entries[index] ?? null;
      if (entry === null) {
        const frame = doc.createElement("iframe");
        frame.classList.add("frame");
        frame.setAttribute("title", "Guide page");
        const created: Entry = { frame, url, loading: true, generation: 1, live: null };
        frame.addEventListener("load", () => {
          created.loading = false;
          if (hideChrome) applyTo(created);
          watchClicks(created);
        });
        frame.setAttribute("src", url);
        element.append(frame);
        entry = created;
        entries[index] = entry;
      } else if (entry.url !== url) {
        entry.loading = true;
        entry.generation += 1;
        // A search on the page being left would only ever look at the page that replaces it.
        entry.live?.abort();
        entry.frame.setAttribute("src", url);
        entry.url = url;
      }
      entry.frame.classList.remove("inactive");
      // A frame that is still navigating is applied by its load handler.
      if (hideChrome && !entry.loading) applyTo(entry);
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
      for (const e of old) if (!used.has(e)) e.frame.remove();
    },
    reset() {
      element.replaceChildren();
      entries.fill(null);
    },
    setHideChrome(hide) {
      hideChrome = hide;
      for (const entry of entries) if (entry !== null) applyTo(entry);
    },
    async locate(index, text, heading, mode = "text") {
      const entry = Number.isInteger(index) ? (entries[index] ?? null) : null;
      if (entry === null) return "gone";
      entry.live?.abort();
      const mine = new AbortController();
      entry.live = mine;
      const generation = entry.generation;
      const dropped = (): boolean => !entries.includes(entry) || entry.generation !== generation;
      const found = await locateInFrame(entry.frame, text, heading, {
        ready: () => !entry.loading,
        gone: dropped,
        signal: mine.signal,
        mode,
      });
      if (entry.live === mine) entry.live = null;
      if (found) return "found";
      return mine.signal.aborted || dropped() ? "gone" : "not-found";
    },
  };
}
