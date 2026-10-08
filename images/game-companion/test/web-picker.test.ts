// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createPicker } from "../src/web/picker.js";
import { defaultLayout } from "../src/web/state.js";
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
    platformLabel: "RA · PS2",
    nowPlaying: true,
  },
  {
    hubId: "h1",
    title: "Zeta Game",
    url: "/doc/zeta",
    source: "steam",
    gameId: "10",
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
    fullscreen: false,
    wakeLockSupported: true,
    fullscreenSupported: true,
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

  it("holds five buttons and a hint, the guide text size last before the hint", () => {
    const { picker } = make();
    picker.setSettings(all);
    const list = picker.element.querySelector(".picker-settings") as HTMLElement;
    const rows = [...list.querySelectorAll("button")];
    expect(rows.map((b) => b.className)).toEqual([
      "setting-keep-awake",
      "setting-hide-chrome",
      "setting-fullscreen",
      "setting-guide-jump",
      "setting-guide-zoom",
    ]);
    expect(list.lastElementChild?.className).toBe("setting-hint");
    expect(rows.every((b) => b.getAttribute("type") === "button")).toBe(true);
    const hint = list.querySelector("p.setting-hint");
    expect(hint?.textContent).toBe(
      "To use it like an app, open the browser menu and choose Add to Home screen.",
    );
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

  it("hides the rows the browser cannot support, and shows them again", () => {
    const { picker } = make();
    picker.setSettings({ ...all, wakeLockSupported: false, fullscreenSupported: false });
    expect(row(picker, "setting-keep-awake").hidden).toBe(true);
    expect(row(picker, "setting-fullscreen").hidden).toBe(true);
    expect(row(picker, "setting-hide-chrome").hidden).toBe(false);
    expect(row(picker, "setting-guide-jump").hidden).toBe(false);
    expect(picker.element.querySelector(".setting-hint")).not.toBeNull();
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
    expect(handlers.onSetting.mock.calls).toEqual([
      ["keepAwake"],
      ["hideChrome"],
      ["fullscreen"],
      ["guideJump"],
      ["guideZoom"],
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
