/** How long a pointer must stay down for a long press. */
export const LONG_PRESS_MS = 500;
/** How far (CSS px) the pointer may wander during a long press before it is a scroll or drag. */
export const LONG_PRESS_SLOP = 10;
/** A click this soon after letting go of a long press is the browser's own, and is swallowed. */
export const LONG_PRESS_CLICK_MS = 1000;

export interface LongPress {
  /** Off, the element sees plain clicks only and a press under way is dropped. On by default. */
  setEnabled(on: boolean): void;
}

/**
 * Calls `onLongPress` once, on the timer, when a pointer is held on `element` for
 * LONG_PRESS_MS without moving more than LONG_PRESS_SLOP px; whether it is then let go or still
 * held does not matter. The click a browser sends on letting go after a long press (within
 * LONG_PRESS_CLICK_MS) is swallowed, so the element's own click handler sees only taps. A
 * release, a cancel (the page started scrolling), leaving the element (a mouse moved off it) or
 * a larger move before the timer ends the press as an ordinary tap or nothing. Only the main
 * mouse button counts. The caller keeps the context menu and the touch callout away (see rail.ts
 * and the `.rail button` style).
 */
export function addLongPress(
  element: HTMLElement,
  onLongPress: () => void,
  now: () => number = () => Date.now(),
): LongPress {
  let enabled = true;
  let press: {
    pointerId: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  // The pointer of a long press that fired and is still down, then when it was let go.
  let held: number | null = null;
  let releasedAt: number | null = null;

  const cancel = (): void => {
    if (press === null) return;
    clearTimeout(press.timer);
    press = null;
  };

  element.addEventListener("pointerdown", (event) => {
    cancel();
    held = null;
    releasedAt = null;
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    const pointerId = event.pointerId;
    press = {
      pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press = null;
        held = pointerId;
        onLongPress();
      }, LONG_PRESS_MS),
    };
  });
  element.addEventListener("pointermove", (event) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancel();
  });
  // A mouse moved off the element sends it no more moves, so leaving it ends the press.
  for (const type of ["pointercancel", "pointerleave"]) {
    element.addEventListener(type, (event) => {
      const { pointerId } = event as PointerEvent;
      if (press !== null && pointerId === press.pointerId) cancel();
      if (type === "pointercancel" && held === pointerId) held = null;
    });
  }
  element.addEventListener("pointerup", (event) => {
    if (press !== null && event.pointerId === press.pointerId) cancel();
    if (held === event.pointerId) {
      held = null;
      releasedAt = now();
    }
  });
  // Capturing, so it runs before the element's own click listener.
  element.addEventListener(
    "click",
    (event) => {
      if (releasedAt === null) return;
      const soon = now() - releasedAt <= LONG_PRESS_CLICK_MS;
      releasedAt = null;
      if (!soon) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );

  return {
    setEnabled(on) {
      enabled = on;
      if (on) return;
      cancel();
      held = null;
      releasedAt = null;
    },
  };
}
