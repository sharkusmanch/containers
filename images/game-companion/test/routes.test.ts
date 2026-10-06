import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandler, IMAGE_HOSTS, type RouteDeps } from "../src/server/routes.js";
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
const now: NowResponse = { game: null, state: "none", stale: false, observedAt: null, hubs: [] };
const ach: AchievementsResponse = {
  source: "steam",
  id: "10",
  title: "Test Game",
  total: 0,
  unlocked: 0,
  stale: false,
  achievements: [],
};

let server: Server;
let base: string;
let refreshCalls = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-routes-"));
  await writeFile(join(dir, "index.html"), "<p>shell</p>");
  await writeFile(join(dir, "app.js"), "export {}");
  const deps: RouteDeps = {
    staticDir: dir,
    now: () => now,
    guides: () => ({ available: true, hubs: [hub] }),
    hubTree: (id) => (id === "h1" ? { hub, pages: [], defaultPins: ["Guide"] } : null),
    refreshGuides: () => {
      refreshCalls += 1;
    },
    achievements: async (source, id) => (source === "steam" && id === "10" ? ach : null),
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

  it("404s an unknown hub", async () => {
    expect((await fetch(`${base}/companion/api/guides/nope`)).status).toBe(404);
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
