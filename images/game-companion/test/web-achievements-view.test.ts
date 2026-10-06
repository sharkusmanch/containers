// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  HIDE_UNLOCKED_STORAGE_KEY,
  SORT_STORAGE_KEY,
  createAchievementsView,
  isMasked,
  loadHideUnlocked,
  loadSortPref,
  matchesFilter,
  recentUnlocks,
  saveHideUnlocked,
  saveSortPref,
  sortAchievements,
  sortLocked,
  summaryLine,
} from "../src/web/achievements-view.js";
import type { Achievement, AchievementsResponse } from "../src/shared/types.js";

const a = (over: Partial<Achievement> & { id: string }): Achievement => ({
  name: over.id,
  description: `desc ${over.id}`,
  icon: null,
  unlocked: false,
  unlockedAt: null,
  unlockPercent: null,
  hidden: false,
  missable: false,
  ...over,
});

const list: Achievement[] = [
  a({ id: "rare", unlockPercent: 4.1, missable: true }),
  a({ id: "done-old", unlocked: true, unlockedAt: "2026-10-01T10:00:00.000Z", unlockPercent: 99 }),
  a({ id: "common", unlockPercent: 88.2 }),
  a({ id: "unknown" }),
  a({
    id: "secret",
    unlockPercent: 50,
    hidden: true,
    name: "Secret Name",
    description: "Secret text",
  }),
  a({
    id: "done-new",
    unlocked: true,
    unlockedAt: "2026-10-05T10:00:00.000Z",
    unlockPercent: 60,
    hidden: true,
  }),
  a({ id: "tie", unlockPercent: 50 }),
];
const data: AchievementsResponse = {
  source: "ra",
  id: "1",
  title: "Game",
  total: 7,
  unlocked: 2,
  stale: false,
  achievements: list,
};

describe("sortLocked", () => {
  it("orders locked achievements by unlock rate, highest first, unknown last", () => {
    expect(sortLocked(list).map((x) => x.id)).toEqual([
      "common",
      "secret",
      "tie",
      "rare",
      "unknown",
    ]);
  });
  it("does not mutate its input", () => {
    const before = list.map((x) => x.id);
    sortLocked(list);
    expect(list.map((x) => x.id)).toEqual(before);
  });
});

describe("recentUnlocks", () => {
  it("returns the newest unlocks first", () => {
    expect(recentUnlocks(list).map((x) => x.id)).toEqual(["done-new", "done-old"]);
    expect(recentUnlocks(list, 1).map((x) => x.id)).toEqual(["done-new"]);
  });
});

describe("summaryLine", () => {
  it("formats count and rounded percentage", () => {
    expect(summaryLine({ total: 87, unlocked: 12 })).toBe("12 / 87 · 14%");
  });
  it("handles an empty set", () => {
    expect(summaryLine({ total: 0, unlocked: 0 })).toBe("0 / 0");
  });
});

describe("isMasked", () => {
  it("masks hidden locked achievements until revealed", () => {
    const secret = list[4] as Achievement;
    expect(isMasked(secret, new Set())).toBe(true);
    expect(isMasked(secret, new Set(["secret"]))).toBe(false);
  });
  it("never masks unlocked or non-hidden achievements", () => {
    expect(isMasked(list[5] as Achievement, new Set())).toBe(false);
    expect(isMasked(list[0] as Achievement, new Set())).toBe(false);
  });
});

describe("createAchievementsView", () => {
  it("shows the summary, recent unlocks and the locked list in order", () => {
    const view = createAchievementsView(document);
    view.update(data);
    expect(view.element.querySelector(".ach-summary")?.textContent).toBe("2 / 7 · 29%");
    expect(
      [...view.element.querySelectorAll(".ach-recent .ach-name")].map((e) => e.textContent),
    ).toEqual(["done-new", "done-old"]);
    expect(
      [...view.element.querySelectorAll(".ach-locked .ach-row")].map(
        (e) => (e as HTMLElement).dataset.id,
      ),
    ).toEqual(["common", "secret", "tie", "rare", "unknown"]);
  });

  it("hides a hidden achievement's name and description until it is tapped", () => {
    const view = createAchievementsView(document);
    view.update(data);
    const row = view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement;
    expect(row.textContent).not.toContain("Secret Name");
    expect(row.textContent).not.toContain("Secret text");
    expect(row.textContent).toContain("Hidden achievement");
    row.click();
    const after = view.element.querySelector(
      '.ach-locked .ach-row[data-id="secret"]',
    ) as HTMLElement;
    expect(after.textContent).toContain("Secret Name");
    expect(after.textContent).toContain("Secret text");
  });

  it("keeps a revealed achievement revealed across updates", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector('.ach-row[data-id="secret"]') as HTMLElement).click();
    view.update({ ...data });
    expect(view.element.querySelector('.ach-row[data-id="secret"]')?.textContent).toContain(
      "Secret Name",
    );
  });

  it("marks missable achievements and shows the unlock rate", () => {
    const view = createAchievementsView(document);
    view.update(data);
    const row = view.element.querySelector('.ach-row[data-id="rare"]') as HTMLElement;
    expect(row.querySelector(".ach-missable")?.textContent).toBe("Missable");
    expect(row.querySelector(".ach-pct")?.textContent).toBe("4.1%");
    expect(view.element.querySelector('.ach-row[data-id="unknown"] .ach-pct')?.textContent).toBe(
      "",
    );
  });

  it("toggles a row's expanded state on tap", () => {
    const view = createAchievementsView(document);
    view.update(data);
    const sel = '.ach-locked .ach-row[data-id="common"]';
    (view.element.querySelector(sel) as HTMLElement).click();
    expect(view.element.querySelector(sel)?.classList.contains("expanded")).toBe(true);
    (view.element.querySelector(sel) as HTMLElement).click();
    expect(view.element.querySelector(sel)?.classList.contains("expanded")).toBe(false);
  });

  it("puts unlocked achievements in a collapsed section", () => {
    const view = createAchievementsView(document);
    view.update(data);
    const details = view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll(".ach-row")).toHaveLength(2);
  });

  it("renders markup in names and descriptions as literal text", () => {
    const view = createAchievementsView(document);
    const evil = a({
      id: "x",
      name: '<img src=x onerror="window.__pwned=1">',
      description: "<script>window.__pwned=1</script>",
      unlockPercent: 1,
    });
    view.update({ ...data, title: "<b>t</b>", achievements: [evil], total: 1, unlocked: 0 });
    expect(view.element.querySelector("img[src='x']")).toBeNull();
    expect(view.element.querySelector("script")).toBeNull();
    expect(view.element.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("only sets an icon src that is an https URL", () => {
    const view = createAchievementsView(document);
    view.update({
      ...data,
      achievements: [
        a({ id: "i1", icon: "https://media.retroachievements.org/Badge/1.png" }),
        a({ id: "i2", icon: "javascript:alert(1)" }),
      ],
      total: 2,
      unlocked: 0,
    });
    expect(view.element.querySelector('.ach-row[data-id="i1"] img')?.getAttribute("src")).toBe(
      "https://media.retroachievements.org/Badge/1.png",
    );
    expect(view.element.querySelector('.ach-row[data-id="i2"] img')).toBeNull();
  });

  it("keeps the Unlocked section open when a row inside it is tapped", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open = true;
    (
      view.element.querySelector('details.ach-unlocked .ach-row[data-id="done-old"]') as HTMLElement
    ).click();
    const details = view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(
      details.querySelector('.ach-row[data-id="done-old"]')?.classList.contains("expanded"),
    ).toBe(true);
  });

  it("keeps the Unlocked section open across updates of the same game", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open = true;
    view.update({ ...data });
    expect((view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open).toBe(
      true,
    );
  });

  it("forgets revealed, expanded and open state when the game changes", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement).click();
    (view.element.querySelector('.ach-locked .ach-row[data-id="common"]') as HTMLElement).click();
    (view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open = true;
    view.update({ ...data, id: "2" });
    const row = view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement;
    expect(row.textContent).toContain("Hidden achievement");
    expect(row.textContent).not.toContain("Secret Name");
    expect(
      view.element
        .querySelector('.ach-locked .ach-row[data-id="common"]')
        ?.classList.contains("expanded"),
    ).toBe(false);
    expect((view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open).toBe(
      false,
    );
  });

  it("treats the same id from another source as a different game", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement).click();
    view.update({ ...data, source: "steam" });
    expect(
      view.element.querySelector('.ach-locked .ach-row[data-id="secret"]')?.textContent,
    ).toContain("Hidden achievement");
  });

  it("keeps state across a loading or error message for the same game", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement).click();
    view.update(null, "Loading…");
    expect(view.element.querySelector(".ach-message")?.textContent).toBe("Loading…");
    view.update({ ...data });
    expect(
      view.element.querySelector('.ach-locked .ach-row[data-id="secret"]')?.textContent,
    ).toContain("Secret Name");
  });

  it("leaks nothing about a masked achievement, including through its icon", () => {
    const view = createAchievementsView(document);
    const secret = a({
      id: "s",
      name: "Secret Name",
      description: "Secret text",
      hidden: true,
      unlockPercent: 5,
      icon: "https://media.example.org/Badge/9.png",
    });
    view.update({ ...data, achievements: [secret], total: 1, unlocked: 0 });
    const row = view.element.querySelector('.ach-row[data-id="s"]') as HTMLElement;
    expect(row.querySelector("img")).toBeNull();
    const attrs = [row, ...row.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((at) => at.value),
    );
    expect(attrs.join("|")).not.toMatch(/Secret|media\.example/);
  });

  it("shows a message instead of a list when there is no data", () => {
    const view = createAchievementsView(document);
    view.update(null, "No achievements for this game");
    expect(view.element.querySelector(".ach-message")?.textContent).toBe(
      "No achievements for this game",
    );
    expect(view.element.querySelector(".ach-row")).toBeNull();
  });

  it("flags stale data", () => {
    const view = createAchievementsView(document);
    view.update({ ...data, stale: true });
    expect(view.element.querySelector(".ach-stale")?.textContent).toBe("Showing older data");
  });
});

const locked = (): Achievement[] => list.filter((x) => !x.unlocked);
const ids = (xs: Achievement[]): string[] => xs.map((x) => x.id);
const isSecretMasked = (x: Achievement): boolean => x.id === "secret";

function memory() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe("sortAchievements", () => {
  it("defaults to rarity, most-earned first", () => {
    expect(DEFAULT_SORT).toEqual({ key: "rarity", dir: "desc" });
    expect(ids(sortAchievements(locked(), DEFAULT_SORT))).toEqual([
      "common",
      "secret",
      "tie",
      "rare",
      "unknown",
    ]);
  });

  it("sorts rarest first when ascending, with unknown rarity still last and ties in input order", () => {
    expect(ids(sortAchievements(locked(), { key: "rarity", dir: "asc" }))).toEqual([
      "rare",
      "secret",
      "tie",
      "common",
      "unknown",
    ]);
  });

  it("sorts by name in both directions with masked rows last", () => {
    expect(ids(sortAchievements(locked(), { key: "name", dir: "asc" }, isSecretMasked))).toEqual([
      "common",
      "rare",
      "tie",
      "unknown",
      "secret",
    ]);
    expect(ids(sortAchievements(locked(), { key: "name", dir: "desc" }, isSecretMasked))).toEqual([
      "unknown",
      "tie",
      "rare",
      "common",
      "secret",
    ]);
  });

  it("places an unmasked achievement by its real name", () => {
    expect(ids(sortAchievements(locked(), { key: "name", dir: "asc" }))).toEqual([
      "common",
      "rare",
      "secret",
      "tie",
      "unknown",
    ]);
  });

  it("compares names without regard to case and with numbers in numeric order", () => {
    const xs = [
      a({ id: "1", name: "Stage 10" }),
      a({ id: "2", name: "stage 2" }),
      a({ id: "3", name: "Apple" }),
    ];
    expect(ids(sortAchievements(xs, { key: "name", dir: "asc" }))).toEqual(["3", "2", "1"]);
  });

  it("keeps or reverses the game's own order", () => {
    expect(ids(sortAchievements(locked(), { key: "order", dir: "asc" }))).toEqual([
      "rare",
      "common",
      "unknown",
      "secret",
      "tie",
    ]);
    expect(ids(sortAchievements(locked(), { key: "order", dir: "desc" }))).toEqual([
      "tie",
      "secret",
      "unknown",
      "common",
      "rare",
    ]);
  });

  it("does not filter and does not mutate its input", () => {
    const before = ids(list);
    expect(sortAchievements(list, { key: "name", dir: "desc" })).toHaveLength(list.length);
    expect(ids(list)).toEqual(before);
  });
});

describe("sort preference storage", () => {
  it("round-trips a preference", () => {
    const s = memory();
    saveSortPref(s, { key: "name", dir: "desc" });
    expect([...s.store.keys()]).toEqual([SORT_STORAGE_KEY]);
    expect(loadSortPref(s)).toEqual({ key: "name", dir: "desc" });
  });

  it.each([
    "not json",
    "{}",
    '{"key":"points","dir":"asc"}',
    '{"key":"name","dir":"up"}',
    "[]",
    "null",
  ])("falls back to the default for a bad stored value: %s", (raw) => {
    const s = memory();
    s.setItem(SORT_STORAGE_KEY, raw);
    expect(loadSortPref(s)).toEqual(DEFAULT_SORT);
  });

  it("falls back to the default with no storage or a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSortPref(null)).toEqual(DEFAULT_SORT);
    expect(loadSortPref(undefined)).toEqual(DEFAULT_SORT);
    expect(loadSortPref(broken)).toEqual(DEFAULT_SORT);
    expect(() => saveSortPref(broken, DEFAULT_SORT)).not.toThrow();
    expect(() => saveSortPref(null, DEFAULT_SORT)).not.toThrow();
  });

  it("never hands out the shared default object", () => {
    const p = loadSortPref(null);
    p.dir = "asc";
    expect(DEFAULT_SORT.dir).toBe("desc");
  });
});

describe("sort controls", () => {
  const lockedIds = (el: HTMLElement): (string | undefined)[] =>
    [...el.querySelectorAll(".ach-locked .ach-row")].map((e) => (e as HTMLElement).dataset.id);
  const unlockedIds = (el: HTMLElement): (string | undefined)[] =>
    [...el.querySelectorAll(".ach-unlocked .ach-row")].map((e) => (e as HTMLElement).dataset.id);
  const key = (el: HTMLElement): HTMLElement => el.querySelector(".ach-sort-key") as HTMLElement;
  const dir = (el: HTMLElement): HTMLElement => el.querySelector(".ach-sort-dir") as HTMLElement;

  it("shows rarity, descending, by default, after the summary", () => {
    const view = createAchievementsView(document);
    view.update(data);
    expect(key(view.element).textContent).toBe("Unlock percentage");
    expect(key(view.element).getAttribute("aria-label")).toBe("Sort by: Unlock percentage");
    expect(dir(view.element).textContent).toBe("↓");
    expect(dir(view.element).getAttribute("aria-label")).toBe("Descending");
    expect(
      view.element
        .querySelector(".ach-summary")
        ?.nextElementSibling?.classList.contains("ach-sort"),
    ).toBe(true);
    expect(lockedIds(view.element)).toEqual(["common", "secret", "tie", "rare", "unknown"]);
  });

  it("is not shown in the message-only state", () => {
    const view = createAchievementsView(document);
    view.update(null, "Loading…");
    expect(view.element.querySelector(".ach-sort")).toBeNull();
  });

  it("flips the direction for both lists", () => {
    const view = createAchievementsView(document);
    view.update(data);
    dir(view.element).click();
    expect(dir(view.element).textContent).toBe("↑");
    expect(dir(view.element).getAttribute("aria-label")).toBe("Ascending");
    expect(lockedIds(view.element)).toEqual(["rare", "secret", "tie", "common", "unknown"]);
    expect(unlockedIds(view.element)).toEqual(["done-new", "done-old"]);
  });

  it("cycles the sort key, resetting to each key's natural direction", () => {
    const view = createAchievementsView(document);
    view.update(data);
    dir(view.element).click();
    key(view.element).click();
    expect(key(view.element).textContent).toBe("Name");
    expect(dir(view.element).textContent).toBe("↑");
    expect(lockedIds(view.element)).toEqual(["common", "rare", "tie", "unknown", "secret"]);
    key(view.element).click();
    expect(key(view.element).textContent).toBe("Game order");
    expect(dir(view.element).textContent).toBe("↑");
    expect(lockedIds(view.element)).toEqual(["rare", "common", "unknown", "secret", "tie"]);
    key(view.element).click();
    expect(key(view.element).textContent).toBe("Unlock percentage");
    expect(dir(view.element).textContent).toBe("↓");
    expect(lockedIds(view.element)).toEqual(["common", "secret", "tie", "rare", "unknown"]);
  });

  it("moves a hidden achievement to its alphabetical place once it is revealed", () => {
    const view = createAchievementsView(document);
    view.update(data);
    key(view.element).click();
    expect(lockedIds(view.element)).toEqual(["common", "rare", "tie", "unknown", "secret"]);
    (view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement).click();
    expect(lockedIds(view.element)).toEqual(["common", "rare", "secret", "tie", "unknown"]);
  });

  it("saves the choice and a new view restores it", () => {
    const s = memory();
    const first = createAchievementsView(document, { storage: s });
    first.update(data);
    key(first.element).click();
    dir(first.element).click();
    expect(JSON.parse(s.store.get(SORT_STORAGE_KEY) as string)).toEqual({
      key: "name",
      dir: "desc",
    });
    const second = createAchievementsView(document, { storage: s });
    second.update(data);
    expect(key(second.element).textContent).toBe("Name");
    expect(dir(second.element).textContent).toBe("↓");
    expect(lockedIds(second.element)).toEqual(["unknown", "tie", "rare", "common", "secret"]);
  });

  it("keeps the choice across updates and across a change of game", () => {
    const view = createAchievementsView(document);
    view.update(data);
    dir(view.element).click();
    view.update({ ...data });
    expect(dir(view.element).textContent).toBe("↑");
    view.update({ ...data, id: "2" });
    expect(dir(view.element).textContent).toBe("↑");
    expect(lockedIds(view.element)).toEqual(["rare", "secret", "tie", "common", "unknown"]);
  });

  it("does not treat a click on a sort button as a click on a row", () => {
    const view = createAchievementsView(document);
    view.update(data);
    key(view.element).click();
    dir(view.element).click();
    expect(view.element.querySelector(".ach-row.expanded")).toBeNull();
    expect(key(view.element).classList.contains("ach-row")).toBe(false);
  });
});

describe("hide unlocked", () => {
  const toggle = (el: HTMLElement): HTMLElement =>
    el.querySelector(".ach-hide-unlocked") as HTMLElement;

  it("shows unlocked achievements by default", () => {
    const view = createAchievementsView(document);
    view.update(data);
    expect(toggle(view.element).textContent).toBe("Unlocked: shown");
    expect(toggle(view.element).getAttribute("aria-pressed")).toBe("false");
    expect(view.element.querySelector(".ach-recent")).not.toBeNull();
    expect(view.element.querySelector("details.ach-unlocked")).not.toBeNull();
    expect([...view.element.querySelectorAll(".ach-sort button")].map((b) => b.className)).toEqual([
      "ach-sort-key",
      "ach-sort-dir",
      "ach-hide-unlocked",
    ]);
  });

  it("removes the recent strip and the unlocked section when turned on, keeping the summary and the locked list", () => {
    const view = createAchievementsView(document);
    view.update(data);
    toggle(view.element).click();
    expect(toggle(view.element).textContent).toBe("Unlocked: hidden");
    expect(toggle(view.element).getAttribute("aria-pressed")).toBe("true");
    expect(view.element.querySelector(".ach-recent")).toBeNull();
    expect(view.element.querySelector("details.ach-unlocked")).toBeNull();
    expect(view.element.querySelectorAll(".ach-row")).toHaveLength(5);
    expect(view.element.querySelector(".ach-summary")?.textContent).toBe("2 / 7 · 29%");
    toggle(view.element).click();
    expect(view.element.querySelector("details.ach-unlocked")).not.toBeNull();
  });

  it("saves the choice, restores it in a new view and keeps it across a change of game", () => {
    const s = memory();
    const first = createAchievementsView(document, { storage: s });
    first.update(data);
    toggle(first.element).click();
    expect(s.store.get(HIDE_UNLOCKED_STORAGE_KEY)).toBe("1");
    const second = createAchievementsView(document, { storage: s });
    second.update(data);
    expect(toggle(second.element).getAttribute("aria-pressed")).toBe("true");
    second.update({ ...data, id: "2" });
    expect(second.element.querySelector("details.ach-unlocked")).toBeNull();
    toggle(second.element).click();
    expect(s.store.get(HIDE_UNLOCKED_STORAGE_KEY)).toBe("0");
  });

  it("reads only an exact stored 1 as hidden and survives missing or broken storage", () => {
    const s = memory();
    expect(loadHideUnlocked(s)).toBe(false);
    for (const raw of ["0", "true", "yes", ""]) {
      s.setItem(HIDE_UNLOCKED_STORAGE_KEY, raw);
      expect(loadHideUnlocked(s)).toBe(false);
    }
    saveHideUnlocked(s, true);
    expect(loadHideUnlocked(s)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadHideUnlocked(null)).toBe(false);
    expect(loadHideUnlocked(broken)).toBe(false);
    expect(() => saveHideUnlocked(broken, true)).not.toThrow();
  });

  it("brings the unlocked section back in the state the user left it", () => {
    const view = createAchievementsView(document);
    view.update(data);
    (view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open = true;
    toggle(view.element).click();
    view.update({ ...data });
    toggle(view.element).click();
    expect((view.element.querySelector("details.ach-unlocked") as HTMLDetailsElement).open).toBe(
      true,
    );
  });

  it("does not treat a click on the option as a click on a row", () => {
    const view = createAchievementsView(document);
    view.update(data);
    toggle(view.element).click();
    expect(view.element.querySelector(".ach-row.expanded")).toBeNull();
    expect(toggle(view.element).classList.contains("ach-row")).toBe(false);
  });
});

describe("matchesFilter", () => {
  const plain = a({
    id: "x",
    name: "Sample Feat",
    description: "Defeated the sample boss using only physical damage.",
  });

  it("matches everything for an empty or blank filter, masked or not", () => {
    expect(matchesFilter(plain, "", false)).toBe(true);
    expect(matchesFilter(plain, "   ", true)).toBe(true);
  });

  it("finds text in the name or the description, ignoring case and surrounding spaces", () => {
    expect(matchesFilter(plain, "sample feat", false)).toBe(true);
    expect(matchesFilter(plain, "  SAMPLE BOSS ", false)).toBe(true);
    expect(matchesFilter(plain, "dragon", false)).toBe(false);
  });

  it("treats the filter as one string, not separate words", () => {
    expect(matchesFilter(plain, "feat sample", false)).toBe(false);
  });

  it("searches only the name when there is no description", () => {
    const bare = a({ id: "y", name: "Quiet One", description: null });
    expect(matchesFilter(bare, "quiet", false)).toBe(true);
    expect(matchesFilter(bare, "null", false)).toBe(false);
  });

  it("never matches a masked achievement while a filter is set", () => {
    expect(matchesFilter(plain, "feat", true)).toBe(false);
  });
});

describe("filter box", () => {
  const input = (el: HTMLElement): HTMLInputElement =>
    el.querySelector(".ach-filter-input") as HTMLInputElement;
  const clear = (el: HTMLElement): HTMLButtonElement =>
    el.querySelector(".ach-filter-clear") as HTMLButtonElement;
  const type = (el: HTMLElement, text: string): void => {
    input(el).value = text;
    input(el).dispatchEvent(new Event("input", { bubbles: true }));
  };
  const lockedIds = (el: HTMLElement): (string | undefined)[] =>
    [...el.querySelectorAll(".ach-locked .ach-row")].map((e) => (e as HTMLElement).dataset.id);
  const unlockedIds = (el: HTMLElement): (string | undefined)[] =>
    [...el.querySelectorAll(".ach-unlocked .ach-row")].map((e) => (e as HTMLElement).dataset.id);

  it("sits after the sort controls with the right attributes and an initially hidden clear button", () => {
    const view = createAchievementsView(document);
    view.update(data);
    const row = view.element.querySelector(".ach-filter") as HTMLElement;
    expect(view.element.querySelector(".ach-sort")?.nextElementSibling).toBe(row);
    expect(input(view.element).type).toBe("search");
    expect(input(view.element).placeholder).toBe("Filter achievements");
    expect(input(view.element).getAttribute("aria-label")).toBe("Filter achievements");
    expect(input(view.element).getAttribute("autocomplete")).toBe("off");
    expect(clear(view.element).getAttribute("aria-label")).toBe("Clear filter");
    expect(clear(view.element).hidden).toBe(true);
  });

  it("is not shown in the message-only state", () => {
    const view = createAchievementsView(document);
    view.update(null, "Loading…");
    expect(view.element.querySelector(".ach-filter")).toBeNull();
  });

  it("filters the locked and unlocked lists by name", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "com");
    expect(lockedIds(view.element)).toEqual(["common"]);
    expect(unlockedIds(view.element)).toEqual([]);
    type(view.element, "done");
    expect(lockedIds(view.element)).toEqual([]);
    expect(unlockedIds(view.element)).toEqual(["done-old", "done-new"]);
    expect(view.element.querySelector(".ach-unlocked > summary")?.textContent).toBe("Unlocked (2)");
  });

  it("filters by description, ignoring case", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "DESC RARE");
    expect(lockedIds(view.element)).toEqual(["rare"]);
  });

  it("keeps the current sort order among the matches", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "desc");
    expect(lockedIds(view.element)).toEqual(["common", "tie", "rare", "unknown"]);
  });

  it("does not find a hidden achievement until it has been revealed", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "secret");
    expect(lockedIds(view.element)).toEqual([]);
    expect(view.element.querySelector(".ach-empty")?.textContent).toBe("No matching achievements");
    type(view.element, "");
    (view.element.querySelector('.ach-locked .ach-row[data-id="secret"]') as HTMLElement).click();
    type(view.element, "secret");
    expect(lockedIds(view.element)).toEqual(["secret"]);
    expect(view.element.querySelector(".ach-empty")).toBeNull();
  });

  it("hides the recent strip while filtering and keeps the summary on the game's totals", () => {
    const view = createAchievementsView(document);
    view.update(data);
    expect(view.element.querySelector(".ach-recent")).not.toBeNull();
    type(view.element, "com");
    expect(view.element.querySelector(".ach-recent")).toBeNull();
    expect(view.element.querySelector(".ach-summary")?.textContent).toBe("2 / 7 · 29%");
    type(view.element, "");
    expect(view.element.querySelector(".ach-recent")).not.toBeNull();
    expect(view.element.querySelector(".ach-empty")).toBeNull();
  });

  it("says so when nothing matches, also with unlocked hidden", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "zzz");
    expect(view.element.querySelector(".ach-empty")?.textContent).toBe("No matching achievements");
    expect(view.element.querySelectorAll(".ach-row")).toHaveLength(0);
    type(view.element, "done");
    expect(view.element.querySelector(".ach-empty")).toBeNull();
    (view.element.querySelector(".ach-hide-unlocked") as HTMLElement).click();
    expect(view.element.querySelector(".ach-empty")?.textContent).toBe("No matching achievements");
  });

  it("shows the clear button only while there is text, and clearing restores the lists and focuses the input", () => {
    const view = createAchievementsView(document);
    document.body.append(view.element);
    view.update(data);
    type(view.element, "com");
    expect(clear(view.element).hidden).toBe(false);
    clear(view.element).click();
    expect(input(view.element).value).toBe("");
    expect(clear(view.element).hidden).toBe(true);
    expect(lockedIds(view.element)).toHaveLength(5);
    expect(document.activeElement).toBe(input(view.element));
    view.element.remove();
  });

  it("keeps the same input and control elements, the typed text and focus across every kind of render", () => {
    const view = createAchievementsView(document);
    document.body.append(view.element);
    view.update(data);
    const box = input(view.element);
    const sortKey = view.element.querySelector(".ach-sort-key");
    const sortDir = view.element.querySelector(".ach-sort-dir");
    const hide = view.element.querySelector(".ach-hide-unlocked");
    box.focus();
    type(view.element, "co");
    expect(input(view.element)).toBe(box);
    expect(document.activeElement).toBe(box);
    view.update({ ...data });
    expect(input(view.element)).toBe(box);
    expect(box.value).toBe("co");
    expect(document.activeElement).toBe(box);
    expect(lockedIds(view.element)).toEqual(["common"]);
    (sortDir as HTMLElement).click();
    (hide as HTMLElement).click();
    expect(view.element.querySelector(".ach-sort-key")).toBe(sortKey);
    expect(view.element.querySelector(".ach-sort-dir")).toBe(sortDir);
    expect(view.element.querySelector(".ach-hide-unlocked")).toBe(hide);
    expect(input(view.element)).toBe(box);
    view.update(null, "Loading…");
    view.update({ ...data });
    expect(input(view.element)).toBe(box);
    expect(view.element.querySelector(".ach-sort-key")).toBe(sortKey);
    expect(box.value).toBe("co");
    view.element.remove();
  });

  it("clears the filter when a different game arrives, and keeps it for the same game", () => {
    const view = createAchievementsView(document);
    view.update(data);
    type(view.element, "com");
    view.update({ ...data });
    expect(input(view.element).value).toBe("com");
    view.update({ ...data, id: "2" });
    expect(input(view.element).value).toBe("");
    expect(clear(view.element).hidden).toBe(true);
    expect(lockedIds(view.element)).toHaveLength(5);
  });

  it("does not treat typing or the clear button as a click on a row", () => {
    const view = createAchievementsView(document);
    view.update(data);
    input(view.element).click();
    type(view.element, "com");
    clear(view.element).click();
    expect(view.element.querySelector(".ach-row.expanded")).toBeNull();
  });
});
