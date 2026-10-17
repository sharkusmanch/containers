import { DEFAULT_SPLIT_FRACTION, clampSplitFraction } from "./layout-mode.js";

/** What the right pane shows; 🏆 and 💬 choose. */
export type RightPane = "achievements" | "ask";

/** The two panes: the slot framed on the left and the panel on the right. */
export interface Panes {
  left: number;
  right: RightPane;
}

/** Two releases on the divider at most this far apart are a double tap. */
export const DOUBLE_TAP_MS = 350;

/**
 * What the two panes show. The left pane frames the active slot; when 🏆 or 💬 is the active
 * choice, the slot shown last, else the first usable one. `usable[i]` tells whether slot i holds
 * an address the frames can show. Null when no slot is usable: the page then works as one pane.
 */
export function choosePanes(state: {
  active: number;
  usable: readonly boolean[];
  lastSlot: number | null;
  askOpen: boolean;
}): Panes | null {
  const { active, usable, lastSlot, askOpen } = state;
  const ok = (index: number | null): index is number => index !== null && usable[index] === true;
  const left = ok(active) ? active : ok(lastSlot) ? lastSlot : usable.indexOf(true);
  if (left < 0) return null;
  return { left, right: askOpen ? "ask" : "achievements" };
}

/** The left pane's share of an area `width` wide starting at `left`, for a pointer at `x`. */
export function fractionAt(x: number, left: number, width: number): number | null {
  if (!(width > 0)) return null;
  return clampSplitFraction((x - left) / width);
}

export function isDoubleTap(previousRelease: number | null, now: number): boolean {
  return previousRelease !== null && now - previousRelease <= DOUBLE_TAP_MS;
}

export interface Divider {
  element: HTMLElement;
}

/**
 * The bar between the panes. Dragging it reports each new fraction to `onMove` and, when let go
 * after moving, to `onCommit`; a double tap resets it to the default and reports that to both.
 */
export function createDivider(
  doc: Document,
  options: {
    /** Where it starts. */
    fraction: number;
    /** The area the fraction is a share of, in client pixels. */
    measure(): { left: number; width: number };
    onMove(fraction: number): void;
    onCommit(fraction: number): void;
    now?: () => number;
  },
): Divider {
  const now = options.now ?? Date.now;
  const element = doc.createElement("div");
  element.classList.add("split-divider");
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", "vertical");
  element.setAttribute("aria-label", "Pane divider");

  let fraction = clampSplitFraction(options.fraction);
  let drag: { pointerId: number; moved: boolean } | null = null;
  let lastRelease: number | null = null;

  const end = (event: PointerEvent): { moved: boolean } | null => {
    if (drag === null || event.pointerId !== drag.pointerId) return null;
    const ended = drag;
    drag = null;
    if (typeof element.releasePointerCapture === "function") {
      element.releasePointerCapture(event.pointerId);
    }
    return ended;
  };

  element.addEventListener("pointerdown", (event) => {
    drag = { pointerId: event.pointerId, moved: false };
    // Keeps the moves coming here even when the pointer passes over a framed page.
    if (typeof element.setPointerCapture === "function") {
      element.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  });
  element.addEventListener("pointermove", (event) => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const area = options.measure();
    const next = fractionAt(event.clientX, area.left, area.width);
    if (next === null || next === fraction) return;
    fraction = next;
    drag.moved = true;
    options.onMove(fraction);
  });
  element.addEventListener("pointerup", (event) => {
    const ended = end(event);
    if (ended === null) return;
    const at = now();
    if (isDoubleTap(lastRelease, at)) {
      lastRelease = null;
      fraction = DEFAULT_SPLIT_FRACTION;
      options.onMove(fraction);
      options.onCommit(fraction);
      return;
    }
    lastRelease = at;
    if (ended.moved) options.onCommit(fraction);
  });
  element.addEventListener("pointercancel", (event) => {
    const ended = end(event);
    if (ended?.moved === true) options.onCommit(fraction);
  });

  return { element };
}
