import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeps } from "../src/server/app.js";
import { GuideIndex } from "../src/server/guide-index.js";
import { PlatformMemory } from "../src/server/platform-memory.js";
import { XboxClient } from "../src/server/xbox.js";
import type { XboxAuthState } from "../src/shared/types.js";
import { fixture } from "./helpers.js";
import { INSTRUCTIONS } from "../src/server/assistant-context.js";
import type { PageText } from "../src/server/guide-pages.js";
import type { AchievementsResponse, AskEvent, GuideHub } from "../src/shared/types.js";

const hub: GuideHub = {
  hubId: "h1",
  title: "Zeta",
  url: "/doc/z",
  source: "steam",
  gameId: "10",
  xboxTitleId: null,
  platforms: ["steam"],
  lastPlatform: null,
  trackedOn: null,
  platformLabel: "Steam",
  nowPlaying: false,
};

function parts(over: Record<string, unknown> = {}) {
  return {
    staticDir: "x",
    defaultPins: [] as string[],
    editablePages: [] as string[],
    additionalRaGameIds: [] as string[],
    detector: {
      current: () => ({
        game: { source: "steam" as const, id: "10", title: "Zeta" },
        state: "playing" as const,
        observedAt: Date.UTC(2026, 9, 6),
        presence: null,
        device: null,
        stale: false,
      }),
    },
    index: {
      available: () => true,
      hubs: () => [hub],
      lookup: (s: string, id: string) => (s === "steam" && id === "10" ? [hub] : []),
      tree: () => null,
      requestRefresh: () => {},
    },
    achievements: { get: async () => null },
    pages: {
      find: async () => null,
      marks: async () => null,
      where: async () => null,
      progress: async () => null,
      texts: async () => null,
    },
    ask: null,
    ...over,
  };
}

describe("buildDeps", () => {
  it("adds the configured default pins to every hub tree", () => {
    const tree = () => ({ hub, pages: [] });
    const d = buildDeps(
      parts({
        defaultPins: ["Alpha Page", "Beta Page"],
        index: { ...parts().index, tree },
      }),
    );
    expect(d.hubTree("h1")).toEqual({
      hub,
      pages: [],
      defaultPins: ["Alpha Page", "Beta Page"],
      editablePages: [],
    });
  });

  it("adds the configured editable pages to every hub tree, or an empty list", () => {
    const tree = () => ({ hub, pages: [] });
    const withList = buildDeps(
      parts({ editablePages: ["Sample Notes"], index: { ...parts().index, tree } }),
    );
    expect(withList.hubTree("h1")?.editablePages).toEqual(["Sample Notes"]);
    const without = buildDeps(parts({ index: { ...parts().index, tree } }));
    expect(without.hubTree("h1")?.editablePages).toEqual([]);
  });

  it("reports an empty default pin list when none is configured", () => {
    const tree = () => ({ hub, pages: [] });
    const d = buildDeps(parts({ index: { ...parts().index, tree } }));
    expect(d.hubTree("h1")?.defaultPins).toEqual([]);
    expect(buildDeps(parts()).hubTree("h1")).toBeNull();
  });

  it("attaches the matching hubs and an ISO time to the current game", () => {
    expect(buildDeps(parts()).now()).toEqual({
      game: { source: "steam", id: "10", title: "Zeta" },
      state: "playing",
      stale: false,
      observedAt: "2026-10-06T00:00:00.000Z",
      presence: null,
      device: null,
      hubs: [hub],
      assistant: false,
    });
  });

  it("passes the detector's presence through to the answer", () => {
    const d = buildDeps(
      parts({
        detector: {
          current: () => ({
            game: { source: "ra" as const, id: "20", title: "Zeta" },
            state: "playing" as const,
            observedAt: 1,
            presence: "Chapter 2: Sample Caves",
            device: null,
            stale: false,
          }),
        },
      }),
    );
    expect(d.now().presence).toBe("Chapter 2: Sample Caves");
  });

  it("returns no hubs for a game without an id", () => {
    const d = buildDeps(
      parts({
        detector: {
          current: () => ({
            game: { source: "steam" as const, id: null, title: "Emulator" },
            state: "playing" as const,
            observedAt: 1,
            presence: null,
            device: null,
            stale: false,
          }),
        },
      }),
    );
    expect(d.now().hubs).toEqual([]);
  });

  it("returns nulls when there is no game", () => {
    const d = buildDeps(
      parts({
        detector: {
          current: () => ({
            game: null,
            state: "none" as const,
            observedAt: null,
            presence: null,
            device: null,
            stale: false,
          }),
        },
      }),
    );
    expect(d.now()).toEqual({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      device: null,
      hubs: [],
      assistant: false,
    });
  });

  it("reports guide availability", () => {
    expect(buildDeps(parts()).guides()).toEqual({ available: true, hubs: [hub] });
  });

  it("calls the index and the achievement service as methods, keeping their `this`", async () => {
    class Index {
      private readonly known = hub;
      refreshed = 0;
      available(): boolean {
        return true;
      }
      hubs(): GuideHub[] {
        return [this.known];
      }
      lookup(): GuideHub[] {
        return [this.known];
      }
      tree(id: string) {
        return id === this.known.hubId ? { hub: this.known, pages: [] } : null;
      }
      requestRefresh(): void {
        this.refreshed += 1;
      }
    }
    class Service {
      private readonly title = "Zeta";
      async get(source: "steam" | "ra", id: string) {
        return {
          source,
          id,
          title: this.title,
          total: 0,
          unlocked: 0,
          stale: false,
          achievements: [],
        };
      }
    }
    class Detector {
      private readonly title = "Zeta";
      current() {
        return {
          game: { source: "steam" as const, id: "10", title: this.title },
          state: "playing" as const,
          observedAt: 1,
          stale: false,
        };
      }
    }
    const index = new Index();
    const d = buildDeps(parts({ index, achievements: new Service(), detector: new Detector() }));
    expect(d.now()).toMatchObject({ game: { id: "10", title: "Zeta" }, hubs: [hub] });
    expect(d.guides()).toEqual({ available: true, hubs: [hub] });
    expect(d.hubTree("h1")).toEqual({ hub, pages: [], defaultPins: [], editablePages: [] });
    expect(d.hubTree("nope")).toBeNull();
    d.refreshGuides();
    expect(index.refreshed).toBe(1);
    expect((await d.achievements("steam", "10"))?.title).toBe("Zeta");
  });
});

describe("guide pages", () => {
  it("calls the page service as methods, keeping their `this`", async () => {
    class Pages {
      private readonly title = "Sample Quest";
      asked: string[] = [];
      async find(hubId: string, query: string) {
        this.asked.push(`find:${hubId}:${query}`);
        return {
          matches: [{ pageTitle: this.title, pageUrl: "/doc/a", heading: null, snippet: query }],
          truncated: false,
        };
      }
      async marks(hubId: string) {
        this.asked.push(`marks:${hubId}`);
        return { missable: [this.title.toLowerCase()] };
      }
    }
    const pages = new Pages();
    const d = buildDeps(parts({ pages }));
    expect((await d.find("h1", "needle"))?.matches[0]?.pageTitle).toBe("Sample Quest");
    expect(await d.marks("h1")).toEqual({ missable: ["sample quest"] });
    expect(pages.asked).toEqual(["find:h1:needle", "marks:h1"]);
  });

  it("passes an unknown hub through as null", async () => {
    const d = buildDeps(parts());
    expect(await d.find("nope", "needle")).toBeNull();
    expect(await d.marks("nope")).toBeNull();
  });
});

describe("guide where and progress", () => {
  const ra = (id: string): GuideHub => ({
    ...hub,
    hubId: "h2",
    source: "ra",
    gameId: id,
    xboxTitleId: null,
    platforms: ["ra"],
    lastPlatform: null,
    trackedOn: null,
    platformLabel: "RA",
  });
  const detecting = (
    game: { source: "steam" | "ra"; id: string | null } | null,
    state: "playing" | "last-played" | "none",
    presence: string | null,
  ) => ({
    current: () => ({
      game: game && { ...game, title: "Zeta" },
      state,
      observedAt: 1,
      presence,
      device: null,
      stale: false,
    }),
  });
  function setup(
    snapshot: ReturnType<typeof detecting>,
    hubs: Record<string, GuideHub | null> = { h1: hub },
  ) {
    const asked: unknown[][] = [];
    const pages = {
      find: async () => null,
      marks: async () => null,
      where: async (...args: unknown[]) => {
        asked.push(["where", ...args]);
        return { matches: [] };
      },
      progress: async (...args: unknown[]) => {
        asked.push(["progress", ...args]);
        return { pages: [{ url: "/doc/a", completed: 1, total: 2 }] };
      },
    };
    const index = {
      ...parts().index,
      tree: (id: string) => {
        const h = hubs[id];
        return h ? { hub: h, pages: [] } : null;
      },
    };
    return { asked, d: buildDeps(parts({ pages, index, detector: snapshot })) };
  }
  const playing = { source: "steam" as const, id: "10" };

  it("hands the detector's presence to the page service when this game is being played", async () => {
    const { d, asked } = setup(detecting(playing, "playing", "In Mock Village"));
    await d.where("h1");
    expect(asked).toEqual([["where", "h1", "In Mock Village"]]);
  });

  it("answers the page service's value for a match", async () => {
    const pages = {
      find: async () => null,
      marks: async () => null,
      where: async () => ({
        matches: [{ pageTitle: "G", pageUrl: "/doc/a", heading: "Mock Village", phrase: "Mock" }],
      }),
      progress: async () => null,
    };
    const d = buildDeps(
      parts({
        pages,
        index: { ...parts().index, tree: () => ({ hub, pages: [] }) },
        detector: detecting(playing, "playing", "Mock Village"),
      }),
    );
    expect((await d.where("h1"))?.matches).toHaveLength(1);
  });

  it("calls the page service as methods, keeping their `this`", async () => {
    class Pages {
      private readonly url = "/doc/a";
      find = async () => null;
      marks = async () => null;
      async where(hubId: string, status: string) {
        return {
          matches: [{ pageTitle: hubId, pageUrl: this.url, heading: status, phrase: status }],
        };
      }
      async progress(_hubId: string, opts?: { refresh?: boolean }) {
        return { pages: [{ url: this.url, completed: opts?.refresh ? 2 : 1, total: 3 }] };
      }
    }
    const d = buildDeps(
      parts({
        pages: new Pages(),
        index: { ...parts().index, tree: () => ({ hub, pages: [] }) },
        detector: detecting(playing, "playing", "Mock Village"),
      }),
    );
    expect((await d.where("h1"))?.matches[0]?.pageUrl).toBe("/doc/a");
    expect(await d.progress("h1", { refresh: true })).toEqual({
      pages: [{ url: "/doc/a", completed: 2, total: 3 }],
    });
  });

  it.each([
    ["the state is last-played", detecting(playing, "last-played", "In Mock Village")],
    ["the state is none", detecting(null, "none", "In Mock Village")],
    ["there is no presence", detecting(playing, "playing", null)],
    [
      "another steam game is being played",
      detecting({ source: "steam", id: "11" }, "playing", "x"),
    ],
    [
      "the same id on the other source is being played",
      detecting({ source: "ra", id: "10" }, "playing", "x"),
    ],
    ["the game has no id", detecting({ source: "steam", id: null }, "playing", "x")],
  ])("answers no matches, without the page service, when %s", async (_name, snapshot) => {
    const { d, asked } = setup(snapshot);
    expect(await d.where("h1")).toEqual({ matches: [] });
    expect(asked).toEqual([]);
  });

  it("answers no matches for a hub of another game or source, or with no game id", async () => {
    for (const other of [
      ra("10"),
      { ...hub, gameId: "11" },
      { ...hub, source: null },
      { ...hub, gameId: null },
    ]) {
      const { d, asked } = setup(detecting(playing, "playing", "In Mock Village"), { h1: other });
      expect(await d.where("h1")).toEqual({ matches: [] });
      expect(asked).toEqual([]);
    }
  });

  it("never matches a hub that has no source or game id, even when the detected game's id is null", async () => {
    for (const other of [
      { ...hub, gameId: null },
      { ...hub, source: null, gameId: null },
    ]) {
      const { d, asked } = setup(
        detecting({ source: "steam", id: null }, "playing", "In Mock Village"),
        { h1: other },
      );
      expect(await d.where("h1")).toEqual({ matches: [] });
      expect(asked).toEqual([]);
    }
  });

  it("answers null for an unknown hub without the page service", async () => {
    const { d, asked } = setup(detecting(playing, "playing", "In Mock Village"));
    expect(await d.where("nope")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("passes the hub and the refresh flag on to progress", async () => {
    const { d, asked } = setup(detecting(null, "none", null));
    expect(await d.progress("h1", { refresh: true })).toEqual({
      pages: [{ url: "/doc/a", completed: 1, total: 2 }],
    });
    await d.progress("h1", { refresh: false });
    expect(asked).toEqual([
      ["progress", "h1", { refresh: true }],
      ["progress", "h1", { refresh: false }],
    ]);
  });

  it("passes an unknown hub through as null for progress", async () => {
    expect(await buildDeps(parts()).progress("nope", { refresh: false })).toBeNull();
  });
});

describe("achievements allowlist", () => {
  it("allows only explicitly configured RA IDs without detector or guide history", async () => {
    const calls: [string, string, unknown][] = [];
    const d = buildDeps(
      parts({
        additionalRaGameIds: ["724", "16084", "11632"],
        detector: {
          current: () => ({ game: null, state: "none" as const, observedAt: null, stale: false }),
        },
        index: { ...parts().index, lookup: () => [] },
        achievements: {
          get: async (source: "steam" | "ra", id: string, opts: unknown) => {
            calls.push([source, id, opts]);
            return null;
          },
        },
      }),
    );
    for (const id of ["724", "16084", "11632"]) await d.achievements("ra", id);
    await d.achievements("ra", "999");
    await d.achievements("steam", "724");
    expect(calls).toEqual(["724", "16084", "11632"].map((id) => ["ra", id, { priority: false }]));
  });
  function gated(over: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const achievements = {
      get: async (source: "steam" | "ra", id: string) => {
        asked.push(`${source}:${id}`);
        return {
          source,
          id,
          title: "T",
          total: 0,
          unlocked: 0,
          stale: false,
          achievements: [],
        };
      },
    };
    return { asked, parts: parts({ achievements, ...over }) };
  }

  const detectorOf = (game: { source: "steam" | "ra"; id: string | null } | null) => ({
    current: () => ({
      game: game && { ...game, title: "G" },
      state: game ? ("playing" as const) : ("none" as const),
      observedAt: 1,
      presence: null,
      device: null,
      stale: false,
    }),
  });

  const noHubs = { lookup: () => [] as GuideHub[] };
  const indexWith = (over: Record<string, unknown>) => ({ ...parts().index, ...over });

  it("answers null without calling the service for an unknown, never-detected game", async () => {
    const g = gated({ detector: detectorOf(null), index: indexWith(noHubs) });
    const d = buildDeps(g.parts);
    expect(await d.achievements("steam", "999")).toBeNull();
    expect(await d.achievements("ra", "999")).toBeNull();
    expect(g.asked).toEqual([]);
  });

  it("serves a game that a hub in the index names, for that source only", async () => {
    const g = gated({ detector: detectorOf(null) });
    const d = buildDeps(g.parts);
    expect((await d.achievements("steam", "10"))?.id).toBe("10");
    expect(await d.achievements("ra", "10")).toBeNull();
    expect(g.asked).toEqual(["steam:10"]);
  });

  it("serves a game the detector reports, with or without a guide", async () => {
    const current = { game: { source: "ra" as const, id: "77" as string | null } };
    const g = gated({
      detector: { current: () => detectorOf(current.game).current() },
      index: indexWith(noHubs),
    });
    const d = buildDeps(g.parts);
    expect(await d.achievements("ra", "78")).toBeNull();
    expect((await d.achievements("ra", "77"))?.id).toBe("77");
    d.now();
    expect((await d.achievements("ra", "77"))?.id).toBe("77");
    expect(await d.achievements("steam", "77")).toBeNull();
    expect(g.asked).toEqual(["ra:77", "ra:77"]);
  });

  it("keeps serving a detected game after the detector moves on", async () => {
    const current: { game: { source: "steam" | "ra"; id: string | null } | null } = {
      game: { source: "steam", id: "5" },
    };
    const g = gated({
      detector: { current: () => detectorOf(current.game).current() },
      index: indexWith(noHubs),
    });
    const d = buildDeps(g.parts);
    d.now();
    current.game = { source: "ra", id: "6" };
    d.now();
    current.game = null;
    expect((await d.achievements("steam", "5"))?.id).toBe("5");
    expect((await d.achievements("ra", "6"))?.id).toBe("6");
  });

  it("does not record a game without an id", async () => {
    const g = gated({
      detector: detectorOf({ source: "steam", id: null }),
      index: indexWith(noHubs),
    });
    const d = buildDeps(g.parts);
    d.now();
    expect(await d.achievements("steam", "null")).toBeNull();
    expect(g.asked).toEqual([]);
  });

  it("remembers at most 20 detected games, dropping the oldest", async () => {
    const current: { game: { source: "steam"; id: string } } = {
      game: { source: "steam", id: "1" },
    };
    const g = gated({
      detector: { current: () => detectorOf(current.game).current() },
      index: indexWith(noHubs),
    });
    const d = buildDeps(g.parts);
    for (let i = 1; i <= 21; i += 1) {
      current.game = { source: "steam", id: String(i) };
      d.now();
    }
    expect(await d.achievements("steam", "1")).toBeNull();
    expect((await d.achievements("steam", "2"))?.id).toBe("2");
    expect((await d.achievements("steam", "21"))?.id).toBe("21");
  });

  it("marks a request priority exactly when the detector reported the game", async () => {
    const calls: [string, string, unknown][] = [];
    const recording = {
      get: async (source: "steam" | "ra", id: string, opts?: { priority?: boolean }) => {
        calls.push([source, id, opts?.priority ?? false]);
        return null;
      },
    };
    const d = buildDeps(
      parts({
        achievements: recording,
        detector: detectorOf({ source: "steam", id: "10" }),
        index: indexWith({
          lookup: (s: string, id: string) => (s === "ra" && id === "20" ? [hub] : []),
        }),
      }),
    );
    await d.achievements("steam", "10");
    await d.achievements("ra", "20");
    expect(calls).toEqual([
      ["steam", "10", true],
      ["ra", "20", false],
    ]);
  });

  describe("priority is for the current game only", () => {
    function setup() {
      const calls: [string, string, boolean][] = [];
      const current: { game: { source: "steam" | "ra"; id: string | null } | null } = {
        game: { source: "steam", id: "1" },
      };
      const recording = {
        get: async (source: "steam" | "ra", id: string, opts?: { priority?: boolean }) => {
          calls.push([source, id, opts?.priority ?? false]);
          return null;
        },
      };
      const d = buildDeps(
        parts({
          achievements: recording,
          detector: { current: () => detectorOf(current.game).current() },
          index: indexWith({
            lookup: (s: string, id: string) => (s === "ra" && id === "20" ? [hub] : []),
          }),
        }),
      );
      return { calls, current, d };
    }

    it("gives priority to the current game, not to one that is only in the history", async () => {
      const { calls, current, d } = setup();
      d.now();
      current.game = { source: "steam", id: "2" };
      d.now();
      await d.achievements("steam", "2");
      await d.achievements("steam", "1");
      expect(calls).toEqual([
        ["steam", "2", true],
        ["steam", "1", false],
      ]);
    });

    it("treats a guide-only game as non-priority", async () => {
      const { calls, d } = setup();
      await d.achievements("ra", "20");
      expect(calls).toEqual([["ra", "20", false]]);
    });

    it("makes nothing priority when the current snapshot has no game, but still allows history", async () => {
      const { calls, current, d } = setup();
      d.now();
      current.game = null;
      await d.achievements("steam", "1");
      expect(calls).toEqual([["steam", "1", false]]);
    });

    it("makes nothing priority when the current game has no id", async () => {
      const { calls, current, d } = setup();
      d.now();
      current.game = { source: "steam", id: null };
      await d.achievements("steam", "1");
      expect(calls).toEqual([["steam", "1", false]]);
    });
  });
});

describe("ask", () => {
  const ORIGIN = "https://wiki.example.test";
  const req = (over: Record<string, unknown> = {}) => ({
    hubId: "h1" as string | null,
    game: { source: "steam" as const, id: "10" } as { source: "steam" | "ra"; id: string } | null,
    history: [{ question: "Q1", answer: "A1" }],
    question: "What next?",
    depth: "hint" as const,
    ...over,
  });
  const text = (title: string, body: string): PageText => ({
    id: title,
    title,
    url: `/doc/${title}`,
    text: body,
  });
  const achievements: AchievementsResponse = {
    source: "steam",
    id: "10",
    title: "Zeta Achievements",
    total: 4,
    unlocked: 1,
    stale: false,
    achievements: [
      {
        id: "A",
        name: "Golden Lantern",
        description: "Find it",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: null,
        hidden: false,
        missable: false,
        kind: null,
      },
    ],
  };
  const events: AskEvent[] = [
    { type: "text", text: "Go left." },
    { type: "done", truncatedGuide: false },
  ];

  function setup(over: Record<string, unknown> = {}) {
    const calls = {
      ask: [] as unknown[][],
      texts: [] as string[],
      get: [] as unknown[][],
      where: [] as unknown[][],
    };
    const base = parts();
    const built = parts({
      defaultPins: ["Notes"],
      index: {
        ...base.index,
        tree: (id: string) => (id === "h1" ? { hub, pages: [] } : null),
      },
      achievements: {
        get: async (...args: unknown[]) => {
          calls.get.push(args);
          return achievements;
        },
      },
      pages: {
        ...base.pages,
        texts: async (id: string) => {
          calls.texts.push(id);
          return id === "h1"
            ? [text("Walkthrough", "walk"), text("Notes", "- [ ] \u26A0 **Golden Lantern**")]
            : null;
        },
        where: async (...args: unknown[]) => {
          calls.where.push(args);
          return {
            matches: [
              {
                pageTitle: "Walkthrough",
                pageUrl: "/doc/w",
                heading: "Mock Village",
                phrase: "Mock",
              },
            ],
          };
        },
      },
      ask: {
        origin: ORIGIN,
        limiter: { admit: () => ({ ok: true }) },
        agent: {
          ask: async (...args: unknown[]) => {
            calls.ask.push(args);
            return (async function* () {
              yield* events;
            })();
          },
        },
      },
      ...over,
    });
    return { calls, d: buildDeps(built) };
  }
  const detecting = (
    game: { source: "steam" | "ra"; id: string | null } | null,
    state: "playing" | "last-played" | "none",
    presence: string | null = null,
  ) => ({
    current: () => ({
      game: game && { ...game, title: "Detected Title" },
      state,
      observedAt: 1,
      presence,
      device: null,
      stale: false,
    }),
  });
  const collect = async (g: AsyncIterable<AskEvent> | "busy" | null | undefined) => {
    const out: AskEvent[] = [];
    if (g === "busy") return out;
    for await (const e of g ?? []) out.push(e);
    return out;
  };
  const sent = (calls: { ask: unknown[][] }) => calls.ask[0]?.[0] as Record<string, unknown>;

  it("reports the assistant on now() and exposes the origin and admission", () => {
    const { d } = setup();
    expect(d.now().assistant).toBe(true);
    expect(d.ask?.origin).toBe(ORIGIN);
    expect(d.ask?.admit()).toEqual({ ok: true });
    const off = buildDeps(parts());
    expect(off.now().assistant).toBe(false);
    expect(off.ask).toBeNull();
  });

  it("answers null for an unknown hub", async () => {
    const { d, calls } = setup();
    expect(d.ask?.allowed(req({ hubId: "nope" }))).toBe(false);
    expect(await d.ask?.start(req({ hubId: "nope" }), new AbortController().signal)).toBeNull();
    expect(calls.ask).toHaveLength(0);
  });

  it("gates a game exactly like the achievements lookup", async () => {
    const signal = new AbortController().signal;
    // Not detected, not indexed, not allowlisted.
    const closed = setup({
      detector: detecting({ source: "steam", id: "99" }, "playing"),
      index: { ...parts().index, lookup: () => [] },
    });
    expect(
      await closed.d.ask?.start(req({ hubId: null, game: { source: "ra", id: "5" } }), signal),
    ).toBeNull();
    expect(closed.d.ask?.allowed(req({ hubId: null, game: { source: "ra", id: "5" } }))).toBe(
      false,
    );
    expect(await closed.d.achievements("ra", "5")).toBeNull();
    expect(closed.calls.get).toHaveLength(0);

    // Detected game.
    const seen = setup({
      detector: detecting({ source: "ra", id: "5" }, "playing"),
      index: { ...parts().index, lookup: () => [] },
    });
    expect(
      await collect(
        await seen.d.ask?.start(req({ hubId: null, game: { source: "ra", id: "5" } }), signal),
      ),
    ).toEqual(events);
    expect(seen.d.ask?.allowed(req({ hubId: null, game: { source: "ra", id: "5" } }))).toBe(true);

    // Indexed game.
    const indexed = setup({ detector: detecting(null, "none") });
    expect(await indexed.d.ask?.start(req({ hubId: null }), signal)).not.toBeNull();
    expect(indexed.d.ask?.allowed(req({ hubId: null }))).toBe(true);

    // Explicit RA allowlist.
    const listed = setup({
      detector: detecting(null, "none"),
      additionalRaGameIds: ["77"],
      index: { ...parts().index, lookup: () => [] },
    });
    expect(
      await listed.d.ask?.start(req({ hubId: null, game: { source: "ra", id: "77" } }), signal),
    ).not.toBeNull();
    expect(
      await listed.d.ask?.start(req({ hubId: null, game: { source: "steam", id: "77" } }), signal),
    ).toBeNull();
    expect(listed.d.ask?.allowed(req({ hubId: null, game: { source: "ra", id: "77" } }))).toBe(
      true,
    );
    expect(listed.d.ask?.allowed(req({ hubId: null, game: { source: "steam", id: "77" } }))).toBe(
      false,
    );
  });

  it("builds the context from the hub's pages, achievements and the playing status", async () => {
    const { d, calls } = setup({
      detector: detecting({ source: "steam", id: "10" }, "playing", "In Mock Village"),
    });
    const ctl = new AbortController();
    const out = await collect(await d.ask?.start(req(), ctl.signal));
    expect(out).toEqual(events);
    expect(calls.texts).toEqual(["h1"]);
    expect(calls.get).toEqual([["steam", "10", { priority: true }]]);
    expect(calls.where).toEqual([["h1", "In Mock Village"]]);

    const [body, signal] = calls.ask[0] as [Record<string, unknown>, AbortSignal];
    expect(Object.keys(body).sort()).toEqual([
      "depth",
      "history",
      "hub",
      "instructions",
      "question",
      "statusBlock",
    ]);
    expect(body.instructions).toBe(INSTRUCTIONS);
    expect(body.statusBlock).toBe(
      [
        "Game: Zeta (Steam)",
        "State: playing",
        "Status line: In Mock Village",
        "Achievements: 1/4 unlocked",
        "Missables still open:",
        "- Golden Lantern \u2014 Find it",
        "Guide section matching the status line: Walkthrough \u203A Mock Village",
      ].join("\n"),
    );
    expect(body.history).toEqual([{ question: "Q1", answer: "A1" }]);
    expect(body.question).toBe("What next?");
    expect(body.depth).toBe("hint");
    expect(body.hub).toBe("h1");
    expect(signal).toBe(ctl.signal);
  });

  it("sends no guide text: the agent reads pages through its tools", async () => {
    const { d, calls } = setup({
      detector: detecting({ source: "steam", id: "10" }, "playing", "In Mock Village"),
    });
    await collect(await d.ask?.start(req(), new AbortController().signal));
    const json = JSON.stringify(sent(calls));
    expect(json).not.toContain("walk");
    expect(json).not.toContain("Pinned pages");
    expect(json).not.toContain("Guide outline");
  });

  it("hands back the agent's busy answer", async () => {
    const { d } = setup({
      ask: {
        origin: ORIGIN,
        limiter: { admit: () => ({ ok: true }) },
        agent: { ask: async () => "busy" as const },
      },
    });
    expect(await d.ask?.start(req(), new AbortController().signal)).toBe("busy");
  });

  it("leaves out the status line and the section unless this hub's game is being played", async () => {
    for (const snap of [
      detecting({ source: "steam", id: "10" }, "last-played", "In Mock Village"),
      detecting({ source: "ra", id: "10" }, "playing", "In Mock Village"),
      detecting(null, "none"),
    ]) {
      const { d, calls } = setup({ detector: snap });
      await collect(await d.ask?.start(req(), new AbortController().signal));
      const status = sent(calls).statusBlock as string;
      expect(status).not.toContain("Status line");
      expect(status).not.toContain("Guide section");
      expect(calls.where).toHaveLength(0);
    }
  });

  it("maps the detector state to the play state", async () => {
    const states: [ReturnType<typeof detecting>, string][] = [
      [detecting({ source: "steam", id: "10" }, "last-played"), "State: last-played"],
      [detecting({ source: "ra", id: "10" }, "playing"), "State: not detected"],
      [detecting(null, "none"), "State: not detected"],
    ];
    for (const [snap, line] of states) {
      const { d, calls } = setup({ detector: snap });
      await collect(await d.ask?.start(req(), new AbortController().signal));
      expect(sent(calls).statusBlock).toContain(line);
    }
  });

  it("asks for achievements without priority when another game is playing", async () => {
    const { d, calls } = setup({ detector: detecting({ source: "steam", id: "11" }, "playing") });
    await d.ask?.start(req(), new AbortController().signal);
    expect(calls.get).toEqual([["steam", "10", { priority: false }]]);
  });

  it("seeds a hub-only question with the hub's game's achievements", async () => {
    const { d, calls } = setup({
      detector: detecting({ source: "steam", id: "10" }, "playing", "In Mock Village"),
    });
    const hubOnly = req({ game: null });
    expect(d.ask?.allowed(hubOnly)).toBe(true);
    await collect((await d.ask?.start(hubOnly, new AbortController().signal)) ?? null);
    expect(calls.get).toEqual([["steam", "10", { priority: true }]]);
    const status = sent(calls).statusBlock as string;
    expect(status).toContain("Achievements: 1/4 unlocked");
    expect(status).toContain("- Golden Lantern");
  });

  it("builds the whole context from the hub's game when a different game is sent with it", async () => {
    const snap = detecting({ source: "steam", id: "10" }, "playing", "In Mock Village");
    const matched = setup({ detector: snap });
    await collect(await matched.d.ask?.start(req(), new AbortController().signal));

    const mismatched = setup({ detector: snap });
    const other = req({ game: { source: "ra", id: "5" } });
    // The sent game is ignored, so it need not be allowed.
    expect(mismatched.d.ask?.allowed(other)).toBe(true);
    await collect(await mismatched.d.ask?.start(other, new AbortController().signal));

    expect(mismatched.calls.get).toEqual([["steam", "10", { priority: true }]]);
    expect(sent(mismatched.calls)).toEqual(sent(matched.calls));
  });

  it("tolerates an achievements failure", async () => {
    const { d, calls } = setup({
      achievements: {
        get: async () => {
          throw new Error("down");
        },
      },
    });
    await collect(await d.ask?.start(req(), new AbortController().signal));
    expect(sent(calls).statusBlock).toContain("Achievements: unknown");
  });

  it("works from a game alone: no pages, titled from the achievements, labelled by source", async () => {
    const { d, calls } = setup({ detector: detecting(null, "none"), additionalRaGameIds: ["5"] });
    await collect(
      (await d.ask?.start(
        req({ hubId: null, game: { source: "ra", id: "5" } }),
        new AbortController().signal,
      )) ?? null,
    );
    expect(calls.texts).toHaveLength(0);
    expect((sent(calls).statusBlock as string).split("\n")[0]).toBe(
      "Game: Zeta Achievements (RetroAchievements)",
    );
    expect(sent(calls).hub).toBeNull();
  });
});

describe("mcp tools", () => {
  const other: GuideHub = {
    hubId: "h2",
    title: "Omega",
    url: "/doc/o",
    source: "ra",
    gameId: "20",
    xboxTitleId: null,
    platforms: ["ra"],
    lastPlatform: null,
    trackedOn: null,
    platformLabel: "RA · GC",
    nowPlaying: false,
  };
  const loose: GuideHub = { ...other, hubId: "h3", title: "Loose", source: null, gameId: null };
  const page = (title: string, body: string): PageText => ({
    id: title,
    title,
    url: `/doc/${title}`,
    text: body,
  });
  const zetaPages = [
    page(
      "Walkthrough",
      "# Mock Village\nTalk to the sample smith.\n## Mock Caves\nFind the lantern.",
    ),
    page("Notes", "- [ ] ⚠ **Golden Lantern**"),
  ];
  const zetaAch: AchievementsResponse = {
    source: "steam",
    id: "10",
    title: "Zeta Achievements",
    total: 4,
    unlocked: 1,
    stale: false,
    achievements: [
      {
        id: "A",
        name: "Golden Lantern",
        description: "Find it",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: null,
        hidden: false,
        missable: false,
        kind: null,
      },
    ],
  };
  const playing = (game: { source: "steam" | "ra"; id: string | null } | null, presence = "") => ({
    current: () => ({
      game: game && { ...game, title: "Detected Title" },
      state: game ? ("playing" as const) : ("none" as const),
      observedAt: 1,
      presence: presence === "" ? null : presence,
      device: null,
      stale: false,
    }),
  });

  function setup(over: Record<string, unknown> = {}) {
    const calls = { texts: [] as string[], get: [] as unknown[][], where: [] as unknown[][] };
    const hubs = [hub, other, loose];
    const base = parts();
    const d = buildDeps(
      parts({
        defaultPins: ["Notes"],
        index: {
          ...base.index,
          hubs: () => hubs,
          lookup: (s: string, id: string) => hubs.filter((h) => h.source === s && h.gameId === id),
          tree: (id: string) => {
            const found = hubs.find((h) => h.hubId === id);
            return found ? { hub: found, pages: [] } : null;
          },
        },
        achievements: {
          get: async (...args: unknown[]) => {
            calls.get.push(args);
            return args[0] === "steam" && args[1] === "10" ? zetaAch : null;
          },
        },
        pages: {
          ...base.pages,
          texts: async (id: string) => {
            calls.texts.push(id);
            if (id === "h1") return zetaPages;
            if (id === "h2") return [page("Omega Guide", "# Start\nOmega text.")];
            if (id === "h3") return [];
            return null;
          },
          where: async (...args: unknown[]) => {
            calls.where.push(args);
            return {
              matches: [
                {
                  pageTitle: "Walkthrough",
                  pageUrl: "/doc/w",
                  heading: "Mock Village",
                  phrase: "x",
                },
              ],
            };
          },
        },
        mcp: { token: "sample-token", version: "9.9.9" },
        ...over,
      }),
    );
    const tools = d.mcp?.tools;
    if (!tools) throw new Error("mcp tools missing");
    return { calls, d, tools };
  }

  const NO_CURRENT = {
    text: "No guide for the current game. Call list_guides and pass hub.",
    isError: true,
  };
  const unknown = (id: string) => ({
    text: `Unknown guide "${id}". Call list_guides for the guide ids.`,
    isError: true,
  });
  const UNLOADED = { text: "The guide could not be loaded right now.", isError: true };

  it("is off without a token, and carries the token and version with one", () => {
    expect(buildDeps(parts()).mcp).toBeNull();
    const { d } = setup();
    expect(d.mcp?.token).toBe("sample-token");
    expect(d.mcp?.version).toBe("9.9.9");
  });

  it("lists every guide with its platform and hub id", async () => {
    const { tools } = setup();
    expect(await tools.listGuides()).toEqual({
      text: ["- Zeta (Steam): h1", "- Omega (RA · GC): h2", "- Loose (RA · GC): h3"].join("\n"),
    });
  });

  it("reports an unavailable or empty guide list", async () => {
    const off = setup({ index: { ...parts().index, available: () => false } });
    expect(await off.tools.listGuides()).toEqual({
      text: "The guide list is not available right now.",
      isError: true,
    });
    const none = setup({ index: { ...parts().index, hubs: () => [] } });
    expect(await none.tools.listGuides()).toEqual({ text: "There are no guides." });
  });

  it("defaults the guide tools to the current game's guide", async () => {
    const { tools, calls } = setup({ detector: playing({ source: "steam", id: "10" }) });
    const outline = await tools.outline(undefined);
    expect(outline).toEqual({
      text: [
        "## Walkthrough (72 chars)",
        "  - Mock Village",
        "    - Mock Caves",
        "## Notes (26 chars)",
      ].join("\n"),
    });
    expect(await tools.search("lantern", undefined)).toEqual({
      text: ["- Walkthrough › Mock Caves: Find the lantern.", "- Notes: ⚠ Golden Lantern"].join(
        "\n",
      ),
    });
    expect(await tools.read("walkthrough", "mock caves", undefined)).toEqual({
      text: "## Mock Caves\nFind the lantern.",
    });
    expect(calls.texts).toEqual(["h1", "h1", "h1"]);
  });

  it("uses a named guide over the current game's", async () => {
    const { tools, calls } = setup({ detector: playing({ source: "steam", id: "10" }) });
    expect(await tools.read("Omega Guide", undefined, "h2")).toEqual({
      text: "# Start\nOmega text.",
    });
    expect(calls.texts).toEqual(["h2"]);
  });

  it("errors when no guide is named and the current game has none", async () => {
    for (const detector of [
      playing(null),
      playing({ source: "steam", id: null }),
      playing({ source: "steam", id: "99" }),
    ]) {
      const { tools, calls } = setup({ detector });
      expect(await tools.outline(undefined)).toEqual(NO_CURRENT);
      expect(await tools.search("lantern", undefined)).toEqual(NO_CURRENT);
      expect(await tools.read("Walkthrough", undefined, undefined)).toEqual(NO_CURRENT);
      expect(calls.texts).toEqual([]);
    }
  });

  it("errors on an unknown guide id", async () => {
    const { tools, calls } = setup();
    expect(await tools.outline("zz")).toEqual(unknown("zz"));
    expect(await tools.search("lantern", "zz")).toEqual(unknown("zz"));
    expect(await tools.read("Walkthrough", undefined, "zz")).toEqual(unknown("zz"));
    expect(await tools.status("zz")).toEqual(unknown("zz"));
    expect(calls.texts).toEqual([]);
  });

  it("errors on an unknown page or section with the readGuide text", async () => {
    const { tools } = setup();
    expect(await tools.read("Missing", undefined, "h1")).toEqual({
      text: 'No page called "Missing". Pages: Walkthrough; Notes',
      isError: true,
    });
    expect(await tools.read("Walkthrough", "Nowhere", "h1")).toEqual({
      text: 'No section called "Nowhere" on Walkthrough. Sections: Mock Village; Mock Caves',
      isError: true,
    });
  });

  it("errors when the guide's pages cannot be loaded", async () => {
    const failing = setup({
      pages: {
        ...parts().pages,
        texts: async () => {
          throw new Error("limit");
        },
      },
    });
    expect(await failing.tools.outline("h1")).toEqual(UNLOADED);
    const { tools } = setup();
    expect(await tools.outline("h3")).toEqual(UNLOADED);
    expect(await tools.search("x", "h3")).toEqual(UNLOADED);
  });

  it("builds the status block for the current game's guide like Ask does", async () => {
    const { tools, calls } = setup({
      detector: playing({ source: "steam", id: "10" }, "In Mock Village"),
    });
    expect(await tools.status(undefined)).toEqual({
      text: [
        "Game: Zeta (Steam)",
        "State: playing",
        "Status line: In Mock Village",
        "Achievements: 1/4 unlocked",
        "Missables still open:",
        "- Golden Lantern — Find it",
        "Guide section matching the status line: Walkthrough › Mock Village",
      ].join("\n"),
    });
    expect(calls.get).toEqual([["steam", "10", { priority: true }]]);
    expect(calls.where).toEqual([["h1", "In Mock Village"]]);
  });

  it("reports a named guide's game as not detected while another is played", async () => {
    const { tools, calls } = setup({
      detector: playing({ source: "steam", id: "10" }, "In Mock Village"),
    });
    expect(await tools.status("h2")).toEqual({
      text: ["Game: Omega (RA · GC)", "State: not detected", "Achievements: unknown"].join("\n"),
    });
    expect(calls.get).toEqual([["ra", "20", { priority: false }]]);
    expect(calls.where).toEqual([]);
  });

  it("reports the current game without a guide when it has none", async () => {
    const { tools, calls } = setup({
      detector: playing({ source: "ra", id: "55" }, "Somewhere"),
    });
    expect(await tools.status(undefined)).toEqual({
      text: [
        "Game: Detected Title (RetroAchievements)",
        "State: playing",
        "Status line: Somewhere",
        "Achievements: unknown",
      ].join("\n"),
    });
    expect(calls.texts).toEqual([]);
  });

  it("errors on status when no game is detected and no guide is named", async () => {
    for (const detector of [playing(null), playing({ source: "steam", id: null })]) {
      const { tools } = setup({ detector });
      expect(await tools.status(undefined)).toEqual({
        text: "No game is detected right now. Call list_guides and pass hub.",
        isError: true,
      });
    }
  });
});

describe("xbox", () => {
  const xboxGame = { source: "xbox" as const, id: "1000000001", title: "Sample Wars: E-Day™" };
  const xboxSnapshot = (state: "playing" | "last-played" = "playing") => ({
    current: () => ({
      game: xboxGame,
      state,
      observedAt: Date.UTC(2026, 9, 18),
      presence: state === "playing" ? "Act 2: Sample Bridge" : null,
      device: state === "playing" ? "Series X" : null,
      stale: false,
    }),
  });
  const docs = [
    {
      id: "hub-wars",
      title: "Sample Wars: E-Day",
      url: "/doc/wars-aaa",
      text: "| **Steam App ID** | 1000001 |\n",
    },
    { id: "hub-other", title: "Other Game", url: "/doc/other-bbb", text: "no id" },
  ];
  const tree = [
    {
      id: "p1",
      title: "Guides",
      url: "/doc/guides-ppp",
      children: docs.map((d) => ({ id: d.id, title: d.title, url: d.url, children: [] })),
    },
  ];

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-xbox-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The memory file is written in the background; wait for it before the directory goes. */
  const written = (file: string) => vi.waitFor(() => readFile(file, "utf8"));

  async function realParts(memory: PlatformMemory) {
    const index = new GuideIndex({
      source: {
        listChildren: async () => docs,
        collectionTree: async () => tree,
        docText: async () => "",
      },
      collectionId: "c",
      guidesParentId: "p1",
      scheduleDocId: null,
      memory,
    });
    await index.refresh();
    return index;
  }

  it("now for an xbox game returns hubs, device and presence", async () => {
    const file = join(dir, "platforms.json");
    const memory = new PlatformMemory({ file });
    await memory.load();
    const index = await realParts(memory);
    const d = buildDeps(parts({ index, detector: xboxSnapshot(), memory }));
    const now = d.now();
    await written(file);
    expect(now).toMatchObject({
      game: xboxGame,
      state: "playing",
      presence: "Act 2: Sample Bridge",
      device: "Series X",
    });
    expect(now.hubs).toEqual([
      {
        hubId: "hub-wars",
        title: "Sample Wars: E-Day",
        url: "/doc/wars-aaa",
        source: "steam",
        gameId: "1000001",
        xboxTitleId: "1000000001",
        platforms: ["steam", "xbox"],
        lastPlatform: "xbox",
        trackedOn: null,
        platformLabel: "Steam + Xbox",
        nowPlaying: false,
      },
    ]);
  });

  it("name-matched hub is remembered and later found by title id", async () => {
    const file = join(dir, "platforms.json");
    const memory = new PlatformMemory({ file });
    await memory.load();
    const index = await realParts(memory);
    const d = buildDeps(parts({ index, detector: xboxSnapshot(), memory }));
    d.now();
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(saved["hub-wars"]).toMatchObject({ last: "xbox", xboxTitleId: "1000000001" });
    });

    // After a restart, without the title: found by the remembered ID, and allowed for lookups.
    const reloaded = new PlatformMemory({ file });
    await reloaded.load();
    const index2 = await realParts(reloaded);
    expect(index2.lookup("xbox", "1000000001").map((h) => h.hubId)).toEqual(["hub-wars"]);
    const got: unknown[] = [];
    const d2 = buildDeps(
      parts({
        index: index2,
        detector: { current: () => ({ ...xboxSnapshot().current(), game: null, state: "none" }) },
        achievements: {
          get: async (...args: unknown[]) => {
            got.push(args);
            return null;
          },
        },
      }),
    );
    await d2.achievements("xbox", "1000000001");
    expect(got).toEqual([["xbox", "1000000001", { priority: false }]]);
    expect(d2.guides().hubs.find((h) => h.hubId === "hub-wars")).toMatchObject({
      platforms: ["steam", "xbox"],
      lastPlatform: "xbox",
      trackedOn: null,
      xboxTitleId: "1000000001",
    });
  });

  it("records Steam when a Steam game with a guide is being played, and nothing when last played", async () => {
    const recorded: unknown[][] = [];
    const memory = {
      record: async (...args: unknown[]) => {
        recorded.push(args);
      },
    };
    buildDeps(parts({ memory })).now();
    expect(recorded).toEqual([["h1", "steam"]]);
    recorded.length = 0;
    buildDeps(parts({ memory, detector: xboxSnapshot("last-played") })).now();
    expect(recorded).toEqual([]);
  });

  it("logs a failed memory write without failing the answer", async () => {
    const lines: string[] = [];
    const memory = {
      record: async () => {
        throw new Error("EACCES: /secret/path");
      },
    };
    const d = buildDeps(parts({ memory, log: (line: string) => lines.push(line) }));
    expect(d.now().hubs).toEqual([hub]);
    await vi.waitFor(() => expect(lines).toEqual(["platform memory write failed"]));
  });

  it("offers the status line to a hub found for the Xbox game by name", async () => {
    const file = join(dir, "platforms.json");
    const memory = new PlatformMemory({ file });
    await memory.load();
    const index = await realParts(memory);
    const asked: unknown[][] = [];
    const d = buildDeps(
      parts({
        index,
        memory,
        detector: xboxSnapshot(),
        pages: {
          ...parts().pages,
          where: async (...args: unknown[]) => {
            asked.push(args);
            return { matches: [] };
          },
        },
      }),
    );
    d.now();
    await written(file);
    await d.where("hub-wars");
    await d.where("hub-other");
    expect(asked).toEqual([["hub-wars", "Act 2: Sample Bridge"]]);
  });

  it("labels an Xbox game without a guide as Xbox for Ask", async () => {
    const calls: unknown[] = [];
    const d = buildDeps(
      parts({
        detector: xboxSnapshot(),
        ask: {
          origin: "https://wiki.example",
          limiter: { admit: () => ({ ok: true }) },
          agent: {
            ask: async (body: unknown) => {
              calls.push(body);
              return null;
            },
          },
        },
      }),
    );
    await d.ask?.start(
      {
        hubId: null,
        game: { source: "xbox", id: "1000000001" },
        history: [],
        question: "q",
        depth: "hint",
      },
      new AbortController().signal,
    );
    expect((calls[0] as { statusBlock: string }).statusBlock.split("\n")[0]).toBe(
      "Game: Sample Wars: E-Day™ (Xbox)",
    );
  });
});

describe("xbox sign-in", () => {
  const states: string[] = [];
  const auth = {
    status: () => ({
      state: "disconnected" as const,
      gamertag: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    }),
    startConnect: async () => {
      states.push("connect");
      return { ...auth.status(), state: "connecting" as const, userCode: "ABCD-EFGH" };
    },
    cancelConnect: () => void states.push("cancel"),
    disconnect: async () => void states.push("disconnect"),
  };

  it("is absent without Xbox, and hands the routes the sign-in with its origin", async () => {
    expect(buildDeps(parts()).xbox).toBeNull();
    const d = buildDeps(parts({ xbox: { origin: "https://wiki.example.test", auth } }));
    const xbox = d.xbox;
    expect(xbox?.origin).toBe("https://wiki.example.test");
    expect(xbox?.status().state).toBe("disconnected");
    expect((await xbox?.connect())?.userCode).toBe("ABCD-EFGH");
    expect(xbox?.cancel().state).toBe("disconnected");
    expect((await xbox?.disconnect())?.state).toBe("disconnected");
    expect(states).toEqual(["connect", "cancel", "disconnect"]);
  });
});

describe("xbox in Ask and companion_status", () => {
  const shared: GuideHub = {
    hubId: "shared",
    title: "Sample Wars",
    url: "/doc/wars",
    source: "steam",
    gameId: "10",
    xboxTitleId: "1000000001",
    platforms: ["steam", "xbox"],
    lastPlatform: "xbox",
    trackedOn: null,
    platformLabel: "Steam + Xbox",
    nowPlaying: false,
  };
  const steamAch: AchievementsResponse = {
    source: "steam",
    id: "10",
    title: "Sample Wars",
    total: 2,
    unlocked: 0,
    stale: false,
    achievements: [
      {
        id: "S1",
        name: "Steam Medal",
        description: "Steam only",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: null,
        hidden: false,
        missable: false,
        kind: null,
      },
    ],
  };
  const xboxAch: AchievementsResponse = {
    source: "xbox",
    id: "1000000001",
    title: "Sample Wars",
    total: 3,
    unlocked: 1,
    stale: false,
    gamerscore: { current: 25, total: 150 },
    achievements: [
      {
        id: "X1",
        name: "Bridge Builder",
        description: "Cross the bridge",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: null,
        hidden: false,
        missable: false,
        kind: "progression",
        gamerscore: 25,
      },
      {
        id: "X2",
        name: "Moonlit Secret",
        description: "Find the buried moon",
        icon: null,
        unlocked: false,
        unlockedAt: null,
        unlockPercent: null,
        hidden: true,
        missable: false,
        kind: null,
        gamerscore: 50,
      },
    ],
  };
  const detecting = (
    game: { source: "steam" | "xbox"; id: string } | null,
    state: "playing" | "last-played" = "playing",
  ) => ({
    current: () => ({
      game: game && { ...game, title: "Detected Title" },
      state: game ? state : ("none" as const),
      observedAt: 1,
      presence: game && state === "playing" ? "Act 2: Sample Bridge" : null,
      device: game?.source === "xbox" && state === "playing" ? "Series X" : null,
      stale: false,
    }),
  });

  function setup(detector: unknown) {
    const gets: unknown[][] = [];
    const wheres: unknown[][] = [];
    const asked: { statusBlock: string }[] = [];
    const base = parts();
    const d = buildDeps(
      parts({
        detector,
        index: {
          ...base.index,
          hubs: () => [shared],
          lookup: (s: string, id: string) =>
            (s === "steam" && id === "10") || (s === "xbox" && id === "1000000001") ? [shared] : [],
          tree: (id: string) => (id === "shared" ? { hub: shared, pages: [] } : null),
        },
        achievements: {
          get: async (...args: unknown[]) => {
            gets.push(args);
            return args[0] === "xbox" ? xboxAch : args[0] === "steam" ? steamAch : null;
          },
        },
        pages: {
          ...base.pages,
          texts: async () => [],
          where: async (...args: unknown[]) => {
            wheres.push(args);
            return {
              matches: [
                { pageTitle: "Walkthrough", pageUrl: "/w", heading: "Bridge", phrase: "x" },
              ],
            };
          },
        },
        mcp: { token: "t", version: "1" },
        ask: {
          origin: "https://wiki.example",
          limiter: { admit: () => ({ ok: true }) },
          agent: {
            ask: async (body: { statusBlock: string }) => {
              asked.push(body);
              return null;
            },
          },
        },
      }),
    );
    const ask = async (game: { source: "steam" | "xbox"; id: string } | null) => {
      await d.ask?.start(
        { hubId: "shared", game, history: [], question: "q", depth: "hint" },
        new AbortController().signal,
      );
      return asked[asked.length - 1]?.statusBlock ?? null;
    };
    return { d, gets, wheres, ask, status: () => d.mcp?.tools.status("shared") };
  }
  const xboxPlaying = { source: "xbox" as const, id: "1000000001" };

  it("status block names xbox source, device and gamerscore for a shared guide", async () => {
    const { ask, status, gets, wheres } = setup(detecting(xboxPlaying));
    const expected = [
      "Game: Sample Wars (Steam + Xbox)",
      "Source: Xbox (Series X)",
      "State: playing",
      "Status line: Act 2: Sample Bridge",
      "Achievements: 1/3 unlocked",
      "Gamerscore: 25/150",
      "Next story achievements:",
      "- Bridge Builder — Cross the bridge",
      "Hidden achievements still locked: 1",
      "Guide section matching the status line: Walkthrough › Bridge",
    ].join("\n");
    expect(await ask(null)).toBe(expected);
    expect((await status())?.text).toBe(expected);
    expect(gets).toEqual([
      ["xbox", "1000000001", { priority: true }],
      ["xbox", "1000000001", { priority: true }],
    ]);
    expect(wheres.length).toBe(2);
  });

  it("locked secret xbox achievements are counted, not named", async () => {
    const { ask, status } = setup(detecting(xboxPlaying));
    for (const text of [await ask(null), (await status())?.text ?? ""]) {
      expect(text).not.toContain("Moonlit Secret");
      expect(text).not.toContain("buried moon");
      expect(text).toContain("Hidden achievements still locked: 1");
    }
  });

  it("the same shared guide with a Steam detection is unchanged", async () => {
    const { ask, status, gets } = setup(detecting({ source: "steam", id: "10" }));
    const expected = [
      "Game: Sample Wars (Steam + Xbox)",
      "State: playing",
      "Status line: Act 2: Sample Bridge",
      "Achievements: 0/2 unlocked",
      "Guide section matching the status line: Walkthrough › Bridge",
    ].join("\n");
    expect(await ask(null)).toBe(expected);
    expect((await status())?.text).toBe(expected);
    expect(gets.every((g) => g[0] === "steam" && g[1] === "10")).toBe(true);
  });

  it("names Xbox for a request carrying the guide's Xbox title ID when it is not played", async () => {
    const { ask, gets } = setup(detecting(null));
    const block = await ask(xboxPlaying);
    expect(block).toContain("Source: Xbox\n");
    expect(block).toContain("State: not detected");
    expect(block).toContain("Gamerscore: 25/150");
    expect(gets).toEqual([["xbox", "1000000001", { priority: false }]]);
  });

  it("ignores an Xbox request that does not carry the guide's title ID", async () => {
    const { ask, gets } = setup(detecting(null));
    const block = await ask({ source: "xbox", id: "2000000002" });
    expect(block).not.toContain("Source: Xbox");
    expect(block).toContain("Achievements: 0/2 unlocked");
    expect(gets).toEqual([["steam", "10", { priority: false }]]);
  });

  it("keeps the Xbox last-played state without a device", async () => {
    const { status } = setup(detecting(xboxPlaying, "last-played"));
    const text = (await status())?.text ?? "";
    expect(text).toContain("Source: Xbox\n");
    expect(text).toContain("State: last-played");
    expect(text).not.toContain("Series X");
  });
});

describe("xbox MCP tools", () => {
  const XUID = "2535000000001";
  const TOKEN = "XBL3.0 x=fake-uhs;fake-xsts";
  const GAMERTAG = "SampleGamer";

  type Answer = number | (() => Response);

  function setup(
    state: XboxAuthState,
    answers: { titlehub?: Answer; achievements?: Answer; now?: () => number } = {},
  ) {
    const urls: string[] = [];
    const answer = (a: Answer | undefined, body: string): Response =>
      typeof a === "function" ? a() : new Response(body, { status: a ?? 200 });
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      urls.push(u);
      if (u.includes("titlehub")) return answer(answers.titlehub, fixture("xbox-titlehub.json"));
      return answer(answers.achievements, fixture("xbox-achievements.json"));
    }) as typeof fetch;
    const client = new XboxClient({
      auth: { session: async () => ({ headers: { Authorization: TOKEN }, xuid: XUID }) },
      fetch: fetchFn,
      ...(answers.now ? { now: answers.now } : {}),
    });
    const auth = {
      status: () => ({
        state,
        gamertag: state === "connected" ? GAMERTAG : null,
        userCode: state === "connecting" ? "ABCD-EFGH" : null,
        verificationUri: null,
        expiresAt: null,
        lostSince: null,
      }),
      startConnect: async () => auth.status(),
      cancelConnect: () => {},
      disconnect: async () => {},
    };
    const d = buildDeps(
      parts({
        mcp: { token: "sample-token", version: "9.9.9" },
        xbox: { origin: "https://wiki.example.test", auth, client },
      }),
    );
    const tools = d.mcp?.tools;
    if (!tools) throw new Error("mcp tools missing");
    return { tools, urls };
  }

  const NOT_CONNECTED = { text: "Xbox is not connected.", isError: true };

  it("xbox_titles lists the games newest first and filters by name", async () => {
    const { tools } = setup("connected");
    const all = await tools.xboxTitles(undefined);
    expect(all.isError).toBeUndefined();
    expect(all.text.split("\n")).toEqual([
      "2000000002 | Test Quest: Moon Edition | PC, XboxSeries | last played 2026-10-18T10:05:00.000Z | 25/1000 G",
      "2000000004 | Console Only Demo | XboxOne | last played unknown | 0/0 G",
    ]);
    expect((await tools.xboxTitles("QUEST: moon")).text).toMatch(/^2000000002 \|/);
    expect(await tools.xboxTitles("nothing")).toEqual({ text: "No Xbox titles match that query." });
  });

  it("xbox_achievements lists every field, secret ones included, with the title's name", async () => {
    const { tools, urls } = setup("connected");
    const r = await tools.xboxAchievements("2000000002");
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("Test Quest: Moon Edition | 15/95 G");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(
      "3 | The Far Side | locked | 1% | 50 G | secret | no progress | Find the hidden base on the far side. | locked: This achievement is a secret.",
    );
    expect(urls.some((u) => u.includes("titleId=2000000002"))).toBe(true);
  });

  it("neither tool puts the token, the XUID or the gamertag in its output", async () => {
    const { tools } = setup("connected");
    for (const r of [
      await tools.xboxTitles(undefined),
      await tools.xboxAchievements("2000000002"),
    ]) {
      expect(r.text).not.toContain(XUID);
      expect(r.text).not.toContain("fake-xsts");
      expect(r.text).not.toContain("fake-uhs");
      expect(r.text).not.toContain(GAMERTAG);
    }
  });

  it.each(["off", "disconnected", "connecting", "lost"] as const)(
    "both tools answer 'Xbox is not connected.' when the sign-in is %s, calling nothing",
    async (state) => {
      const { tools, urls } = setup(state);
      expect(await tools.xboxTitles(undefined)).toEqual(NOT_CONNECTED);
      expect(await tools.xboxAchievements("2000000002")).toEqual(NOT_CONNECTED);
      expect(urls).toEqual([]);
    },
  );

  it("answers as not connected when Xbox is off in the deployment or has no client", async () => {
    for (const over of [{}, { xbox: null }]) {
      const tools = buildDeps(parts({ mcp: { token: "t", version: "1" }, ...over })).mcp?.tools;
      expect(await tools?.xboxTitles(undefined)).toEqual(NOT_CONNECTED);
      expect(await tools?.xboxAchievements("1")).toEqual(NOT_CONNECTED);
    }
  });

  it("answers a fixed error, never a URL or token, when Xbox fails", async () => {
    const down = setup("connected", { titlehub: 500, achievements: 500 });
    const failed = {
      text: "Xbox could not be reached right now. Try again shortly.",
      isError: true,
    };
    expect(await down.tools.xboxTitles(undefined)).toEqual(failed);
    expect(await down.tools.xboxAchievements("2000000002")).toEqual(failed);
  });

  /** The fixture's history with one more game, as titlehub lists it once the game is played. */
  const withNewGame = (): string => {
    const history = JSON.parse(fixture("xbox-titlehub.json")) as { titles: unknown[] };
    history.titles.unshift({
      titleId: "2000000009",
      name: "Brand New Racer",
      type: "Game",
      devices: ["XboxSeries"],
      titleHistory: { lastTimePlayed: "2026-10-18T12:00:00.0000000Z" },
      achievement: { currentGamerscore: 0, totalGamerscore: 1000 },
    });
    return JSON.stringify(history);
  };

  function freshness() {
    const clock = { t: 1_000_000 };
    const hub = { body: fixture("xbox-titlehub.json"), status: 200 };
    const { tools, urls } = setup("connected", {
      titlehub: () => new Response(hub.body, { status: hub.status }),
      now: () => clock.t,
    });
    const historyCalls = () => urls.filter((u) => u.includes("titlehub")).length;
    return { tools, clock, hub, historyCalls };
  }

  const NO_MATCH = { text: "No Xbox titles match that query." };

  it("xbox_titles reloads a history over 5 min old once when a query matches nothing", async () => {
    const { tools, clock, hub, historyCalls } = freshness();
    expect(await tools.xboxTitles("brand new")).toEqual(NO_MATCH);
    expect(historyCalls()).toBe(1);
    hub.body = withNewGame();
    // Within 5 min: no reload.
    clock.t += 4 * 60_000;
    expect(await tools.xboxTitles("brand new")).toEqual(NO_MATCH);
    expect(historyCalls()).toBe(1);
    clock.t += 2 * 60_000;
    expect((await tools.xboxTitles("brand new")).text).toBe(
      "2000000009 | Brand New Racer | XboxSeries | last played 2026-10-18T12:00:00.000Z | 0/1000 G",
    );
    expect(historyCalls()).toBe(2);
    // A query that matches does not reload.
    clock.t += 10 * 60_000;
    await tools.xboxTitles("moon");
    expect(historyCalls()).toBe(2);
  });

  it("xbox_titles without a query reloads a history over 15 min old", async () => {
    const { tools, clock, hub, historyCalls } = freshness();
    await tools.xboxTitles(undefined);
    hub.body = withNewGame();
    clock.t += 14 * 60_000;
    expect((await tools.xboxTitles(undefined)).text).not.toContain("Brand New Racer");
    expect(historyCalls()).toBe(1);
    clock.t += 2 * 60_000;
    expect((await tools.xboxTitles(undefined)).text.split("\n")[0]).toMatch(
      /^2000000009 \| Brand New Racer \|/,
    );
    expect(historyCalls()).toBe(2);
  });

  it("xbox_titles does not reload inside the failure backoff", async () => {
    const { tools, clock, hub, historyCalls } = freshness();
    await tools.xboxTitles(undefined);
    hub.status = 500;
    clock.t += 6 * 60_000;
    expect(await tools.xboxTitles("brand new")).toEqual(NO_MATCH);
    expect(historyCalls()).toBe(2);
    clock.t += 2 * 60_000;
    expect(await tools.xboxTitles("brand new")).toEqual(NO_MATCH);
    expect(historyCalls()).toBe(2);
  });

  it("both tools say Xbox is busy, with the wait rounded up to whole seconds, on a 429", async () => {
    const clock = { t: 1_000_000 };
    const busy = (after: string) => () =>
      new Response("{}", { status: 429, headers: { "retry-after": after } });
    const { tools } = setup("connected", {
      titlehub: busy("30"),
      achievements: busy("0"),
      now: () => clock.t,
    });
    expect(await tools.xboxTitles(undefined)).toEqual({
      text: "Xbox is busy; try again in 30 s.",
      isError: true,
    });
    clock.t += 9_500;
    expect(await tools.xboxTitles("moon")).toEqual({
      text: "Xbox is busy; try again in 21 s.",
      isError: true,
    });
    expect(await tools.xboxAchievements("2000000002")).toEqual({
      text: "Xbox is busy; try again in 1 s.",
      isError: true,
    });
  });

  it("xbox_achievements says there is no list for a title with Gamerscore and no achievements", async () => {
    const { tools } = setup("connected", {
      achievements: () => new Response(JSON.stringify({ achievements: [] }), { status: 200 }),
    });
    expect(await tools.xboxAchievements("2000000002")).toEqual({
      text: "Xbox has no achievement list for this title (it may be an Xbox 360 game).",
    });
  });
});
