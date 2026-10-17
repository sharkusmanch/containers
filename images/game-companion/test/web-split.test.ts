// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ACHIEVEMENTS } from "../src/web/state.js";
import {
  DOUBLE_TAP_MS,
  choosePanes,
  createDivider,
  fractionAt,
  isDoubleTap,
} from "../src/web/split.js";

describe("choosePanes", () => {
  const usable = [true, true, false, false];

  it.each([
    // [active, lastSlot, askOpen] -> left, right
    [1, null, false, { left: 1, right: "achievements" }],
    [1, 0, true, { left: 1, right: "ask" }],
    [ACHIEVEMENTS, 1, false, { left: 1, right: "achievements" }],
    [ACHIEVEMENTS, 0, true, { left: 0, right: "ask" }],
    [ACHIEVEMENTS, null, false, { left: 0, right: "achievements" }],
    [ACHIEVEMENTS, 2, false, { left: 0, right: "achievements" }],
    [2, 1, false, { left: 1, right: "achievements" }],
  ] as const)(
    "active %i, last shown %s, Ask open %s gives %o",
    (active, lastSlot, askOpen, expected) => {
      expect(choosePanes({ active, usable, lastSlot, askOpen })).toEqual(expected);
    },
  );

  it("takes the first usable slot when none was shown yet", () => {
    expect(
      choosePanes({
        active: ACHIEVEMENTS,
        usable: [false, false, true, true],
        lastSlot: null,
        askOpen: false,
      }),
    ).toEqual({ left: 2, right: "achievements" });
  });

  it("gives nothing (a single page) when no slot is usable", () => {
    expect(
      choosePanes({
        active: ACHIEVEMENTS,
        usable: [false, false, false, false],
        lastSlot: 1,
        askOpen: true,
      }),
    ).toBeNull();
  });
});

describe("fractionAt", () => {
  it("is the share of the width left of the pointer", () => {
    expect(fractionAt(500, 100, 800)).toBe(0.5);
  });

  it("clamps to 0.3 and 0.7", () => {
    expect(fractionAt(100, 100, 800)).toBe(0.3);
    expect(fractionAt(1000, 100, 800)).toBe(0.7);
  });

  it("gives nothing for an area with no width", () => {
    expect(fractionAt(10, 0, 0)).toBeNull();
  });
});

describe("isDoubleTap", () => {
  it(`counts a second release within ${DOUBLE_TAP_MS} ms`, () => {
    expect(isDoubleTap(1000, 1000 + DOUBLE_TAP_MS)).toBe(true);
    expect(isDoubleTap(1000, 1001 + DOUBLE_TAP_MS)).toBe(false);
    expect(isDoubleTap(null, 1000)).toBe(false);
  });
});

describe("createDivider", () => {
  const setup = (fraction = 0.55) => {
    let clock = 10_000;
    const onMove = vi.fn();
    const onCommit = vi.fn();
    const divider = createDivider(document, {
      fraction,
      measure: () => ({ left: 100, width: 800 }),
      onMove,
      onCommit,
      now: () => clock,
    });
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(divider.element, {
      setPointerCapture: capture,
      releasePointerCapture: release,
    });
    const fire = (type: string, clientX = 0, pointerId = 1, extra: PointerEventInit = {}): void => {
      divider.element.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId, ...extra }),
      );
    };
    const advance = (ms: number): void => {
      clock += ms;
    };
    return { divider, onMove, onCommit, capture, release, fire, advance };
  };

  it("is a vertical separator", () => {
    const { divider } = setup();
    expect(divider.element.classList.contains("split-divider")).toBe(true);
    expect(divider.element.getAttribute("role")).toBe("separator");
    expect(divider.element.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("follows a drag, clamped, and saves where it is let go", () => {
    const { onMove, onCommit, capture, release, fire } = setup();
    fire("pointerdown", 540);
    expect(capture).toHaveBeenCalledWith(1);
    fire("pointermove", 420);
    fire("pointermove", 1000);
    expect(onMove.mock.calls).toEqual([[0.4], [0.7]]);
    expect(onCommit).not.toHaveBeenCalled();
    fire("pointerup", 1000);
    expect(release).toHaveBeenCalledWith(1);
    expect(onCommit.mock.calls).toEqual([[0.7]]);
  });

  it("ignores moves without a press, and moves of another pointer", () => {
    const { onMove, fire } = setup();
    fire("pointermove", 420);
    fire("pointerdown", 540, 1);
    fire("pointermove", 420, 2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("saves nothing for a tap that does not move it", () => {
    const { onCommit, fire } = setup();
    fire("pointerdown", 540);
    fire("pointerup", 540);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it(`resets to 0.55 on a second release within ${DOUBLE_TAP_MS} ms`, () => {
    const { onMove, onCommit, fire, advance } = setup(0.4);
    fire("pointerdown", 420);
    fire("pointerup", 420);
    advance(DOUBLE_TAP_MS);
    fire("pointerdown", 420);
    fire("pointerup", 420);
    expect(onMove.mock.calls).toEqual([[0.55]]);
    expect(onCommit.mock.calls).toEqual([[0.55]]);
  });

  it("does not reset on two releases further apart", () => {
    const { onCommit, fire, advance } = setup(0.4);
    fire("pointerdown", 420);
    fire("pointerup", 420);
    advance(DOUBLE_TAP_MS + 1);
    fire("pointerdown", 420);
    fire("pointerup", 420);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not count a third release as another double tap", () => {
    const { onCommit, fire, advance } = setup(0.4);
    for (let i = 0; i < 3; i += 1) {
      fire("pointerdown", 420);
      fire("pointerup", 420);
      advance(100);
    }
    expect(onCommit.mock.calls).toEqual([[0.55]]);
  });

  it("ends a drag on cancel, keeping where it got to", () => {
    const { onCommit, fire } = setup();
    fire("pointerdown", 540);
    fire("pointermove", 420);
    fire("pointercancel", 420);
    expect(onCommit.mock.calls).toEqual([[0.4]]);
    fire("pointermove", 900);
    expect(onCommit.mock.calls).toEqual([[0.4]]);
  });

  it("ends a drag when the pointer capture is lost, as it does on cancel", () => {
    const { onCommit, fire } = setup();
    fire("pointerdown", 540);
    fire("pointermove", 420);
    fire("lostpointercapture", 420);
    expect(onCommit.mock.calls).toEqual([[0.4]]);
    fire("pointermove", 900);
    expect(onCommit.mock.calls).toEqual([[0.4]]);
  });

  it("saves nothing when capture is lost on a drag that never moved", () => {
    const { onCommit, fire } = setup();
    fire("pointerdown", 540);
    fire("lostpointercapture", 540);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not take the capture released by its own pointerup as a second ending", () => {
    const { onCommit, fire } = setup();
    fire("pointerdown", 540);
    fire("pointermove", 420);
    fire("pointerup", 420);
    fire("lostpointercapture", 420);
    expect(onCommit.mock.calls).toEqual([[0.4]]);
  });

  it("ignores a mouse move with no button held, and follows one with the button down", () => {
    const { onMove, fire } = setup();
    fire("pointerdown", 540, 1, { pointerType: "mouse", buttons: 1 });
    fire("pointermove", 420, 1, { pointerType: "mouse", buttons: 0 });
    expect(onMove).not.toHaveBeenCalled();
    fire("pointermove", 420, 1, { pointerType: "mouse", buttons: 1 });
    expect(onMove.mock.calls).toEqual([[0.4]]);
  });

  it("still follows a touch or pen move that reports no buttons", () => {
    const { onMove, fire } = setup();
    fire("pointerdown", 540, 1, { pointerType: "touch", buttons: 0 });
    fire("pointermove", 420, 1, { pointerType: "touch", buttons: 0 });
    expect(onMove.mock.calls).toEqual([[0.4]]);
  });
});
