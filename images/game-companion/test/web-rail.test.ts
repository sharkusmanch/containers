// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRail } from "../src/web/rail.js";
import { ACHIEVEMENTS, type Layout } from "../src/web/state.js";

const handlers = () => ({ onSelect: vi.fn(), onMore: vi.fn(), onAsk: vi.fn() });

const layout: Layout = {
  slots: [
    { title: "Achievement Checklist", url: "/doc/c" },
    { title: "Blind Playthrough Essentials", url: "/doc/b" },
    null,
    null,
  ],
  active: 1,
};

describe("createRail", () => {
  it("renders the achievements button, one button per slot and the more button", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 12);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons).toHaveLength(7);
    expect(buttons[0]?.querySelector(".rail-count")?.textContent).toBe("12");
    expect(buttons.slice(1, 5).map((b) => b.textContent)).toEqual(["Checklist", "Blind", "", ""]);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
    expect(buttons[3]?.disabled).toBe(true);
    expect(buttons[6]?.getAttribute("aria-label")).toBe("Pages and games");
  });

  it("shows the labels it is given, and slotLabel for a slot without one", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, null, [], ["Chk", null, null, null]);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons.slice(1, 5).map((b) => b.textContent)).toEqual(["Chk", "Blind", "", ""]);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
  });

  it("marks only the active button", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, null);
    const active = [...rail.element.querySelectorAll("button")].map((b) =>
      b.classList.contains("active"),
    );
    expect(active).toEqual([false, false, true, false, false, false, false]);
    rail.render({ ...layout, active: ACHIEVEMENTS }, null);
    expect(rail.element.querySelectorAll("button")[0]?.classList.contains("active")).toBe(true);
  });

  it("omits the count when it is unknown", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, null);
    expect(rail.element.querySelector(".rail-count")?.textContent).toBe("");
  });

  it("reports selections and the more button", () => {
    const onSelect = vi.fn();
    const onMore = vi.fn();
    const rail = createRail(document, { onSelect, onMore, onAsk: vi.fn() });
    rail.render(layout, 3);
    const buttons = rail.element.querySelectorAll("button");
    buttons[0]?.click();
    buttons[2]?.click();
    buttons[6]?.click();
    expect(onSelect.mock.calls).toEqual([[ACHIEVEMENTS], [1]]);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("hides empty slots instead of leaving a gap", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons).toHaveLength(7);
    expect(buttons.map((b) => b.hidden)).toEqual([false, false, false, true, true, true, false]);
    rail.render({ slots: [null, null, null, null], active: ACHIEVEMENTS }, 3);
    expect([...rail.element.querySelectorAll("button")].map((b) => b.hidden)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    rail.render(layout, 3);
    expect([...rail.element.querySelectorAll("button")].map((b) => b.hidden)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("rail progress", () => {
  const slotButtons = (rail: { element: HTMLElement }): HTMLElement[] =>
    [...rail.element.querySelectorAll<HTMLElement>("button")].slice(1, 5);
  const count = (b: HTMLElement | undefined): string | null | undefined =>
    b?.querySelector(".rail-count")?.textContent;
  const label = (b: HTMLElement | undefined): string | null | undefined =>
    b?.querySelector(".rail-label")?.textContent;

  it("holds the abbreviation and the progress text in two spans", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3, [{ completed: 7, total: 12 }, null, null, null]);
    const [first, second] = slotButtons(rail);
    expect([...(first as HTMLElement).children].map((c) => c.className)).toEqual([
      "rail-label",
      "rail-count",
    ]);
    expect(label(first)).toBe("Checklist");
    expect(count(first)).toBe("7/12");
    expect(first?.textContent).toBe("Checklist7/12");
    expect(first?.getAttribute("aria-label")).toBe("Achievement Checklist, 7 of 12 done");
    expect(label(second)).toBe("Blind");
    expect(count(second)).toBe("");
    expect(second?.getAttribute("aria-label")).toBe("Blind Playthrough Essentials");
  });

  it("shows zero progress as 0/5", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, null, [{ completed: 0, total: 5 }, null, null, null]);
    expect(count(slotButtons(rail)[0])).toBe("0/5");
    expect(slotButtons(rail)[0]?.getAttribute("aria-label")).toBe(
      "Achievement Checklist, 0 of 5 done",
    );
  });

  it.each([
    [{ completed: 99, total: 100 }, "99/100"],
    [{ completed: 100, total: 100 }, "100%"],
    [{ completed: 123, total: 1040 }, "11%"],
    [{ completed: 1040, total: 1040 }, "100%"],
    [{ completed: 5, total: 10000 }, "0%"],
  ])("writes %j as %s", (progress, text) => {
    const rail = createRail(document, handlers());
    rail.render(layout, null, [progress, null, null, null]);
    expect(count(slotButtons(rail)[0])).toBe(text);
    expect(slotButtons(rail)[0]?.getAttribute("aria-label")).toBe(
      `Achievement Checklist, ${progress.completed} of ${progress.total} done`,
    );
  });

  it("clears the progress when a later render has none, and without the argument", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, null, [{ completed: 1, total: 2 }, null, null, null]);
    rail.render(layout, null, [null, null, null, null]);
    expect(count(slotButtons(rail)[0])).toBe("");
    expect(slotButtons(rail)[0]?.getAttribute("aria-label")).toBe("Achievement Checklist");
    rail.render(layout, null, [{ completed: 1, total: 2 }, null, null, null]);
    rail.render(layout, null);
    expect(count(slotButtons(rail)[0])).toBe("");
  });

  it("leaves hidden slots, the achievements button and the more button alone", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 12, [
      { completed: 1, total: 2 },
      { completed: 3, total: 4 },
      { completed: 9, total: 9 },
      null,
    ]);
    const buttons = [...rail.element.querySelectorAll<HTMLElement>("button")];
    expect(buttons.map((b) => b.hidden)).toEqual([false, false, false, true, true, true, false]);
    expect(count(buttons[3])).toBe("");
    expect(buttons[3]?.getAttribute("aria-label")).toBe("Empty slot");
    expect(buttons[0]?.querySelector(".rail-count")?.textContent).toBe("12");
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Achievements");
    expect(buttons[6]?.textContent).toBe("⋯");
    expect(buttons[6]?.getAttribute("aria-label")).toBe("Pages and games");
  });
});

describe("rail pulse", () => {
  afterEach(() => vi.useRealTimers());

  it("marks only the achievements button, then clears it after the given time", () => {
    vi.useFakeTimers();
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    const buttons = [...rail.element.querySelectorAll("button")];
    rail.pulse(500);
    expect(buttons.map((b) => b.classList.contains("pulse"))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    vi.advanceTimersByTime(499);
    expect(buttons[0]?.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(buttons[0]?.classList.contains("pulse")).toBe(false);
  });

  it("lasts ten seconds by default", () => {
    vi.useFakeTimers();
    const rail = createRail(document, handlers());
    rail.pulse();
    const first = rail.element.querySelector("button") as HTMLElement;
    vi.advanceTimersByTime(9_999);
    expect(first.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.classList.contains("pulse")).toBe(false);
  });

  it("restarts the time when pulsed again, and survives a re-render", () => {
    vi.useFakeTimers();
    const rail = createRail(document, handlers());
    const first = rail.element.querySelector("button") as HTMLElement;
    rail.pulse(1000);
    vi.advanceTimersByTime(600);
    rail.render(layout, 4);
    expect(first.classList.contains("pulse")).toBe(true);
    rail.pulse(1000);
    vi.advanceTimersByTime(600);
    expect(first.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(first.classList.contains("pulse")).toBe(false);
  });

  it("stopPulse removes the class at once and cancels the pending removal", () => {
    vi.useFakeTimers();
    const rail = createRail(document, handlers());
    const first = rail.element.querySelector("button") as HTMLElement;
    rail.pulse(1000);
    expect(first.classList.contains("pulse")).toBe(true);
    rail.stopPulse();
    expect(first.classList.contains("pulse")).toBe(false);
    rail.pulse(1000);
    rail.stopPulse();
    rail.pulse(5000);
    vi.advanceTimersByTime(1000);
    expect(first.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(first.classList.contains("pulse")).toBe(false);
  });

  it("stopPulse with nothing pulsing does nothing", () => {
    const rail = createRail(document, handlers());
    rail.stopPulse();
    expect(rail.element.querySelector(".pulse")).toBeNull();
  });
});

describe("rail Ask button", () => {
  const askButton = (rail: { element: HTMLElement }): HTMLButtonElement =>
    rail.element.querySelector('button[aria-label="Ask"]') as HTMLButtonElement;

  it("sits after the slots and before the more button, with its icon, hidden until set", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons.indexOf(askButton(rail))).toBe(5);
    expect(buttons[6]?.textContent).toBe("⋯");
    expect(askButton(rail).querySelector(".rail-icon")?.textContent).toBe("💬");
    expect(askButton(rail).hidden).toBe(true);
  });

  it("is hidden, disabled or enabled as set, and reports a tap", () => {
    const onAsk = vi.fn();
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn(), onAsk });
    rail.render(layout, 3);
    rail.setAsk("enabled", false);
    expect(askButton(rail).hidden).toBe(false);
    expect(askButton(rail).disabled).toBe(false);
    askButton(rail).click();
    expect(onAsk).toHaveBeenCalledTimes(1);
    rail.setAsk("disabled", false);
    expect(askButton(rail).hidden).toBe(false);
    expect(askButton(rail).disabled).toBe(true);
    rail.setAsk("hidden", false);
    expect(askButton(rail).hidden).toBe(true);
  });

  it("while active, it alone is marked active, through later renders too", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    rail.setAsk("enabled", true);
    const active = (): boolean[] =>
      [...rail.element.querySelectorAll("button")].map((b) => b.classList.contains("active"));
    expect(active()).toEqual([false, false, false, false, false, true, false]);
    rail.render({ ...layout, active: ACHIEVEMENTS }, 3);
    expect(active()).toEqual([false, false, false, false, false, true, false]);
    rail.setAsk("enabled", false);
    expect(active()).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("rail in two panes", () => {
  const active = (rail: { element: HTMLElement }): boolean[] =>
    [...rail.element.querySelectorAll("button")].map((b) => b.classList.contains("active"));

  it("marks the left pane's page and the right pane's choice together", () => {
    const rail = createRail(document, handlers());
    rail.render({ ...layout, active: ACHIEVEMENTS }, 3);
    rail.setAsk("enabled", false);
    rail.setPanes({ left: 1, right: "achievements" });
    expect(active(rail)).toEqual([true, false, true, false, false, false, false]);
    rail.setPanes({ left: 0, right: "ask" });
    expect(active(rail)).toEqual([false, true, false, false, false, true, false]);
    rail.render(layout, 3);
    expect(active(rail)).toEqual([false, true, false, false, false, true, false]);
  });

  it("goes back to marking one item when there are no panes", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    rail.setPanes({ left: 0, right: "achievements" });
    rail.setPanes(null);
    expect(active(rail)).toEqual([false, false, true, false, false, false, false]);
  });
});

describe("rail with a page on the right", () => {
  const buttons = (rail: { element: HTMLElement }): HTMLButtonElement[] => [
    ...rail.element.querySelectorAll("button"),
  ];
  const marks = (rail: { element: HTMLElement }) =>
    buttons(rail).map((b) =>
      b.classList.contains("right-pane") ? "R" : b.classList.contains("active") ? "A" : "-",
    );

  it("marks the right pane's slot apart, and not 🏆", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    rail.setPanes({ left: 0, right: { slot: 1 } });
    expect(marks(rail)).toEqual(["-", "A", "R", "-", "-", "-", "-"]);
    expect(buttons(rail)[2]?.classList.contains("active")).toBe(false);
  });

  it("says so to a screen reader, and stops saying it when the page leaves the right", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3, [null, { completed: 1, total: 4 }]);
    rail.setPanes({ left: 0, right: { slot: 1 } });
    const label = (): string | null => buttons(rail)[2]?.getAttribute("aria-label") ?? null;
    expect(label()).toBe("Blind Playthrough Essentials, 1 of 4 done, shown on the right");
    // Through a later render too.
    rail.render(layout, 3);
    expect(label()).toBe("Blind Playthrough Essentials, shown on the right");
    rail.setPanes({ left: 0, right: "achievements" });
    expect(label()).toBe("Blind Playthrough Essentials");
    expect(marks(rail)).toEqual(["A", "A", "-", "-", "-", "-", "-"]);
  });

  it("marks only the right page when it is shown alone, without saying it is on the right", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    rail.setPanes({ left: null, right: { slot: 0 } });
    expect(marks(rail)).toEqual(["-", "R", "-", "-", "-", "-", "-"]);
    expect(buttons(rail)[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
  });

  it("tells a screen reader whether the Ask panel is open", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    const ask = rail.element.querySelector('button[aria-label="Ask"]');
    rail.setAsk("enabled", true);
    expect(ask?.getAttribute("aria-pressed")).toBe("true");
    rail.setAsk("enabled", false);
    expect(ask?.getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the mark with the panes", () => {
    const rail = createRail(document, handlers());
    rail.render(layout, 3);
    rail.setPanes({ left: 0, right: { slot: 1 } });
    rail.setPanes(null);
    expect(buttons(rail).some((b) => b.classList.contains("right-pane"))).toBe(false);
    expect(buttons(rail)[2]?.getAttribute("aria-label")).toBe("Blind Playthrough Essentials");
  });
});

describe("rail long press", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (withLongPress = true) => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onLongPress = vi.fn();
    const rail = createRail(document, {
      onSelect,
      onMore: vi.fn(),
      onAsk: vi.fn(),
      ...(withLongPress ? { onLongPress } : {}),
    });
    rail.render(layout, 3);
    const slot = rail.element.querySelectorAll("button")[2] as HTMLButtonElement;
    const fire = (type: string, x = 20, y = 20, pointerId = 1, extra: PointerEventInit = {}) =>
      slot.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId,
          ...extra,
        }),
      );
    // What a browser sends for a press held `ms` and let go where it started.
    const press = (ms: number): void => {
      fire("pointerdown");
      vi.advanceTimersByTime(ms);
      fire("pointerup");
      slot.click();
    };
    return { rail, slot, onSelect, onLongPress, fire, press };
  };

  it("reports a press held 500 ms once, on the timer, and swallows the click after it", () => {
    const { onSelect, onLongPress, fire, slot } = setup();
    fire("pointerdown");
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(2000);
    fire("pointerup");
    slot.click();
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves a tap a tap, also right after a long press", () => {
    const { onSelect, onLongPress, press } = setup();
    press(100);
    expect(onSelect.mock.calls).toEqual([[1]]);
    press(600);
    press(100);
    expect(onLongPress.mock.calls).toEqual([[1]]);
    expect(onSelect.mock.calls).toEqual([[1], [1]]);
  });

  it("takes a release before 500 ms as a tap, with no long press later", () => {
    const { onSelect, onLongPress, fire, slot } = setup();
    fire("pointerdown");
    vi.advanceTimersByTime(300);
    fire("pointerup");
    slot.click();
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it("cancels on a move of more than 10 px, but not on a small wobble", () => {
    const { onLongPress, fire } = setup();
    fire("pointerdown", 20, 20);
    fire("pointermove", 26, 27);
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fire("pointerup");
    fire("pointerdown", 20, 20);
    fire("pointermove", 20, 31);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointercancel (the page scrolled) and ignores another pointer's moves", () => {
    const { onLongPress, fire } = setup();
    fire("pointerdown");
    fire("pointercancel");
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    fire("pointerdown", 20, 20, 1);
    fire("pointermove", 200, 200, 2);
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores a mouse button other than the main one", () => {
    const { onLongPress, fire } = setup();
    fire("pointerdown", 20, 20, 1, { pointerType: "mouse", button: 2 });
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does not swallow a keyboard click after a long press whose click never came", () => {
    const { onSelect, fire, slot } = setup();
    fire("pointerdown");
    vi.advanceTimersByTime(600);
    fire("pointercancel");
    slot.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    slot.click();
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it("swallows only a click that comes within a second of letting go", () => {
    const { onSelect, onLongPress, fire, slot } = setup();
    fire("pointerdown");
    vi.advanceTimersByTime(500);
    fire("pointerup");
    vi.advanceTimersByTime(2000);
    slot.click();
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it("cancels when a mouse leaves the button before the timer", () => {
    const { onLongPress, fire } = setup();
    fire("pointerdown", 20, 20, 1, { pointerType: "mouse", button: 0, buttons: 1 });
    fire("pointerleave", 20, 20, 1, { pointerType: "mouse", buttons: 1 });
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("is switched off by setLongPress(false): a held button is a plain click", () => {
    const { rail, onSelect, onLongPress, press } = setup();
    rail.setLongPress(false);
    press(800);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onSelect.mock.calls).toEqual([[1]]);
    rail.setLongPress(true);
    press(800);
    expect(onLongPress.mock.calls).toEqual([[1]]);
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it("drops a press under way when switched off", () => {
    const { rail, onLongPress, fire } = setup();
    fire("pointerdown");
    rail.setLongPress(false);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("is a tap without a long-press handler", () => {
    const { onSelect, press } = setup(false);
    press(800);
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it("holds no callout: the context menu of a rail button is prevented", () => {
    const { rail } = setup();
    for (const b of buttons(rail)) {
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      b.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(true);
    }
  });

  const buttons = (rail: { element: HTMLElement }): HTMLButtonElement[] => [
    ...rail.element.querySelectorAll("button"),
  ];
});
