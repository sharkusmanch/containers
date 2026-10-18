import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_UNAVAILABLE, AgentClient } from "../src/server/agent-client.js";
import { createHandler, type RouteDeps } from "../src/server/routes.js";

// The ask route in front of a real AgentClient and a fake agent: the whole proxy path.

const ORIGIN = "https://wiki.example.test";
const valid = {
  hubId: "h1",
  game: { source: "steam", id: "10" },
  history: [],
  question: "What next?",
  depth: "full",
};

let agentServer: Server;
let companion: Server;
let url: string;
let handle: (req: IncomingMessage, res: ServerResponse) => void;
/** Resolves when the companion closes its agent request before the agent ended it. */
let agentClosedEarly: Promise<void>;
let agentRequests: number;
let timers: { fn: () => void; ms: number; over: boolean }[];
const pending = () => timers.filter((t) => !t.over);

beforeAll(async () => {
  agentServer = createServer((req, res) => {
    agentRequests += 1;
    agentClosedEarly = new Promise<void>((resolve) => {
      res.on("close", () => {
        if (!res.writableFinished) resolve();
      });
    });
    req.resume();
    req.on("end", () => handle(req, res));
  });
  await new Promise<void>((r) => agentServer.listen(0, "127.0.0.1", r));
  const agent = new AgentClient({
    url: `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}`,
    token: "sample-agent-token",
    log: () => undefined,
  });

  const deps: RouteDeps = {
    staticDir: "/nonexistent",
    now: () => ({
      game: null,
      state: "none",
      stale: false,
      observedAt: null,
      presence: null,
      hubs: [],
      assistant: true,
    }),
    guides: () => ({ available: false, hubs: [] }),
    hubTree: () => null,
    refreshGuides: () => {},
    achievements: async () => null,
    find: async () => null,
    marks: async () => null,
    where: async () => null,
    progress: async () => null,
    ask: {
      origin: ORIGIN,
      allowed: () => true,
      admit: () => ({ ok: true }),
      start: (req, signal) =>
        agent.ask(
          {
            instructions: "I",
            statusBlock: "S",
            history: req.history,
            question: req.question,
            depth: req.depth,
            hub: req.hubId,
          },
          signal,
        ),
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
  companion = createServer((req, res) => void createHandler(deps)(req, res));
  await new Promise<void>((r) => companion.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(companion.address() as AddressInfo).port}/companion/api/ask`;
});

afterAll(async () => {
  agentServer.closeAllConnections();
  companion.closeAllConnections();
  await new Promise<void>((r) => agentServer.close(() => r()));
  await new Promise<void>((r) => companion.close(() => r()));
});

beforeEach(() => {
  agentRequests = 0;
  timers = [];
});

const post = (signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(valid),
    ...(signal ? { signal } : {}),
  });

const lines = (text: string): unknown[] =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);

describe("Ask through the agent", () => {
  it("streams the agent's validated events through as NDJSON", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        [
          { type: "lookup", label: "Read guide: Walkthrough" },
          { type: "search", query: "sample" },
          { type: "mystery" },
          { type: "ping" },
          { type: "text", text: "Go left." },
          { type: "done", truncatedGuide: false },
        ]
          .map((e) => `${JSON.stringify(e)}\n`)
          .join(""),
      );
    };
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(lines(await r.text())).toEqual([
      { type: "lookup", label: "Read guide: Walkthrough" },
      { type: "search", query: "sample" },
      { type: "text", text: "Go left." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("turns the agent's 429 into the companion's minute-limit 429", async () => {
    handle = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":"busy"}');
    };
    const r = await post();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(await r.json()).toEqual({ error: "rate limited", limit: "minute" });
  });

  it.each([401, 500, 503])(
    "answers 200 with one unavailable error for the agent's %i",
    async (s) => {
      handle = (_req, res) => {
        res.writeHead(s);
        res.end();
      };
      const r = await post();
      expect(r.status).toBe(200);
      expect(lines(await r.text())).toEqual([{ type: "error", message: AGENT_UNAVAILABLE }]);
    },
  );

  it("pings the browser while the agent stays silent", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
    };
    const ctrl = new AbortController();
    const r = await post(ctrl.signal);
    expect(r.status).toBe(200);
    expect(pending().map((t) => t.ms)).toEqual([15000]);
    pending()[0]?.fn();
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('{"type":"ping"}\n');
    ctrl.abort();
    await agentClosedEarly;
  });

  it("closes the agent request when the browser leaves mid-answer", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "text", text: "Go" })}\n`);
    };
    const ctrl = new AbortController();
    const r = await post(ctrl.signal);
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    ctrl.abort();
    await agentClosedEarly;
    expect(agentRequests).toBe(1);
  });

  it("closes the agent request when the browser leaves before the agent answers", async () => {
    handle = () => undefined;
    const ctrl = new AbortController();
    const done = post(ctrl.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(agentRequests).toBe(1));
    ctrl.abort();
    await done;
    await agentClosedEarly;
  });
});
