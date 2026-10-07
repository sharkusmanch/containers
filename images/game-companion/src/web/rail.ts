import { ACHIEVEMENTS, SLOT_COUNT, slotLabel, type Layout } from "./state.js";

export interface RailHandlers {
  onSelect(index: number): void;
  onMore(): void;
}

/** How far a reader has got through the checklist of a pinned page. */
export interface PageProgressLabel {
  completed: number;
  total: number;
}

export interface Rail {
  element: HTMLElement;
  /** `progress[i]` is the checklist progress of the page in slot i, when it has one. */
  render(
    layout: Layout,
    unlockedCount: number | null,
    progress?: (PageProgressLabel | null)[],
  ): void;
  /** Marks the achievements button for a while, to draw the eye to it. */
  pulse(ms?: number): void;
  /** Ends a pulse at once. */
  stopPulse(): void;
}

/** `3/12` when that is at most 6 characters, otherwise the whole percent rounded down. */
function progressText({ completed, total }: PageProgressLabel): string {
  const fraction = `${completed}/${total}`;
  if (fraction.length <= 6) return fraction;
  return `${total > 0 ? Math.floor((completed * 100) / total) : 0}%`;
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
    const abbreviation = doc.createElement("span");
    abbreviation.classList.add("rail-label");
    const done = doc.createElement("span");
    done.classList.add("rail-count");
    b.append(abbreviation, done);
    b.addEventListener("click", () => handlers.onSelect(index));
    return { button: b, abbreviation, done };
  });

  const more = button("Pages and games");
  more.textContent = "⋯";
  more.addEventListener("click", () => handlers.onMore());

  element.append(achievements, ...slotButtons.map((s) => s.button), more);

  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    element,
    pulse(ms = 10_000) {
      clearTimeout(pulseTimer);
      achievements.classList.add("pulse");
      pulseTimer = setTimeout(() => achievements.classList.remove("pulse"), ms);
    },
    stopPulse() {
      clearTimeout(pulseTimer);
      achievements.classList.remove("pulse");
    },
    render(layout, unlockedCount, progress = []) {
      count.textContent = unlockedCount === null ? "" : String(unlockedCount);
      achievements.classList.toggle("active", layout.active === ACHIEVEMENTS);
      slotButtons.forEach(({ button: b, abbreviation, done }, index) => {
        const slot = layout.slots[index] ?? null;
        const shown = slot === null ? null : (progress[index] ?? null);
        abbreviation.textContent = slot === null ? "" : slotLabel(slot.title);
        done.textContent = shown === null ? "" : progressText(shown);
        b.setAttribute(
          "aria-label",
          slot === null
            ? "Empty slot"
            : shown === null
              ? slot.title
              : `${slot.title}, ${shown.completed} of ${shown.total} done`,
        );
        b.disabled = slot === null;
        b.hidden = slot === null;
        b.classList.toggle("active", layout.active === index);
      });
    },
  };
}
