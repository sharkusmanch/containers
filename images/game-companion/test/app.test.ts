import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/server/app.js";
import type { GuideHub } from "../src/shared/types.js";

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
    pages: { find: async () => null, marks: async () => null },
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
    expect(d.hubTree("h1")).toEqual({ hub, pages: [], defaultPins: ["Alpha Page", "Beta Page"] });
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
    expect(d.hubTree("h1")).toEqual({ hub, pages: [], defaultPins: [] });
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

describe("achievements allowlist", () => {
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
