// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createPicker } from "../src/web/picker.js";
import { assignSlot, defaultLayout, type GameLink } from "../src/web/state.js";
import type { FindMatch, GuideHub, GuidePage } from "../src/shared/types.js";

const pages: GuidePage[] = [
  { title: "Achievement Checklist", url: "/doc/checklist", children: [] },
  {
    title: "Collectibles",
    url: "/doc/coll",
    children: [{ title: "<i>Area</i> One", url: "/doc/area1", children: [] }],
  },
];
const hubs: GuideHub[] = [
  {
    hubId: "h2",
    title: "Alpha Quest",
    url: "/doc/alpha",
    source: "ra",
    gameId: "20",
    xboxTitleId: null,
    platforms: ["ra"],
    lastPlatform: null,
    platformLabel: "RA · PS2",
    nowPlaying: true,
  },
  {
    hubId: "h1",
    title: "Zeta Game",
    url: "/doc/zeta",
    source: "steam",
    gameId: "10",
    xboxTitleId: null,
    platforms: ["steam"],
    lastPlatform: null,
    platformLabel: "Steam",
    nowPlaying: false,
  },
];

function make() {
  const handlers = {
    onPage: vi.fn(),
    onHub: vi.fn(),
    onClose: vi.fn(),
    onUnpin: vi.fn(),
    onMatch: vi.fn(),
    onSetting: vi.fn(),
    onAddLink: vi.fn((): string | null => null),
    onRemoveLink: vi.fn(),
    onLink: vi.fn(),
    onInstall: vi.fn(),
    onDismissSetup: vi.fn(),
  };
  const picker = createPicker(document, handlers);
  picker.setPages(pages, defaultLayout(pages, ["Achievement Checklist"]));
  picker.setHubs(hubs, true);
  return { picker, handlers };
}

describe("createPicker", () => {
  it("starts closed and opens on the requested tab", () => {
    const { picker } = make();
    expect(picker.element.hidden).toBe(true);
    picker.open("pages");
    expect(picker.element.hidden).toBe(false);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(false);
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(true);
  });

  it("lists the page tree with nesting and marks pinned pages", () => {
    const { picker } = make();
    picker.open("pages");
    const items = [
      ...picker.element.querySelectorAll(".picker-pages .picker-item"),
    ] as HTMLElement[];
    expect(items.map((i) => i.querySelector(".picker-title")?.textContent)).toEqual([
      "Achievement Checklist",
      "Collectibles",
      "<i>Area</i> One",
    ]);
    expect(items.map((i) => i.dataset.depth)).toEqual(["0", "0", "1"]);
    expect(items[0]?.classList.contains("pinned")).toBe(true);
    expect(items[1]?.classList.contains("pinned")).toBe(false);
    expect(picker.element.querySelector("i")).toBeNull();
  });

  it("reports the chosen page and closes", () => {
    const { picker, handlers } = make();
    picker.open("pages");
    (picker.element.querySelectorAll(".picker-pages .picker-item")[1] as HTMLElement).click();
    expect(handlers.onPage).toHaveBeenCalledWith({ title: "Collectibles", url: "/doc/coll" });
    expect(picker.element.hidden).toBe(true);
  });

  it("lists games with their platform and reports the chosen hub", () => {
    const { picker, handlers } = make();
    picker.open("games");
    const items = [
      ...picker.element.querySelectorAll(".picker-games .picker-item"),
    ] as HTMLElement[];
    expect(items.map((i) => i.querySelector(".picker-title")?.textContent)).toEqual([
      "Alpha Quest",
      "Zeta Game",
    ]);
    expect(items.map((i) => i.querySelector(".picker-platform")?.textContent)).toEqual([
      "RA · PS2",
      "Steam",
    ]);
    expect(items[0]?.classList.contains("now-playing")).toBe(true);
    items[1]?.click();
    expect(handlers.onHub).toHaveBeenCalledWith(hubs[1]);
  });

  it("switches tabs", () => {
    const { picker } = make();
    picker.open("pages");
    (picker.element.querySelector('[data-tab="games"]') as HTMLElement).click();
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(false);
  });

  it("explains an empty page list and an unavailable guide index", () => {
    const { picker } = make();
    picker.setPages([], defaultLayout([], []));
    picker.setHubs([], false);
    picker.open("pages");
    expect(picker.element.querySelector(".picker-pages .picker-empty")?.textContent).toBe(
      "No guide pages for this game",
    );
    expect(picker.element.querySelector(".picker-games .picker-empty")?.textContent).toBe(
      "Guides are unavailable right now",
    );
  });

  it("closes from the close button", () => {
    const { picker, handlers } = make();
    picker.open("pages");
    (picker.element.querySelector(".picker-close") as HTMLElement).click();
    expect(picker.element.hidden).toBe(true);
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

describe("game groups", () => {
  const hub = (
    hubId: string,
    title: string,
    platformLabel: string,
    nowPlaying = false,
  ): GuideHub => ({
    hubId,
    title,
    url: `/doc/${hubId}`,
    source: platformLabel === "Other" ? null : platformLabel === "Steam" ? "steam" : "ra",
    gameId: platformLabel === "Other" ? null : hubId,
    xboxTitleId: null,
    platforms: platformLabel === "Other" ? [] : platformLabel === "Steam" ? ["steam"] : ["ra"],
    lastPlatform: null,
    platformLabel,
    nowPlaying,
  });
  const mixed: GuideHub[] = [
    hub("1", "Alpha Quest", "RA · PS2", true),
    hub("2", "Beta", "Steam"),
    hub("3", "Console Thing", "Other"),
    hub("4", "Delta", "RA · GC"),
    hub("5", "Echo", "Steam"),
    hub("6", "Foxtrot", "RA · PS2"),
  ];

  function build(hubs: GuideHub[], available = true) {
    const handlers = {
      onPage: vi.fn(),
      onHub: vi.fn(),
      onClose: vi.fn(),
      onUnpin: vi.fn(),
      onMatch: vi.fn(),
      onSetting: vi.fn(),
      onAddLink: vi.fn(() => null),
      onRemoveLink: vi.fn(),
      onLink: vi.fn(),
      onInstall: vi.fn(),
      onDismissSetup: vi.fn(),
    };
    const picker = createPicker(document, handlers);
    picker.setHubs(hubs, available);
    picker.open("games");
    return { picker, handlers };
  }
  const groups = (el: HTMLElement): HTMLElement[] => [
    ...el.querySelectorAll<HTMLElement>(".picker-games .picker-group"),
  ];
  const titlesIn = (g: HTMLElement): (string | null | undefined)[] =>
    [...g.querySelectorAll(".picker-item")].map(
      (i) => i.querySelector(".picker-title")?.textContent,
    );

  it("puts now-playing games first, then platforms by name, with Other last", () => {
    const { picker } = build(mixed);
    const gs = groups(picker.element);
    expect(gs.map((g) => g.querySelector(".picker-group-name")?.textContent)).toEqual([
      "Now playing",
      "RA · GC",
      "RA · PS2",
      "Steam",
      "Other",
    ]);
    expect(gs.map((g) => g.dataset.group)).toEqual([
      "Now playing",
      "RA · GC",
      "RA · PS2",
      "Steam",
      "Other",
    ]);
    expect(gs.map((g) => g.querySelector(".picker-group-count")?.textContent)).toEqual([
      "1",
      "1",
      "1",
      "2",
      "1",
    ]);
    expect(gs.map(titlesIn)).toEqual([
      ["Alpha Quest"],
      ["Delta"],
      ["Foxtrot"],
      ["Beta", "Echo"],
      ["Console Thing"],
    ]);
  });

  it("does not repeat a now-playing game in its platform group", () => {
    const { picker } = build(mixed);
    const all = [
      ...picker.element.querySelectorAll(".picker-games .picker-item .picker-title"),
    ].map((t) => t.textContent);
    expect(all).toEqual(["Alpha Quest", "Delta", "Foxtrot", "Beta", "Echo", "Console Thing"]);
  });

  it("omits the now-playing group when nothing is flagged, and any empty group", () => {
    const { picker } = build([hub("2", "Beta", "Steam"), hub("5", "Echo", "Steam")]);
    expect(groups(picker.element).map((g) => g.dataset.group)).toEqual(["Steam"]);
  });

  it("drops a platform group whose only game is now playing", () => {
    const { picker } = build([
      hub("1", "Alpha Quest", "RA · PS2", true),
      hub("2", "Beta", "Steam"),
    ]);
    expect(groups(picker.element).map((g) => g.dataset.group)).toEqual(["Now playing", "Steam"]);
  });

  it("keeps the order given within a group", () => {
    const { picker } = build([
      hub("9", "Zulu", "Steam"),
      hub("8", "Yankee", "Steam"),
      hub("7", "Xray", "Steam"),
    ]);
    expect(titlesIn(groups(picker.element)[0] as HTMLElement)).toEqual(["Zulu", "Yankee", "Xray"]);
  });

  it("still shows each game's platform and reports the chosen hub", () => {
    const { picker, handlers } = build(mixed);
    const items = [...picker.element.querySelectorAll<HTMLElement>(".picker-games .picker-item")];
    expect(items[0]?.querySelector(".picker-platform")?.textContent).toBe("RA · PS2");
    expect(items[0]?.classList.contains("now-playing")).toBe(true);
    items[3]?.click();
    expect(handlers.onHub).toHaveBeenCalledWith(mixed[1]);
    expect(picker.element.hidden).toBe(true);
  });

  it("renders a group name as text, never as markup", () => {
    const { picker } = build([hub("1", "Game", "<b>bold</b>")]);
    expect(picker.element.querySelector("b")).toBeNull();
    expect(picker.element.querySelector(".picker-group-name")?.textContent).toBe("<b>bold</b>");
  });

  it("renders no group in either empty state", () => {
    expect(groups(build([], true).picker.element)).toHaveLength(0);
    const unavailable = build([], false).picker.element;
    expect(groups(unavailable)).toHaveLength(0);
    expect(unavailable.querySelector(".picker-games .picker-empty")?.textContent).toBe(
      "Guides are unavailable right now",
    );
  });

  it("replaces the groups when the list is set again", () => {
    const { picker } = build(mixed);
    picker.setHubs([hub("2", "Beta", "Steam")], true);
    expect(groups(picker.element).map((g) => g.dataset.group)).toEqual(["Steam"]);
    expect(picker.element.querySelectorAll(".picker-games .picker-item")).toHaveLength(1);
  });
});

describe("removing a pinned page", () => {
  it("offers a remove button only on pinned pages", () => {
    const { picker } = make();
    picker.open("pages");
    const rows = [...picker.element.querySelectorAll<HTMLElement>(".picker-pages .picker-row")];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector(".picker-unpin")?.getAttribute("aria-label")).toBe(
      "Remove Achievement Checklist from the sidebar",
    );
    expect(rows[0]?.querySelector(".picker-unpin")?.textContent).toBe("✕");
    expect(rows[1]?.querySelector(".picker-unpin")).toBeNull();
    expect(rows[2]?.querySelector(".picker-unpin")).toBeNull();
    expect(picker.element.querySelector("button button")).toBeNull();
  });

  it("reports the page to remove without choosing it or closing", () => {
    const { picker, handlers } = make();
    picker.open("pages");
    (picker.element.querySelector(".picker-pages .picker-unpin") as HTMLElement).click();
    expect(handlers.onUnpin).toHaveBeenCalledWith({
      title: "Achievement Checklist",
      url: "/doc/checklist",
    });
    expect(handlers.onPage).not.toHaveBeenCalled();
    expect(picker.element.hidden).toBe(false);
  });
});

describe("choosing a guide", () => {
  it("offers only the Games tab while a choice is pending", () => {
    const { picker } = make();
    picker.setChoosing(true);
    picker.open("pages");
    const pagesTab = picker.element.querySelector('[data-tab="pages"]') as HTMLElement;
    expect(pagesTab.hidden).toBe(true);
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(false);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
    pagesTab.click();
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
  });

  it("brings both tabs back when the choice ends", () => {
    const { picker } = make();
    picker.setChoosing(true);
    picker.open("games");
    picker.setChoosing(false);
    const pagesTab = picker.element.querySelector('[data-tab="pages"]') as HTMLElement;
    expect(pagesTab.hidden).toBe(false);
    pagesTab.click();
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(false);
  });
});

describe("matches view", () => {
  const matches: FindMatch[] = [
    {
      pageTitle: "Collectibles",
      pageUrl: "/doc/coll",
      heading: "Chapter One",
      snippet: "Sample Boss drops the gem",
    },
    {
      pageTitle: "Walkthrough",
      pageUrl: "/doc/walk",
      heading: null,
      snippet: "Defeat the <b>Sample Boss</b> <img src=x onerror=alert(1)>",
    },
  ];
  const tabs = (picker: { element: HTMLElement }): HTMLElement[] => [
    ...picker.element.querySelectorAll<HTMLElement>(".picker-tab"),
  ];

  it("opens showing only the matches, with the query in a heading and the tabs hidden", () => {
    const { picker } = make();
    picker.showMatches("Sample Boss", matches, false);
    expect(picker.element.hidden).toBe(false);
    const list = picker.element.querySelector(".picker-matches") as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(list.querySelector(".picker-matches-title")?.textContent).toBe(
      "In the guide: Sample Boss",
    );
    expect(tabs(picker)).toHaveLength(3);
    expect(tabs(picker).every((t) => t.hidden)).toBe(true);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-close") as HTMLElement).hidden).toBe(false);
  });

  it("lists title, heading and snippet of each match in order, empty heading for null", () => {
    const { picker } = make();
    picker.showMatches("Sample Boss", matches, false);
    const items = [...picker.element.querySelectorAll(".picker-matches button.picker-item")];
    expect(items).toHaveLength(2);
    expect(
      items.map((i) => [
        i.querySelector(".picker-title")?.textContent,
        i.querySelector(".picker-heading")?.textContent,
        i.querySelector(".picker-snippet")?.textContent,
      ]),
    ).toEqual([
      ["Collectibles", "Chapter One", "Sample Boss drops the gem"],
      ["Walkthrough", "", "Defeat the <b>Sample Boss</b> <img src=x onerror=alert(1)>"],
    ]);
    expect(picker.element.querySelector(".picker-matches .picker-empty")).toBeNull();
  });

  it("renders every field as text: markup creates no elements", () => {
    const { picker } = make();
    picker.showMatches(
      "<i>q</i>",
      [{ pageTitle: "<u>T</u>", pageUrl: "/doc/t", heading: "<s>H</s>", snippet: "<b>S</b><img>" }],
      false,
    );
    expect(
      picker.element.querySelector(".picker-matches")?.querySelector("i, u, s, b, img"),
    ).toBeNull();
    expect(picker.element.querySelector(".picker-matches-title")?.textContent).toBe(
      "In the guide: <i>q</i>",
    );
  });

  it("adds a final note when the list was truncated, and not otherwise", () => {
    const { picker } = make();
    picker.showMatches("x", matches, true);
    const list = picker.element.querySelector(".picker-matches") as HTMLElement;
    const last = list.lastElementChild as HTMLElement;
    expect(last.classList.contains("picker-empty")).toBe(true);
    expect(last.textContent).toBe("More matches not shown");
    expect(list.querySelectorAll(".picker-empty")).toHaveLength(1);
    picker.showMatches("x", matches, false);
    expect(picker.element.querySelector(".picker-matches .picker-empty")).toBeNull();
  });

  it("reports the chosen match and closes", () => {
    const { picker, handlers } = make();
    picker.showMatches("Sample Boss", matches, false);
    (picker.element.querySelectorAll(".picker-matches .picker-item")[1] as HTMLElement).click();
    expect(handlers.onMatch).toHaveBeenCalledTimes(1);
    expect(handlers.onMatch).toHaveBeenCalledWith(matches[1]);
    expect(picker.element.hidden).toBe(true);
    expect(handlers.onPage).not.toHaveBeenCalled();
  });

  it("restores the tabs on the next open", () => {
    const { picker } = make();
    picker.showMatches("x", matches, false);
    picker.open("pages");
    expect(tabs(picker).every((t) => !t.hidden)).toBe(true);
    expect((picker.element.querySelector(".picker-matches") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(false);
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(true);
    picker.showMatches("x", matches, false);
    picker.open("games");
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(false);
    expect(tabs(picker).every((t) => !t.hidden)).toBe(true);
  });

  it("restores the tabs when closed from the close button or by choosing", () => {
    const { picker, handlers } = make();
    picker.showMatches("x", matches, false);
    (picker.element.querySelector(".picker-close") as HTMLElement).click();
    expect(picker.element.hidden).toBe(true);
    expect(handlers.onClose).toHaveBeenCalled();
    expect(tabs(picker).every((t) => !t.hidden)).toBe(true);
    picker.showMatches("x", matches, false);
    (picker.element.querySelector(".picker-matches .picker-item") as HTMLElement).click();
    expect(tabs(picker).every((t) => !t.hidden)).toBe(true);
  });

  it("keeps the Pages tab hidden while a guide choice is pending, after the matches view", () => {
    const { picker } = make();
    picker.setChoosing(true);
    picker.showMatches("x", matches, false);
    picker.open("games");
    expect(tabs(picker).map((t) => t.hidden)).toEqual([true, false, true]);
  });

  it("is not affected by page or game refreshes while showing", () => {
    const { picker } = make();
    picker.showMatches("x", matches, false);
    picker.setPages(pages, defaultLayout(pages, []));
    picker.setHubs(hubs, true);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-matches") as HTMLElement).hidden).toBe(false);
  });
});

describe("display settings", () => {
  const all = {
    keepAwake: true,
    hideChrome: true,
    guideJump: true,
    guideZoom: 100 as const,
    readerMode: true,
    layoutMode: "auto" as const,
    window: { width: 412, height: 915, layout: "tabs" as const },
    fullscreen: false,
    wakeLockSupported: true,
    fullscreenSupported: true,
    install: "hidden" as const,
    setupDismissed: false,
  };
  const row = (picker: { element: HTMLElement }, name: string): HTMLButtonElement =>
    picker.element.querySelector(`.picker-settings .${name}`) as HTMLButtonElement;
  const tab = (picker: { element: HTMLElement }): HTMLButtonElement =>
    picker.element.querySelector('[data-tab="settings"]') as HTMLButtonElement;

  it("adds a Display tab after Pages and Games that shows only the settings list", () => {
    const { picker } = make();
    picker.setSettings(all);
    expect(
      [...picker.element.querySelectorAll(".picker-tab")].map((t) => [
        (t as HTMLElement).dataset["tab"],
        t.textContent,
      ]),
    ).toEqual([
      ["pages", "Pages"],
      ["games", "Games"],
      ["settings", "Display"],
    ]);
    picker.open("pages");
    tab(picker).click();
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(false);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-games") as HTMLElement).hidden).toBe(true);
    expect(tab(picker).classList.contains("active")).toBe(true);
    (picker.element.querySelector('[data-tab="pages"]') as HTMLElement).click();
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(false);
  });

  it("holds the set-up card, seven setting buttons, then the readout and the install row", () => {
    const { picker } = make();
    picker.setSettings(all);
    const list = picker.element.querySelector(".picker-settings") as HTMLElement;
    expect(list.firstElementChild?.className).toBe("setup-card");
    const rows = [...list.querySelectorAll(":scope > button")];
    expect(rows.map((b) => b.className)).toEqual([
      "setting-keep-awake",
      "setting-hide-chrome",
      "setting-fullscreen",
      "setting-guide-jump",
      "setting-guide-zoom",
      "setting-reader-mode",
      "setting-layout",
    ]);
    expect(rows.every((b) => b.getAttribute("type") === "button")).toBe(true);
    expect(rows.at(-1)?.nextElementSibling?.className).toBe("setting-layout-readout");
    expect(list.lastElementChild?.className).toBe("setting-install");
    expect(list.querySelector(".setting-hint")).toBeNull();
  });

  it("labels each row for both states, with aria-pressed", () => {
    const { picker } = make();
    picker.setSettings(all);
    expect(row(picker, "setting-keep-awake").textContent).toBe("Keep screen on: on");
    expect(row(picker, "setting-keep-awake").getAttribute("aria-pressed")).toBe("true");
    expect(row(picker, "setting-hide-chrome").textContent).toBe("Outline bars: hidden");
    expect(row(picker, "setting-hide-chrome").getAttribute("aria-pressed")).toBe("true");
    expect(row(picker, "setting-fullscreen").textContent).toBe("Full screen: off");
    expect(row(picker, "setting-guide-jump").textContent).toBe("Guide jump from status: on");
    expect(row(picker, "setting-guide-jump").getAttribute("aria-pressed")).toBe("true");
    picker.setSettings({
      ...all,
      keepAwake: false,
      hideChrome: false,
      guideJump: false,
      fullscreen: true,
    });
    expect(row(picker, "setting-guide-jump").textContent).toBe("Guide jump from status: off");
    expect(row(picker, "setting-guide-jump").getAttribute("aria-pressed")).toBe("false");
    expect(row(picker, "setting-keep-awake").textContent).toBe("Keep screen on: off");
    expect(row(picker, "setting-keep-awake").getAttribute("aria-pressed")).toBe("false");
    expect(row(picker, "setting-hide-chrome").textContent).toBe("Outline bars: shown");
    expect(row(picker, "setting-hide-chrome").getAttribute("aria-pressed")).toBe("false");
    expect(row(picker, "setting-fullscreen").textContent).toBe("Full screen: on");
    expect(row(picker, "setting-fullscreen").getAttribute("aria-pressed")).toBe("true");
  });

  it("labels the reader mode row for both states, with aria-pressed, and never hides it", () => {
    const { picker } = make();
    picker.setSettings(all);
    expect(row(picker, "setting-reader-mode").textContent).toBe("Reader mode: on");
    expect(row(picker, "setting-reader-mode").getAttribute("aria-pressed")).toBe("true");
    picker.setSettings({ ...all, readerMode: false });
    expect(row(picker, "setting-reader-mode").textContent).toBe("Reader mode: off");
    expect(row(picker, "setting-reader-mode").getAttribute("aria-pressed")).toBe("false");
    picker.setSettings({ ...all, wakeLockSupported: false, fullscreenSupported: false });
    expect(row(picker, "setting-reader-mode").hidden).toBe(false);
  });

  it("keeps the picker open when the reader mode row is tapped", () => {
    const { picker, handlers } = make();
    picker.setSettings(all);
    picker.open("pages");
    tab(picker).click();
    row(picker, "setting-reader-mode").click();
    expect(handlers.onSetting).toHaveBeenCalledWith("readerMode");
    expect(picker.element.hidden).toBe(false);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("hides the rows the browser cannot support, and shows them again", () => {
    const { picker } = make();
    picker.setSettings({ ...all, wakeLockSupported: false, fullscreenSupported: false });
    expect(row(picker, "setting-keep-awake").hidden).toBe(true);
    expect(row(picker, "setting-fullscreen").hidden).toBe(true);
    expect(row(picker, "setting-hide-chrome").hidden).toBe(false);
    expect(row(picker, "setting-guide-jump").hidden).toBe(false);
    picker.setSettings(all);
    expect(row(picker, "setting-keep-awake").hidden).toBe(false);
    expect(row(picker, "setting-fullscreen").hidden).toBe(false);
  });

  it("reports a click on each row and leaves the picker open", () => {
    const { picker, handlers } = make();
    picker.setSettings(all);
    picker.open("pages");
    tab(picker).click();
    row(picker, "setting-keep-awake").click();
    row(picker, "setting-hide-chrome").click();
    row(picker, "setting-fullscreen").click();
    row(picker, "setting-guide-jump").click();
    row(picker, "setting-guide-zoom").click();
    row(picker, "setting-reader-mode").click();
    row(picker, "setting-layout").click();
    expect(handlers.onSetting.mock.calls).toEqual([
      ["keepAwake"],
      ["hideChrome"],
      ["fullscreen"],
      ["guideJump"],
      ["guideZoom"],
      ["readerMode"],
      ["layoutMode"],
    ]);
    expect(picker.element.hidden).toBe(false);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it.each([100, 90, 80, 70] as const)(
    "labels the guide text size row at %i percent",
    (guideZoom) => {
      const { picker } = make();
      picker.setSettings({ ...all, guideZoom });
      expect(row(picker, "setting-guide-zoom").textContent).toBe(`Guide text size: ${guideZoom}%`);
      expect(row(picker, "setting-guide-zoom").hasAttribute("aria-pressed")).toBe(false);
      expect(row(picker, "setting-guide-zoom").hidden).toBe(false);
    },
  );

  it.each([
    ["auto", "Layout: Automatic"],
    ["single", "Layout: Single"],
    ["tabs", "Layout: Bottom tabs"],
    ["split", "Layout: Two panes"],
  ] as const)("labels the layout row for %s", (layoutMode, text) => {
    const { picker } = make();
    picker.setSettings({ ...all, layoutMode });
    expect(row(picker, "setting-layout").textContent).toBe(text);
    expect(row(picker, "setting-layout").hasAttribute("aria-pressed")).toBe(false);
    expect(row(picker, "setting-layout").hidden).toBe(false);
  });

  const card = (picker: { element: HTMLElement }): HTMLElement =>
    picker.element.querySelector(".picker-settings .setup-card") as HTMLElement;
  const install = (picker: { element: HTMLElement }): HTMLElement =>
    picker.element.querySelector(".picker-settings .setting-install") as HTMLElement;
  const installButton = (picker: { element: HTMLElement }): HTMLButtonElement =>
    install(picker).querySelector(".setting-install-button") as HTMLButtonElement;
  const installText = (picker: { element: HTMLElement }): HTMLElement =>
    install(picker).querySelector(".setting-install-apple") as HTMLElement;

  it("shows the set-up card first, with its three lines and a Got it button", () => {
    const { picker } = make();
    picker.setSettings(all);
    expect(card(picker).hidden).toBe(false);
    expect(card(picker).querySelector(".setup-card-title")?.textContent).toBe("Set up this device");
    expect(
      [...card(picker).querySelectorAll(".setup-card-line")].map((p) => p.textContent),
    ).toEqual([
      "Install the app (see Install below).",
      "Sign in to Outline once inside the installed app; guide pages stay blank until you do.",
      "Reader mode is for touch screens; turn it off with a keyboard.",
    ]);
    const gotIt = card(picker).querySelector("button.setup-card-dismiss") as HTMLButtonElement;
    expect(gotIt.textContent).toBe("Got it");
    expect(gotIt.getAttribute("type")).toBe("button");
  });

  it.each([
    ["hidden", true],
    ["prompt", false],
    ["apple", false],
  ] as const)(
    "shows the card's install line only while the Install row shows (install %s)",
    (installState, lineHidden) => {
      const { picker } = make();
      picker.setSettings({ ...all, install: installState });
      const lines = [...card(picker).querySelectorAll<HTMLElement>(".setup-card-line")];
      expect(lines[0]?.textContent).toBe("Install the app (see Install below).");
      expect(lines.map((l) => l.hidden)).toEqual([lineHidden, false, false]);
      expect(install(picker).hidden).toBe(lineHidden);
    },
  );

  it("brings the card's install line back when the browser offers an install", () => {
    const { picker } = make();
    picker.setSettings({ ...all, install: "hidden" });
    const first = card(picker).querySelector(".setup-card-line") as HTMLElement;
    expect(first.hidden).toBe(true);
    picker.setSettings({ ...all, install: "prompt" });
    expect(first.hidden).toBe(false);
  });

  it("reports Got it, leaves the picker open, and hides the card once dismissed", () => {
    const { picker, handlers } = make();
    picker.setSettings(all);
    picker.open("pages");
    tab(picker).click();
    (card(picker).querySelector(".setup-card-dismiss") as HTMLButtonElement).click();
    expect(handlers.onDismissSetup).toHaveBeenCalledTimes(1);
    expect(handlers.onSetting).not.toHaveBeenCalled();
    expect(picker.element.hidden).toBe(false);
    picker.setSettings({ ...all, setupDismissed: true });
    expect(card(picker).hidden).toBe(true);
  });

  it("offers an Install app button when the browser has an install prompt", () => {
    const { picker, handlers } = make();
    picker.setSettings({ ...all, install: "prompt" });
    picker.open("pages");
    tab(picker).click();
    expect(install(picker).hidden).toBe(false);
    expect(installButton(picker).hidden).toBe(false);
    expect(installButton(picker).textContent).toBe("Install app");
    expect(installButton(picker).getAttribute("type")).toBe("button");
    expect(installText(picker).hidden).toBe(true);
    installButton(picker).click();
    expect(handlers.onInstall).toHaveBeenCalledTimes(1);
    expect(handlers.onSetting).not.toHaveBeenCalled();
    expect(picker.element.hidden).toBe(false);
  });

  it("tells an iPhone or iPad how to add it to the home screen", () => {
    const { picker } = make();
    picker.setSettings({ ...all, install: "apple" });
    expect(install(picker).hidden).toBe(false);
    expect(installButton(picker).hidden).toBe(true);
    expect(installText(picker).hidden).toBe(false);
    expect(installText(picker).textContent).toBe("Install: Share › Add to Home Screen");
  });

  it("hides the install row when there is nothing to offer, and brings it back", () => {
    const { picker } = make();
    picker.setSettings({ ...all, install: "hidden" });
    expect(install(picker).hidden).toBe(true);
    picker.setSettings({ ...all, install: "prompt" });
    expect(install(picker).hidden).toBe(false);
    picker.setSettings({ ...all, install: "hidden" });
    expect(install(picker).hidden).toBe(true);
  });

  it("shows the window readout with the resolved layout, never Automatic", () => {
    const { picker } = make();
    const readout = (): string | null | undefined =>
      picker.element.querySelector(".picker-settings .setting-layout-readout")?.textContent;
    picker.setSettings(all);
    expect(readout()).toBe("Window 412 \u00d7 915 (2.22) \u00b7 Bottom tabs");
    picker.setSettings({ ...all, window: { width: 884, height: 1004, layout: "split" } });
    expect(readout()).toBe("Window 884 \u00d7 1004 (1.14) \u00b7 Two panes");
    picker.setSettings({
      ...all,
      layoutMode: "single",
      window: { width: 411, height: 470, layout: "single" },
    });
    expect(readout()).toBe("Window 411 \u00d7 470 (1.14) \u00b7 Single");
  });

  it("keeps the picker open when the guide text size row is tapped", () => {
    const { picker, handlers } = make();
    picker.setSettings(all);
    picker.open("pages");
    tab(picker).click();
    row(picker, "setting-guide-zoom").click();
    expect(handlers.onSetting).toHaveBeenCalledWith("guideZoom");
    expect(picker.element.hidden).toBe(false);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("hides the Display tab while a guide choice is pending, and brings it back", () => {
    const { picker } = make();
    picker.setChoosing(true);
    picker.open("games");
    expect(tab(picker).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(true);
    tab(picker).click();
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(true);
    picker.setChoosing(false);
    expect(tab(picker).hidden).toBe(false);
  });

  it("hides the Display tab and the settings while matches are shown, and restores them", () => {
    const { picker } = make();
    picker.open("pages");
    tab(picker).click();
    picker.showMatches("x", [], false);
    expect(tab(picker).hidden).toBe(true);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(true);
    picker.open("pages");
    expect(tab(picker).hidden).toBe(false);
    expect((picker.element.querySelector(".picker-settings") as HTMLElement).hidden).toBe(true);
  });

  it("restores the tab after the matches view is closed", () => {
    const { picker } = make();
    picker.showMatches("x", [], false);
    (picker.element.querySelector(".picker-close") as HTMLElement).click();
    expect(tab(picker).hidden).toBe(false);
  });
});

describe("your links", () => {
  const linkA: GameLink = { title: "Sample Map", url: "https://links.example.test/map" };
  const linkB: GameLink = {
    title: "<b>Planner</b>",
    url: "https://links.example.test/plan?x=1&y=2",
  };
  const emptyLayout = () => defaultLayout([], []);
  const section = (picker: { element: HTMLElement }) =>
    picker.element.querySelector(".picker-pages .picker-links") as HTMLElement;
  const rows = (picker: { element: HTMLElement }) => [
    ...picker.element.querySelectorAll<HTMLElement>(".picker-link"),
  ];
  const fill = (picker: { element: HTMLElement }, name: string, url: string) => {
    (picker.element.querySelector(".picker-link-name") as HTMLInputElement).value = name;
    (picker.element.querySelector(".picker-link-url") as HTMLInputElement).value = url;
  };
  const submit = (picker: { element: HTMLElement }) => {
    const form = picker.element.querySelector(".picker-link-add") as HTMLFormElement;
    const event = new Event("submit", { cancelable: true, bubbles: true });
    form.dispatchEvent(event);
    return event;
  };

  it("is hidden until the game has links available, and when it is not", () => {
    const { picker } = make();
    expect(section(picker).hidden).toBe(true);
    picker.setLinks([], emptyLayout(), true);
    expect(section(picker).hidden).toBe(false);
    picker.setLinks([linkA], emptyLayout(), false);
    expect(section(picker).hidden).toBe(true);
  });

  it("shows the heading and the form even with no links, and no guide pages", () => {
    const { picker } = make();
    picker.setPages([], emptyLayout());
    picker.setLinks([], emptyLayout(), true);
    picker.open("pages");
    expect(section(picker).hidden).toBe(false);
    expect(section(picker).querySelector("h3.picker-links-title")?.textContent).toBe("Your links");
    expect(rows(picker)).toHaveLength(0);
    const form = section(picker).querySelector("form.picker-link-add") as HTMLFormElement;
    const name = form.querySelector("input.picker-link-name") as HTMLInputElement;
    const url = form.querySelector("input.picker-link-url") as HTMLInputElement;
    expect(name.getAttribute("type")).toBe("text");
    expect(name.getAttribute("placeholder")).toBe("Name");
    expect(name.getAttribute("maxlength")).toBe("40");
    expect(url.getAttribute("type")).toBe("url");
    expect(url.getAttribute("inputmode")).toBe("url");
    expect(url.getAttribute("placeholder")).toBe("https://…");
    expect(url.getAttribute("autocapitalize")).toBe("off");
    expect(url.getAttribute("autocomplete")).toBe("off");
    expect(url.getAttribute("spellcheck")).toBe("false");
    const button = form.querySelector('button[type="submit"]') as HTMLElement;
    expect(button.textContent).toBe("Add");
    expect(form.querySelector(".picker-link-error")?.textContent).toBe("");
  });

  it("lists the section below the guide's pages", () => {
    const { picker } = make();
    picker.setLinks([linkA], emptyLayout(), true);
    const children = [...(picker.element.querySelector(".picker-pages") as HTMLElement).children];
    expect(children.at(-1)).toBe(section(picker));
    const pageRows = picker.element.querySelector(".picker-page-rows") as HTMLElement;
    expect(pageRows.querySelector(".picker-row")).not.toBeNull();
    expect(children.indexOf(pageRows)).toBe(children.indexOf(section(picker)) - 1);
    // Redrawing the pages keeps the section last.
    picker.setPages(pages, emptyLayout());
    expect(
      [...(picker.element.querySelector(".picker-pages") as HTMLElement).children].at(-1),
    ).toBe(section(picker));
    expect(rows(picker)).toHaveLength(1);
  });

  it("draws a row per link: title, open anchor and remove button", () => {
    const { picker } = make();
    picker.setLinks([linkA, linkB], emptyLayout(), true);
    expect(rows(picker)).toHaveLength(2);
    const [first, second] = rows(picker);
    expect(first?.classList.contains("picker-row")).toBe(true);
    expect(first?.querySelector(".picker-item .picker-title")?.textContent).toBe("Sample Map");
    const open = first?.querySelector("a.picker-link-open") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(linkA.url);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("aria-label")).toBe("Open in a new tab");
    expect(open.textContent).toBe("↗");
    const remove = first?.querySelector("button.picker-link-remove") as HTMLElement;
    expect(remove.textContent).toBe("Remove");
    expect(remove.getAttribute("type")).toBe("button");
    expect(remove.getAttribute("aria-label")).toBe("Remove Sample Map");
    expect(second?.querySelector("a.picker-link-open")?.getAttribute("href")).toBe(linkB.url);
    expect(picker.element.querySelector("button button")).toBeNull();
  });

  it("shows a title containing markup literally", () => {
    const { picker } = make();
    picker.setLinks([linkB], emptyLayout(), true);
    const row = rows(picker)[0];
    expect(row?.querySelector(".picker-title")?.textContent).toBe("<b>Planner</b>");
    expect(row?.querySelector("b")).toBeNull();
    expect(row?.querySelector(".picker-link-remove")?.getAttribute("aria-label")).toBe(
      "Remove <b>Planner</b>",
    );
  });

  it("marks a pinned link and offers the same unpin button as a page", () => {
    const { picker, handlers } = make();
    const layout = assignSlot(emptyLayout(), linkA);
    picker.setLinks([linkA, linkB], layout, true);
    const [first, second] = rows(picker);
    expect(first?.querySelector(".picker-item")?.classList.contains("pinned")).toBe(true);
    expect(second?.querySelector(".picker-item")?.classList.contains("pinned")).toBe(false);
    expect(first?.querySelector(".picker-unpin")?.getAttribute("aria-label")).toBe(
      "Remove Sample Map from the sidebar",
    );
    expect(first?.querySelector(".picker-unpin")?.textContent).toBe("✕");
    expect(second?.querySelector(".picker-unpin")).toBeNull();
    (first?.querySelector(".picker-unpin") as HTMLElement).click();
    expect(handlers.onUnpin).toHaveBeenCalledWith(linkA);
    expect(handlers.onLink).not.toHaveBeenCalled();
  });

  it("a tap on a link reports it and closes the picker", () => {
    const { picker, handlers } = make();
    picker.setLinks([linkA], emptyLayout(), true);
    picker.open("pages");
    (rows(picker)[0]?.querySelector(".picker-item") as HTMLElement).click();
    expect(handlers.onLink).toHaveBeenCalledWith(linkA);
    expect(handlers.onPage).not.toHaveBeenCalled();
    expect(picker.element.hidden).toBe(true);
  });

  it("a tap on Remove reports the address and leaves the picker open", () => {
    const { picker, handlers } = make();
    picker.setLinks([linkA], emptyLayout(), true);
    picker.open("pages");
    (rows(picker)[0]?.querySelector(".picker-link-remove") as HTMLElement).click();
    expect(handlers.onRemoveLink).toHaveBeenCalledWith(linkA.url);
    expect(handlers.onLink).not.toHaveBeenCalled();
    expect(picker.element.hidden).toBe(false);
  });

  it("submitting reports both values, clears the inputs on success and never navigates", () => {
    const { picker, handlers } = make();
    picker.setLinks([], emptyLayout(), true);
    fill(picker, "Sample Map", "https://links.example.test/map");
    const event = submit(picker);
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onAddLink).toHaveBeenCalledWith("Sample Map", "https://links.example.test/map");
    expect((picker.element.querySelector(".picker-link-name") as HTMLInputElement).value).toBe("");
    expect((picker.element.querySelector(".picker-link-url") as HTMLInputElement).value).toBe("");
    expect(picker.element.querySelector(".picker-link-error")?.textContent).toBe("");
  });

  it("shows the returned error, keeps the inputs, and clears it after a success", () => {
    const { picker, handlers } = make();
    picker.setLinks([], emptyLayout(), true);
    handlers.onAddLink.mockReturnValueOnce("Enter an address that starts with https://");
    fill(picker, "x", "nonsense");
    expect(submit(picker).defaultPrevented).toBe(true);
    expect(picker.element.querySelector(".picker-link-error")?.textContent).toBe(
      "Enter an address that starts with https://",
    );
    expect((picker.element.querySelector(".picker-link-name") as HTMLInputElement).value).toBe("x");
    expect((picker.element.querySelector(".picker-link-url") as HTMLInputElement).value).toBe(
      "nonsense",
    );
    fill(picker, "x", "https://links.example.test/");
    submit(picker);
    expect(picker.element.querySelector(".picker-link-error")?.textContent).toBe("");
  });

  it("keeps the form element, its focus and its text across redraws of pages and links", () => {
    const { picker } = make();
    document.body.append(picker.element);
    picker.setLinks([], emptyLayout(), true);
    picker.open("pages");
    const form = picker.element.querySelector(".picker-link-add");
    const input = picker.element.querySelector(".picker-link-url") as HTMLInputElement;
    input.focus();
    input.value = "https://links.exa";
    expect(document.activeElement).toBe(input);
    picker.setPages(pages, emptyLayout());
    picker.setLinks([linkA], emptyLayout(), true);
    picker.setPages([], emptyLayout());
    expect(picker.element.querySelector(".picker-link-add")).toBe(form);
    expect(picker.element.querySelector(".picker-link-url")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("https://links.exa");
    picker.element.remove();
  });

  it("keeps what was typed when the list is redrawn", () => {
    const { picker } = make();
    picker.setLinks([], emptyLayout(), true);
    fill(picker, "Half", "https://links.exa");
    picker.setLinks([linkA], emptyLayout(), true);
    expect((picker.element.querySelector(".picker-link-name") as HTMLInputElement).value).toBe(
      "Half",
    );
    expect((picker.element.querySelector(".picker-link-url") as HTMLInputElement).value).toBe(
      "https://links.exa",
    );
  });

  it("is not reachable while a guide chooser or a matches list shows", () => {
    const { picker } = make();
    picker.setLinks([linkA], emptyLayout(), true);
    picker.setChoosing(true);
    picker.open("pages");
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
    picker.setChoosing(false);
    picker.open("pages");
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(false);
    picker.showMatches("sample", [], false);
    expect((picker.element.querySelector(".picker-pages") as HTMLElement).hidden).toBe(true);
  });
});
