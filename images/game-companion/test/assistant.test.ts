import { describe, expect, it, vi } from "vitest";
import { buildMessages, type BuiltContext } from "../src/server/assistant-context.js";
import { Assistant, type StreamClient, type StreamEvent } from "../src/server/assistant.js";
import type { AskEvent, AskHistoryEntry } from "../src/shared/types.js";

const ctx: BuiltContext = { system: "SYSTEM TEXT", statusBlock: "STATUS", truncatedGuide: true };
const history: AskHistoryEntry[] = [{ question: "earlier q", answer: "earlier a" }];
const QUESTION = "where is the zorblax key";

const start = (type: string, index: number, extra: Record<string, unknown> = {}): StreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type, ...extra },
});
const delta = (index: number, d: Record<string, unknown>): StreamEvent => ({
  type: "content_block_delta",
  index,
  delta: d,
});
const stop = (index: number): StreamEvent => ({ type: "content_block_stop", index });
const text = (index: number, t: string): StreamEvent =>
  delta(index, { type: "text_delta", text: t });

interface Fake {
  client: StreamClient;
  calls: { params: Record<string, unknown>; signal: AbortSignal }[];
}

function fake(
  events: StreamEvent[],
  final: { stop_reason: string | null; usage: Record<string, unknown> } = {
    stop_reason: "end_turn",
    usage: {},
  },
  failAfter?: Error,
): Fake {
  const calls: Fake["calls"] = [];
  const client: StreamClient = {
    stream(params, opts) {
      calls.push({ params, signal: opts.signal });
      const iterable = {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
          if (failAfter) throw failAfter;
        },
        finalMessage: async () => final,
      };
      return iterable;
    },
  };
  return { client, calls };
}

function make(f: Fake, now: () => number = Date.now) {
  const log = vi.fn();
  return {
    log,
    assistant: new Assistant({ client: f.client, model: "m-1", effort: "low", log, now }),
  };
}

async function run(
  assistant: Assistant,
  signal: AbortSignal = new AbortController().signal,
): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of assistant.ask(ctx, history, QUESTION, "hint", signal)) out.push(e);
  return out;
}

describe("Assistant request", () => {
  it("sends the exact model parameters", async () => {
    const f = fake([]);
    await run(make(f).assistant);
    expect(f.calls).toHaveLength(1);
    const params = f.calls[0]!.params;
    expect(params).toEqual({
      model: "m-1",
      max_tokens: 8000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: "SYSTEM TEXT", cache_control: { type: "ephemeral" } }],
      messages: buildMessages(ctx, history, QUESTION, "hint"),
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("stream");
  });
});

describe("Assistant stream", () => {
  it("turns text deltas into text events and ends with done", async () => {
    const f = fake([start("text", 0), text(0, "Hel"), text(0, "lo"), stop(0)]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("ignores thinking deltas", async () => {
    const f = fake([
      start("thinking", 0),
      delta(0, { type: "thinking_delta", thinking: "secret musing" }),
      stop(0),
      start("text", 1),
      text(1, "Answer"),
      stop(1),
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: "Answer" },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("emits one search event per web_search block, at its stop", async () => {
    const f = fake([
      start("server_tool_use", 1, { name: "web_search" }),
      delta(1, { type: "input_json_delta", partial_json: '{"que' }),
      delta(1, { type: "input_json_delta", partial_json: 'ry": "zorblax key"}' }),
      stop(1),
      start("web_search_tool_result", 2),
      stop(2),
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "search", query: "zorblax key" },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("emits no search event when the query JSON is unparsable", async () => {
    const f = fake([
      start("server_tool_use", 1, { name: "web_search" }),
      delta(1, { type: "input_json_delta", partial_json: '{"query": ' }),
      stop(1),
    ]);
    expect(await run(make(f).assistant)).toEqual([{ type: "done", truncatedGuide: true }]);
  });

  it("appends a cut-short note on max_tokens, before done", async () => {
    const f = fake([start("text", 0), text(0, "Part"), stop(0)], {
      stop_reason: "max_tokens",
      usage: {},
    });
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: "Part" },
      { type: "text", text: "\n(answer cut short)" },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("reports a refusal as an error and no done", async () => {
    const f = fake([], { stop_reason: "refusal", usage: {} });
    expect(await run(make(f).assistant)).toEqual([
      { type: "error", message: "I can't help with that one." },
    ]);
  });

  it("reports a mid-stream failure as one generic error", async () => {
    const f = fake(
      [start("text", 0), text(0, "Hi")],
      undefined,
      new Error("upstream said: secret detail"),
    );
    const events = await run(make(f).assistant);
    expect(events).toEqual([
      { type: "text", text: "Hi" },
      { type: "error", message: "The assistant is unavailable right now. Try again in a minute." },
    ]);
  });
});

describe("Assistant abort", () => {
  it("passes the same signal and ends silently when aborted", async () => {
    const controller = new AbortController();
    const f = fake([start("text", 0), text(0, "Hi")], undefined, new Error("aborted"));
    const { assistant, log } = make(f);
    const out: AskEvent[] = [];
    for await (const e of assistant.ask(ctx, history, QUESTION, "hint", controller.signal)) {
      out.push(e);
      controller.abort();
    }
    expect(f.calls[0]!.signal).toBe(controller.signal);
    expect(out).toEqual([{ type: "text", text: "Hi" }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ stop: "aborted" });
  });

  it("logs stop: aborted when the consumer stops early after an abort", async () => {
    const controller = new AbortController();
    const f = fake([start("text", 0), text(0, "Hi"), text(0, " there"), stop(0)], {
      stop_reason: "end_turn",
      usage: {},
    });
    const { assistant, log } = make(f);
    const gen = assistant.ask(ctx, history, QUESTION, "hint", controller.signal);
    expect(await gen.next()).toEqual({ done: false, value: { type: "text", text: "Hi" } });
    controller.abort();
    await gen.return(undefined);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ stop: "aborted" });
  });
});

describe("Assistant logging", () => {
  it("logs one ask line with counts and no question, history or answer text", async () => {
    let t = 1000;
    const f = fake(
      [
        start("server_tool_use", 0, { name: "web_search" }),
        delta(0, { type: "input_json_delta", partial_json: '{"query":"a web query"}' }),
        stop(0),
        start("server_tool_use", 1, { name: "web_search" }),
        delta(1, { type: "input_json_delta", partial_json: '{"query":"another"}' }),
        stop(1),
        start("text", 2),
        text(2, "The ANSWERTEXT is here"),
        stop(2),
      ],
      {
        stop_reason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      },
    );
    const { assistant, log } = make(f, () => (t += 250));
    await run(assistant);
    expect(log).toHaveBeenCalledTimes(1);
    const call = log.mock.calls[0] as [string, Record<string, unknown>];
    const [msg, extra] = call;
    expect(msg).toBe("ask");
    expect(extra).toEqual({
      model: "m-1",
      ms: 250,
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
      searches: 2,
      stop: "end_turn",
    });
    const dump = JSON.stringify(log.mock.calls);
    for (const secret of [QUESTION, "earlier q", "earlier a", "ANSWERTEXT", "a web query"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("logs the error name, never the upstream text, after a failure", async () => {
    class UpstreamBoom extends Error {
      override name = "UpstreamBoom";
    }
    const f = fake([], undefined, new UpstreamBoom("api key sk-secret rejected"));
    const { assistant, log } = make(f);
    await run(assistant);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ error: "UpstreamBoom" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret");
  });

  it("logs the SDK error's class name and status, never its message", async () => {
    // Like SDK 0.135.0's error classes: no `name` of its own, a numeric `status`.
    class AuthenticationError extends Error {
      readonly status = 401;
    }
    const f = fake([], undefined, new AuthenticationError("invalid x-api-key sk-secret"));
    const { assistant, log } = make(f);
    await run(assistant);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ error: "AuthenticationError", status: 401 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret");
  });
});
