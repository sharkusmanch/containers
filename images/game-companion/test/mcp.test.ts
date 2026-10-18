import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleMessage,
  type McpTools,
  PROTOCOL_VERSIONS,
  protocolVersionOk,
  TOOLS,
  tokenMatches,
} from "../src/server/mcp.js";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

function fakeTools(over: Partial<McpTools> = {}) {
  const calls: unknown[][] = [];
  const tools: McpTools = {
    status: async (...args) => {
      calls.push(["status", ...args]);
      return { text: "Game: Sample Quest (Steam)" };
    },
    listGuides: async (...args) => {
      calls.push(["listGuides", ...args]);
      return { text: "- Sample Quest (Steam): h1" };
    },
    outline: async (...args) => {
      calls.push(["outline", ...args]);
      return { text: "## Walkthrough (10 chars)" };
    },
    search: async (...args) => {
      calls.push(["search", ...args]);
      return { text: "- Walkthrough: sample lantern" };
    },
    read: async (...args) => {
      calls.push(["read", ...args]);
      return { text: "# Walkthrough" };
    },
    ...over,
  };
  return { calls, tools };
}

const VERSION = "9.9.9";
const send = (msg: unknown, tools: McpTools = fakeTools().tools) =>
  handleMessage(msg, { tools, version: VERSION });
const call = (name: string, args?: unknown, tools?: McpTools) =>
  send(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: args === undefined ? { name } : { name, arguments: args },
    },
    tools,
  );

describe("initialize", () => {
  it("echoes every protocol version it knows", async () => {
    expect(PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
    for (const v of PROTOCOL_VERSIONS) {
      const r = await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "x", version: "1" } },
      });
      expect(r).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: v,
          capabilities: { tools: {} },
          serverInfo: { name: "game-companion", version: VERSION },
        },
      });
    }
  });

  it("answers its latest version for one it does not know", async () => {
    const r = await send({
      jsonrpc: "2.0",
      id: "a",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    });
    expect(r).toMatchObject({ id: "a", result: { protocolVersion: "2025-11-25" } });
  });

  it("rejects a missing protocol version as invalid params", async () => {
    for (const params of [undefined, {}, { protocolVersion: 5 }]) {
      const r = await send({ jsonrpc: "2.0", id: 2, method: "initialize", params });
      expect(r).toEqual({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32602, message: "Invalid params" },
      });
    }
  });
});

describe("messages", () => {
  it("answers nothing to a notification, known or not", async () => {
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(
      await send({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
    ).toBeNull();
    expect(await send({ jsonrpc: "2.0", method: "tools/call", params: { name: "x" } })).toBeNull();
  });

  it("answers ping with an empty result", async () => {
    expect(await send({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
  });

  it("rejects an unknown method with -32601", async () => {
    expect(await send({ jsonrpc: "2.0", id: 4, method: "resources/list" })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("rejects anything that is not a single JSON-RPC 2.0 request with -32600", async () => {
    const bad: unknown[] = [
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      null,
      "ping",
      42,
      { id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, method: 5 },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: { x: 1 }, method: "ping" },
      { jsonrpc: "2.0", id: 1.5, method: "ping" },
    ];
    for (const msg of bad) {
      expect(await send(msg)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }
  });

  it("rejects params that are not an object with -32602", async () => {
    for (const params of [[], "x", 1, null]) {
      expect(await send({ jsonrpc: "2.0", id: 5, method: "ping", params })).toEqual({
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32602, message: "Invalid params" },
      });
    }
  });
});

describe("tools/list", () => {
  it("lists exactly the five read-only tools with closed input schemas", async () => {
    const r = await send({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
    expect(r).toEqual({ jsonrpc: "2.0", id: 6, result: { tools: TOOLS } });
    expect(TOOLS.map((t) => t.name)).toEqual([
      "companion_status",
      "list_guides",
      "guide_outline",
      "search_guide",
      "read_guide_page",
    ]);
    const hub = {
      type: "string",
      pattern: "^[A-Za-z0-9-]{1,64}$",
      description: expect.any(String) as unknown,
    };
    const text = {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: expect.any(String) as unknown,
    };
    const schemas = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema]));
    expect(schemas).toEqual({
      companion_status: {
        type: "object",
        properties: { hub },
        required: [],
        additionalProperties: false,
      },
      list_guides: { type: "object", properties: {}, required: [], additionalProperties: false },
      guide_outline: {
        type: "object",
        properties: { hub },
        required: [],
        additionalProperties: false,
      },
      search_guide: {
        type: "object",
        properties: { query: text, hub },
        required: ["query"],
        additionalProperties: false,
      },
      read_guide_page: {
        type: "object",
        properties: { page: text, section: text, hub },
        required: ["page"],
        additionalProperties: false,
      },
    });
    for (const t of TOOLS) {
      expect(t.description).toMatch(/^[A-Z][^\n]+\.$/);
      expect(t.description.split(". ")).toHaveLength(1);
    }
  });
});

describe("tools/call", () => {
  it("dispatches each tool with its arguments and wraps the text", async () => {
    const { calls, tools } = fakeTools();
    expect(await call("companion_status", {}, tools)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "Game: Sample Quest (Steam)" }] },
    });
    await call("companion_status", { hub: "h-2" }, tools);
    await call("list_guides", undefined, tools);
    await call("guide_outline", { hub: "h1" }, tools);
    await call("guide_outline", {}, tools);
    await call("search_guide", { query: "lantern" }, tools);
    await call("search_guide", { query: "lantern", hub: "h1" }, tools);
    await call("read_guide_page", { page: "Walkthrough" }, tools);
    await call(
      "read_guide_page",
      { page: "Walkthrough", section: "Mock Village", hub: "h1" },
      tools,
    );
    expect(calls).toEqual([
      ["status", undefined],
      ["status", "h-2"],
      ["listGuides"],
      ["outline", "h1"],
      ["outline", undefined],
      ["search", "lantern", undefined],
      ["search", "lantern", "h1"],
      ["read", "Walkthrough", undefined, undefined],
      ["read", "Walkthrough", "Mock Village", "h1"],
    ]);
  });

  it("marks a backend's error result with isError", async () => {
    const { tools } = fakeTools({
      outline: async () => ({ text: "No guide for the current game.", isError: true }),
    });
    expect(await call("guide_outline", {}, tools)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "No guide for the current game." }],
        isError: true,
      },
    });
  });

  it("turns a backend that throws into an error result", async () => {
    const { tools } = fakeTools({
      search: async () => {
        throw new Error("boom");
      },
    });
    expect(await call("search_guide", { query: "lantern" }, tools)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "The tool failed. Try again shortly." }],
        isError: true,
      },
    });
  });

  it("rejects an unknown tool or a malformed call with -32602", async () => {
    const bad: unknown[] = [
      { name: "write_guide" },
      { name: 5 },
      {},
      { name: "list_guides", arguments: [] },
      { name: "list_guides", arguments: "x" },
      { name: "list_guides", arguments: null },
    ];
    for (const params of bad) {
      const r = await send({ jsonrpc: "2.0", id: 8, method: "tools/call", params });
      expect(r).toMatchObject({ jsonrpc: "2.0", id: 8, error: { code: -32602 } });
    }
    expect(await send({ jsonrpc: "2.0", id: 8, method: "tools/call" })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("answers arguments that break the schema with an error result, calling nothing", async () => {
    const { calls, tools } = fakeTools();
    const cases: [string, unknown, string][] = [
      ["list_guides", { hub: "h1" }, 'Unknown argument "hub".'],
      ["companion_status", { game: "x" }, 'Unknown argument "game".'],
      ["companion_status", { toString: "x" }, 'Unknown argument "toString".'],
      ["companion_status", { hub: 5 }, 'Argument "hub" must be a string.'],
      [
        "companion_status",
        { hub: "has space" },
        'Argument "hub" must be a guide id from list_guides.',
      ],
      [
        "guide_outline",
        { hub: "x".repeat(65) },
        'Argument "hub" must be a guide id from list_guides.',
      ],
      ["search_guide", {}, 'Missing argument "query".'],
      ["search_guide", { query: "  " }, 'Argument "query" must not be empty.'],
      [
        "search_guide",
        { query: "x".repeat(201) },
        'Argument "query" is longer than 200 characters.',
      ],
      ["read_guide_page", { section: "A" }, 'Missing argument "page".'],
      ["read_guide_page", { page: "A", section: 1 }, 'Argument "section" must be a string.'],
    ];
    for (const [name, args, text] of cases) {
      expect(await call(name, args, tools)).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text }], isError: true },
      });
    }
    expect(calls).toEqual([]);
  });

  it("counts characters, not UTF-16 units, against the length limit", async () => {
    const { calls, tools } = fakeTools();
    const r = await call("search_guide", { query: "\u{1F3AE}".repeat(200) }, tools);
    expect(r).toMatchObject({ result: { content: [{ type: "text" }] } });
    expect(calls).toHaveLength(1);
  });
});

describe("tokenMatches", () => {
  const TOKEN = "sample-token-0123456789";
  it("accepts the exact bearer token, with any case on the scheme", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it("rejects a missing, wrong, shorter, longer or differently-schemed token", () => {
    for (const header of [
      undefined,
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}X`,
      `Bearer  ${TOKEN}`,
      "Bearer ",
    ]) {
      expect(tokenMatches(header, TOKEN)).toBe(false);
    }
  });
  it("compares equal-length tokens in constant time and never throws on a length mismatch", () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(tokenMatches(`Bearer ${TOKEN.slice(0, -1)}X`, TOKEN)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(() => tokenMatches(`Bearer ${TOKEN}${TOKEN}`, TOKEN)).not.toThrow();
  });
});

describe("protocolVersionOk", () => {
  it("accepts an absent header or a known version, and nothing else", () => {
    expect(protocolVersionOk(undefined)).toBe(true);
    for (const v of PROTOCOL_VERSIONS) expect(protocolVersionOk(v)).toBe(true);
    expect(protocolVersionOk("2024-11-05")).toBe(false);
    expect(protocolVersionOk("")).toBe(false);
  });
});
