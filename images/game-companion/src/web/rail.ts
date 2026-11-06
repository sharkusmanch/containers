import { addLongPress } from "./long-press.js";
import type { Panes } from "./split.js";
import { ACHIEVEMENTS, SLOT_COUNT, slotLabel, type Layout } from "./state.js";

export interface RailHandlers {
  onSelect(index: number): void;
  /** A long press on slot `index`'s button (see addLongPress); without it, a long press is a tap. */
  onLongPress?(index: number): void;
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
   * renders too; null goes back to marking the one item on screen. A slot shown on the right is
   * marked `right-pane` (not `active`) and its label says so.
   */
  setPanes(panes: Panes | null): void;
  /** Turns the slots' long press on (two panes) or off (the other layouts: plain clicks only). */
  setLongPress(enabled: boolean): void;
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
    // No callout or menu on a held button (a long press on a slot has a meaning of its own).
    b.addEventListener("contextmenu", (event) => event.preventDefault());
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
    const longPress = addLongPress(b, () => {
      if (handlers.onLongPress === undefined) handlers.onSelect(index);
      else handlers.onLongPress(index);
    });
    b.addEventListener("click", () => handlers.onSelect(index));
    return { button: b, abbreviation, done, longPress, label: "Empty slot" };
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
    const onRight = panes !== null && typeof panes.right === "object" ? panes.right.slot : null;
    // A right pane's page shown alone (nothing on the left) is not "on the right" to the ear.
    const beside = panes?.left != null;
    slotButtons.forEach(({ button: b, label }, index) => {
      b.classList.toggle("right-pane", onRight === index);
      b.setAttribute(
        "aria-label",
        onRight === index && beside ? `${label}, shown on the right` : label,
      );
    });
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
      // With two panes 💬 opens and closes the panel.
      ask.setAttribute("aria-pressed", active ? "true" : "false");
      askActive = active;
      markActive();
    },
    setLongPress(enabled) {
      for (const { longPress } of slotButtons) longPress.setEnabled(enabled);
    },
    setPanes(next) {
      panes = next;
      markActive();
    },
    render(layout, unlockedCount, progress = []) {
      count.textContent = unlockedCount === null ? "" : String(unlockedCount);
      lastActive = layout.active;
      slotButtons.forEach((entry, index) => {
        const { button: b, abbreviation, done } = entry;
        const slot = layout.slots[index] ?? null;
        const shown = slot === null ? null : (progress[index] ?? null);
        abbreviation.textContent = slot === null ? "" : slotLabel(slot.title);
        done.textContent = shown === null ? "" : progressText(shown);
        // Set on the button by markActive, with the right pane's note when it applies.
        entry.label =
          slot === null
            ? "Empty slot"
            : shown === null
              ? slot.title
              : `${slot.title}, ${shown.completed} of ${shown.total} done`;
        b.disabled = slot === null;
        b.hidden = slot === null;
      });
      markActive();
    },
  };
}
