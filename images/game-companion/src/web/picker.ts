import type { FindMatch, GuideHub, GuidePage } from "../shared/types.js";
import type { GuideZoom } from "./device.js";
import type { GameLink, Layout, Slot } from "./state.js";

export interface PickerHandlers {
  onPage(page: Slot): void;
  onHub(hub: GuideHub): void;
  onClose(): void;
  onUnpin(page: Slot): void;
  onMatch(match: FindMatch): void;
  /** A display setting was tapped. The picker stays open. */
  onSetting(name: SettingName): void;
  /** The add form was submitted. Returns a message to show, or null when the link was added. */
  onAddLink(title: string, url: string): string | null;
  onRemoveLink(url: string): void;
  /** A link row was tapped: pin it and open it. */
  onLink(link: GameLink): void;
}

export type SettingName = "keepAwake" | "hideChrome" | "guideJump" | "guideZoom" | "fullscreen";

export interface SettingsState {
  keepAwake: boolean;
  hideChrome: boolean;
  guideJump: boolean;
  guideZoom: GuideZoom;
  fullscreen: boolean;
  wakeLockSupported: boolean;
  fullscreenSupported: boolean;
}

export interface Picker {
  element: HTMLElement;
  open(tab: "pages" | "games"): void;
  close(): void;
  setPages(pages: GuidePage[], layout: Layout): void;
  /** The game's own links, below its pages; `available` false hides the section (no game to attach them to). */
  setLinks(links: GameLink[], layout: Layout, available: boolean): void;
  setHubs(hubs: GuideHub[], available: boolean): void;
  /** While a guide choice is pending only the Games tab is offered. */
  setChoosing(choosing: boolean): void;
  /** Opens the picker showing only the places a guide mentions `query`. */
  showMatches(query: string, matches: FindMatch[], truncated: boolean): void;
  /** Updates the labels of the Display tab. */
  setSettings(state: SettingsState): void;
}

type Tab = "pages" | "games" | "settings";

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
    ["settings", "Display"],
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
  const matchesList = doc.createElement("div");
  matchesList.classList.add("picker-matches");
  matchesList.hidden = true;
  const settingsList = doc.createElement("div");
  settingsList.classList.add("picker-settings");
  const settingRows = new Map<SettingName, HTMLButtonElement>();
  for (const [name, className] of [
    ["keepAwake", "setting-keep-awake"],
    ["hideChrome", "setting-hide-chrome"],
    ["fullscreen", "setting-fullscreen"],
    ["guideJump", "setting-guide-jump"],
    ["guideZoom", "setting-guide-zoom"],
  ] as const) {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.classList.add(className);
    b.addEventListener("click", () => handlers.onSetting(name));
    settingRows.set(name, b);
    settingsList.append(b);
  }
  const hint = doc.createElement("p");
  hint.classList.add("setting-hint");
  hint.textContent = "To use it like an app, open the browser menu and choose Add to Home screen.";
  settingsList.append(hint);
  element.append(header, pagesList, gamesList, matchesList, settingsList);

  let choosing = false;
  let matchesShowing = false;

  function showTab(wanted: Tab): void {
    const next: Tab = choosing ? "games" : wanted;
    matchesShowing = false;
    matchesList.hidden = true;
    pagesList.hidden = next !== "pages";
    gamesList.hidden = next !== "games";
    settingsList.hidden = next !== "settings";
    for (const [name, b] of tabButtons) {
      b.hidden = name !== "games" && choosing;
      b.classList.toggle("active", name === next);
    }
  }

  showTab("pages");

  const close = (): void => {
    element.hidden = true;
    if (matchesShowing) showTab("pages");
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
      if (isPinned) row.append(pinButton(page));
      return [row, ...pageItems(page.children, pinned, depth + 1)];
    });

  const pinButton = (page: Slot): HTMLButtonElement => {
    const unpin = doc.createElement("button");
    unpin.setAttribute("type", "button");
    unpin.classList.add("picker-unpin");
    unpin.setAttribute("aria-label", `Remove ${page.title} from the sidebar`);
    unpin.textContent = "✕";
    unpin.addEventListener("click", () => {
      handlers.onUnpin({ title: page.title, url: page.url });
    });
    return unpin;
  };

  const linksSection = doc.createElement("section");
  linksSection.classList.add("picker-links");
  linksSection.hidden = true;
  const linksTitle = doc.createElement("h3");
  linksTitle.classList.add("picker-links-title");
  linksTitle.textContent = "Your links";
  const linkRows = doc.createElement("div");
  linkRows.classList.add("picker-link-rows");
  const addForm = doc.createElement("form");
  addForm.classList.add("picker-link-add");
  addForm.noValidate = true;
  const nameInput = doc.createElement("input");
  nameInput.classList.add("picker-link-name");
  nameInput.setAttribute("type", "text");
  nameInput.setAttribute("placeholder", "Name");
  nameInput.setAttribute("maxlength", "40");
  nameInput.setAttribute("aria-label", "Link name");
  nameInput.setAttribute("autocomplete", "off");
  const urlInput = doc.createElement("input");
  urlInput.classList.add("picker-link-url");
  urlInput.setAttribute("type", "url");
  urlInput.setAttribute("inputmode", "url");
  urlInput.setAttribute("placeholder", "https://…");
  urlInput.setAttribute("aria-label", "Link address");
  urlInput.setAttribute("autocapitalize", "off");
  urlInput.setAttribute("autocomplete", "off");
  urlInput.setAttribute("spellcheck", "false");
  const addButton = doc.createElement("button");
  addButton.setAttribute("type", "submit");
  addButton.classList.add("picker-link-submit");
  addButton.textContent = "Add";
  const linkError = doc.createElement("p");
  linkError.classList.add("picker-link-error");
  addForm.append(nameInput, urlInput, addButton, linkError);
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = handlers.onAddLink(nameInput.value, urlInput.value);
    linkError.textContent = message ?? "";
    if (message === null) {
      nameInput.value = "";
      urlInput.value = "";
    }
  });
  linksSection.append(linksTitle, linkRows, addForm);
  // The pages are redrawn into their own container, so the links section, with the add form, is
  // never detached and keeps focus and typed text.
  const pageRows = doc.createElement("div");
  pageRows.classList.add("picker-page-rows");
  pagesList.append(pageRows, linksSection);

  const linkRow = (link: GameLink, isPinned: boolean): HTMLElement => {
    const { button } = item(link.title);
    button.classList.toggle("pinned", isPinned);
    button.addEventListener("click", () => {
      close();
      handlers.onLink({ title: link.title, url: link.url });
    });
    const row = doc.createElement("div");
    row.classList.add("picker-row", "picker-link");
    row.append(button);
    if (isPinned) row.append(pinButton(link));
    const open = doc.createElement("a");
    open.classList.add("picker-link-open");
    open.setAttribute("href", link.url);
    open.setAttribute("target", "_blank");
    open.setAttribute("rel", "noopener noreferrer");
    open.setAttribute("aria-label", "Open in a new tab");
    open.textContent = "↗";
    const remove = doc.createElement("button");
    remove.setAttribute("type", "button");
    remove.classList.add("picker-link-remove");
    remove.setAttribute("aria-label", `Remove ${link.title}`);
    remove.textContent = "Remove";
    remove.addEventListener("click", () => handlers.onRemoveLink(link.url));
    row.append(open, remove);
    return row;
  };

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
      if (matchesShowing) return;
      for (const [name, b] of tabButtons) if (name !== "games") b.hidden = value;
      if (value) showTab("games");
    },
    setSettings(state) {
      const label = (name: SettingName, text: string, pressed: boolean, supported = true): void => {
        const b = settingRows.get(name);
        if (b === undefined) return;
        b.textContent = text;
        b.setAttribute("aria-pressed", pressed ? "true" : "false");
        b.hidden = !supported;
      };
      label(
        "keepAwake",
        `Keep screen on: ${state.keepAwake ? "on" : "off"}`,
        state.keepAwake,
        state.wakeLockSupported,
      );
      label(
        "hideChrome",
        `Outline bars: ${state.hideChrome ? "hidden" : "shown"}`,
        state.hideChrome,
      );
      label(
        "fullscreen",
        `Full screen: ${state.fullscreen ? "on" : "off"}`,
        state.fullscreen,
        state.fullscreenSupported,
      );
      label(
        "guideJump",
        `Guide jump from status: ${state.guideJump ? "on" : "off"}`,
        state.guideJump,
      );
      const zoomRow = settingRows.get("guideZoom");
      if (zoomRow !== undefined) zoomRow.textContent = `Guide text size: ${state.guideZoom}%`;
    },
    showMatches(query, matches, truncated) {
      const title = doc.createElement("h3");
      title.classList.add("picker-matches-title");
      title.textContent = `In the guide: ${query}`;
      const rows = matches.map((match) => {
        const { button } = item(match.pageTitle);
        const heading = doc.createElement("span");
        heading.classList.add("picker-heading");
        heading.textContent = match.heading ?? "";
        const snippet = doc.createElement("span");
        snippet.classList.add("picker-snippet");
        snippet.textContent = match.snippet;
        button.append(heading, snippet);
        button.addEventListener("click", () => {
          close();
          handlers.onMatch(match);
        });
        return button;
      });
      matchesList.replaceChildren(
        title,
        ...rows,
        ...(truncated ? [empty("More matches not shown")] : []),
      );
      matchesShowing = true;
      matchesList.hidden = false;
      pagesList.hidden = true;
      gamesList.hidden = true;
      settingsList.hidden = true;
      for (const b of tabButtons.values()) b.hidden = true;
      element.hidden = false;
    },
    setPages(pages, layout) {
      const pinned = new Set<string>();
      for (const slot of layout.slots) if (slot !== null) pinned.add(slot.url);
      pageRows.replaceChildren(
        ...(pages.length === 0
          ? [empty("No guide pages for this game")]
          : pageItems(pages, pinned, 0)),
      );
    },
    setLinks(links, layout, available) {
      const pinned = new Set<string>();
      for (const slot of layout.slots) if (slot !== null) pinned.add(slot.url);
      linkRows.replaceChildren(...links.map((link) => linkRow(link, pinned.has(link.url))));
      linksSection.hidden = !available;
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
