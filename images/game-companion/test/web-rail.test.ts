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
    expect(buttons.slice(1, 5).map((b) => b.textContent)).toEqual(["AC", "BP", "", ""]);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
    expect(buttons[3]?.disabled).toBe(true);
    expect(buttons[6]?.getAttribute("aria-label")).toBe("Pages and games");
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
    expect(label(first)).toBe("AC");
    expect(count(first)).toBe("7/12");
    expect(first?.textContent).toBe("AC7/12");
    expect(first?.getAttribute("aria-label")).toBe("Achievement Checklist, 7 of 12 done");
    expect(label(second)).toBe("BP");
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
