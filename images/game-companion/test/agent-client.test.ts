import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_UNAVAILABLE,
  AgentClient,
  type AgentReply,
  type AgentRequest,
} from "../src/server/agent-client.js";
import type { AskEvent } from "../src/shared/types.js";

const TOKEN = "sample-agent-token";
const QUESTION = "Where is the sample key?";

const body: AgentRequest = {
  instructions: "INSTRUCTIONS",
  statusBlock: "Game: Sample Quest (Steam)",
  history: [{ question: "Q1", answer: "A1" }],
  question: QUESTION,
  depth: "hint",
  hub: "h1",
};

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
  /** Resolves when the companion closes the connection before the agent ended the response. */
  closedEarly: Promise<void>;
}

/** What the fake agent does with each request. */
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let seen: Seen[];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (raw += d));
    req.on("end", () => {
      const closedEarly = new Promise<void>((resolve) => {
        res.on("close", () => {
          if (!res.writableFinished) resolve();
        });
      });
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw, closedEarly });
      handle(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  handle = (_req, res) => ndjson(res, [{ type: "done", truncatedGuide: false }]);
});

function ndjson(res: ServerResponse, lines: unknown[]): void {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.end(lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join(""));
}

const client = (over: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) => {
  const log = vi.fn();
  return { log, agent: new AgentClient({ url: base, token: TOKEN, log, ...over }) };
};

async function collect(reply: AgentReply): Promise<AskEvent[] | "busy"> {
  if (reply === "busy") return "busy";
  const out: AskEvent[] = [];
  for await (const e of reply) out.push(e);
  return out;
}

const run = async (agent: AgentClient, signal = new AbortController().signal) =>
  collect(await agent.ask(body, signal));

const unavailable: AskEvent[] = [{ type: "error", message: AGENT_UNAVAILABLE }];

describe("AgentClient request", () => {
  it("posts the question to /ask with the bearer token and exactly the agreed fields", async () => {
    await run(client({ url: `${base}/` }).agent);
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/ask");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers.cookie).toBeUndefined();
    const sent = JSON.parse(req?.body ?? "") as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "depth",
      "history",
      "hub",
      "instructions",
      "question",
      "statusBlock",
    ]);
    expect(sent).toEqual(body);
  });

  it("forwards the researched depth", async () => {
    const { agent } = client();
    await collect(await agent.ask({ ...body, depth: "researched" }, new AbortController().signal));
    expect((JSON.parse(seen[0]?.body ?? "") as AgentRequest).depth).toBe("researched");
  });

  it("sends a null hub as null", async () => {
    const { agent } = client();
    await collect(await agent.ask({ ...body, hub: null }, new AbortController().signal));
    expect((JSON.parse(seen[0]?.body ?? "") as AgentRequest).hub).toBeNull();
  });
});

describe("AgentClient stream", () => {
  it("passes every known event type through, in order, and drops the agent's pings", async () => {
    handle = (_req, res) =>
      ndjson(res, [
        { type: "lookup", label: "Searched your guide: sample key" },
        { type: "ping" },
        { type: "search", query: "sample key location" },
        { type: "text", text: "Under the " },
        { type: "text", text: "mat." },
        { type: "done", truncatedGuide: false },
      ]);
    expect(await run(client().agent)).toEqual([
      { type: "lookup", label: "Searched your guide: sample key" },
      { type: "search", query: "sample key location" },
      { type: "text", text: "Under the " },
      { type: "text", text: "mat." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("passes an error event through and ends there", async () => {
    handle = (_req, res) =>
      ndjson(res, [
        { type: "text", text: "Partly" },
        { type: "error", message: "I can't help with that one." },
        { type: "text", text: "after the end" },
      ]);
    expect(await run(client().agent)).toEqual([
      { type: "text", text: "Partly" },
      { type: "error", message: "I can't help with that one." },
    ]);
  });

  it("drops unknown types, malformed lines and wrong field types, and strips extra keys", async () => {
    handle = (_req, res) =>
      ndjson(res, [
        "not json",
        "[1,2]",
        "null",
        '"text"',
        { type: "thinking", text: "hmm" },
        { text: "no type" },
        { type: "text", text: 5 },
        { type: "search" },
        { type: "lookup", label: null },
        { type: "error" },
        { type: "text", text: "Go left.", secret: "dropped" },
        "",
        { type: "done", truncatedGuide: false, extra: 1 },
      ]);
    expect(await run(client().agent)).toEqual([
      { type: "text", text: "Go left." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("accepts a bare done, so a finished answer ends cleanly", async () => {
    handle = (_req, res) => ndjson(res, [{ type: "text", text: "Go left." }, { type: "done" }]);
    expect(await run(client().agent)).toEqual([
      { type: "text", text: "Go left." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("passes truncatedGuide true through, and reads anything but true as false", async () => {
    handle = (_req, res) => ndjson(res, [{ type: "done", truncatedGuide: true }]);
    expect(await run(client().agent)).toEqual([{ type: "done", truncatedGuide: true }]);
    for (const value of ["yes", 1, null, {}]) {
      handle = (_req, res) => ndjson(res, [{ type: "done", truncatedGuide: value }]);
      expect(await run(client().agent)).toEqual([{ type: "done", truncatedGuide: false }]);
    }
  });

  it("joins lines split across chunks and reads a last line without a newline", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"text","te');
      setTimeout(() => {
        res.write('xt":"café"}\n{"type":"done",');
        setTimeout(() => res.end('"truncatedGuide":false}'), 10);
      }, 10);
    };
    expect(await run(client().agent)).toEqual([
      { type: "text", text: "café" },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("ends with the unavailable error when the agent stops without done or error", async () => {
    handle = (_req, res) => ndjson(res, [{ type: "text", text: "Half an" }]);
    expect(await run(client().agent)).toEqual([{ type: "text", text: "Half an" }, ...unavailable]);
  });

  it("ends with the unavailable error when the agent connection breaks mid-stream", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "text", text: "Half" })}\n`);
      setTimeout(() => res.destroy(), 20);
    };
    expect(await run(client().agent)).toEqual([{ type: "text", text: "Half" }, ...unavailable]);
  });

  it("keeps waiting for a slow stream once the headers have arrived", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      setTimeout(() => res.end(`${JSON.stringify({ type: "done", truncatedGuide: false })}\n`), 80);
    };
    expect(await run(client({ headersTimeoutMs: 30 }).agent)).toEqual([
      { type: "done", truncatedGuide: false },
    ]);
  });
});

describe("AgentClient failures", () => {
  it("answers busy for the agent's 429", async () => {
    handle = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
    };
    expect(await run(client().agent)).toBe("busy");
  });

  it.each([401, 403, 500, 502, 503])(
    "answers the unavailable error for status %i",
    async (status) => {
      handle = (_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "x" }));
      };
      expect(await run(client().agent)).toEqual(unavailable);
    },
  );

  it("answers the unavailable error when the agent cannot be reached", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await run(client({ url: `http://127.0.0.1:${port}` }).agent)).toEqual(unavailable);
  });

  it("gives up, and closes the request, when the headers do not come in time", async () => {
    handle = () => undefined;
    expect(await run(client({ headersTimeoutMs: 40 }).agent)).toEqual(unavailable);
    await seen[0]?.closedEarly;
  });

  it("defaults the response-headers timeout to 20 seconds, cancelled once they arrive", async () => {
    const cancel = vi.fn();
    const setTimer = vi.fn((_fn: () => void, _ms: number) => cancel);
    expect(await run(client({ setTimer }).agent)).toEqual([
      { type: "done", truncatedGuide: false },
    ]);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(20_000);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("AgentClient abort", () => {
  it("aborts the upstream request when the caller aborts before the headers", async () => {
    handle = () => undefined;
    const controller = new AbortController();
    const pending = client().agent.ask(body, controller.signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    expect(await collect(await pending)).toEqual([]);
    await seen[0]?.closedEarly;
  });

  it("aborts the upstream request when the caller aborts mid-stream, with no error event", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "text", text: "Go" })}\n`);
    };
    const controller = new AbortController();
    const reply = await client().agent.ask(body, controller.signal);
    if (reply === "busy") throw new Error("unexpected busy");
    const out: AskEvent[] = [];
    for await (const e of reply) {
      out.push(e);
      controller.abort();
    }
    expect(out).toEqual([{ type: "text", text: "Go" }]);
    await seen[0]?.closedEarly;
  });
});

describe("AgentClient logging", () => {
  it("logs one line per question with the outcome, never the question or answer text", async () => {
    handle = (_req, res) =>
      ndjson(res, [
        { type: "search", query: "secret query" },
        { type: "text", text: "secret answer" },
        { type: "done", truncatedGuide: false },
      ]);
    const { agent, log } = client();
    await run(agent);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("ask");
    expect(log.mock.calls[0]?.[1]).toMatchObject({ outcome: "done" });
    const line = JSON.stringify(log.mock.calls);
    for (const secret of [QUESTION, "secret query", "secret answer", TOKEN, "Q1", "A1"]) {
      expect(line).not.toContain(secret);
    }
  });

  it.each([
    ["busy", 429, { outcome: "busy", status: 429 }],
    ["a server error", 500, { outcome: "unavailable", status: 500 }],
  ] as const)("logs %s with its status", async (_name, status, expected) => {
    handle = (_req, res) => {
      res.writeHead(status);
      res.end();
    };
    const { agent, log } = client();
    await run(agent);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toMatchObject(expected);
  });

  it("logs an aborted question as aborted", async () => {
    handle = () => undefined;
    const controller = new AbortController();
    const { agent, log } = client();
    const pending = agent.ask(body, controller.signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await collect(await pending);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toMatchObject({ outcome: "aborted" });
  });
});
