/** How long a pointer must stay down for a long press. */
export const LONG_PRESS_MS = 500;
/** How far (CSS px) the pointer may wander during a long press before it is a scroll or drag. */
export const LONG_PRESS_SLOP = 10;

/**
 * Calls `onLongPress` once, on the timer, when a pointer is held on `element` for
 * LONG_PRESS_MS without moving more than LONG_PRESS_SLOP px; whether it is then let go or still
 * held does not matter. The click a browser sends on release after a long press is swallowed, so
 * the element's own click handler sees only taps. A release, a cancel (the page started
 * scrolling) or a larger move before the timer ends the press as an ordinary tap or nothing.
 * Only the main mouse button counts. The caller keeps the context menu and the touch callout
 * away (see rail.ts and the `.rail button` style).
 */
export function addLongPress(element: HTMLElement, onLongPress: () => void): void {
  let press: {
    pointerId: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  // Set by a long press until the click that follows it; a later press or a key clears it, since
  // a touch that ends in a cancel sends no click at all.
  let swallow = false;

  const cancel = (): void => {
    if (press === null) return;
    clearTimeout(press.timer);
    press = null;
  };

  element.addEventListener("pointerdown", (event) => {
    cancel();
    swallow = false;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press = null;
        swallow = true;
        onLongPress();
      }, LONG_PRESS_MS),
    };
  });
  element.addEventListener("pointermove", (event) => {
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancel();
  });
  for (const type of ["pointerup", "pointercancel"]) {
    element.addEventListener(type, (event) => {
      if (press !== null && (event as PointerEvent).pointerId === press.pointerId) cancel();
    });
  }
  element.addEventListener("keydown", () => {
    swallow = false;
  });
  // Capturing, so it runs before the element's own click listener.
  element.addEventListener(
    "click",
    (event) => {
      if (!swallow) return;
      swallow = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}
