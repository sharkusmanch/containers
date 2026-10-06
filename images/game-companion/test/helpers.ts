import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/server/fetch-json.js";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export interface FakeFetch {
  fn: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
}

/** Routes by substring of the URL (or of the JSON body for POSTs). First match wins. */
export function fakeFetch(routes: [string, { status?: number; body: string }][]): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = `${url} ${typeof init?.body === "string" ? init.body : ""}`;
    const hit = routes.find(([needle]) => key.includes(needle));
    if (!hit) return new Response("not routed", { status: 599 });
    return new Response(hit[1].body, { status: hit[1].status ?? 200 });
  };
  return { fn, calls };
}
