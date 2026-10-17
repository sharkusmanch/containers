/**
 * The service worker, registered from boot.js for the page's own directory (/companion/). It keeps
 * a copy of every page file it fetches so the shell still opens when the network is gone, and
 * leaves everything else (the API, the health check, other paths and hosts) to the browser.
 *
 * Browsers load it as a classic script: the build strips the `export` keywords that let the tests
 * import it (scripts/copy-static.mjs), so it must not import anything.
 */

/** The one cache the worker writes to. */
export const SHELL_CACHE = "game-companion-shell";

const BASE = "/companion/";
/** First path segments under BASE that the worker never intercepts. */
const NEVER = ["api", "healthz"];

export type SwDecision = "network-first" | "pass";

/** Whether the worker answers a request (network first, cache as fallback) or leaves it alone. */
export function swDecision(url: string, method: string, origin: string): SwDecision {
  if (method !== "GET") return "pass";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "pass";
  }
  if (parsed.origin !== origin || !parsed.pathname.startsWith(BASE)) return "pass";
  const first = parsed.pathname.slice(BASE.length).split("/")[0] ?? "";
  return NEVER.includes(first) ? "pass" : "network-first";
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface SwDeps {
  fetch(request: Request): Promise<Response>;
  caches: { open(name: string): Promise<CacheLike> };
  /** The worker's own origin: only its requests are handled. */
  origin: string;
}

/** The answer to a request the worker handles, or null for one it leaves to the browser. */
export function handleFetch(request: Request, deps: SwDeps): Promise<Response> | null {
  if (swDecision(request.url, request.method, deps.origin) === "pass") return null;
  return networkFirst(request, deps);
}

async function networkFirst(request: Request, deps: SwDeps): Promise<Response> {
  let response: Response;
  try {
    response = await deps.fetch(request);
  } catch (failure) {
    const cached = await deps.caches
      .open(SHELL_CACHE)
      .then((cache) => cache.match(request))
      .catch(() => undefined);
    if (cached !== undefined) return cached;
    throw failure;
  }
  if (response.ok) {
    try {
      await (await deps.caches.open(SHELL_CACHE)).put(request, response.clone());
    } catch {
      // A full or unavailable cache only costs the offline copy.
    }
  }
  return response;
}

interface ExtendableEventLike {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

/** The parts of ServiceWorkerGlobalScope the worker uses (the DOM types do not describe it). */
export interface WorkerScopeLike {
  location: { origin: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  caches: SwDeps["caches"];
  fetch(request: Request): Promise<Response>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

/** Wires the worker's events: a new version takes over at once, and page files go network first. */
export function installWorker(scope: WorkerScopeLike): void {
  scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
  scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
  scope.addEventListener("fetch", (event) => {
    const answer = handleFetch(event.request, {
      fetch: (request) => scope.fetch(request),
      caches: scope.caches,
      origin: scope.location.origin,
    });
    if (answer !== null) event.respondWith(answer);
  });
}

if ("ServiceWorkerGlobalScope" in globalThis) {
  installWorker(globalThis as unknown as WorkerScopeLike);
}
