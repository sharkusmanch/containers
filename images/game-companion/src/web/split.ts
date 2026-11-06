import { DEFAULT_SPLIT_FRACTION, clampSplitFraction } from "./layout-mode.js";

/**
 * What the right pane shows: the achievements (🏆), the Ask panel (💬), or the page of a slot
 * (a long press on its rail button).
 */
export type RightPane = "achievements" | "ask" | { slot: number };

/**
 * The two panes: the slot framed on the left and what the right shows. `left` is null only when
 * the right shows a page and no other slot is usable: that page then fills the stage alone.
 */
export interface Panes {
  left: number | null;
  right: RightPane;
}

/** Two releases on the divider at most this far apart are a double tap. */
export const DOUBLE_TAP_MS = 350;

/**
 * What the two panes show. `usable[i]` tells whether slot i holds an address the frames can show.
 * The right pane shows Ask while it is open, else slot `right` when that is usable, else the
 * achievements. The left pane frames the active slot; when 🏆 or 💬 is the active choice, or the
 * active slot is the one chosen for the right (even while Ask covers it, so closing Ask moves
 * nothing), the slot shown last, else the first usable one, never the right's. Null when there is
 * nothing for the left and the right is not a page: the stage then works as one pane.
 */
export function choosePanes(state: {
  active: number;
  usable: readonly boolean[];
  lastSlot: number | null;
  askOpen: boolean;
  right?: number | null;
}): Panes | null {
  const { active, usable, lastSlot, askOpen } = state;
  const ok = (index: number | null | undefined): index is number =>
    index !== null && index !== undefined && usable[index] === true;
  const right = ok(state.right) ? state.right : null;
  const free = (index: number | null): index is number => ok(index) && index !== right;
  const left = free(active)
    ? active
    : free(lastSlot)
      ? lastSlot
      : usable.findIndex((_, index) => free(index));
  if (askOpen || right === null) {
    return left < 0 ? null : { left, right: askOpen ? "ask" : "achievements" };
  }
  return { left: left < 0 ? null : left, right: { slot: right } };
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
    // A mouse button let go outside the window sends no pointerup; moves without it are not a drag.
    if (event.pointerType === "mouse" && event.buttons === 0) return;
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
  // A lost capture (the page lost focus, the element was hidden) ends the drag like a cancel.
  for (const type of ["pointercancel", "lostpointercapture"]) {
    element.addEventListener(type, (event) => {
      const ended = end(event as PointerEvent);
      if (ended?.moved === true) options.onCommit(fraction);
    });
  }

  return { element };
}
