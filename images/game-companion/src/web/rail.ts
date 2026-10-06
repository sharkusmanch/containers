import { ACHIEVEMENTS, SLOT_COUNT, slotLabel, type Layout } from "./state.js";

export interface RailHandlers {
  onSelect(index: number): void;
  onMore(): void;
}

export interface Rail {
  element: HTMLElement;
  render(layout: Layout, unlockedCount: number | null): void;
  /** Marks the achievements button for a while, to draw the eye to it. */
  pulse(ms?: number): void;
}

export function createRail(doc: Document, handlers: RailHandlers): Rail {
  const element = doc.createElement("nav");
  element.classList.add("rail");

  const button = (label: string): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.setAttribute("aria-label", label);
    return b;
  };

  const achievements = button("Achievements");
  const icon = doc.createElement("span");
  icon.classList.add("rail-icon");
  icon.textContent = "🏆";
  const count = doc.createElement("span");
  count.classList.add("rail-count");
  achievements.append(icon, count);
  achievements.addEventListener("click", () => handlers.onSelect(ACHIEVEMENTS));

  const slotButtons = Array.from({ length: SLOT_COUNT }, (_, index) => {
    const b = button("Empty slot");
    b.classList.add("rail-slot");
    b.addEventListener("click", () => handlers.onSelect(index));
    return b;
  });

  const more = button("Pages and games");
  more.textContent = "⋯";
  more.addEventListener("click", () => handlers.onMore());

  element.append(achievements, ...slotButtons, more);

  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    element,
    pulse(ms = 10_000) {
      clearTimeout(pulseTimer);
      achievements.classList.add("pulse");
      pulseTimer = setTimeout(() => achievements.classList.remove("pulse"), ms);
    },
    render(layout, unlockedCount) {
      count.textContent = unlockedCount === null ? "" : String(unlockedCount);
      achievements.classList.toggle("active", layout.active === ACHIEVEMENTS);
      slotButtons.forEach((b, index) => {
        const slot = layout.slots[index] ?? null;
        b.textContent = slot === null ? "" : slotLabel(slot.title);
        b.setAttribute("aria-label", slot === null ? "Empty slot" : slot.title);
        b.disabled = slot === null;
        b.hidden = slot === null;
        b.classList.toggle("active", layout.active === index);
      });
    },
  };
}
