import type { Panes } from "./split.js";
import { ACHIEVEMENTS, SLOT_COUNT, slotLabel, type Layout } from "./state.js";

export interface RailHandlers {
  onSelect(index: number): void;
  onMore(): void;
  onAsk(): void;
}

/** The Ask button: absent without an assistant, disabled while no game is selected. */
export type AskState = "hidden" | "enabled" | "disabled";

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
  /** Shows the Ask button; while `active`, it is the one marked active. */
  setAsk(state: AskState, active: boolean): void;
  /**
   * With two panes, marks the left pane's slot and the right pane's choice together, through later
   * renders too; null goes back to marking the one item on screen.
   */
  setPanes(panes: Panes | null): void;
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

  const ask = button("Ask");
  const askIcon = doc.createElement("span");
  askIcon.classList.add("rail-icon");
  askIcon.textContent = "💬";
  ask.append(askIcon);
  ask.hidden = true;
  ask.addEventListener("click", () => handlers.onAsk());

  const more = button("Pages and games");
  more.textContent = "⋯";
  more.addEventListener("click", () => handlers.onMore());

  element.append(achievements, ...slotButtons.map((s) => s.button), ask, more);

  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActive: number | null = null;
  let askActive = false;
  let panes: Panes | null = null;

  // The open Ask panel covers the stage, so the layout's active item is not marked meanwhile.
  const markActive = (): void => {
    if (panes !== null) {
      const { left, right } = panes;
      achievements.classList.toggle("active", right === "achievements");
      slotButtons.forEach(({ button: b }, index) => b.classList.toggle("active", left === index));
      ask.classList.toggle("active", right === "ask");
      return;
    }
    const shown = askActive ? null : lastActive;
    achievements.classList.toggle("active", shown === ACHIEVEMENTS);
    slotButtons.forEach(({ button: b }, index) => b.classList.toggle("active", shown === index));
    ask.classList.toggle("active", askActive);
  };

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
    setAsk(state, active) {
      ask.hidden = state === "hidden";
      ask.disabled = state === "disabled";
      askActive = active;
      markActive();
    },
    setPanes(next) {
      panes = next;
      markActive();
    },
    render(layout, unlockedCount, progress = []) {
      count.textContent = unlockedCount === null ? "" : String(unlockedCount);
      lastActive = layout.active;
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
      });
      markActive();
    },
  };
}
