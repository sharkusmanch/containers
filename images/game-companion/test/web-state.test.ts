import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  LINKS_MAX,
  SLOT_COUNT,
  activate,
  addLink,
  assignSlot,
  compactLayout,
  defaultLayout,
  docId,
  flattenPages,
  gameKey,
  isSafeDocUrl,
  isSafeLinkUrl,
  layoutKey,
  linksKey,
  loadLayout,
  loadLinks,
  normaliseLink,
  reconcileLayout,
  removeLink,
  removeSlot,
  saveLayout,
  saveLinks,
  slotLabel,
  type GameLink,
  type Layout,
} from "../src/web/state.js";
import type { GuidePage } from "../src/shared/types.js";

const page = (title: string, url: string, children: GuidePage[] = []): GuidePage => ({
  title,
  url,
  children,
});
const titles = ["Achievement Checklist", "Blind Playthrough Essentials"];
const pages = [
  page("Research Notes", "/doc/research", [page("Phase 1", "/doc/p1")]),
  page("Blind Playthrough Essentials", "/doc/bpe"),
  page("Achievement Checklist", "/doc/checklist"),
  page("Collectibles", "/doc/coll", [page("Collectibles: Area One", "/doc/area1")]),
];

function memory(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("isSafeDocUrl", () => {
  it.each([
    ["/doc/abc", true],
    ["/doc/a-b-c-XyZ123", true],
    ["https://evil.example/doc/abc", false],
    ["//evil.example/doc/abc", false],
    ["/doc//evil", false],
    ["/doc/..", false],
    ["/doc/%2e%2e", false],
    ["/doc/a/../b", false],
    ["/doc/a.b", false],
    ["/docs/abc", false],
    ["javascript:alert(1)", false],
    ["/doc/a\\b", false],
    ["/collection/x", false],
    ["", false],
  ])("%s → %s", (url, ok) => expect(isSafeDocUrl(url)).toBe(ok));
});

describe("flattenPages", () => {
  it("walks depth-first", () => {
    expect(flattenPages(pages).map((p) => p.url)).toEqual([
      "/doc/research",
      "/doc/p1",
      "/doc/bpe",
      "/doc/checklist",
      "/doc/coll",
      "/doc/area1",
    ]);
  });
});

describe("defaultLayout", () => {
  it("pins the given titles in order and starts on achievements", () => {
    const l = defaultLayout(pages, titles);
    expect(l.slots).toHaveLength(SLOT_COUNT);
    expect(l.slots[0]).toEqual({ title: "Achievement Checklist", url: "/doc/checklist" });
    expect(l.slots[1]).toEqual({ title: "Blind Playthrough Essentials", url: "/doc/bpe" });
    expect(l.slots[2]).toBeNull();
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("pins nothing when no titles are given", () => {
    const l = defaultLayout(pages, []);
    expect(l.slots).toEqual([null, null, null, null]);
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("follows the order of the titles, not the order of the tree", () => {
    const l = defaultLayout(pages, ["Collectibles", "Blind Playthrough Essentials"]);
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/coll", "/doc/bpe", null, null]);
  });

  it("leaves every slot empty when the guide has none of the pages", () => {
    expect(defaultLayout([page("Other", "/doc/o")], titles).slots).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("skips a title that matches no page without leaving a gap", () => {
    const l = defaultLayout(pages, ["Missing", "Collectibles", "Also Missing", "Research Notes"]);
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/coll", "/doc/research", null, null]);
  });

  it("fills only the available slots when there are more titles than slots", () => {
    const many = Array.from({ length: SLOT_COUNT + 2 }, (_, i) => page(`P${i}`, `/doc/p${i}x`));
    const l = defaultLayout(
      many,
      many.map((p) => p.title),
    );
    expect(l.slots.every((s) => s !== null)).toBe(true);
    expect(l.slots.map((s) => s?.title)).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("does not pin the same page twice", () => {
    const l = defaultLayout(pages, ["Collectibles", "Collectibles"]);
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/coll", null, null, null]);
  });

  it("finds a page when it is nested", () => {
    const nested = [page("Top", "/doc/top", [page("Achievement Checklist", "/doc/c2")])];
    expect(defaultLayout(nested, titles).slots[0]?.url).toBe("/doc/c2");
  });

  it("ignores a matching page whose URL is not a safe doc path", () => {
    const l = defaultLayout([page("Unsafe", "https://evil.example/x")], ["Unsafe"]);
    expect(l.slots).toEqual([null, null, null, null]);
  });
});

describe("assignSlot", () => {
  const start = defaultLayout(pages, titles);

  it("activates the slot that already holds the page", () => {
    const l = assignSlot(start, { title: "Blind Playthrough Essentials", url: "/doc/bpe" });
    expect(l.active).toBe(1);
    expect(l.slots).toEqual(start.slots);
  });

  it("fills the first empty slot", () => {
    const l = assignSlot(start, { title: "Collectibles", url: "/doc/coll" });
    expect(l.slots[2]?.url).toBe("/doc/coll");
    expect(l.active).toBe(2);
  });

  it("replaces the active guide slot when all are full", () => {
    let l = start;
    l = assignSlot(l, { title: "A", url: "/doc/a" });
    l = assignSlot(l, { title: "B", url: "/doc/b" });
    l = activate(l, 1);
    l = assignSlot(l, { title: "C", url: "/doc/c" });
    expect(l.slots[1]?.url).toBe("/doc/c");
    expect(l.active).toBe(1);
  });

  it("replaces the last slot when all are full and achievements is active", () => {
    let l = start;
    l = assignSlot(l, { title: "A", url: "/doc/a" });
    l = assignSlot(l, { title: "B", url: "/doc/b" });
    l = activate(l, ACHIEVEMENTS);
    l = assignSlot(l, { title: "C", url: "/doc/c" });
    expect(l.slots[SLOT_COUNT - 1]?.url).toBe("/doc/c");
    expect(l.active).toBe(SLOT_COUNT - 1);
  });

  it("ignores an unsafe URL", () => {
    expect(assignSlot(start, { title: "Evil", url: "http://evil.example/doc/x" })).toEqual(start);
  });

  it("does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(start)) as Layout;
    assignSlot(start, { title: "Collectibles", url: "/doc/coll" });
    expect(start).toEqual(copy);
  });
});

describe("activate", () => {
  it("ignores an empty slot and an out-of-range index", () => {
    const l = defaultLayout(pages, titles);
    expect(activate(l, 3)).toEqual(l);
    expect(activate(l, 9)).toEqual(l);
    expect(activate(l, 0).active).toBe(0);
  });
});

describe("slotLabel", () => {
  it.each([
    ["Achievement Checklist", "AC"],
    ["Blind Playthrough Essentials", "BP"],
    ["Collectibles", "CO"],
    ["Collectibles: Basalt Hills", "CB"],
    ["Strategies: Side, Global", "SS"],
    ["  ", "?"],
    ["éclair notes", "ÉN"],
    ["100% Run", "1R"],
  ])("%s → %s", (title, label) => expect(slotLabel(title)).toBe(label));
});

describe("layout storage", () => {
  it("closes gaps in a layout stored by an earlier version", () => {
    const s = memory();
    s.setItem(
      layoutKey("h1"),
      JSON.stringify({
        slots: [null, { title: "A", url: "/doc/a" }, null, { title: "B", url: "/doc/b" }],
        active: 3,
      }),
    );
    expect(loadLayout(s, "h1")).toEqual({
      slots: [{ title: "A", url: "/doc/a" }, { title: "B", url: "/doc/b" }, null, null],
      active: 1,
    });
  });

  it("round-trips a layout under a prefixed key", () => {
    const s = memory();
    const l = assignSlot(defaultLayout(pages, titles), { title: "Collectibles", url: "/doc/coll" });
    saveLayout(s, "h1", l);
    expect([...s.data.keys()]).toEqual([layoutKey("h1")]);
    expect(layoutKey("h1")).toBe("game-companion:v1:layout:h1");
    expect(loadLayout(s, "h1")).toEqual(l);
  });

  it.each([
    "not json",
    "{}",
    '{"slots":[],"active":0}',
    '{"slots":[null,null,null,null],"active":7}',
    '{"slots":[{"title":"x","url":"http://evil.example"},null,null,null],"active":-1}',
    '{"slots":[{"title":"x","url":"javascript:alert(1)"},null,null,null],"active":-1}',
    '{"slots":[null,null,null,null],"active":2}',
  ])("rejects a corrupt or unsafe stored value: %s", (raw) => {
    const s = memory();
    s.setItem(layoutKey("h1"), raw);
    expect(loadLayout(s, "h1")).toBeNull();
  });

  it("returns null when storage throws", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadLayout(s, "h1")).toBeNull();
    expect(() => saveLayout(s, "h1", defaultLayout(pages, titles))).not.toThrow();
  });
});

describe("gameKey", () => {
  it("identifies games by source and id, or by title for a shortcut", () => {
    expect(gameKey({ source: "steam", id: "10", title: "A" })).toBe("steam:10");
    expect(gameKey({ source: "ra", id: "20", title: "B" })).toBe("ra:20");
    expect(gameKey({ source: "steam", id: null, title: "Emulator" })).toBe("steam:?Emulator");
    expect(gameKey(null)).toBe("");
  });
});

describe("compactLayout", () => {
  const slot = (n: string) => ({ title: n, url: `/doc/${n}` });

  it("moves pinned pages to the front in order and keeps the length", () => {
    const l = compactLayout({ slots: [null, slot("a"), null, slot("b")], active: ACHIEVEMENTS });
    expect(l.slots).toEqual([slot("a"), slot("b"), null, null]);
    expect(l.slots).toHaveLength(SLOT_COUNT);
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("makes the active index follow its page", () => {
    expect(compactLayout({ slots: [null, slot("a"), null, slot("b")], active: 3 }).active).toBe(1);
    expect(compactLayout({ slots: [null, slot("a"), null, slot("b")], active: 1 }).active).toBe(0);
  });

  it("returns the same object when there is nothing to move", () => {
    const compact: Layout = { slots: [slot("a"), slot("b"), null, null], active: 1 };
    expect(compactLayout(compact)).toBe(compact);
    const empty: Layout = { slots: [null, null, null, null], active: ACHIEVEMENTS };
    expect(compactLayout(empty)).toBe(empty);
  });

  it("does not mutate its input", () => {
    const start: Layout = { slots: [null, slot("a"), null, slot("b")], active: 3 };
    const copy = JSON.parse(JSON.stringify(start)) as Layout;
    compactLayout(start);
    expect(start).toEqual(copy);
  });
});

describe("removeSlot", () => {
  const full = (): Layout => {
    let l = defaultLayout(pages, titles); // slot 0 checklist, slot 1 essentials
    l = assignSlot(l, { title: "Collectibles", url: "/doc/coll" }); // slot 2, active 2
    return l;
  };

  it("closes the gap: later pages move up and the active page is followed", () => {
    const l = removeSlot(full(), "/doc/bpe");
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/checklist", "/doc/coll", null, null]);
    expect(l.active).toBe(1);
  });

  it("keeps the active page when an earlier page is removed", () => {
    const l = removeSlot(activate(full(), 1), "/doc/checklist");
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/bpe", "/doc/coll", null, null]);
    expect(l.active).toBe(0);
  });

  it("falls back to achievements when the active page is removed", () => {
    const l = removeSlot(full(), "/doc/coll");
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/checklist", "/doc/bpe", null, null]);
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("returns the same object when the page is not pinned", () => {
    const start = full();
    expect(removeSlot(start, "/doc/not-there")).toBe(start);
  });

  it("does not mutate its input", () => {
    const start = full();
    const copy = JSON.parse(JSON.stringify(start)) as Layout;
    removeSlot(start, "/doc/checklist");
    expect(start).toEqual(copy);
  });

  it("puts the next added page directly after the remaining ones", () => {
    const l = assignSlot(removeSlot(full(), "/doc/checklist"), { title: "New", url: "/doc/new" });
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/bpe", "/doc/coll", "/doc/new", null]);
    expect(l.active).toBe(2);
  });
});

describe("docId", () => {
  it.each([
    ["/doc/achievement-checklist-abc1234567", "abc1234567"],
    ["/doc/x", "x"],
    ["/doc/a-very-long-title-with-many-hyphens-Q9", "Q9"],
    ["/doc/-id", "id"],
  ])("takes the part after the last hyphen of %s", (url, id) => {
    expect(docId(url)).toBe(id);
  });
});

describe("reconcileLayout", () => {
  const tree: GuidePage[] = [
    page("Achievement Checklist", "/doc/achievement-checklist-AAA"),
    page("Notes", "/doc/notes-BBB", [page("Deep Page", "/doc/deep-page-CCC")]),
  ];
  const slot = (title: string, url: string) => ({ title, url });

  it("follows a retitled page: the slot takes the current title and url", () => {
    const l = reconcileLayout(
      { slots: [slot("Old Name", "/doc/old-name-AAA"), null, null, null], active: 0 },
      tree,
    );
    expect(l.slots[0]).toEqual(slot("Achievement Checklist", "/doc/achievement-checklist-AAA"));
    expect(l.active).toBe(0);
  });

  it("finds pages at any depth", () => {
    const l = reconcileLayout(
      { slots: [slot("Old Deep", "/doc/old-deep-CCC"), null, null, null], active: ACHIEVEMENTS },
      tree,
    );
    expect(l.slots[0]).toEqual(slot("Deep Page", "/doc/deep-page-CCC"));
  });

  it("empties the slot of a deleted page and closes the gap", () => {
    const l = reconcileLayout(
      {
        slots: [slot("Gone", "/doc/gone-ZZZ"), slot("Notes", "/doc/notes-BBB"), null, null],
        active: 1,
      },
      tree,
    );
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/notes-BBB", null, null, null]);
    expect(l.active).toBe(0);
  });

  it("goes to achievements when the active page is deleted, keeping the other pins", () => {
    const l = reconcileLayout(
      {
        slots: [slot("Notes", "/doc/notes-BBB"), slot("Gone", "/doc/gone-ZZZ"), null, null],
        active: 1,
      },
      tree,
    );
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/notes-BBB", null, null, null]);
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("does not mutate its input", () => {
    const start: Layout = {
      slots: [slot("Old Name", "/doc/old-name-AAA"), slot("Gone", "/doc/gone-ZZZ"), null, null],
      active: 0,
    };
    const copy = JSON.parse(JSON.stringify(start)) as Layout;
    reconcileLayout(start, tree);
    expect(start).toEqual(copy);
  });
});

describe("isSafeLinkUrl", () => {
  it.each([
    "https://links.example.test/",
    "https://links.example.test/a/b",
    "https://links.example.test/a?x=1&y=2#top",
    "https://links.example.test:8443/a",
    "https://xn--bcher-kva.example.test/a",
  ])("accepts the canonical address %s", (url) => expect(isSafeLinkUrl(url)).toBe(true));

  it.each([
    "https://links.example.test",
    "https://bücher.example.test/a",
    "HTTPS://LINKS.EXAMPLE.TEST/a",
    "https:/doc/abc",
    " https://links.example.test/a",
    "https://links.example.test/a ",
    "https://links.example.test/\ta",
    "https://links.example.test/a\n",
    "http://links.example.test/a",
    "javascript:alert(1)",
    "data:text/html,hello",
    "blob:https://links.example.test/abc",
    "//links.example.test/x",
    "/doc/x",
    "https://user:pass@links.example.test/a",
    "https://user@links.example.test/a",
    "https://:pass@links.example.test/a",
    "https://",
    "not a url",
    "",
    `https://links.example.test/${"a".repeat(1990)}`,
  ])("rejects %s", (url) => expect(isSafeLinkUrl(url)).toBe(false));

  it("accepts exactly 2000 characters and rejects 2001", () => {
    const base = "https://links.example.test/";
    expect(isSafeLinkUrl(base + "a".repeat(2000 - base.length))).toBe(true);
    expect(isSafeLinkUrl(base + "a".repeat(2001 - base.length))).toBe(false);
  });

  it("rejects a non-string without throwing", () => {
    for (const value of [null, undefined, 5, {}, ["https://links.example.test"]]) {
      expect(isSafeLinkUrl(value as string)).toBe(false);
    }
  });
});

describe("normaliseLink", () => {
  it("trims both and stores the normalised address", () => {
    expect(normaliseLink("  Sample Map  ", "  HTTPS://Links.Example.Test  ")).toEqual({
      title: "Sample Map",
      url: "https://links.example.test/",
    });
  });

  it("uses the hostname when the title is empty", () => {
    expect(normaliseLink("   ", "https://links.example.test:8443/a")).toEqual({
      title: "links.example.test",
      url: "https://links.example.test:8443/a",
    });
  });

  it("cuts a default title (the hostname) to 40 characters too", () => {
    const host = `${"a".repeat(30)}.${"b".repeat(30)}.example.test`;
    const link = normaliseLink("", `https://${host}/x`);
    expect(link?.title).toBe(host.slice(0, 40));
    expect(link?.url).toBe(`https://${host}/x`);
  });

  it("refuses an address that is longer once canonical, though the typed text was short", () => {
    const typed = `https://links.example.test/${"漢".repeat(400)}`;
    expect(typed.length).toBeLessThan(2000);
    expect(new URL(typed).href.length).toBeGreaterThan(2000);
    expect(normaliseLink("T", typed)).toBeNull();
  });

  it("canonicalises sloppy typed input, and what it returns passes its own check", () => {
    const link = normaliseLink("T", "  HTTPS://Links.Example.Test  ");
    expect(link?.url).toBe("https://links.example.test/");
    expect(isSafeLinkUrl(link?.url ?? "")).toBe(true);
    const idn = normaliseLink("T", "https://bücher.example.test/a");
    expect(isSafeLinkUrl(idn?.url ?? "")).toBe(true);
  });

  it("cuts the title to 40 characters without splitting a surrogate pair", () => {
    const plain = normaliseLink("x".repeat(60), "https://links.example.test/a");
    expect(plain?.title).toBe("x".repeat(40));
    const pairs = normaliseLink("😀".repeat(30), "https://links.example.test/a");
    expect(pairs?.title).toBe("😀".repeat(30));
    const edge = normaliseLink(`${"y".repeat(39)}😀tail`, "https://links.example.test/a");
    expect(edge?.title).toBe(`${"y".repeat(39)}😀`);
    expect(Array.from(edge?.title ?? "")).toHaveLength(40);
  });

  it.each([
    ["http://links.example.test/a"],
    ["javascript:alert(1)"],
    ["/doc/x"],
    ["https://u:p@links.example.test/"],
    [""],
    ["nonsense"],
  ])("returns null for %s", (url) => expect(normaliseLink("T", url)).toBeNull());
});

describe("link storage", () => {
  const a: GameLink = { title: "A", url: "https://links.example.test/a" };
  const b: GameLink = { title: "B", url: "https://links.example.test/b" };

  it("uses a prefixed key and round-trips", () => {
    const s = memory();
    expect(linksKey("h1")).toBe("game-companion:v1:links:h1");
    saveLinks(s, "h1", [a, b]);
    expect([...s.data.keys()]).toEqual([linksKey("h1")]);
    expect(loadLinks(s, "h1")).toEqual([a, b]);
    expect(loadLinks(s, "other")).toEqual([]);
  });

  it.each(["not json", "{}", "null", '"x"', "5"])("loads nothing from %s", (raw) => {
    const s = memory();
    s.setItem(linksKey("h1"), raw);
    expect(loadLinks(s, "h1")).toEqual([]);
  });

  it.each([
    ["a malformed scheme separator", "https:/doc/abc"],
    ["a leading space", " https://links.example.test/a"],
    ["an embedded tab", "https://links.example.test/\ta"],
    ["a non-canonical host", "HTTPS://Links.Example.Test/a"],
  ])("drops a stored address with %s", (_name, url) => {
    const s = memory();
    s.setItem(linksKey("h1"), JSON.stringify([{ title: "Bad", url }, a]));
    expect(loadLinks(s, "h1")).toEqual([a]);
  });

  it("saveLinks says whether it stored, and never throws", () => {
    const s = memory();
    expect(saveLinks(s, "h1", [a])).toBe(true);
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(saveLinks(blocked, "h1", [a])).toBe(false);
  });

  it("drops invalid entries and duplicate addresses", () => {
    const s = memory();
    s.setItem(
      linksKey("h1"),
      JSON.stringify([
        a,
        { title: "Bad", url: "javascript:alert(1)" },
        { title: "Http", url: "http://links.example.test/x" },
        { title: 5, url: "https://links.example.test/c" },
        null,
        "text",
        { title: "A again", url: a.url },
        b,
      ]),
    );
    expect(loadLinks(s, "h1")).toEqual([a, b]);
  });

  it("keeps at most LINKS_MAX", () => {
    const s = memory();
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `L${i}`,
      url: `https://links.example.test/${i}`,
    }));
    s.setItem(linksKey("h1"), JSON.stringify(many));
    expect(LINKS_MAX).toBe(12);
    expect(loadLinks(s, "h1")).toEqual(many.slice(0, 12));
  });

  it("never throws when storage does", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadLinks(s, "h1")).toEqual([]);
    expect(() => saveLinks(s, "h1", [a])).not.toThrow();
  });
});

describe("addLink and removeLink", () => {
  const a: GameLink = { title: "A", url: "https://links.example.test/a" };
  const b: GameLink = { title: "B", url: "https://links.example.test/b" };

  it("adds at the end without mutating", () => {
    const start = [a];
    const next = addLink(start, b);
    expect(next).toEqual([a, b]);
    expect(start).toEqual([a]);
    expect(next).not.toBe(start);
  });

  it("returns the list unchanged for a duplicate address", () => {
    const start = [a];
    expect(addLink(start, { title: "Other", url: a.url })).toBe(start);
  });

  it("refuses beyond the limit", () => {
    const full = Array.from({ length: LINKS_MAX }, (_, i) => ({
      title: `L${i}`,
      url: `https://links.example.test/${i}`,
    }));
    expect(addLink(full, b)).toBe(full);
    expect(addLink(full.slice(1), b)).toHaveLength(LINKS_MAX);
  });

  it("removes by address without mutating", () => {
    const start = [a, b];
    expect(removeLink(start, a.url)).toEqual([b]);
    expect(start).toEqual([a, b]);
    expect(removeLink(start, "https://links.example.test/none")).toEqual([a, b]);
  });
});

describe("links in a layout", () => {
  const link: GameLink = { title: "Sample Map", url: "https://links.example.test/map" };
  const slot = (title: string, url: string) => ({ title, url });
  const docTree: GuidePage[] = [page("Notes", "/doc/notes-BBB")];
  const empty = (): Layout => defaultLayout([], []);

  it("assignSlot accepts a link and still rejects other addresses", () => {
    const l = assignSlot(empty(), link);
    expect(l.slots[0]).toEqual(link);
    expect(l.active).toBe(0);
    const before = empty();
    for (const url of ["http://links.example.test/x", "javascript:alert(1)", "/other", ""]) {
      expect(assignSlot(before, { title: "x", url })).toBe(before);
    }
  });

  it("reconcileLayout keeps a pinned link and takes its current title", () => {
    const l = reconcileLayout(
      { slots: [slot("Old", link.url), slot("Notes", "/doc/notes-BBB"), null, null], active: 0 },
      docTree,
      [link],
    );
    expect(l.slots[0]).toEqual(link);
    expect(l.slots[1]).toEqual(slot("Notes", "/doc/notes-BBB"));
    expect(l.active).toBe(0);
  });

  it("reconcileLayout drops a link that was removed and falls back to achievements", () => {
    const l = reconcileLayout(
      {
        slots: [slot("Notes", "/doc/notes-BBB"), slot("Sample Map", link.url), null, null],
        active: 1,
      },
      docTree,
      [],
    );
    expect(l.slots.map((s) => s?.url ?? null)).toEqual(["/doc/notes-BBB", null, null, null]);
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("does not let a link match a page by its trailing id", () => {
    const lookalike = slot("Look", "https://links.example.test/x-BBB");
    const l = reconcileLayout({ slots: [lookalike, null, null, null], active: 0 }, docTree, []);
    expect(l.slots[0]).toBeNull();
    expect(l.active).toBe(ACHIEVEMENTS);
  });

  it("keeps page behaviour unchanged when no links are given", () => {
    const l = reconcileLayout(
      { slots: [slot("Old", "/doc/old-BBB"), null, null, null], active: 0 },
      docTree,
    );
    expect(l.slots[0]).toEqual(slot("Notes", "/doc/notes-BBB"));
  });

  it("loads a stored layout with a link slot and rejects a javascript: one", () => {
    const s = memory();
    saveLayout(s, "h1", assignSlot(empty(), link));
    expect(loadLayout(s, "h1")).toEqual({ slots: [link, null, null, null], active: 0 });
    s.setItem(
      layoutKey("h2"),
      JSON.stringify({ slots: [slot("x", "javascript:alert(1)"), null, null, null], active: 0 }),
    );
    expect(loadLayout(s, "h2")).toBeNull();
    s.setItem(
      layoutKey("h3"),
      JSON.stringify({
        slots: [slot("x", " https://links.example.test/a"), null, null, null],
        active: 0,
      }),
    );
    expect(loadLayout(s, "h3")).toBeNull();
  });
});
