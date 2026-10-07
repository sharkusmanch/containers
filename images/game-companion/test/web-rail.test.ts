// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRail } from "../src/web/rail.js";
import { ACHIEVEMENTS, type Layout } from "../src/web/state.js";

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
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.render(layout, 12);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons).toHaveLength(6);
    expect(buttons[0]?.querySelector(".rail-count")?.textContent).toBe("12");
    expect(buttons.slice(1, 5).map((b) => b.textContent)).toEqual(["AC", "BP", "", ""]);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Achievement Checklist");
    expect(buttons[3]?.disabled).toBe(true);
    expect(buttons[5]?.getAttribute("aria-label")).toBe("Pages and games");
  });

  it("marks only the active button", () => {
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.render(layout, null);
    const active = [...rail.element.querySelectorAll("button")].map((b) =>
      b.classList.contains("active"),
    );
    expect(active).toEqual([false, false, true, false, false, false]);
    rail.render({ ...layout, active: ACHIEVEMENTS }, null);
    expect(rail.element.querySelectorAll("button")[0]?.classList.contains("active")).toBe(true);
  });

  it("omits the count when it is unknown", () => {
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.render(layout, null);
    expect(rail.element.querySelector(".rail-count")?.textContent).toBe("");
  });

  it("reports selections and the more button", () => {
    const onSelect = vi.fn();
    const onMore = vi.fn();
    const rail = createRail(document, { onSelect, onMore });
    rail.render(layout, 3);
    const buttons = rail.element.querySelectorAll("button");
    buttons[0]?.click();
    buttons[2]?.click();
    buttons[5]?.click();
    expect(onSelect.mock.calls).toEqual([[ACHIEVEMENTS], [1]]);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("hides empty slots instead of leaving a gap", () => {
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.render(layout, 3);
    const buttons = [...rail.element.querySelectorAll("button")];
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => b.hidden)).toEqual([false, false, false, true, true, false]);
    rail.render({ slots: [null, null, null, null], active: ACHIEVEMENTS }, 3);
    expect([...rail.element.querySelectorAll("button")].map((b) => b.hidden)).toEqual([
      false,
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
      false,
    ]);
  });
});

describe("rail pulse", () => {
  afterEach(() => vi.useRealTimers());

  it("marks only the achievements button, then clears it after the given time", () => {
    vi.useFakeTimers();
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
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
    ]);
    vi.advanceTimersByTime(499);
    expect(buttons[0]?.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(buttons[0]?.classList.contains("pulse")).toBe(false);
  });

  it("lasts ten seconds by default", () => {
    vi.useFakeTimers();
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.pulse();
    const first = rail.element.querySelector("button") as HTMLElement;
    vi.advanceTimersByTime(9_999);
    expect(first.classList.contains("pulse")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.classList.contains("pulse")).toBe(false);
  });

  it("restarts the time when pulsed again, and survives a re-render", () => {
    vi.useFakeTimers();
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
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
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
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
    const rail = createRail(document, { onSelect: vi.fn(), onMore: vi.fn() });
    rail.stopPulse();
    expect(rail.element.querySelector(".pulse")).toBeNull();
  });
});
