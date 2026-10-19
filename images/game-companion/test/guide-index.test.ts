import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GuideIndex,
  isSafeGuideUrl,
  normaliseTitle,
  parseHubIdentity,
  parseNowPlaying,
  platformLabel,
  type GuideSource,
} from "../src/server/guide-index.js";
import type { OutlineDoc, OutlineNode } from "../src/server/outline.js";
import type { Source } from "../src/shared/types.js";

const rows = JSON.parse(
  readFileSync(new URL("./fixtures/hub-rows.json", import.meta.url), "utf8"),
) as {
  text: string;
  expect: { steam: string | null; ra: string | null; xbox: string | null } | null;
}[];

describe("parseHubIdentity", () => {
  it.each(rows.map((r, i) => [i, r] as const))("row case %i", (_i, r) => {
    expect(parseHubIdentity(r.text)).toEqual(r.expect);
  });
});

describe("platformLabel", () => {
  it("labels Steam hubs", () => {
    expect(platformLabel("Test Game", ["steam"])).toBe("Steam");
  });
  it("labels Xbox hubs and hubs known on both", () => {
    expect(platformLabel("Test Game", ["xbox"])).toBe("Xbox");
    expect(platformLabel("Test Game", ["steam", "xbox"])).toBe("Steam + Xbox");
  });
  it("adds the console from an RA title suffix", () => {
    expect(platformLabel("Sample Quest (N64 — RetroAchievements)", ["ra"])).toBe("RA · N64");
  });
  it("falls back to plain RA without a suffix", () => {
    expect(platformLabel("Sample Quest", ["ra"])).toBe("RA");
  });
  it("keeps the RA label for a hub that also has a Steam row", () => {
    expect(platformLabel("Sample Quest (GC — RetroAchievements)", ["steam", "ra"])).toBe("RA · GC");
  });
  it("labels hubs without an ID", () => {
    expect(platformLabel("Some PS5 Game", [])).toBe("Other");
  });
});

describe("parseNowPlaying", () => {
  const text =
    "intro\n\n* **Now Playing:** one game.\n\n## Now Playing\n\n**Sample Saga 1st Chapter**\n\n* note **bold in a bullet**\n\n**Second Game**\n\n## Up Next\n\n**Not This One** — Owned\n";
  it("returns bold titles that start a line inside the section only", () => {
    expect(parseNowPlaying(text)).toEqual(["Sample Saga 1st Chapter", "Second Game"]);
  });
  it("returns nothing when the section is missing", () => {
    expect(parseNowPlaying("## Up Next\n\n**X**\n")).toEqual([]);
  });
});

describe("normaliseTitle", () => {
  it("ignores case, punctuation, accents and a trailing parenthetical", () => {
    expect(normaliseTitle("Pokémon: Let's Go! (GBA — RetroAchievements)")).toBe("pokemon let s go");
  });
  it("ignores trade marks, copyright signs and whitespace runs", () => {
    expect(normaliseTitle("Sample Wars:  E-Day™")).toBe(normaliseTitle("Sample Wars: E-Day"));
    expect(normaliseTitle("Sample® Racing ©")).toBe("sample racing");
  });
});

const docs: OutlineDoc[] = [
  { id: "h1", title: "Zeta Game", url: "/doc/zeta-aaa", text: "| **Steam App ID** | 10 |\n" },
  {
    id: "h2",
    title: "Alpha Quest (PS2 — RetroAchievements)",
    url: "/doc/alpha-bbb",
    text: "| **RA Game ID** | 20 |\n",
  },
  { id: "h3", title: "Console Only", url: "/doc/console-ccc", text: "no id" },
  {
    id: "h4",
    title: "Bad Link",
    url: "https://evil.example/doc/x",
    text: "| **Steam App ID** | 30 |\n",
  },
];
const tree: OutlineNode[] = [
  {
    id: "p1",
    title: "Achievement Guides",
    url: "/doc/guides-ppp",
    children: [
      {
        id: "h1",
        title: "Zeta Game",
        url: "/doc/zeta-aaa",
        children: [
          { id: "c1", title: "Achievement Checklist", url: "/doc/checklist-ddd", children: [] },
          {
            id: "c2",
            title: "Collectibles",
            url: "/doc/collectibles-eee",
            children: [
              { id: "c3", title: "Collectibles: Area One", url: "/doc/area-one-fff", children: [] },
              { id: "c4", title: "Off-site", url: "https://evil.example/x", children: [] },
            ],
          },
        ],
      },
      {
        id: "h2",
        title: "Alpha Quest (PS2 — RetroAchievements)",
        url: "/doc/alpha-bbb",
        children: [],
      },
    ],
  },
];

function source(overrides: Partial<GuideSource> = {}): GuideSource {
  return {
    listChildren: async () => docs,
    collectionTree: async () => tree,
    docText: async () => "## Now Playing\n\n**Alpha Quest** — started\n",
    ...overrides,
  };
}

const base = { collectionId: "c", guidesParentId: "p1", scheduleDocId: "s1" };

describe("GuideIndex", () => {
  it("is unavailable and empty before the first refresh", () => {
    const idx = new GuideIndex({ ...base, source: source() });
    expect(idx.available()).toBe(false);
    expect(idx.hubs()).toEqual([]);
  });

  it("stays unavailable with no Outline source configured", async () => {
    const idx = new GuideIndex({ ...base, source: null });
    expect(await idx.refresh()).toBe(false);
    expect(idx.available()).toBe(false);
  });

  it("indexes hubs, puts Now Playing first and drops hubs with unsafe URLs", async () => {
    const idx = new GuideIndex({ ...base, source: source() });
    expect(await idx.refresh()).toBe(true);
    expect(idx.hubs().map((h) => [h.title, h.platformLabel, h.nowPlaying])).toEqual([
      ["Alpha Quest (PS2 — RetroAchievements)", "RA · PS2", true],
      ["Console Only", "Other", false],
      ["Zeta Game", "Steam", false],
    ]);
  });

  it("looks up by source and id, never across sources", async () => {
    const idx = new GuideIndex({ ...base, source: source() });
    await idx.refresh();
    expect(idx.lookup("steam", "10").map((h) => h.hubId)).toEqual(["h1"]);
    expect(idx.lookup("ra", "10")).toEqual([]);
    expect(idx.lookup("ra", "20").map((h) => h.hubId)).toEqual(["h2"]);
  });

  it("returns every hub sharing one id", async () => {
    const dup = [
      ...docs,
      {
        id: "h5",
        title: "Zeta Game DLC",
        url: "/doc/zeta-dlc-ggg",
        text: "| **Steam App ID** | 10 |\n",
      },
    ];
    const idx = new GuideIndex({ ...base, source: source({ listChildren: async () => dup }) });
    await idx.refresh();
    expect(
      idx
        .lookup("steam", "10")
        .map((h) => h.hubId)
        .sort(),
    ).toEqual(["h1", "h5"]);
  });

  it("returns a hub's page tree without off-site pages", async () => {
    const idx = new GuideIndex({ ...base, source: source() });
    await idx.refresh();
    const t = idx.tree("h1");
    expect(t?.pages.map((p) => p.title)).toEqual(["Achievement Checklist", "Collectibles"]);
    expect(t?.pages[1]?.children.map((p) => p.title)).toEqual(["Collectibles: Area One"]);
    expect(idx.tree("nope")).toBeNull();
  });

  it("lists a hub's pages with their ids in tree order, safe URLs only", async () => {
    const idx = new GuideIndex({ ...base, source: source() });
    await idx.refresh();
    expect(idx.pageRefs("h1")).toEqual([
      { id: "c1", title: "Achievement Checklist", url: "/doc/checklist-ddd" },
      { id: "c2", title: "Collectibles", url: "/doc/collectibles-eee" },
      { id: "c3", title: "Collectibles: Area One", url: "/doc/area-one-fff" },
    ]);
    expect(idx.pageRefs("h2")).toEqual([]);
    expect(idx.pageRefs("nope")).toBeNull();
    expect(idx.pageRefs("h4")).toBeNull();
  });

  it("drops the children of an unsafe page from the refs, as tree() does", async () => {
    const nested: OutlineNode[] = [
      {
        id: "p1",
        title: "Achievement Guides",
        url: "/doc/guides-ppp",
        children: [
          {
            id: "h1",
            title: "Zeta Game",
            url: "/doc/zeta-aaa",
            children: [
              {
                id: "x1",
                title: "Off-site",
                url: "https://evil.example/x",
                children: [{ id: "x2", title: "Hidden", url: "/doc/hidden-ggg", children: [] }],
              },
              { id: "x3", title: "Kept", url: "/doc/kept-hhh", children: [] },
            ],
          },
        ],
      },
    ];
    const idx = new GuideIndex({ ...base, source: source({ collectionTree: async () => nested }) });
    await idx.refresh();
    expect(idx.pageRefs("h1")?.map((r) => r.id)).toEqual(["x3"]);
    expect(idx.tree("h1")?.pages.map((p) => p.title)).toEqual(["Kept"]);
  });

  it("gives a hub an empty tree when the collection tree lacks it", async () => {
    const idx = new GuideIndex({ ...base, source: source() });
    await idx.refresh();
    expect(idx.tree("h3")?.pages).toEqual([]);
  });

  it("keeps the previous index when a refresh fails", async () => {
    let fail = false;
    const idx = new GuideIndex({
      ...base,
      source: source({
        listChildren: async () => {
          if (fail) throw new Error("down");
          return docs;
        },
      }),
    });
    await idx.refresh();
    fail = true;
    expect(await idx.refresh()).toBe(false);
    expect(idx.available()).toBe(true);
    expect(idx.hubs()).toHaveLength(3);
  });

  it("still builds when only the schedule document fails", async () => {
    const idx = new GuideIndex({
      ...base,
      source: source({
        docText: async () => {
          throw new Error("no");
        },
      }),
    });
    expect(await idx.refresh()).toBe(true);
    expect(idx.hubs().every((h) => !h.nowPlaying)).toBe(true);
  });

  it("rate-limits requested refreshes", async () => {
    let calls = 0;
    let t = 1_000_000;
    const idx = new GuideIndex({
      ...base,
      now: () => t,
      source: source({
        listChildren: async () => {
          calls += 1;
          return docs;
        },
      }),
    });
    idx.requestRefresh();
    idx.requestRefresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    t += 61_000;
    idx.requestRefresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });
});

describe("GuideIndex with Xbox", () => {
  const xdocs: OutlineDoc[] = [
    {
      id: "shared",
      title: "Gears of War: E-Day",
      url: "/doc/shared-aaa",
      text: "| **Steam App ID** | 1000001 |\n| **Xbox Title ID** | 1000000001 |\n",
    },
    {
      id: "steam-only",
      title: "Sample Racer",
      url: "/doc/racer-bbb",
      text: "| App ID | 1000002 |\n",
    },
    { id: "unlabelled", title: "Sample Saga", url: "/doc/saga-ccc", text: "no id" },
    {
      id: "ra-only",
      title: "Sample Quest (GC — RetroAchievements)",
      url: "/doc/quest-ddd",
      text: "| **RA Game ID** | 30001 |\n",
    },
    {
      id: "ra-and-steam",
      title: "Sample Port",
      url: "/doc/port-eee",
      text: "| **RA Game ID** | 30002 |\n| **Steam App ID** | 1000003 |\n",
    },
    {
      id: "xbox-only",
      title: "Sample Tactics",
      url: "/doc/tactics-fff",
      text: "| Xbox Title ID | 1000000004 |\n",
    },
    { id: "twin-1", title: "Sample Twins", url: "/doc/twin-ggg", text: "| App ID | 1000005 |\n" },
    { id: "twin-2", title: "Sample Twins!", url: "/doc/twin-hhh", text: "no id" },
  ];

  function memoryFake(records: Record<string, { last: Source; xboxTitleId: string | null }>) {
    return {
      get: (hubId: string) => {
        const r = records[hubId];
        return r ? { ...r, seenAt: "2026-10-18T00:00:00.000Z" } : null;
      },
      byXboxTitle: (titleId: string) =>
        Object.entries(records)
          .filter(([, r]) => r.xboxTitleId === titleId)
          .map(([hubId]) => hubId),
    };
  }

  async function built(memory?: ReturnType<typeof memoryFake>) {
    const idx = new GuideIndex({
      ...base,
      scheduleDocId: null,
      source: source({ listChildren: async () => xdocs }),
      ...(memory ? { memory } : {}),
    });
    await idx.refresh();
    return idx;
  }

  const ids = (hubs: { hubId: string }[]) => hubs.map((h) => h.hubId);

  it("parses Xbox Title ID bold and plain", () => {
    expect(parseHubIdentity("| **Xbox Title ID** | 1000000001 |\n")).toEqual({
      steam: null,
      ra: null,
      xbox: "1000000001",
    });
    expect(parseHubIdentity("| Xbox Title ID | 1000000002 |\n")).toEqual({
      steam: null,
      ra: null,
      xbox: "1000000002",
    });
  });

  it('hub with steam and xbox rows has platforms [steam, xbox] and label "Steam + Xbox"', async () => {
    const idx = await built();
    expect(idx.tree("shared")?.hub).toEqual({
      hubId: "shared",
      title: "Gears of War: E-Day",
      url: "/doc/shared-aaa",
      source: "steam",
      gameId: "1000001",
      xboxTitleId: "1000000001",
      platforms: ["steam", "xbox"],
      lastPlatform: null,
      platformLabel: "Steam + Xbox",
      nowPlaying: false,
    });
    expect(idx.tree("xbox-only")?.hub).toMatchObject({
      source: "xbox",
      gameId: "1000000004",
      xboxTitleId: "1000000004",
      platforms: ["xbox"],
      platformLabel: "Xbox",
    });
    expect(idx.tree("unlabelled")?.hub).toMatchObject({ platforms: [], platformLabel: "Other" });
    expect(idx.tree("ra-only")?.hub).toMatchObject({ platforms: ["ra"], platformLabel: "RA · GC" });
  });

  it("lookup xbox by row wins over name", async () => {
    const idx = await built();
    expect(ids(idx.lookup("xbox", "1000000004", "Sample Racer"))).toEqual(["xbox-only"]);
    expect(ids(idx.lookup("xbox", "1000000001"))).toEqual(["shared"]);
  });

  it("lookup xbox by normalised name", async () => {
    const idx = await built();
    expect(ids(idx.lookup("xbox", "2000000002", "SAMPLE   racer"))).toEqual(["steam-only"]);
    expect(ids(idx.lookup("xbox", "2000000002", "Sample Racer™"))).toEqual(["steam-only"]);
    expect(ids(idx.lookup("xbox", "2000000003", "Sample Saga"))).toEqual(["unlabelled"]);
    // A guide that also has an RA row still takes part when it has a Steam row.
    expect(ids(idx.lookup("xbox", "2000000004", "Sample Port"))).toEqual(["ra-and-steam"]);
    expect(idx.lookup("xbox", "2000000005", "Nothing Like It")).toEqual([]);
    expect(idx.lookup("xbox", "2000000006")).toEqual([]);
    expect(idx.lookup("xbox", "2000000007", "™")).toEqual([]);
  });

  it("a hub with an Xbox Title ID row never name-matches another Xbox title", async () => {
    const idx = await built();
    // "shared" names Xbox title 1000000001 in its row; another title of the same name is not it.
    expect(idx.lookup("xbox", "2000000001", "Gears of War: E-Day™")).toEqual([]);
  });

  it("an explicit Xbox row, or a hub remembered for another Xbox title, is never overridden by name", async () => {
    const docs: OutlineDoc[] = [
      {
        id: "flight-2024",
        title: "Microsoft Flight Simulator (2024)",
        url: "/doc/flight-2024-aaa",
        text: "| **Steam App ID** | 1000010 |\n| **Xbox Title ID** | 333 |\n",
      },
      {
        id: "remembered",
        title: "Sample Drift",
        url: "/doc/drift-bbb",
        text: "| **Steam App ID** | 1000011 |\n",
      },
    ];
    const idx = new GuideIndex({
      ...base,
      scheduleDocId: null,
      source: source({ listChildren: async () => docs }),
      memory: memoryFake({ remembered: { last: "xbox", xboxTitleId: "555" } }),
    });
    await idx.refresh();
    expect(idx.lookup("xbox", "444", "Microsoft Flight Simulator")).toEqual([]);
    expect(ids(idx.lookup("xbox", "333", "Microsoft Flight Simulator"))).toEqual(["flight-2024"]);
    expect(idx.lookup("xbox", "444", "Sample Drift")).toEqual([]);
    expect(ids(idx.lookup("xbox", "555", "Sample Drift"))).toEqual(["remembered"]);
  });

  it("RA-only hubs never name-match", async () => {
    const idx = await built();
    expect(idx.lookup("xbox", "2000000001", "Sample Quest")).toEqual([]);
    expect(idx.lookup("xbox", "2000000001", "Sample Quest (GC — RetroAchievements)")).toEqual([]);
  });

  it("two same-named hubs → []", async () => {
    const idx = await built();
    expect(idx.lookup("xbox", "2000000001", "Sample Twins")).toEqual([]);
  });

  it("steam lookup of a shared hub unchanged", async () => {
    const idx = await built();
    expect(ids(idx.lookup("steam", "1000001"))).toEqual(["shared"]);
    expect(ids(idx.lookup("steam", "1000001", "Unrelated Title"))).toEqual(["shared"]);
    expect(idx.lookup("steam", "1000000001")).toEqual([]);
    expect(ids(idx.lookup("ra", "30001"))).toEqual(["ra-only"]);
    // As before, a hub with an RA row is an RA hub for Steam lookups.
    expect(idx.lookup("steam", "1000003")).toEqual([]);
  });

  it("finds a remembered hub by its Xbox title ID and shows what is remembered", async () => {
    const idx = await built(
      memoryFake({
        "steam-only": { last: "xbox", xboxTitleId: "2000000002" },
        shared: { last: "steam", xboxTitleId: "2000000009" },
      }),
    );
    expect(ids(idx.lookup("xbox", "2000000002"))).toEqual(["steam-only"]);
    expect(idx.tree("steam-only")?.hub).toMatchObject({
      source: "steam",
      gameId: "1000002",
      xboxTitleId: "2000000002",
      platforms: ["steam", "xbox"],
      lastPlatform: "xbox",
      platformLabel: "Steam + Xbox",
    });
    // The row wins over a remembered ID.
    expect(idx.tree("shared")?.hub).toMatchObject({
      xboxTitleId: "1000000001",
      lastPlatform: "steam",
    });
    expect(ids(idx.lookup("xbox", "1000000001"))).toEqual(["shared"]);
    expect(idx.hubs().find((h) => h.hubId === "steam-only")?.platformLabel).toBe("Steam + Xbox");
  });
});

describe("isSafeGuideUrl", () => {
  it.each([
    ["/doc/abc", true],
    ["/doc/a-b_c-XyZ123", true],
    ["https://evil.example/doc/abc", false],
    ["/doc/a/b", false],
    ["/doc/", false],
    ["/doc/abc\n", false],
  ])("%s → %s", (url, ok) => expect(isSafeGuideUrl(url)).toBe(ok));
});

describe("GuideIndex auto refresh", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  afterEach(() => {
    vi.useRealTimers();
  });

  function counting(failFirst: number) {
    const state = { calls: 0, failFirst };
    const idx = new GuideIndex({
      ...base,
      source: source({
        listChildren: async () => {
          state.calls += 1;
          if (state.calls <= state.failFirst) throw new Error("down");
          return docs;
        },
      }),
    });
    return { state, idx };
  }

  it("refreshes at once, retries every retryMs until the first success, then goes hourly", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(2);
    const results: boolean[] = [];
    idx.startAutoRefresh({ onResult: (ok) => results.push(ok) });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);
    expect(results).toEqual([false]);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.calls).toBe(3);
    expect(results).toEqual([false, false, true]);
    expect(idx.available()).toBe(true);

    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(state.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(4);
  });

  it("keeps the hourly cadence when a refresh fails after a success", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(0);
    state.failFirst = 0;
    idx.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(idx.available()).toBe(true);
    state.failFirst = 99;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(3);
  });

  it("takes custom retry and interval periods", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(1);
    idx.startAutoRefresh({ retryMs: 100, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(3);
  });

  it("starts no timers and makes no calls without a source", async () => {
    vi.useFakeTimers();
    const idx = new GuideIndex({ ...base, source: null });
    const results: boolean[] = [];
    idx.startAutoRefresh({ onResult: (ok) => results.push(ok) });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(vi.getTimerCount()).toBe(0);
    expect(results).toEqual([]);
  });

  it("stops everything on stopAutoRefresh, even mid-refresh", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(99);
    idx.startAutoRefresh({ retryMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(state.calls).toBe(3);
    idx.stopAutoRefresh();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.calls).toBe(3);

    const second = counting(99);
    second.idx.startAutoRefresh();
    second.idx.stopAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(second.state.calls).toBe(1);
  });

  it("does not double the calls when started twice", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(99);
    idx.startAutoRefresh({ retryMs: 100 });
    idx.startAutoRefresh({ retryMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(3);
  });

  it("keeps refreshing when onResult throws", async () => {
    vi.useFakeTimers();
    const { state, idx } = counting(99);
    let results = 0;
    idx.startAutoRefresh({
      retryMs: 100,
      onResult: () => {
        results += 1;
        if (results === 1) throw new Error("callback broke");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(3);
    expect(results).toBe(3);
    idx.stopAutoRefresh();
  });

  it("unrefs its timers so they never keep the process alive", async () => {
    vi.useFakeTimers();
    const { idx } = counting(99);
    const unref = vi.spyOn(globalThis, "setTimeout");
    idx.startAutoRefresh({ retryMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const timer = unref.mock.results.at(-1)?.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    idx.stopAutoRefresh();
  });
});
