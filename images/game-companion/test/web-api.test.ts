import { describe, expect, it } from "vitest";
import { AUTH_RETRY_MS, ApiError, REQUEST_TIMEOUT_MS, createApi } from "../src/web/api.js";
import type { AskEvent, AskRequest } from "../src/shared/types.js";

function fake(status: number, body: unknown): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, urls };
}

describe("createApi", () => {
  it("requests relative URLs under the api base", async () => {
    const f = fake(200, { available: true, hubs: [] });
    const api = createApi(f.fn);
    await api.guides();
    await api.guides(true);
    await api.hubTree("h1");
    expect(f.urls).toEqual(["api/guides", "api/guides?refresh=1", "api/guides/h1"]);
  });

  it("encodes path parts", async () => {
    const f = fake(200, {});
    await createApi(f.fn).hubTree("a/b");
    expect(f.urls[0]).toBe("api/guides/a%2Fb");
  });

  it("returns null achievements on 404 and throws on other errors", async () => {
    expect(await createApi(fake(404, {}).fn).achievements("steam", "10")).toBeNull();
    const err = await createApi(fake(500, {}).fn)
      .achievements("steam", "10")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("reads the Xbox sign-in and posts each action as an empty JSON object", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const body = {
      state: "connecting",
      gamertag: null,
      userCode: "ABCD-EFGH",
      verificationUri: "https://www.microsoft.com/link",
      expiresAt: "2026-10-18T12:15:00.000Z",
      lostSince: null,
    };
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: input as string, init });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const api = createApi(fn);
    expect(await api.xbox()).toEqual(body);
    for (const action of ["connect", "cancel", "disconnect"] as const) {
      expect(await api.xboxAction(action)).toEqual(body);
    }
    expect(seen.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET api/xbox",
      "POST api/xbox/connect",
      "POST api/xbox/cancel",
      "POST api/xbox/disconnect",
    ]);
    const post = seen[1]?.init as RequestInit;
    expect(post.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(post.body).toBe("{}");
    expect(post.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws ApiError for a refused Xbox action", async () => {
    const err = await createApi(fake(502, { error: "x" }).fn)
      .xboxAction("connect")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it("gives up on a request that never answers once the deadline passes", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(8000);
    const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const started = Date.now();
    await expect(createApi(fn, "api", 20).now()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("throws ApiError for a failed now request", async () => {
    await expect(createApi(fake(502, {}).fn).now()).rejects.toBeInstanceOf(ApiError);
  });

  it("builds the find URL with the query encoded", async () => {
    const f = fake(200, { matches: [], truncated: false });
    const api = createApi(f.fn);
    await api.find("h1", "Sample Quest");
    await api.find("h1", "Fish & Chips");
    await api.find("h1", "Café ünï");
    await api.find("a/b", "x");
    expect(f.urls).toEqual([
      "api/guides/h1/find?q=Sample%20Quest",
      "api/guides/h1/find?q=Fish%20%26%20Chips",
      "api/guides/h1/find?q=Caf%C3%A9%20%C3%BCn%C3%AF",
      "api/guides/a%2Fb/find?q=x",
    ]);
  });

  it("puts a query full of reserved characters on the wire encoded, so it reads back unchanged", async () => {
    const f = fake(200, { matches: [], truncated: false });
    const text = "a#b%c+d&e f=g?h/i";
    await createApi(f.fn).find("h1", text);
    expect(f.urls[0]).toBe("api/guides/h1/find?q=a%23b%25c%2Bd%26e%20f%3Dg%3Fh%2Fi");
    const url = new URL(f.urls[0] as string, "http://example.test/companion/");
    expect(url.search.startsWith("?q=")).toBe(true);
    expect([...url.searchParams.keys()]).toEqual(["q"]);
    expect(url.searchParams.get("q")).toBe(text);
    expect(url.hash).toBe("");
  });

  it("returns the find response body", async () => {
    const body = {
      matches: [{ pageTitle: "P", pageUrl: "/doc/p", heading: null, snippet: "s" }],
      truncated: true,
    };
    expect(await createApi(fake(200, body).fn).find("h1", "ab")).toEqual(body);
  });

  it("returns null for find on 404 and throws ApiError otherwise", async () => {
    expect(await createApi(fake(404, {}).fn).find("h1", "ab")).toBeNull();
    for (const status of [400, 500]) {
      const err = await createApi(fake(status, {}).fn)
        .find("h1", "ab")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    }
  });

  it("builds the marks URL, returns the body, maps 404 to null and throws ApiError otherwise", async () => {
    const f = fake(200, { missable: ["sample quest"] });
    const api = createApi(f.fn);
    expect(await api.marks("h1")).toEqual({ missable: ["sample quest"] });
    await api.marks("a/b");
    expect(f.urls).toEqual(["api/guides/h1/marks", "api/guides/a%2Fb/marks"]);
    expect(await createApi(fake(404, {}).fn).marks("h1")).toBeNull();
    const err = await createApi(fake(503, {}).fn)
      .marks("h1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });

  it("builds the where URL, returns the body, maps 404 to null and throws ApiError otherwise", async () => {
    const body = {
      matches: [
        { pageTitle: "P", pageUrl: "/doc/p", heading: "Chapter One", phrase: "Chapter One" },
      ],
    };
    const f = fake(200, body);
    const api = createApi(f.fn);
    expect(await api.where("h1")).toEqual(body);
    await api.where("a/b");
    expect(f.urls).toEqual(["api/guides/h1/where", "api/guides/a%2Fb/where"]);
    expect(await createApi(fake(404, {}).fn).where("h1")).toBeNull();
    const err = await createApi(fake(500, {}).fn)
      .where("h1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("builds the progress URL with and without the refresh flag, maps 404 to null and throws ApiError otherwise", async () => {
    const body = { pages: [{ url: "/doc/p", completed: 2, total: 9 }] };
    const f = fake(200, body);
    const api = createApi(f.fn);
    expect(await api.progress("h1")).toEqual(body);
    await api.progress("h1", false);
    await api.progress("h1", true);
    await api.progress("a/b", true);
    expect(f.urls).toEqual([
      "api/guides/h1/progress",
      "api/guides/h1/progress",
      "api/guides/h1/progress?refresh=1",
      "api/guides/a%2Fb/progress?refresh=1",
    ]);
    expect(await createApi(fake(404, {}).fn).progress("h1")).toBeNull();
    const err = await createApi(fake(500, {}).fn)
      .progress("h1", true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

describe("api.ask", () => {
  const request: AskRequest = {
    hubId: "h1",
    game: { source: "ra", id: "20" },
    history: [{ question: "Q", answer: "A" }],
    question: "Where now?",
    depth: "hint",
  };

  function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
        controller.close();
      },
    });
  }

  it("posts the request as JSON with only the caller's signal", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: input as string, init });
      return new Response(streamOf([]), { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    await createApi(fn).ask(request, controller.signal, () => undefined);
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0] as { url: string; init: RequestInit };
    expect(url).toBe("api/ask");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      accept: "application/x-ndjson",
    });
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(init.signal).toBe(controller.signal);
  });

  it("parses NDJSON split across chunk boundaries and skips lines that are not JSON", async () => {
    const e = new TextEncoder().encode('{"type":"text","text":"café"}\n');
    const cut = e.indexOf(0xc3) + 1; // inside the two bytes of "é"
    const fn = (async () =>
      new Response(
        streamOf([
          '{"type":"search","qu',
          'ery":"sample"}\n',
          e.slice(0, cut),
          e.slice(cut),
          "not json\n\n",
          '{"type":"done","truncatedGuide":false}',
        ]),
        { status: 200 },
      )) as typeof fetch;
    const events: AskEvent[] = [];
    await createApi(fn).ask(request, new AbortController().signal, (ev) => events.push(ev));
    expect(events).toEqual([
      { type: "search", query: "sample" },
      { type: "text", text: "café" },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("throws ApiError carrying the limit and retry-after seconds of a 429", async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ error: "rate limited", limit: "minute" }), {
        status: 429,
        headers: { "retry-after": "17" },
      })) as typeof fetch;
    const err = await createApi(fn)
      .ask(request, new AbortController().signal, () => undefined)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, limit: "minute", retryAfter: 17 });
  });

  it("throws ApiError with no limit for other failures, whatever the body", async () => {
    for (const [status, body] of [
      [503, "not json"],
      [400, JSON.stringify({ error: "bad request" })],
    ] as const) {
      const fn = (async () => new Response(body, { status })) as typeof fetch;
      const err = await createApi(fn)
        .ask(request, new AbortController().signal, () => undefined)
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status, limit: undefined, retryAfter: undefined });
    }
  });
});

describe("api sign-in state", () => {
  const request: AskRequest = {
    hubId: "h1",
    game: null,
    history: [],
    question: "Where now?",
    depth: "hint",
  };
  const ask = (api: ReturnType<typeof createApi>) =>
    api.ask(request, new AbortController().signal, () => undefined).catch((e: unknown) => e);

  const noWait = async (): Promise<void> => undefined;

  /** Every kind of call, each run once against the given fetch. */
  const everyCall = (api: ReturnType<typeof createApi>): Promise<unknown>[] => [
    api.now().catch((e: unknown) => e),
    api.guides().catch((e: unknown) => e),
    api.hubTree("h1").catch((e: unknown) => e),
    api.achievements("steam", "10").catch((e: unknown) => e),
    api.find("h1", "ab").catch((e: unknown) => e),
    api.marks("h1").catch((e: unknown) => e),
    api.where("h1").catch((e: unknown) => e),
    api.progress("h1").catch((e: unknown) => e),
    ask(api),
  ];

  it("reports signed out for a 401 from any call, the ask call included", async () => {
    const api = createApi(
      fake(401, { error: "unauthorized" }).fn,
      "api",
      REQUEST_TIMEOUT_MS,
      noWait,
    );
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    const results = await Promise.all(everyCall(api));
    expect(seen).toEqual(Array.from({ length: 9 }, () => false));
    for (const r of results) expect(r).toMatchObject({ status: 401 });
  });

  it("reports signed in for every successful response", async () => {
    const api = createApi(fake(200, { error: "" }).fn);
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    await api.now();
    await api.marks("h1");
    expect(seen).toEqual([true, true]);
  });

  it("reports nothing for other failures, a 404 or a network error", async () => {
    const seen: boolean[] = [];
    for (const status of [404, 403, 500, 503]) {
      const api = createApi(fake(status, {}).fn);
      api.onAuth?.((signedIn) => seen.push(signedIn));
      await Promise.all(everyCall(api));
    }
    const failing: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const down = createApi(failing);
    down.onAuth?.((signedIn) => seen.push(signedIn));
    await Promise.all(everyCall(down));
    expect(seen).toEqual([]);
  });

  it("tells every listener", async () => {
    const api = createApi(fake(401, {}).fn, "api", REQUEST_TIMEOUT_MS, noWait);
    const a: boolean[] = [];
    const b: boolean[] = [];
    api.onAuth?.((s) => a.push(s));
    api.onAuth?.((s) => b.push(s));
    await api.now().catch(() => undefined);
    expect(a).toEqual([false]);
    expect(b).toEqual([false]);
  });

  it("offers the listener hook on every api it creates", () => {
    expect(typeof createApi(fake(200, {}).fn).onAuth).toBe("function");
  });

  /** A fetch answering each request with the next status in turn, recording method and URL. */
  const sequence = (statuses: number[], body: unknown = { ok: 1 }) => {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(body), { status: statuses.shift() ?? 200 });
    }) as typeof fetch;
    return { fn, calls };
  };
  /** A wait that resolves at once, recording each delay asked for. */
  const recordWaits = () => {
    const waits: number[] = [];
    const wait = async (ms: number): Promise<void> => void waits.push(ms);
    return { wait, waits };
  };

  it("retries a GET once after 2 s on a 401, uses the second answer and reports signed in", async () => {
    expect(AUTH_RETRY_MS).toBe(2000);
    const f = sequence([401, 200], { available: true, hubs: [] });
    const w = recordWaits();
    const api = createApi(f.fn, "api", REQUEST_TIMEOUT_MS, w.wait);
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    expect(await api.guides()).toEqual({ available: true, hubs: [] });
    expect(f.calls).toEqual(["GET api/guides", "GET api/guides"]);
    expect(w.waits).toEqual([2000]);
    expect(seen).toEqual([true]);
  });

  it("reports signed out only when the retried GET answers 401 again", async () => {
    const f = sequence([401, 401]);
    const w = recordWaits();
    const api = createApi(f.fn, "api", REQUEST_TIMEOUT_MS, w.wait);
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    const err = await api.marks("h1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(f.calls).toEqual(["GET api/guides/h1/marks", "GET api/guides/h1/marks"]);
    expect(w.waits).toEqual([2000]);
    expect(seen).toEqual([false]);
  });

  it("never re-sends a question refused with 401: it checks the sign-in with a GET of now", async () => {
    const f = sequence([401, 200]);
    const w = recordWaits();
    const api = createApi(f.fn, "api", REQUEST_TIMEOUT_MS, w.wait);
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    const err = await ask(api);
    expect(f.calls).toEqual(["POST api/ask", "GET api/now"]);
    expect(w.waits).toEqual([2000]);
    expect(seen).toEqual([true]);
    // Still signed in: the question failed for some other reason, told as unavailable.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toMatchObject({ status: 401 });
  });

  it("reports signed out when the question's 401 is confirmed by now answering 401", async () => {
    const f = sequence([401, 401]);
    const api = createApi(f.fn, "api", REQUEST_TIMEOUT_MS, recordWaits().wait);
    const seen: boolean[] = [];
    api.onAuth?.((signedIn) => seen.push(signedIn));
    const err = await ask(api);
    expect(f.calls).toEqual(["POST api/ask", "GET api/now"]);
    expect(seen).toEqual([false]);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401 });
  });
});
