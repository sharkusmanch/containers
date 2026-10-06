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
  hubs: [hub],
};
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
    },
  ],
};

let server: Server;
let api: Api;
let refreshCalls = 0;

beforeAll(async () => {
  const deps: RouteDeps = {
    staticDir: "/nonexistent",
    now: () => now,
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
  };
  server = createServer((req, res) => void createHandler(deps)(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/companion/`;
  const fetchFn: typeof fetch = (input, init) => fetch(new URL(input as string, origin), init);
  api = createApi(fetchFn);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("browser client against the real request handler", () => {
  it("reads the current game", async () => {
    expect(await api.now()).toEqual(now);
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
