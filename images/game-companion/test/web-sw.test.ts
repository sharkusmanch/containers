import { describe, expect, it, vi } from "vitest";
import { SHELL_CACHE, handleFetch, installWorker, swDecision } from "../src/web/sw.js";
import type { CacheLike, WorkerScopeLike } from "../src/web/sw.js";

const ORIGIN = "https://wiki.example.test";

describe("swDecision", () => {
  it.each([
    [`${ORIGIN}/companion/`, "GET", "network-first"],
    [`${ORIGIN}/companion/boot.js`, "GET", "network-first"],
    [`${ORIGIN}/companion/style.css?v=2`, "GET", "network-first"],
    [`${ORIGIN}/companion/manifest.webmanifest`, "GET", "network-first"],
    [`${ORIGIN}/companion/icon-192.png`, "GET", "network-first"],
    [`${ORIGIN}/companion/sw.js`, "GET", "network-first"],
    [`${ORIGIN}/companion/apis.js`, "GET", "network-first"],
    [`${ORIGIN}/companion/api/now`, "GET", "pass"],
    [`${ORIGIN}/companion/api/achievements/steam/10`, "GET", "pass"],
    [`${ORIGIN}/companion/api`, "GET", "pass"],
    [`${ORIGIN}/companion/healthz`, "GET", "pass"],
    [`${ORIGIN}/companion/healthz?probe=1`, "GET", "pass"],
    [`${ORIGIN}/companion/api/ask`, "POST", "pass"],
    [`${ORIGIN}/companion/boot.js`, "POST", "pass"],
    [`${ORIGIN}/companion/boot.js`, "HEAD", "pass"],
    [`${ORIGIN}/companion`, "GET", "pass"],
    [`${ORIGIN}/`, "GET", "pass"],
    [`${ORIGIN}/doc/sample-page-abc123`, "GET", "pass"],
    [`${ORIGIN}/static/sw.js`, "GET", "pass"],
    [`${ORIGIN}/companionx/boot.js`, "GET", "pass"],
    ["https://other.example.test/companion/boot.js", "GET", "pass"],
    ["https://media.example.test/icon.png", "GET", "pass"],
    ["not a url", "GET", "pass"],
  ] as const)("%s %s -> %s", (url, method, expected) => {
    expect(swDecision(url, method, ORIGIN)).toBe(expected);
  });
});

function fakeCache() {
  const stored = new Map<string, Response>();
  const put = vi.fn(async (request: Request, response: Response) => {
    stored.set(request.url, response);
  });
  const cache: CacheLike = {
    match: async (request: Request) => stored.get(request.url)?.clone(),
    put,
  };
  const open = vi.fn(async () => cache);
  return { put, open, stored };
}

describe("handleFetch", () => {
  it("answers from the network and stores a copy in the shell cache", async () => {
    const { put, open, stored } = fakeCache();
    const fetch = vi.fn(async () => new Response("<p>shell</p>", { status: 200 }));
    const request = new Request(`${ORIGIN}/companion/`);
    const response = await handleFetch(request, { fetch, caches: { open }, origin: ORIGIN });
    expect(fetch).toHaveBeenCalledWith(request);
    expect(await response?.text()).toBe("<p>shell</p>");
    expect(open).toHaveBeenCalledWith("game-companion-shell");
    expect(SHELL_CACHE).toBe("game-companion-shell");
    expect(put).toHaveBeenCalledTimes(1);
    expect(await stored.get(`${ORIGIN}/companion/`)?.text()).toBe("<p>shell</p>");
  });

  it("does not store an unsuccessful response, and still returns it", async () => {
    const { put, open } = fakeCache();
    const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const response = await handleFetch(new Request(`${ORIGIN}/companion/gone.js`), {
      fetch,
      caches: { open },
      origin: ORIGIN,
    });
    expect(response?.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("answers from the cache when the network fails", async () => {
    const { open, stored } = fakeCache();
    stored.set(`${ORIGIN}/companion/boot.js`, new Response("cached boot"));
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const response = await handleFetch(new Request(`${ORIGIN}/companion/boot.js`), {
      fetch,
      caches: { open },
      origin: ORIGIN,
    });
    expect(await response?.text()).toBe("cached boot");
  });

  it("fails like the network when the network fails and nothing is cached", async () => {
    const { open } = fakeCache();
    const failure = new TypeError("Failed to fetch");
    const fetch = vi.fn(async () => {
      throw failure;
    });
    const response = handleFetch(new Request(`${ORIGIN}/companion/boot.js`), {
      fetch,
      caches: { open },
      origin: ORIGIN,
    });
    await expect(response).rejects.toBe(failure);
  });

  it("still returns the network response when storing it fails", async () => {
    const open = vi.fn(async () => {
      throw new Error("quota");
    });
    const fetch = vi.fn(async () => new Response("fresh"));
    const response = await handleFetch(new Request(`${ORIGIN}/companion/boot.js`), {
      fetch,
      caches: { open },
      origin: ORIGIN,
    });
    expect(await response?.text()).toBe("fresh");
  });

  it.each([`${ORIGIN}/companion/api/now`, `${ORIGIN}/companion/healthz`, `${ORIGIN}/doc/abc`])(
    "leaves %s to the browser",
    (url) => {
      const { open } = fakeCache();
      const fetch = vi.fn(async () => new Response("x"));
      expect(handleFetch(new Request(url), { fetch, caches: { open }, origin: ORIGIN })).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );
});

describe("installWorker", () => {
  function fakeScope() {
    const listeners = new Map<string, (event: never) => void>();
    const { open } = fakeCache();
    const skipWaiting = vi.fn(async () => undefined);
    const claim = vi.fn(async () => undefined);
    const scope: WorkerScopeLike = {
      location: { origin: ORIGIN },
      skipWaiting,
      clients: { claim },
      caches: { open },
      fetch: vi.fn(async () => new Response("net")),
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
    };
    const fire = (type: string, event: object): void => {
      (listeners.get(type) as (event: object) => void)(event);
    };
    return { scope, fire, skipWaiting, claim };
  }

  it("takes over at once: skipWaiting on install and clients.claim on activate", () => {
    const { scope, fire, skipWaiting, claim } = fakeScope();
    installWorker(scope);
    const install = { waitUntil: vi.fn() };
    fire("install", install);
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(install.waitUntil).toHaveBeenCalledTimes(1);
    const activate = { waitUntil: vi.fn() };
    fire("activate", activate);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(activate.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("answers a shell request and leaves an API request alone", async () => {
    const { scope, fire } = fakeScope();
    installWorker(scope);
    const shell = { request: new Request(`${ORIGIN}/companion/`), respondWith: vi.fn() };
    fire("fetch", shell);
    expect(shell.respondWith).toHaveBeenCalledTimes(1);
    const answer = shell.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    expect(await (await answer).text()).toBe("net");
    const api = { request: new Request(`${ORIGIN}/companion/api/now`), respondWith: vi.fn() };
    fire("fetch", api);
    expect(api.respondWith).not.toHaveBeenCalled();
  });
});
