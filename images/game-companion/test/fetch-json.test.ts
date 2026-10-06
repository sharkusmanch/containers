import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, fetchJson, UpstreamError } from "../src/server/fetch-json.js";

describe("fetchJson", () => {
  it("returns parsed JSON", async () => {
    expect(await fetchJson(async () => new Response('{"a":1}'), "https://x.test")).toEqual({
      a: 1,
    });
  });

  it("throws UpstreamError with the status on a non-2xx", async () => {
    const err = await fetchJson(
      async () => new Response("no", { status: 503 }),
      "https://x.test",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(503);
  });

  it("throws UpstreamError on invalid JSON", async () => {
    await expect(
      fetchJson(async () => new Response("<html>"), "https://x.test"),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("never puts the URL in the error message, since it carries API keys", async () => {
    const err = (await fetchJson(
      async () => new Response("no", { status: 500 }),
      "https://x.test/?key=SECRET",
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
  });

  it("times out a hanging request", async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    const err = await fetchJson(hang, "https://x.test", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBeNull();
  });

  it("times out a body that stalls after the headers arrive", async () => {
    const stall = (_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return Promise.resolve(new Response(body));
    };
    const err = await fetchJson(stall, "https://x.test", { timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBeNull();
  });

  it("defaults to a timeout shorter than the browser's eight seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(4_000);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(8_000);
  });

  it("does not carry the request URL or key from a failing fetch into the error", async () => {
    const url = "https://x.test/?key=SECRET";
    const failing = async (u: string): Promise<Response> => {
      throw new Error(`connect failed for ${u} using SECRET`);
    };
    const err = (await fetchJson(failing, url).catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("x.test");
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("SECRET");
  });
});
