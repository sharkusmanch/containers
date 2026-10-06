import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  SLOT_COUNT,
  activate,
  assignSlot,
  compactLayout,
  defaultLayout,
  docId,
  flattenPages,
  gameKey,
  isSafeDocUrl,
  layoutKey,
  loadLayout,
  reconcileLayout,
  removeSlot,
  saveLayout,
  slotLabel,
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
    expect(assignSlot(start, { title: "Evil", url: "https://evil.example/doc/x" })).toEqual(start);
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
    '{"slots":[{"title":"x","url":"https://evil.example"},null,null,null],"active":-1}',
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
