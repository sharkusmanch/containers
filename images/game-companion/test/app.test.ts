import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/server/app.js";
import type { PageText } from "../src/server/guide-pages.js";
import type { AchievementsResponse, AskEvent, GuideHub } from "../src/shared/types.js";

const hub: GuideHub = {
  hubId: "h1",
  title: "Zeta",
  url: "/doc/z",
  source: "steam",
  gameId: "10",
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

  function setup(over: Record<string, unknown> = {}, guideChars = 1000) {
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
        guideChars,
        assistant: {
          ask: async function* (...args: unknown[]) {
            calls.ask.push(args);
            yield* events;
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
      stale: false,
    }),
  });
  const collect = async (g: AsyncGenerator<AskEvent> | null) => {
    const out: AskEvent[] = [];
    for await (const e of g ?? []) out.push(e);
    return out;
  };

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
        (await seen.d.ask?.start(req({ hubId: null, game: { source: "ra", id: "5" } }), signal)) ??
          null,
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
    const out = await collect((await d.ask?.start(req(), ctl.signal)) ?? null);
    expect(out).toEqual(events);
    expect(calls.texts).toEqual(["h1"]);
    expect(calls.get).toEqual([["steam", "10", { priority: true }]]);
    expect(calls.where).toEqual([["h1", "In Mock Village"]]);

    const [ctx, history, question, depth, signal] = calls.ask[0] as [
      { system: string; statusBlock: string; truncatedGuide: boolean },
      unknown,
      unknown,
      unknown,
      AbortSignal,
    ];
    expect(ctx.system.indexOf("## Notes")).toBeLessThan(ctx.system.indexOf("## Walkthrough"));
    expect(ctx.system).toContain("walk");
    expect(ctx.statusBlock).toBe(
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
    expect(history).toEqual([{ question: "Q1", answer: "A1" }]);
    expect(question).toBe("What next?");
    expect(depth).toBe("hint");
    expect(signal).toBe(ctl.signal);
  });

  it("applies the configured guide budget and pinned titles", async () => {
    const { d, calls } = setup({}, 8);
    await collect((await d.ask?.start(req(), new AbortController().signal)) ?? null);
    const ctx = calls.ask[0]?.[0] as { system: string; truncatedGuide: boolean };
    expect(ctx.truncatedGuide).toBe(true);
    expect(ctx.system).not.toContain("## Walkthrough");
  });

  it("leaves out the status line and the section unless this hub's game is being played", async () => {
    for (const snap of [
      detecting({ source: "steam", id: "10" }, "last-played", "In Mock Village"),
      detecting({ source: "ra", id: "10" }, "playing", "In Mock Village"),
      detecting(null, "none"),
    ]) {
      const { d, calls } = setup({ detector: snap });
      await collect((await d.ask?.start(req(), new AbortController().signal)) ?? null);
      const status = (calls.ask[0]?.[0] as { statusBlock: string }).statusBlock;
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
      await collect((await d.ask?.start(req(), new AbortController().signal)) ?? null);
      expect((calls.ask[0]?.[0] as { statusBlock: string }).statusBlock).toContain(line);
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
    const status = (calls.ask[0]?.[0] as { statusBlock: string }).statusBlock;
    expect(status).toContain("Achievements: 1/4 unlocked");
    expect(status).toContain("- Golden Lantern");
  });

  it("builds the whole context from the hub's game when a different game is sent with it", async () => {
    const snap = detecting({ source: "steam", id: "10" }, "playing", "In Mock Village");
    const matched = setup({ detector: snap });
    await collect((await matched.d.ask?.start(req(), new AbortController().signal)) ?? null);

    const mismatched = setup({ detector: snap });
    const other = req({ game: { source: "ra", id: "5" } });
    // The sent game is ignored, so it need not be allowed.
    expect(mismatched.d.ask?.allowed(other)).toBe(true);
    await collect((await mismatched.d.ask?.start(other, new AbortController().signal)) ?? null);

    expect(mismatched.calls.get).toEqual([["steam", "10", { priority: true }]]);
    expect(mismatched.calls.ask[0]?.[0]).toEqual(matched.calls.ask[0]?.[0]);
  });

  it("tolerates an achievements failure", async () => {
    const { d, calls } = setup({
      achievements: {
        get: async () => {
          throw new Error("down");
        },
      },
    });
    await collect((await d.ask?.start(req(), new AbortController().signal)) ?? null);
    expect((calls.ask[0]?.[0] as { statusBlock: string }).statusBlock).toContain(
      "Achievements: unknown",
    );
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
    const ctx = calls.ask[0]?.[0] as { system: string; statusBlock: string };
    expect(ctx.system).not.toContain("walk");
    expect(ctx.statusBlock.split("\n")[0]).toBe("Game: Zeta Achievements (RetroAchievements)");
  });
});
