import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeIcon } from "../src/server/achievements.js";
import { isSafeGuideUrl } from "../src/server/guide-index.js";
import { createHandler, IMAGE_HOSTS, type RouteDeps } from "../src/server/routes.js";
import type { Api } from "../src/web/api.js";
import { ApiError, createApi } from "../src/web/api.js";
import { isSafeDocUrl } from "../src/web/state.js";
import type { AchievementsResponse, GuideHub, NowResponse } from "../src/shared/types.js";

const hub: GuideHub = {
  hubId: "h1",
  title: "Test Game",
  url: "/doc/test-game-abc",
  source: "steam",
  gameId: "10",
  platformLabel: "Steam",
  nowPlaying: false,
};
const now: NowResponse = {
  game: { source: "steam", id: "10", title: "Test Game" },
  state: "playing",
  stale: false,
  observedAt: "2026-10-06T00:00:00.000Z",
  presence: "Chapter 2: Sample Caves",
  hubs: [hub],
};
let nowValue: NowResponse = now;
const ach: AchievementsResponse = {
  source: "steam",
  id: "10",
  title: "Test Game",
  total: 1,
  unlocked: 0,
  stale: false,
  achievements: [
    {
      id: "A",
      name: "First",
      description: null,
      icon: null,
      unlocked: false,
      unlockedAt: null,
      unlockPercent: 5,
      hidden: false,
      missable: false,
      kind: null,
    },
  ],
};

let server: Server;
let api: Api;
let origin = "";
let refreshCalls = 0;

beforeAll(async () => {
  const deps: RouteDeps = {
    staticDir: "/nonexistent",
    now: () => nowValue,
    guides: () => ({ available: true, hubs: [hub] }),
    hubTree: (id) => (id === "h1" ? { hub, pages: [], defaultPins: ["Guide"] } : null),
    refreshGuides: () => {
      refreshCalls += 1;
    },
    achievements: async (_source, id) => {
      if (id === "10") return ach;
      if (id === "13") throw new Error("upstream down");
      return null;
    },
    find: async (id, q) =>
      id === "h1"
        ? {
            matches: [
              {
                pageTitle: "Sample Guide",
                pageUrl: "/doc/sample-guide",
                heading: "Chapter One",
                snippet: `Find ${q} here`,
              },
            ],
            truncated: false,
          }
        : null,
    marks: async (id) => (id === "h1" ? { missable: ["first"] } : null),
    where: async (id) =>
      id === "h1"
        ? {
            matches: [
              {
                pageTitle: "Sample Guide",
                pageUrl: "/doc/sample-guide",
                heading: "Chapter One",
                phrase: "Chapter One",
              },
            ],
          }
        : null,
    progress: async (id, opts) =>
      id === "h1"
        ? { pages: [{ url: "/doc/sample-guide", completed: opts.refresh ? 3 : 2, total: 4 }] }
        : null,
  };
  server = createServer((req, res) => void createHandler(deps)(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/companion/`;
  const fetchFn: typeof fetch = (input, init) => fetch(new URL(input as string, origin), init);
  api = createApi(fetchFn);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("browser client against the real request handler", () => {
  it("reads the current game", async () => {
    expect(await api.now()).toEqual(now);
  });

  it("reads the presence, and a null one, through the browser client", async () => {
    expect((await api.now()).presence).toBe("Chapter 2: Sample Caves");
    nowValue = { ...now, presence: null };
    try {
      expect((await api.now()).presence).toBeNull();
    } finally {
      nowValue = now;
    }
  });

  it("reads the guide list, and asks for a refresh only when told to", async () => {
    const before = refreshCalls;
    expect(await api.guides()).toEqual({ available: true, hubs: [hub] });
    expect(refreshCalls).toBe(before);
    expect(await api.guides(true)).toEqual({ available: true, hubs: [hub] });
    expect(refreshCalls).toBe(before + 1);
  });

  it("reads a known hub tree and rejects an unknown one with a 404", async () => {
    expect(await api.hubTree("h1")).toEqual({ hub, pages: [], defaultPins: ["Guide"] });
    const err = await api.hubTree("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("reads achievements, maps an absent game to null and a server failure to a 500", async () => {
    expect(await api.achievements("steam", "10")).toEqual(ach);
    expect(await api.achievements("steam", "11")).toBeNull();
    const err = await api.achievements("steam", "13").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

describe("find and marks against the real request handler", () => {
  it("finds text in a known guide, with the query encoded on the wire", async () => {
    expect(await api.find("h1", "Fish & Chips")).toEqual({
      matches: [
        {
          pageTitle: "Sample Guide",
          pageUrl: "/doc/sample-guide",
          heading: "Chapter One",
          snippet: "Find Fish & Chips here",
        },
      ],
      truncated: false,
    });
  });

  it("maps an unknown hub to null for find and for marks", async () => {
    expect(await api.find("nope", "ab")).toBeNull();
    expect(await api.marks("nope")).toBeNull();
  });

  it("surfaces a too-short query as an ApiError 400", async () => {
    const err = await api.find("h1", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });

  it("reads the missable marks of a known guide", async () => {
    expect(await api.marks("h1")).toEqual({ missable: ["first"] });
  });
});

describe("where and progress against the real request handler", () => {
  it("answers where with the dependency's matches and maps an unknown hub to null", async () => {
    expect(await api.where("h1")).toEqual({
      matches: [
        {
          pageTitle: "Sample Guide",
          pageUrl: "/doc/sample-guide",
          heading: "Chapter One",
          phrase: "Chapter One",
        },
      ],
    });
    expect(await api.where("nope")).toBeNull();
  });

  it("answers progress, with refresh only when asked, and maps an unknown hub to null", async () => {
    const pages = (completed: number) => ({
      pages: [{ url: "/doc/sample-guide", completed, total: 4 }],
    });
    expect(await api.progress("h1")).toEqual(pages(2));
    expect(await api.progress("h1", false)).toEqual(pages(2));
    expect(await api.progress("h1", true)).toEqual(pages(3));
    expect(await api.progress("nope")).toBeNull();
  });

  describe("on the wire", () => {
    const raw = async (path: string): Promise<{ status: number; body: unknown }> => {
      const r = await fetch(`${origin}api/guides/${path}`);
      return { status: r.status, body: await r.json() };
    };

    it("answers 404 for an unknown hub on both routes", async () => {
      expect((await raw("nope/where")).status).toBe(404);
      expect((await raw("nope/progress")).status).toBe(404);
    });

    it("treats ?refresh=0 as not refreshing and only ?refresh=1 as a fresh read", async () => {
      const pages = (completed: number) => ({
        status: 200,
        body: { pages: [{ url: "/doc/sample-guide", completed, total: 4 }] },
      });
      expect(await raw("h1/progress")).toEqual(pages(2));
      expect(await raw("h1/progress?refresh=0")).toEqual(pages(2));
      expect(await raw("h1/progress?refresh=1")).toEqual(pages(3));
    });
  });
});

describe("guide URL rule", () => {
  it.each([
    "/doc/abc",
    "/doc/a-b-c-XyZ123",
    "/doc/a_b",
    "https://evil.example/doc/abc",
    "//evil.example/doc/abc",
    "/doc//evil",
    "/doc/..",
    "/doc/%2e%2e",
    "/doc/a/../b",
    "/doc/a.b",
    "/docs/abc",
    "javascript:alert(1)",
    "/doc/a\\b",
    "/collection/x",
    "/doc/abc\n",
    "/doc/",
    "",
  ])("the server and the browser agree on %j", (url) => {
    expect(isSafeGuideUrl(url)).toBe(isSafeDocUrl(url));
  });

  it("both accept the safe examples and refuse the unsafe ones", () => {
    expect(isSafeGuideUrl("/doc/abc")).toBe(true);
    expect(isSafeDocUrl("/doc/abc")).toBe(true);
    expect(isSafeGuideUrl("https://evil.example/doc/abc")).toBe(false);
    expect(isSafeDocUrl("https://evil.example/doc/abc")).toBe(false);
  });
});

describe("image hosts", () => {
  const sample = (pattern: string): string => {
    const host = new URL(pattern.replace("*.", "cdn.sub.")).hostname;
    return `https://${host}/icon.png`;
  };

  it.each(IMAGE_HOSTS)("the icon filter accepts a sample URL on %s", (pattern) => {
    const url = sample(pattern);
    expect(safeIcon(url)).toBe(url);
  });

  it("the icon filter refuses a host the policy does not list", () => {
    expect(safeIcon("https://evil.example/icon.png")).toBeNull();
    expect(safeIcon("https://steamstatic.com.evil.example/icon.png")).toBeNull();
  });
});
