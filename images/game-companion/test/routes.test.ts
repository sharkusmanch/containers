import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandler, IMAGE_HOSTS, type RouteDeps } from "../src/server/routes.js";
import type {
  AchievementsResponse,
  FindResponse,
  GuideHub,
  GuideMarksResponse,
  GuideProgressResponse,
  GuideWhereResponse,
  NowResponse,
} from "../src/shared/types.js";

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
  game: null,
  state: "none",
  stale: false,
  observedAt: null,
  presence: null,
  hubs: [],
};
let nowValue: NowResponse = now;
const ach: AchievementsResponse = {
  source: "steam",
  id: "10",
  title: "Test Game",
  total: 0,
  unlocked: 0,
  stale: false,
  achievements: [],
};

const found: FindResponse = {
  matches: [{ pageTitle: "Checklist", pageUrl: "/doc/c1", heading: null, snippet: "Sample item" }],
  truncated: false,
};
const marked: GuideMarksResponse = { missable: ["sample trophy"] };
const whereHere: GuideWhereResponse = {
  matches: [
    {
      pageTitle: "Walkthrough",
      pageUrl: "/doc/w1",
      heading: "Mock Village",
      phrase: "Mock Village",
    },
  ],
};
const progressed: GuideProgressResponse = {
  pages: [{ url: "/doc/c1", completed: 2, total: 5 }],
};

let server: Server;
let base: string;
let refreshCalls = 0;
const findCalls: [string, string][] = [];
const whereCalls: unknown[][] = [];
const progressCalls: unknown[][] = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-routes-"));
  await writeFile(join(dir, "index.html"), "<p>shell</p>");
  await writeFile(join(dir, "app.js"), "export {}");
  await writeFile(join(dir, "manifest.webmanifest"), '{"name":"Sample"}');
  await writeFile(join(dir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const deps: RouteDeps = {
    staticDir: dir,
    now: () => nowValue,
    guides: () => ({ available: true, hubs: [hub] }),
    hubTree: (id) => (id === "h1" ? { hub, pages: [], defaultPins: ["Guide"] } : null),
    refreshGuides: () => {
      refreshCalls += 1;
    },
    achievements: async (source, id) => (source === "steam" && id === "10" ? ach : null),
    find: async (hubId, q) => {
      findCalls.push([hubId, q]);
      return hubId === "h1" ? found : null;
    },
    marks: async (hubId) => (hubId === "h1" ? marked : null),
    where: async (...args: [string]) => {
      whereCalls.push(args);
      return args[0] === "h1" ? whereHere : null;
    },
    progress: async (...args: [string, { refresh: boolean }]) => {
      progressCalls.push(args);
      return args[0] === "h1" ? progressed : null;
    },
  };
  server = createServer((req, res) => void createHandler(deps)(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("routes", () => {
  it("serves the shell with a strict content policy", async () => {
    const r = await fetch(`${base}/companion/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<p>shell</p>");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("lets the page frame an https address and changes no other directive", async () => {
    const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' ${IMAGE_HOSTS.join(" ")}`,
      "connect-src 'self'",
      "frame-src 'self' https:",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
  });

  it("allows the manifest in the content policy, and serves the manifest and icons with their types", async () => {
    const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toContain("manifest-src 'self'");
    const manifest = await fetch(`${base}/companion/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(await manifest.text()).toBe('{"name":"Sample"}');
    const icon = await fetch(`${base}/companion/icon-192.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("redirects the bare path to the trailing-slash form", async () => {
    const r = await fetch(`${base}/companion`, { redirect: "manual" });
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/companion/");
  });

  it("serves static assets", async () => {
    const r = await fetch(`${base}/companion/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("answers health", async () => {
    const r = await fetch(`${base}/companion/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("returns now, guides and a hub tree as uncached JSON", async () => {
    const n = await fetch(`${base}/companion/api/now`);
    expect(await n.json()).toEqual(now);
    expect(n.headers.get("cache-control")).toBe("no-store");
    expect(await (await fetch(`${base}/companion/api/guides`)).json()).toEqual({
      available: true,
      hubs: [hub],
    });
    expect(await (await fetch(`${base}/companion/api/guides/h1`)).json()).toEqual({
      hub,
      pages: [],
      defaultPins: ["Guide"],
    });
  });

  it("carries the presence in the now answer, a value or null", async () => {
    const withPresence: NowResponse = {
      ...now,
      game: { source: "ra", id: "20", title: "Sample Quest" },
      state: "playing",
      presence: "Chapter 2: Sample Caves",
    };
    nowValue = withPresence;
    try {
      expect(await (await fetch(`${base}/companion/api/now`)).json()).toEqual(withPresence);
      nowValue = { ...withPresence, presence: null };
      expect(await (await fetch(`${base}/companion/api/now`)).json()).toMatchObject({
        presence: null,
      });
    } finally {
      nowValue = now;
    }
  });

  it("404s an unknown hub", async () => {
    expect((await fetch(`${base}/companion/api/guides/nope`)).status).toBe(404);
  });

  describe("guide find and marks", () => {
    const find = (hubId: string, qs: string) =>
      fetch(`${base}/companion/api/guides/${hubId}/find${qs}`);

    it("returns matches for a known hub as uncached JSON", async () => {
      const r = await find("h1", "?q=sample");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(found);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("404s an unknown hub", async () => {
      expect((await find("nope", "?q=sample")).status).toBe(404);
    });

    it.each([
      ["missing", ""],
      ["empty", "?q="],
      ["other parameter", "?query=sample"],
      ["one character", "?q=a"],
      ["one character with padding", "?q=%20%20a%20%20"],
      ["blank", "?q=%20%20%20"],
      ["one emoji", `?q=${encodeURIComponent("\u{1F600}")}`],
      ["101 characters", `?q=${"a".repeat(101)}`],
    ])("rejects a bad q (%s) with 400", async (_name, qs) => {
      const before = findCalls.length;
      expect((await find("h1", qs)).status).toBe(400);
      expect(findCalls.length).toBe(before);
    });

    it("accepts two and one hundred characters", async () => {
      expect((await find("h1", "?q=ab")).status).toBe(200);
      expect((await find("h1", `?q=${"a".repeat(100)}`)).status).toBe(200);
      expect((await find("h1", `?q=${"%20".repeat(5)}${"a".repeat(100)}`)).status).toBe(200);
    });

    it("hands q to the dependency decoded once, spaces and non-ASCII intact", async () => {
      await find("h1", "?q=caf%C3%A9%20au%20lait%20%E2%9A%A0");
      await find("h1", "?q=a+b%2520c");
      expect(findCalls.slice(-2)).toEqual([
        ["h1", "caf\u00e9 au lait \u26a0"],
        ["h1", "a b%20c"],
      ]);
    });

    it("rejects a hub id outside the pattern", async () => {
      expect((await find("h1.x", "?q=sample")).status).toBe(404);
      expect((await find("a".repeat(65), "?q=sample")).status).toBe(404);
    });

    it("returns the missable marks for a known hub", async () => {
      const r = await fetch(`${base}/companion/api/guides/h1/marks`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(marked);
      expect(r.headers.get("cache-control")).toBe("no-store");
    });

    it("404s the marks of an unknown hub", async () => {
      expect((await fetch(`${base}/companion/api/guides/nope/marks`)).status).toBe(404);
    });

    it("rejects writes", async () => {
      for (const p of ["h1/find?q=sample", "h1/marks"]) {
        const r = await fetch(`${base}/companion/api/guides/${p}`, { method: "POST" });
        expect(r.status).toBe(405);
        expect(r.headers.get("allow")).toBe("GET, HEAD");
      }
    });

    it("answers HEAD with the headers and no body", async () => {
      const r = await fetch(`${base}/companion/api/guides/h1/marks`, { method: "HEAD" });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("");
    });

    it("turns a throwing dependency into a 500 without leaking its message", async () => {
      const deps: RouteDeps = {
        staticDir: "/nonexistent",
        now: () => now,
        guides: () => ({ available: false, hubs: [] }),
        hubTree: () => null,
        refreshGuides: () => {},
        achievements: async () => null,
        find: async (_hub, q) => {
          throw new Error(`secret detail ${q}`);
        },
        marks: async () => {
          throw new Error("secret detail");
        },
        where: async () => {
          throw new Error("secret detail");
        },
        progress: async () => {
          throw new Error("secret detail");
        },
      };
      const s = createServer((req, res) => void createHandler(deps)(req, res));
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}/companion/api/guides/h1`;
      for (const path of ["/find?q=needle", "/marks", "/where", "/progress?refresh=1"]) {
        const r = await fetch(origin + path);
        expect(r.status).toBe(500);
        const body = await r.text();
        expect(body).not.toContain("secret detail");
        expect(body).not.toContain("needle");
      }
      await new Promise<void>((res) => s.close(() => res()));
    });
  });

  describe("guide where and progress", () => {
    const get = (path: string, init?: RequestInit) =>
      fetch(`${base}/companion/api/guides/${path}`, init);

    it("returns the where matches for a known hub as uncached JSON", async () => {
      const r = await get("h1/where");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(whereHere);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("404s where for an unknown hub", async () => {
      const r = await get("nope/where");
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "unknown guide" });
    });

    it("hands nothing but the hub id to where, whatever the request carries", async () => {
      whereCalls.length = 0;
      await get("h1/where?q=anything&status=Mock%20Village", {
        headers: { cookie: "session=abc", "x-status": "Mock Village" },
      });
      expect(whereCalls).toEqual([["h1"]]);
    });

    it("returns the progress for a known hub as uncached JSON", async () => {
      const r = await get("h1/progress");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(progressed);
      expect(r.headers.get("cache-control")).toBe("no-store");
    });

    it("404s progress for an unknown hub", async () => {
      const r = await get("nope/progress?refresh=1");
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "unknown guide" });
    });

    it("passes refresh=1 as a refresh and anything else as none", async () => {
      progressCalls.length = 0;
      for (const qs of [
        "",
        "?refresh=1",
        "?refresh=0",
        "?refresh=true",
        "?refresh=",
        "?refresh=11",
      ]) {
        await get(`h1/progress${qs}`);
      }
      expect(progressCalls).toEqual([
        ["h1", { refresh: false }],
        ["h1", { refresh: true }],
        ["h1", { refresh: false }],
        ["h1", { refresh: false }],
        ["h1", { refresh: false }],
        ["h1", { refresh: false }],
      ]);
    });

    it("rejects writes and answers HEAD without a body", async () => {
      for (const p of ["h1/where", "h1/progress"]) {
        const w = await get(p, { method: "POST" });
        expect(w.status).toBe(405);
        expect(w.headers.get("allow")).toBe("GET, HEAD");
        const h = await get(p, { method: "HEAD" });
        expect(h.status).toBe(200);
        expect(await h.text()).toBe("");
      }
    });

    it("rejects a hub id outside the pattern", async () => {
      expect((await get("h1.x/where")).status).toBe(404);
      expect((await get(`${"a".repeat(65)}/progress`)).status).toBe(404);
    });
  });

  it("asks for a guide refresh only when requested", async () => {
    const before = refreshCalls;
    await fetch(`${base}/companion/api/guides`);
    expect(refreshCalls).toBe(before);
    await fetch(`${base}/companion/api/guides?refresh=1`);
    expect(refreshCalls).toBe(before + 1);
  });

  it("returns achievements for a valid source and id", async () => {
    expect(await (await fetch(`${base}/companion/api/achievements/steam/10`)).json()).toEqual(ach);
  });

  it.each([
    "/companion/api/achievements/psn/10",
    "/companion/api/achievements/steam/abc",
    "/companion/api/achievements/steam/12345678901",
    "/companion/api/achievements/steam/-1",
  ])("rejects a bad achievements request: %s", async (p) => {
    expect((await fetch(`${base}${p}`)).status).toBe(400);
  });

  it("404s achievements the service does not have", async () => {
    expect((await fetch(`${base}/companion/api/achievements/steam/11`)).status).toBe(404);
  });

  it("answers HEAD with the headers and no body", async () => {
    const r = await fetch(`${base}/companion/api/now`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await r.text()).toBe("");
  });

  it("404s an unknown API path", async () => {
    expect((await fetch(`${base}/companion/api/nonexistent`)).status).toBe(404);
  });

  it("lists exactly the image hosts in the policy, and keeps connect and style on self", async () => {
    const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("img-src")).toBe(`img-src 'self' ${IMAGE_HOSTS.join(" ")}`);
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("style-src")).toBe("style-src 'self'");
  });

  it("rejects writes", async () => {
    const r = await fetch(`${base}/companion/api/now`, { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });

  it("404s traversal and anything outside the base path", async () => {
    expect((await fetch(`${base}/companion/..%2f..%2fetc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("turns a throwing dependency into a 500 without leaking the message", async () => {
    const deps: RouteDeps = {
      staticDir: "/nonexistent",
      now: () => {
        throw new Error("secret detail");
      },
      guides: () => ({ available: false, hubs: [] }),
      hubTree: () => null,
      refreshGuides: () => {},
      achievements: async () => null,
      find: async () => null,
      marks: async () => null,
      where: async () => null,
      progress: async () => null,
    };
    const s = createServer((req, res) => void createHandler(deps)(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const r = await fetch(
      `http://127.0.0.1:${(s.address() as AddressInfo).port}/companion/api/now`,
    );
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("secret detail");
    await new Promise<void>((res) => s.close(() => res()));
  });
});
