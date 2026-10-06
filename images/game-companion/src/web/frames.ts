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
}

interface Entry {
  frame: HTMLIFrameElement;
  url: string;
}

/**
 * One keep-alive iframe per slot. A frame that is not showing stays in the layout and is only
 * made invisible by class: removing it from rendering (hidden, display: none) makes some
 * browsers reset its scroll position.
 */
export function createFrames(doc: Document, slotCount: number): Frames {
  const element = doc.createElement("div");
  element.classList.add("frames");
  const entries: (Entry | null)[] = Array.from({ length: slotCount }, () => null);

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
        frame.setAttribute("src", url);
        element.append(frame);
        entry = { frame, url };
        entries[index] = entry;
      } else if (entry.url !== url) {
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
  };
}
