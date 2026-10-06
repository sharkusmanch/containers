import { describe, expect, it } from "vitest";
import { ApiError, REQUEST_TIMEOUT_MS, createApi } from "../src/web/api.js";

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
});
