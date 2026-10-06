import type { GuideHub, GuidePage } from "../shared/types.js";
import type { Layout, Slot } from "./state.js";

export interface PickerHandlers {
  onPage(page: Slot): void;
  onHub(hub: GuideHub): void;
  onClose(): void;
  onUnpin(page: Slot): void;
}

export interface Picker {
  element: HTMLElement;
  open(tab: "pages" | "games"): void;
  close(): void;
  setPages(pages: GuidePage[], layout: Layout): void;
  setHubs(hubs: GuideHub[], available: boolean): void;
  /** While a guide choice is pending only the Games tab is offered. */
  setChoosing(choosing: boolean): void;
}

type Tab = "pages" | "games";

export function createPicker(doc: Document, handlers: PickerHandlers): Picker {
  const element = doc.createElement("div");
  element.classList.add("picker");
  element.hidden = true;

  const header = doc.createElement("div");
  header.classList.add("picker-header");
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  for (const [tab, label] of [
    ["pages", "Pages"],
    ["games", "Games"],
  ] as const) {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.classList.add("picker-tab");
    b.dataset["tab"] = tab;
    b.textContent = label;
    b.addEventListener("click", () => showTab(tab));
    tabButtons.set(tab, b);
    header.append(b);
  }
  const closeButton = doc.createElement("button");
  closeButton.setAttribute("type", "button");
  closeButton.classList.add("picker-close");
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "✕";
  header.append(closeButton);

  const pagesList = doc.createElement("div");
  pagesList.classList.add("picker-pages");
  const gamesList = doc.createElement("div");
  gamesList.classList.add("picker-games");
  element.append(header, pagesList, gamesList);

  let choosing = false;

  function showTab(wanted: Tab): void {
    const next: Tab = choosing ? "games" : wanted;
    pagesList.hidden = next !== "pages";
    gamesList.hidden = next !== "games";
    for (const [name, b] of tabButtons) b.classList.toggle("active", name === next);
  }

  showTab("pages");

  const close = (): void => {
    element.hidden = true;
  };

  closeButton.addEventListener("click", () => {
    close();
    handlers.onClose();
  });

  const empty = (text: string): HTMLElement => {
    const p = doc.createElement("p");
    p.classList.add("picker-empty");
    p.textContent = text;
    return p;
  };

  const item = (title: string): { button: HTMLButtonElement; title: HTMLElement } => {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.classList.add("picker-item");
    const t = doc.createElement("span");
    t.classList.add("picker-title");
    t.textContent = title;
    b.append(t);
    return { button: b, title: t };
  };

  const pageItems = (
    pages: GuidePage[],
    pinned: ReadonlySet<string>,
    depth: number,
  ): HTMLElement[] =>
    pages.flatMap((page) => {
      const { button } = item(page.title);
      button.dataset["depth"] = String(depth);
      const isPinned = pinned.has(page.url);
      button.classList.toggle("pinned", isPinned);
      button.addEventListener("click", () => {
        close();
        handlers.onPage({ title: page.title, url: page.url });
      });
      const row = doc.createElement("div");
      row.classList.add("picker-row");
      row.append(button);
      if (isPinned) {
        const unpin = doc.createElement("button");
        unpin.setAttribute("type", "button");
        unpin.classList.add("picker-unpin");
        unpin.setAttribute("aria-label", `Remove ${page.title} from the sidebar`);
        unpin.textContent = "✕";
        unpin.addEventListener("click", () => {
          handlers.onUnpin({ title: page.title, url: page.url });
        });
        row.append(unpin);
      }
      return [row, ...pageItems(page.children, pinned, depth + 1)];
    });

  const gameItem = (hub: GuideHub): HTMLElement => {
    const { button } = item(hub.title);
    const platform = doc.createElement("span");
    platform.classList.add("picker-platform");
    platform.textContent = hub.platformLabel;
    button.append(platform);
    button.classList.toggle("now-playing", hub.nowPlaying);
    button.addEventListener("click", () => {
      close();
      handlers.onHub(hub);
    });
    return button;
  };

  const group = (name: string, hubs: GuideHub[]): HTMLElement => {
    const section = doc.createElement("section");
    section.classList.add("picker-group");
    section.dataset["group"] = name;
    const heading = doc.createElement("h3");
    heading.classList.add("picker-group-title");
    const label = doc.createElement("span");
    label.classList.add("picker-group-name");
    label.textContent = name;
    const count = doc.createElement("span");
    count.classList.add("picker-group-count");
    count.textContent = String(hubs.length);
    heading.append(label, count);
    section.append(heading, ...hubs.map(gameItem));
    return section;
  };

  const groupHubs = (hubs: GuideHub[]): HTMLElement[] => {
    const playing = hubs.filter((h) => h.nowPlaying);
    const byPlatform = new Map<string, GuideHub[]>();
    for (const hub of hubs) {
      if (hub.nowPlaying) continue;
      byPlatform.set(hub.platformLabel, [...(byPlatform.get(hub.platformLabel) ?? []), hub]);
    }
    const names = [...byPlatform.keys()].sort(
      (a, b) => Number(a === "Other") - Number(b === "Other") || a.localeCompare(b),
    );
    return [
      ...(playing.length > 0 ? [group("Now playing", playing)] : []),
      ...names.map((name) => group(name, byPlatform.get(name) ?? [])),
    ];
  };

  return {
    element,
    open(next) {
      showTab(next);
      element.hidden = false;
    },
    close,
    setChoosing(value) {
      choosing = value;
      const pagesTab = tabButtons.get("pages");
      if (pagesTab !== undefined) pagesTab.hidden = value;
      if (value) showTab("games");
    },
    setPages(pages, layout) {
      const pinned = new Set<string>();
      for (const slot of layout.slots) if (slot !== null) pinned.add(slot.url);
      pagesList.replaceChildren(
        ...(pages.length === 0
          ? [empty("No guide pages for this game")]
          : pageItems(pages, pinned, 0)),
      );
    },
    setHubs(hubs, available) {
      gamesList.replaceChildren(
        ...(hubs.length === 0
          ? [empty(available ? "No guides found" : "Guides are unavailable right now")]
          : groupHubs(hubs)),
      );
    },
  };
}
