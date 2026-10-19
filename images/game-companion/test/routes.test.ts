import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  xboxTitleId: null,
  platforms: ["steam"],
  lastPlatform: null,
  platformLabel: "Steam",
  nowPlaying: false,
};
const now: NowResponse = {
  game: null,
  state: "none",
  stale: false,
  observedAt: null,
  presence: null,
  device: null,
  hubs: [],
  assistant: false,
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
  await writeFile(join(dir, "sw.js"), "self.addEventListener('fetch', () => {});");
  await writeFile(join(dir, "manifest.webmanifest"), '{"name":"Sample"}');
  await writeFile(join(dir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const deps: RouteDeps = {
    ask: null,
    staticDir: dir,
    now: () => nowValue,
    guides: () => ({ available: true, hubs: [hub] }),
    hubTree: (id) =>
      id === "h1"
        ? { hub, pages: [], defaultPins: ["Guide"], editablePages: ["Sample Notes"] }
        : null,
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

  it("lets the page frame an https address and run its worker, and changes no other directive", async () => {
    const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' ${IMAGE_HOSTS.join(" ")}`,
      "connect-src 'self'",
      "frame-src 'self' https:",
      "manifest-src 'self'",
      "worker-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
  });

  it("lets the page register its own service worker, and nothing else", async () => {
    const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
    expect(csp.split("; ").filter((d) => d.startsWith("worker-src "))).toEqual([
      "worker-src 'self'",
    ]);
  });

  it("serves the service worker as JavaScript from the page's own path", async () => {
    const r = await fetch(`${base}/companion/sw.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe("self.addEventListener('fetch', () => {});");
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
      editablePages: ["Sample Notes"],
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

    it("CSP img-src includes the Xbox image hosts", async () => {
      const csp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy") ?? "";
      const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src ")) ?? "";
      expect(imgSrc).toContain(" https://images-eds-ssl.xboxlive.com");
      expect(imgSrc).toContain(" https://store-images.s-microsoft.com");
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
        ask: null,
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
      ask: null,
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

describe("POST /companion/api/ask", () => {
  const ORIGIN = "https://wiki.example.test";
  const LIMIT = 32768;
  const valid = {
    hubId: "h1",
    game: { source: "steam", id: "10" },
    history: [{ question: "Q1", answer: "A1" }],
    question: "What next?",
    depth: "hint",
  };
  type Ask = NonNullable<RouteDeps["ask"]>;

  let s: Server;
  let url: string;
  let ask: Ask | null;
  let admission: ReturnType<Ask["admit"]>;
  let startArgs: unknown[][];
  let startResult: "events" | "null" | "hang" | "silent" | "busy";
  let signal: AbortSignal | null;
  let admitCalls: number;
  let allowedResult: boolean;
  /** Timers the route started through `setTimer`; a test fires one by calling `fn`. */
  let timers: { fn: () => void; ms: number; over: boolean }[];
  /** Timers neither fired nor cancelled. */
  const pending = () => timers.filter((t) => !t.over);

  beforeAll(async () => {
    const deps: RouteDeps = {
      staticDir: "/nonexistent",
      now: () => ({ ...now, assistant: ask !== null }),
      guides: () => ({ available: false, hubs: [] }),
      hubTree: () => null,
      refreshGuides: () => {},
      achievements: async () => null,
      find: async () => null,
      marks: async () => null,
      where: async () => null,
      progress: async () => null,
      get ask() {
        return ask;
      },
      setTimer: (fn, ms) => {
        const t = {
          fn: () => {
            t.over = true;
            fn();
          },
          ms,
          over: false,
        };
        timers.push(t);
        return () => {
          t.over = true;
        };
      },
    };
    s = createServer((req, res) => void createHandler(deps)(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/companion/api/ask`;
  });
  afterAll(() => new Promise<void>((r) => s.close(() => r())));

  beforeEach(() => {
    admission = { ok: true };
    startArgs = [];
    startResult = "events";
    signal = null;
    admitCalls = 0;
    allowedResult = true;
    timers = [];
    ask = {
      origin: ORIGIN,
      allowed: () => allowedResult,
      admit: () => {
        admitCalls += 1;
        return admission;
      },
      start: async (...args) => {
        startArgs.push(args);
        signal = args[1];
        if (startResult === "null") return null;
        if (startResult === "busy") return "busy";
        return (async function* () {
          if (startResult === "silent") await new Promise(() => undefined);
          yield { type: "search", query: "sample query" } as const;
          yield { type: "text", text: "Go left." } as const;
          if (startResult === "hang") await new Promise(() => undefined);
          yield { type: "done", truncatedGuide: false } as const;
        })();
      },
    };
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  /** Sends exact headers, so a declared content-length need not match the bytes written. */
  function raw(
    headers: Record<string, string>,
    chunks: Buffer[],
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      for (const c of chunks) req.write(c);
      req.end();
    });
  }

  it("keeps every other path GET/HEAD only, and answers other methods here with allow: POST", async () => {
    const other = await fetch(url.replace("/api/ask", "/api/asks"), { method: "POST" });
    expect(other.status).toBe(405);
    expect(other.headers.get("allow")).toBe("GET, HEAD");
    for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
      const r = await fetch(url, { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    expect(startArgs).toHaveLength(0);
  });

  it("rejects a wrong or missing content type with 415", async () => {
    for (const type of ["text/plain", "application/json-patch+json", "application/jsonx"]) {
      expect((await post(valid, { "content-type": type })).status).toBe(415);
    }
    const none = await raw({ origin: ORIGIN, "content-length": "2" }, [Buffer.from("{}")]);
    expect(none.status).toBe(415);
    expect(admitCalls).toBe(0);
  });

  it("accepts a parameter and any case on the media type", async () => {
    for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
      expect((await post(valid, { "content-type": type })).status).toBe(200);
    }
  });

  it("rejects a missing or different origin with 403", async () => {
    expect((await post(valid, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await post(valid, { origin: `${ORIGIN}/` })).status).toBe(403);
    const none = await raw({ "content-type": "application/json", "content-length": "2" }, [
      Buffer.from("{}"),
    ]);
    expect(none.status).toBe(403);
    expect(startArgs).toHaveLength(0);
  });

  it("rejects a declared length over the limit with 413 before reading the body", async () => {
    const r = await raw(
      { "content-type": "application/json", origin: ORIGIN, "content-length": String(LIMIT + 1) },
      [Buffer.from("{}")],
    );
    expect(r.status).toBe(413);
    expect(admitCalls).toBe(0);
  });

  it("rejects a chunked body over the limit with 413, and accepts one at the limit", async () => {
    const headers = { "content-type": "application/json", origin: ORIGIN };
    const over = await raw(headers, [Buffer.alloc(LIMIT, 0x20), Buffer.from("x")]);
    expect(over.status).toBe(413);
    expect(startArgs).toHaveLength(0);

    const body = JSON.stringify(valid);
    const padded = Buffer.from(body + " ".repeat(LIMIT - body.length));
    const exact = await raw(headers, [padded.subarray(0, 100), padded.subarray(100)]);
    expect(exact.status).toBe(200);
  });

  it("answers 503 when the assistant is not configured", async () => {
    ask = null;
    const r = await post(valid);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "assistant unavailable" });
  });

  it("reports the assistant on /api/now only when configured", async () => {
    const nowUrl = url.replace("/api/ask", "/api/now");
    expect(((await (await fetch(nowUrl)).json()) as NowResponse).assistant).toBe(true);
    ask = null;
    expect(((await (await fetch(nowUrl)).json()) as NowResponse).assistant).toBe(false);
  });

  it("rejects invalid JSON and every schema violation with 400, without asking the limiter", async () => {
    const bad: unknown[] = [
      "{not json",
      "[]",
      "null",
      "42",
      { ...valid, hubId: "has space" },
      { ...valid, hubId: "x".repeat(65) },
      { ...valid, hubId: 5 },
      { ...valid, game: { source: "gog", id: "10" } },
      { ...valid, game: { source: "steam", id: "abc" } },
      { ...valid, game: { source: "steam", id: "12345678901" } },
      { ...valid, game: { source: "steam", id: 10 } },
      { ...valid, game: "steam:10" },
      { ...valid, hubId: null, game: null },
      { ...valid, question: "" },
      { ...valid, question: "   \n " },
      { ...valid, question: "x".repeat(1001) },
      { ...valid, question: 7 },
      { ...valid, history: Array.from({ length: 11 }, () => ({ question: "q", answer: "a" })) },
      { ...valid, history: [{ question: "q", answer: "a".repeat(8001) }] },
      { ...valid, history: [{ question: "q".repeat(1001), answer: "a" }] },
      { ...valid, history: [{ question: "q" }] },
      { ...valid, history: "none" },
      { ...valid, depth: "medium" },
      { ...valid, depth: undefined },
    ];
    for (const body of bad) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)?.slice(0, 80)).toBe(400);
    }
    expect(admitCalls).toBe(0);
    expect(startArgs).toHaveLength(0);
  });

  it("accepts the boundaries and ignores extra keys", async () => {
    const body = {
      ...valid,
      hubId: null,
      game: { source: "ra", id: "1234567890" },
      history: Array.from({ length: 3 }, () => ({
        question: "q".repeat(1000),
        answer: "a".repeat(8000),
      })),
      question: "x".repeat(1000),
      extra: { anything: true },
    };
    const r = await post(body);
    expect(r.status).toBe(200);
    const sent = startArgs[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["depth", "game", "history", "hubId", "question"]);
    expect(sent.hubId).toBeNull();
  });

  it("accepts an Xbox game like a Steam or RetroAchievements one", async () => {
    const r = await post({ ...valid, hubId: null, game: { source: "xbox", id: "1000000001" } });
    expect(r.status).toBe(200);
    const sent = startArgs[0]?.[0] as Record<string, unknown>;
    expect(sent.game).toEqual({ source: "xbox", id: "1000000001" });
  });

  it("passes the trimmed question and the parsed fields to start, and nothing else", async () => {
    const r = await post({ ...valid, question: "  What next?\n" }, { cookie: "session=secret" });
    expect(r.status).toBe(200);
    await r.text();
    expect(startArgs).toHaveLength(1);
    expect(startArgs[0]).toHaveLength(2);
    expect(startArgs[0]?.[0]).toEqual({ ...valid, question: "What next?" });
    expect(startArgs[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(startArgs)).not.toContain("secret");
  });

  it("answers 429 with retry-after and the limit when not admitted", async () => {
    admission = { ok: false, limit: "day", retryAfterSec: 90 };
    const r = await post(valid);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("90");
    expect(await r.json()).toEqual({ error: "rate limited", limit: "day" });
    expect(startArgs).toHaveLength(0);
  });

  it("answers 400 without spending a slot when the hub or game is not allowed", async () => {
    allowedResult = false;
    const r = await post(valid);
    expect(r.status).toBe(400);
    expect(admitCalls).toBe(0);
    expect(startArgs).toHaveLength(0);
  });

  it("answers the minute-limit 429 with retry-after 30 when the agent is busy", async () => {
    startResult = "busy";
    const r = await post(valid);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await r.json()).toEqual({ error: "rate limited", limit: "minute" });
    expect(startArgs).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it("still answers 404 if start refuses after admission", async () => {
    startResult = "null";
    const r = await post(valid);
    expect(r.status).toBe(404);
  });

  it("streams one JSON object per line with the shared headers", async () => {
    const r = await post(valid);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    const baseCsp = (await fetch(`${base}/companion/`)).headers.get("content-security-policy");
    expect(r.headers.get("content-security-policy")).toBe(baseCsp);
    const text = await r.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { type: "search", query: "sample query" },
      { type: "text", text: "Go left." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("aborts the signal when the client goes away mid-stream, and not after a normal end", async () => {
    startResult = "hang";
    const ctrl = new AbortController();
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(valid),
      signal: ctrl.signal,
    });
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(signal?.aborted).toBe(false);
    ctrl.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    startResult = "events";
    await (await post(valid)).text();
    await new Promise((r2) => setTimeout(r2, 20));
    expect(signal?.aborted).toBe(false);
  });

  it("sends the headers at once and a ping line when the stream stays silent", async () => {
    startResult = "silent";
    const ctrl = new AbortController();
    // Resolves only once the headers arrive: nothing else is written yet.
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(valid),
      signal: ctrl.signal,
    });
    expect(r.status).toBe(200);
    expect(pending().map((t) => t.ms)).toEqual([15000]);
    pending()[0]?.fn();
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('{"type":"ping"}\n');
    // Still silent: the next interval is armed, and pings again.
    expect(pending().map((t) => t.ms)).toEqual([15000]);
    ctrl.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await vi.waitFor(() => expect(pending()).toEqual([]));
  });

  it("restarts the keep-alive interval after each event and clears it at the end", async () => {
    const r = await post(valid);
    await r.text();
    // One interval armed at the start and one after each of the three events, all cleared.
    expect(timers.map((t) => t.ms)).toEqual([15000, 15000, 15000, 15000]);
    expect(pending()).toEqual([]);
  });
});

describe("xbox routes", () => {
  const ORIGIN = "https://wiki.example.test";
  // Invented secrets the fake carries next to its status: none may reach a response.
  const FAKE_TOKEN = "fake-refresh-token-0000";
  const FAKE_DEVICE_CODE = "fake-device-code-1111";
  type Xbox = NonNullable<RouteDeps["xbox"]>;
  type Status = ReturnType<Xbox["status"]>;
  const status = (over: Partial<Status>): Status =>
    ({
      state: "disconnected",
      gamertag: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
      // Extra fields a careless dependency might carry.
      refreshToken: FAKE_TOKEN,
      deviceCode: FAKE_DEVICE_CODE,
      ...over,
    }) as Status;

  let s: Server;
  let root: string;
  let xbox: Xbox | null;
  let calls: string[];
  let connectFails: boolean;
  let achievementCalls: string[];

  beforeAll(async () => {
    const deps: RouteDeps = {
      ask: null,
      staticDir: "/nonexistent",
      now: () => now,
      guides: () => ({ available: false, hubs: [] }),
      hubTree: () => null,
      refreshGuides: () => {},
      achievements: async (source, id) => {
        achievementCalls.push(`${source}:${id}`);
        return source === "xbox" && id === "1000000001"
          ? { ...ach, source: "xbox", id, gamerscore: { current: 10, total: 100 } }
          : null;
      },
      find: async () => null,
      marks: async () => null,
      where: async () => null,
      progress: async () => null,
      get xbox() {
        return xbox;
      },
    };
    s = createServer((req, res) => void createHandler(deps)(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    root = `http://127.0.0.1:${(s.address() as AddressInfo).port}/companion/api`;
  });
  afterAll(() => new Promise<void>((r) => s.close(() => r())));

  beforeEach(() => {
    calls = [];
    connectFails = false;
    achievementCalls = [];
    xbox = {
      origin: ORIGIN,
      status: () => {
        calls.push("status");
        return status({ state: "disconnected" });
      },
      connect: async () => {
        calls.push("connect");
        if (connectFails) throw new Error(`upstream said ${FAKE_DEVICE_CODE}`);
        return status({
          state: "connecting",
          userCode: "ABCD-EFGH",
          verificationUri: "https://www.microsoft.com/link",
          expiresAt: "2026-10-18T12:15:00.000Z",
        });
      },
      cancel: () => {
        calls.push("cancel");
        return status({ state: "disconnected" });
      },
      disconnect: async () => {
        calls.push("disconnect");
        return status({ state: "disconnected" });
      },
    };
  });

  const post = (action: string, headers: Record<string, string> = {}, body = "{}") =>
    fetch(`${root}/xbox/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body,
    });

  it("xbox status off without client id", async () => {
    xbox = null;
    const r = await fetch(`${root}/xbox`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      state: "off",
      gamertag: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    });
    // Off means no other Xbox endpoint at all, whatever the method.
    for (const action of ["connect", "cancel", "disconnect"]) {
      expect((await post(action)).status).toBe(404);
      expect((await fetch(`${root}/xbox/${action}`)).status).toBe(404);
    }
  });

  it("reports the status, with only the fields the browser may see", async () => {
    xbox = {
      ...(xbox as Xbox),
      status: () => status({ state: "connected", gamertag: "SampleTag" }),
    };
    const r = await fetch(`${root}/xbox`);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      state: "connected",
      gamertag: "SampleTag",
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      lostSince: null,
    });
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_DEVICE_CODE);
    const head = await fetch(`${root}/xbox`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("connect requires origin and JSON", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      expect((await post("connect", { "content-type": type })).status).toBe(415);
    }
    expect((await post("connect", { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await post("connect", { origin: `${ORIGIN}/` })).status).toBe(403);
    const noOrigin = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${root}/xbox/connect`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(noOrigin).toBe(403);
    for (const body of ["{not json", "[]", "null", '"x"']) {
      expect((await post("connect", {}, body)).status, body).toBe(400);
    }
    expect((await post("connect", {}, `{"pad":"${"x".repeat(2000)}"}`)).status).toBe(413);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const r = await fetch(`${root}/xbox/connect`, { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    expect(calls.filter((c) => c !== "status")).toEqual([]);
    expect(
      (await post("connect", { "content-type": "application/json; charset=utf-8" })).status,
    ).toBe(200);
    expect(calls).toContain("connect");
  });

  it("connect/cancel/disconnect return status only", async () => {
    const seen: Record<string, unknown> = {};
    for (const action of ["connect", "cancel", "disconnect"]) {
      const r = await post(action);
      expect(r.status, action).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const text = await r.text();
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_DEVICE_CODE);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "expiresAt",
        "gamertag",
        "lostSince",
        "state",
        "userCode",
        "verificationUri",
      ]);
      seen[action] = body.state;
    }
    expect(seen).toEqual({
      connect: "connecting",
      cancel: "disconnected",
      disconnect: "disconnected",
    });
    expect(calls).toEqual(["connect", "cancel", "disconnect"]);
  });

  it("answers a connect Microsoft refused with a fixed 502, and an unknown action with 404", async () => {
    connectFails = true;
    const r = await post("connect");
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(FAKE_DEVICE_CODE);
    expect((await post("restart")).status).toBe(404);
    expect((await post("connect/extra")).status).toBe(404);
  });

  it("xbox achievements route", async () => {
    const r = await fetch(`${root}/achievements/xbox/1000000001`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      source: "xbox",
      gamerscore: { current: 10, total: 100 },
    });
    expect((await fetch(`${root}/achievements/xbox/1000000002`)).status).toBe(404);
    expect((await fetch(`${root}/achievements/xbox/12345678901`)).status).toBe(400);
    expect((await fetch(`${root}/achievements/xbox/0x1F`)).status).toBe(400);
    expect(achievementCalls).toEqual(["xbox:1000000001", "xbox:1000000002"]);
  });
});
