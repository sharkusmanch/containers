import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { McpTools } from "../src/server/mcp.js";
import { createHandler, type RouteDeps } from "../src/server/routes.js";

const TOKEN = "sample-mcp-token-0123456789";
const LIMIT = 65536;

let server: Server;
let url: string;
let mcp: Exclude<RouteDeps["mcp"], undefined>;
let toolCalls: unknown[][];

const tools: McpTools = {
  status: async (...args) => {
    toolCalls.push(["status", ...args]);
    return { text: "Game: Sample Quest (Steam)" };
  },
  listGuides: async () => ({ text: "- Sample Quest (Steam): h1" }),
  outline: async () => ({ text: "## Walkthrough (4 chars)" }),
  search: async () => ({ text: "No matches." }),
  read: async () => ({ text: "walk" }),
};

beforeAll(async () => {
  const deps: RouteDeps = {
    ask: null,
    get mcp() {
      return mcp;
    },
    staticDir: "/nonexistent",
    now: () => ({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
      assistant: false,
    }),
    guides: () => ({ available: false, hubs: [] }),
    hubTree: () => null,
    refreshGuides: () => {},
    achievements: async () => null,
    find: async () => null,
    marks: async () => null,
    where: async () => null,
    progress: async () => null,
  };
  server = createServer((req, res) => void createHandler(deps)(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/companion/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  mcp = { token: TOKEN, version: "9.9.9", tools };
  toolCalls = [];
});

const headers = (over: Record<string, string> = {}) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${TOKEN}`,
  ...over,
});
const post = (body: unknown, over: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: headers(over),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Sends exact headers, so a declared content-length need not match the bytes written. */
function raw(
  h: Record<string, string>,
  chunks: Buffer[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: h }, (res) => {
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

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("POST /companion/mcp", () => {
  it("answers a request with a JSON-RPC result as application/json", async () => {
    const r = await post(ping);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("initializes, then calls a tool through the dependencies", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
    });
    expect(await init.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "game-companion", version: "9.9.9" },
      },
    });
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "companion_status", arguments: { hub: "h1" } },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "Game: Sample Quest (Steam)" }] },
    });
    expect(toolCalls).toEqual([["status", "h1"]]);
  });

  it("accepts notifications/initialized with 202 and no body", async () => {
    const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("answers a parse error with -32700, and a batch with -32600", async () => {
    const bad = await post("{not json");
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    const batch = await post([ping]);
    expect(await batch.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("is 404 for every method while no token is configured", async () => {
    mcp = null;
    expect((await post(ping)).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
  });

  it("answers GET and DELETE with 405 and allow: POST", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await fetch(url, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });

  it("rejects a missing or wrong token with 401, calling nothing", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "companion_status" },
    };
    const none = await raw({ "content-type": "application/json" }, [
      Buffer.from(JSON.stringify(body)),
    ]);
    expect(none.status).toBe(401);
    for (const auth of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN, "Bearer "]) {
      expect((await post(body, { authorization: auth })).status).toBe(401);
    }
    expect(toolCalls).toEqual([]);
  });

  it("rejects a wrong content type with 415", async () => {
    const r = await post(ping, { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    expect((await post(ping, { "content-type": "application/json; charset=utf-8" })).status).toBe(
      200,
    );
  });

  it("rejects an unknown protocol version header with 400", async () => {
    const r = await post(ping, { "mcp-protocol-version": "2024-11-05" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Unsupported protocol version" },
    });
  });

  it("rejects a declared length over 64 KiB with 413 before reading", async () => {
    const r = await raw(headers({ "content-length": String(LIMIT + 1) }), [Buffer.from("{}")]);
    expect(r.status).toBe(413);
  });

  it("rejects a chunked body over 64 KiB with 413, and accepts one at the limit", async () => {
    const h = headers();
    const over = await raw(h, [Buffer.alloc(LIMIT, 0x20), Buffer.from("x")]);
    expect(over.status).toBe(413);
    const body = JSON.stringify(ping);
    const padded = Buffer.from(body + " ".repeat(LIMIT - body.length));
    const exact = await raw(h, [padded.subarray(0, 100), padded.subarray(100)]);
    expect(exact.status).toBe(200);
    expect(JSON.parse(exact.body)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("checks the token before the body size", async () => {
    const r = await raw(
      { "content-type": "application/json", "content-length": String(LIMIT + 1) },
      [Buffer.from("{}")],
    );
    expect(r.status).toBe(401);
  });
});
