import { applyChrome } from "./chrome.js";
import { locateInFrame } from "./locate.js";
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
   * Waits for a navigation this module started to finish first. "gone" when the slot has no frame or
   * its frame was dropped meanwhile.
   */
  locate(index: number, text: string, heading?: string | null): Promise<LocateResult>;
}

export type LocateResult = "found" | "not-found" | "gone";

interface Entry {
  frame: HTMLIFrameElement;
  url: string;
  /** True from the moment this module starts a navigation until that frame's load event. */
  loading: boolean;
}

/**
 * One keep-alive iframe per slot. A frame that is not showing stays in the layout and is only
 * made invisible by class: removing it from rendering (hidden, display: none) makes some
 * browsers reset its scroll position.
 */
export function createFrames(
  doc: Document,
  slotCount: number,
  options: { setInterval?: typeof setInterval } = {},
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
  // The wiki redraws its bars when the reader follows a link inside the frame.
  (options.setInterval ?? setInterval)(() => {
    if (!hideChrome) return;
    for (const entry of entries) if (entry !== null) applyTo(entry);
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
        const created: Entry = { frame, url, loading: true };
        frame.addEventListener("load", () => {
          created.loading = false;
          if (hideChrome) applyTo(created);
        });
        frame.setAttribute("src", url);
        element.append(frame);
        entry = created;
        entries[index] = entry;
      } else if (entry.url !== url) {
        entry.loading = true;
        entry.frame.setAttribute("src", url);
        entry.url = url;
      }
      entry.frame.classList.remove("inactive");
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
    async locate(index, text, heading) {
      const entry = Number.isInteger(index) ? (entries[index] ?? null) : null;
      if (entry === null) return "gone";
      const dropped = (): boolean => !entries.includes(entry);
      const found = await locateInFrame(entry.frame, text, heading, {
        ready: () => !entry.loading,
        gone: dropped,
      });
      if (found) return "found";
      return dropped() ? "gone" : "not-found";
    },
  };
}
