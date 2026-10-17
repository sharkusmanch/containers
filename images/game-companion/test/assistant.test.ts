import { describe, expect, it, vi } from "vitest";
import { buildMessages, type BuiltContext } from "../src/server/assistant-context.js";
import {
  Assistant,
  type GuideToolRunner,
  type StreamClient,
  type StreamEvent,
} from "../src/server/assistant.js";
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
/** Longer than the 280 characters held back as possible narration, so it streams live. */
const LONG = "The zorblax key is under the third bridge. ".repeat(7).trimEnd();

interface Final {
  stop_reason: string | null;
  usage: Record<string, unknown>;
  content: unknown[];
  container?: { id?: unknown } | null;
}

interface Round {
  events: StreamEvent[];
  final?: Partial<Final>;
  failAfter?: Error;
  /** Runs after the round's events are consumed, before it ends. */
  after?: () => void;
}

interface Fake {
  client: StreamClient;
  calls: { params: Record<string, unknown>; signal: AbortSignal }[];
}

/** A client that plays one scripted round per request; a request past the script fails the test. */
function scripted(rounds: Round[]): Fake {
  const calls: Fake["calls"] = [];
  const client: StreamClient = {
    stream(params, opts) {
      const round = rounds[calls.length];
      calls.push({ params, signal: opts.signal });
      if (!round) throw new Error(`unexpected request ${calls.length}`);
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of round.events) yield e;
          round.after?.();
          if (round.failAfter) throw round.failAfter;
        },
        finalMessage: async () => ({
          stop_reason: "end_turn",
          usage: {},
          content: [],
          ...round.final,
        }),
      };
    },
  };
  return { client, calls };
}

function fake(
  events: StreamEvent[],
  final: { stop_reason: string | null; usage: Record<string, unknown> } = {
    stop_reason: "end_turn",
    usage: {},
  },
  failAfter?: Error,
): Fake {
  return scripted([{ events, final, ...(failAfter ? { failAfter } : {}) }]);
}

interface FakeGuide extends GuideToolRunner {
  ran: unknown[][];
}

function fakeGuide(): FakeGuide {
  const ran: unknown[][] = [];
  return {
    ran,
    search(query) {
      ran.push(["search", query]);
      return `RESULTS FOR ${query}`;
    },
    read(page, section) {
      ran.push(["read", page, section]);
      if (page === "Missing")
        return { text: "No page called Missing.", label: "Read guide: Missing", ok: false };
      return {
        text: `TEXT OF ${page}`,
        label: section === undefined ? `Read guide: ${page}` : `Read guide: ${page} › ${section}`,
        ok: true,
      };
    },
  };
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
  guide: GuideToolRunner = fakeGuide(),
): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of assistant.ask(ctx, history, QUESTION, "hint", signal, guide)) out.push(e);
  return out;
}

const TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 8000 },
  {
    name: "search_guide",
    description:
      "Search every page of the player's guide for a word or short phrase (a place, item, enemy or character name works best). Returns matching lines with their page and section.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_guide_page",
    description:
      "Read one page of the player's guide, or only one section of it. Use the page and section names from the guide outline.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { page: { type: "string" }, section: { type: "string" } },
      required: ["page"],
      additionalProperties: false,
    },
  },
];

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
      tools: TOOLS,
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
      [start("text", 0), text(0, LONG)],
      undefined,
      new Error("upstream said: secret detail"),
    );
    const events = await run(make(f).assistant);
    expect(events).toEqual([
      { type: "text", text: LONG },
      { type: "error", message: "The assistant is unavailable right now. Try again in a minute." },
    ]);
  });
});

describe("Assistant abort", () => {
  it("passes the same signal and ends silently when aborted", async () => {
    const controller = new AbortController();
    const f = fake([start("text", 0), text(0, LONG)], undefined, new Error("aborted"));
    const { assistant, log } = make(f);
    const out: AskEvent[] = [];
    for await (const e of assistant.ask(
      ctx,
      history,
      QUESTION,
      "hint",
      controller.signal,
      fakeGuide(),
    )) {
      out.push(e);
      controller.abort();
    }
    expect(f.calls[0]!.signal).toBe(controller.signal);
    expect(out).toEqual([{ type: "text", text: LONG }]);
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
    const gen = assistant.ask(ctx, history, QUESTION, "hint", controller.signal, fakeGuide());
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
      rounds: 1,
      guideCalls: 0,
      lookups: 0,
      fetches: 0,
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

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const toolUse = (index: number, c: Call): StreamEvent[] => [
  start("tool_use", index, { id: c.id, name: c.name, input: {} }),
  delta(index, { type: "input_json_delta", partial_json: JSON.stringify(c.input) }),
  stop(index),
];

/** A round that stops with tool_use for `calls`, whose final content is exactly those blocks. */
function toolRound(calls: Call[], usage: Record<string, unknown> = {}): Round {
  return {
    events: calls.flatMap((c, i) => toolUse(i, c)),
    final: {
      stop_reason: "tool_use",
      usage,
      content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    },
  };
}

const answer = (t: string, usage: Record<string, unknown> = {}): Round => ({
  events: [start("text", 0), text(0, t), stop(0)],
  final: { stop_reason: "end_turn", usage, content: [{ type: "text", text: t }] },
});

const search = (id: string, query: string): Call => ({
  id,
  name: "search_guide",
  input: { query },
});

const LIMIT = "Lookup limit reached; answer with what you have.";
const TOO_MANY = "That needed too many lookups. Try a narrower question.";

describe("Assistant tool loop", () => {
  it("runs both guide tools, appends the round's content unchanged and the results, then answers", async () => {
    const round1Content = [
      { type: "thinking", thinking: "musing", signature: "sig-1" },
      { type: "tool_use", id: "tu_1", name: "search_guide", input: { query: "zorblax" } },
      {
        type: "tool_use",
        id: "tu_2",
        name: "read_guide_page",
        input: { page: "Bestiary", section: "Bats" },
      },
    ];
    const f = scripted([
      {
        events: [
          start("thinking", 0),
          delta(0, { type: "thinking_delta", thinking: "musing" }),
          stop(0),
          ...toolUse(1, search("tu_1", "zorblax")),
          ...toolUse(2, {
            id: "tu_2",
            name: "read_guide_page",
            input: { page: "Bestiary", section: "Bats" },
          }),
        ],
        final: { stop_reason: "tool_use", usage: {}, content: round1Content },
      },
      answer("Answer"),
    ]);
    const guide = fakeGuide();
    const events = await run(make(f).assistant, undefined, guide);
    expect(events).toEqual([
      { type: "lookup", label: "Searched your guide: zorblax" },
      { type: "lookup", label: "Read guide: Bestiary › Bats" },
      { type: "text", text: "Answer" },
      { type: "done", truncatedGuide: true },
    ]);
    expect(guide.ran).toEqual([
      ["search", "zorblax"],
      ["read", "Bestiary", "Bats"],
    ]);
    expect(f.calls).toHaveLength(2);
    const original = buildMessages(ctx, history, QUESTION, "hint");
    expect(f.calls[0]!.params.messages).toEqual(original);
    const messages = f.calls[1]!.params.messages as { role: string; content: unknown }[];
    expect(messages).toEqual([
      ...original,
      { role: "assistant", content: round1Content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "RESULTS FOR zorblax" },
          { type: "tool_result", tool_use_id: "tu_2", content: "TEXT OF Bestiary" },
        ],
      },
    ]);
    expect(messages[original.length]!.content).toBe(round1Content);
    const withoutMessages = (params: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(params).filter(([k]) => k !== "messages"));
    expect(withoutMessages(f.calls[1]!.params)).toEqual(withoutMessages(f.calls[0]!.params));
    expect(f.calls[1]!.params.tools).toEqual(TOOLS);
  });

  it("marks failed reads and invalid inputs as errors, running nothing for invalid input", async () => {
    const f = scripted([
      toolRound([
        { id: "a", name: "read_guide_page", input: { page: "Missing" } },
        { id: "b", name: "search_guide", input: {} },
        { id: "c", name: "read_guide_page", input: { page: 5 } },
        { id: "d", name: "read_guide_page", input: { page: "Maps", section: 2 } },
      ]),
      answer("ok"),
    ]);
    const guide = fakeGuide();
    const { assistant, log } = make(f);
    const events = await run(assistant, undefined, guide);
    expect(log.mock.calls[0]![1]).toMatchObject({ guideCalls: 4, lookups: 1 });
    expect(guide.ran).toEqual([["read", "Missing", undefined]]);
    expect(events).toEqual([
      { type: "lookup", label: "Read guide: Missing" },
      { type: "text", text: "ok" },
      { type: "done", truncatedGuide: true },
    ]);
    const results = (f.calls[1]!.params.messages as { content: unknown }[]).at(-1)!.content as {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[];
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
      ["d", true],
    ]);
    expect(results[0]!.content).toBe("No page called Missing.");
    for (const r of results.slice(1)) expect(typeof r.content).toBe("string");
  });

  it("continues a pause_turn round with the assistant content and no user message", async () => {
    const paused = [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
    ];
    const f = scripted([
      {
        events: [
          start("server_tool_use", 0, { name: "web_search" }),
          delta(0, { type: "input_json_delta", partial_json: '{"query":"zorblax lore"}' }),
          stop(0),
        ],
        final: { stop_reason: "pause_turn", usage: {}, content: paused },
      },
      answer("Done"),
    ]);
    const events = await run(make(f).assistant);
    expect(events).toEqual([
      { type: "search", query: "zorblax lore" },
      { type: "text", text: "Done" },
      { type: "done", truncatedGuide: true },
    ]);
    const original = buildMessages(ctx, history, QUESTION, "hint");
    const messages = f.calls[1]!.params.messages as { content: unknown }[];
    expect(messages).toEqual([...original, { role: "assistant", content: paused }]);
    expect(messages.at(-1)!.content).toBe(paused);
  });

  it("treats tool_use with only server tool blocks as the end of the answer", async () => {
    const f = scripted([
      {
        events: [start("text", 0), text(0, "Hi"), stop(0)],
        final: {
          stop_reason: "tool_use",
          usage: {},
          content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }],
        },
      },
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: "Hi" },
      { type: "done", truncatedGuide: true },
    ]);
    expect(f.calls).toHaveLength(1);
  });

  it("answers the 7th guide call with the limit error and keeps going", async () => {
    const f = scripted([
      toolRound([search("1", "q1"), search("2", "q2"), search("3", "q3"), search("4", "q4")]),
      toolRound([
        search("5", "q5"),
        { id: "6", name: "read_guide_page", input: { page: "P6" } },
        search("7", "q7"),
      ]),
      toolRound([search("8", "q8")]),
      answer("Final"),
    ]);
    const guide = fakeGuide();
    const { assistant, log } = make(f);
    const events = await run(assistant, undefined, guide);
    expect(guide.ran).toHaveLength(6);
    expect(events.filter((e) => e.type === "lookup")).toHaveLength(6);
    expect(events.at(-1)).toEqual({ type: "done", truncatedGuide: true });
    const results = (call: number) =>
      (f.calls[call]!.params.messages as { content: unknown }[]).at(-1)!.content;
    expect(results(2)).toEqual([
      { type: "tool_result", tool_use_id: "5", content: "RESULTS FOR q5" },
      { type: "tool_result", tool_use_id: "6", content: "TEXT OF P6" },
      { type: "tool_result", tool_use_id: "7", content: LIMIT, is_error: true },
    ]);
    expect(results(3)).toEqual([
      { type: "tool_result", tool_use_id: "8", content: LIMIT, is_error: true },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ rounds: 4, guideCalls: 8, lookups: 6 });
  });

  it("never sends a 9th request: ends with the too-many-lookups error", async () => {
    const rounds: Round[] = [];
    for (let i = 0; i < 9; i += 1) {
      rounds.push(
        i % 2 === 0
          ? toolRound([search(`t${i}`, `q${i}`)])
          : { events: [], final: { stop_reason: "pause_turn", usage: {}, content: [] } },
      );
    }
    const f = scripted(rounds);
    const { assistant, log } = make(f);
    const events = await run(assistant);
    expect(f.calls).toHaveLength(8);
    expect(events.at(-1)).toEqual({ type: "error", message: TOO_MANY });
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ rounds: 8, lookups: 4, stop: "max_rounds" });
  });

  it("ends at an 8th round that asks for guide tools without running them", async () => {
    const rounds: Round[] = [];
    for (let i = 0; i < 7; i += 1) {
      rounds.push({ events: [], final: { stop_reason: "pause_turn", usage: {}, content: [] } });
    }
    rounds.push(toolRound([search("late", "late query")]));
    const f = scripted(rounds);
    const guide = fakeGuide();
    const { assistant, log } = make(f);
    const events = await run(assistant, undefined, guide);
    expect(f.calls).toHaveLength(8);
    expect(guide.ran).toEqual([]);
    expect(events).toEqual([{ type: "error", message: TOO_MANY }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({
      rounds: 8,
      guideCalls: 0,
      lookups: 0,
      stop: "max_rounds",
    });
  });
});

describe("Assistant text across rounds", () => {
  const textThenTool = (t: string): Round => {
    const round = toolRound([search("1", "q")]);
    return {
      ...round,
      events: [start("text", 0), text(0, t), stop(0), ...toolUse(1, search("1", "q"))],
    };
  };

  it("separates a later round's text from earlier text that ends mid-line", async () => {
    const f = scripted([
      textThenTool(LONG),
      {
        events: [start("text", 0), text(0, "Found"), text(0, " it"), stop(0)],
        final: { stop_reason: "end_turn", usage: {}, content: [] },
      },
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: LONG },
      { type: "lookup", label: "Searched your guide: q" },
      { type: "text", text: "\n\n" },
      { type: "text", text: "Found" },
      { type: "text", text: " it" },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("adds no separator after whitespace or when nothing was streamed before", async () => {
    const afterSpace = scripted([textThenTool(`${LONG}\n`), answer("Found it")]);
    expect((await run(make(afterSpace).assistant)).filter((e) => e.type === "text")).toEqual([
      { type: "text", text: `${LONG}\n` },
      { type: "text", text: "Found it" },
    ]);
    const silent = scripted([toolRound([search("1", "q")]), answer("Found it")]);
    expect((await run(make(silent).assistant)).filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "Found it" },
    ]);
  });
});

const CALLER = { type: "code_execution_20260120", tool_id: "srv_code" };

/** A code_execution block whose code calls the web tools (input streamed as JSON). */
const codeExecution = (index: number): StreamEvent[] => [
  start("server_tool_use", index, { id: "srv_code", name: "code_execution", input: {} }),
  delta(index, { type: "input_json_delta", partial_json: '{"code":"web_search(q)"}' }),
  stop(index),
];

/** A web_search called from code: its whole input is in the start event, no JSON deltas. */
const nestedSearch = (index: number, query: string): StreamEvent[] => [
  start("server_tool_use", index, {
    id: `srv_${index}`,
    name: "web_search",
    input: { query },
    caller: CALLER,
  }),
  stop(index),
];

describe("Assistant per-question web budget", () => {
  const SPENT =
    "Web lookups for this question are used up (3 searches, 2 pages). Answer from the guide and what you already found.";

  /** A tool_use round that first runs `searches` web searches and `fetches` web fetches. */
  function webRound(searches: number, fetches: number, call: Call): Round {
    const events: StreamEvent[] = [];
    let i = 0;
    for (let n = 0; n < searches; n += 1, i += 1) {
      events.push(
        start("server_tool_use", i, { name: "web_search" }),
        delta(i, { type: "input_json_delta", partial_json: `{"query":"w${i}"}` }),
        stop(i),
      );
    }
    for (let n = 0; n < fetches; n += 1, i += 1) {
      events.push(
        start("server_tool_use", i, { name: "web_fetch" }),
        delta(i, {
          type: "input_json_delta",
          partial_json: `{"url":"https://h${i}.example.test/"}`,
        }),
        stop(i),
      );
    }
    events.push(...toolUse(i, call));
    return {
      events,
      final: {
        stop_reason: "tool_use",
        usage: {},
        content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
      },
    };
  }

  const lastContent = (f: Fake, call: number) =>
    (f.calls[call]!.params.messages as { content: unknown }[]).at(-1)!.content;

  it("adds no note while under budget", async () => {
    const f = scripted([
      webRound(2, 1, search("1", "a")),
      webRound(0, 0, search("2", "b")),
      answer("ok"),
    ]);
    await run(make(f).assistant);
    expect(lastContent(f, 1)).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "RESULTS FOR a" },
    ]);
    expect(lastContent(f, 2)).toEqual([
      { type: "tool_result", tool_use_id: "2", content: "RESULTS FOR b" },
    ]);
  });

  it("adds the note after the tool results once 3 searches ran, and on every later round", async () => {
    const f = scripted([
      webRound(3, 0, search("1", "a")),
      webRound(0, 0, search("2", "b")),
      answer("ok"),
    ]);
    await run(make(f).assistant);
    expect(lastContent(f, 1)).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "RESULTS FOR a" },
      { type: "text", text: SPENT },
    ]);
    expect(lastContent(f, 2)).toEqual([
      { type: "tool_result", tool_use_id: "2", content: "RESULTS FOR b" },
      { type: "text", text: SPENT },
    ]);
    for (const call of f.calls) expect(call.params.tools).toEqual(TOOLS);
  });

  it("adds the note once 2 pages were opened across rounds, keeping the tools unchanged", async () => {
    const f = scripted([
      webRound(1, 1, search("1", "a")),
      webRound(0, 1, search("2", "b")),
      answer("ok"),
    ]);
    await run(make(f).assistant);
    expect(lastContent(f, 1)).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "RESULTS FOR a" },
    ]);
    expect(lastContent(f, 2)).toEqual([
      { type: "tool_result", tool_use_id: "2", content: "RESULTS FOR b" },
      { type: "text", text: SPENT },
    ]);
    expect(f.calls[2]!.params.tools).toEqual(f.calls[0]!.params.tools);
    expect(f.calls[2]!.params.tools).toEqual(TOOLS);
  });

  it("counts web searches made from code, whose input arrives whole at block start", async () => {
    const f = scripted([
      {
        events: [
          ...codeExecution(0),
          ...nestedSearch(1, "n1"),
          ...nestedSearch(2, "n2"),
          ...nestedSearch(3, "n3"),
          ...toolUse(4, search("1", "a")),
        ],
        final: {
          stop_reason: "tool_use",
          usage: {},
          content: [{ type: "tool_use", id: "1", name: "search_guide", input: { query: "a" } }],
        },
      },
      answer("ok"),
    ]);
    const { assistant, log } = make(f);
    const events = await run(assistant);
    expect(events.filter((e) => e.type === "search")).toEqual([
      { type: "search", query: "n1" },
      { type: "search", query: "n2" },
      { type: "search", query: "n3" },
    ]);
    expect(lastContent(f, 1)).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "RESULTS FOR a" },
      { type: "text", text: SPENT },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ searches: 3 });
  });
});

describe("Assistant tool loop abort", () => {
  it("aborted during round 2: no round 3, no tool run after the abort", async () => {
    const controller = new AbortController();
    const f = scripted([
      toolRound([search("1", "first")]),
      {
        events: [start("text", 0), text(0, LONG), stop(0), ...toolUse(1, search("2", "x"))],
        final: {
          stop_reason: "tool_use",
          usage: {},
          content: [{ type: "tool_use", id: "2", name: "search_guide", input: { query: "x" } }],
        },
      },
      answer("never"),
    ]);
    const guide = fakeGuide();
    const { assistant, log } = make(f);
    const out: AskEvent[] = [];
    for await (const e of assistant.ask(ctx, history, QUESTION, "hint", controller.signal, guide)) {
      out.push(e);
      if (e.type === "text") controller.abort();
    }
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.signal).toBe(controller.signal);
    expect(guide.ran).toEqual([["search", "first"]]);
    expect(out).toEqual([
      { type: "lookup", label: "Searched your guide: first" },
      { type: "text", text: LONG },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ stop: "aborted", rounds: 2 });
  });

  it("aborted between tool calls: runs no further tool and starts no new round", async () => {
    const controller = new AbortController();
    const f = scripted([toolRound([search("1", "a"), search("2", "b")]), answer("never")]);
    const guide = fakeGuide();
    const { assistant, log } = make(f);
    const out: AskEvent[] = [];
    for await (const e of assistant.ask(ctx, history, QUESTION, "hint", controller.signal, guide)) {
      out.push(e);
      controller.abort();
    }
    expect(guide.ran).toEqual([["search", "a"]]);
    expect(f.calls).toHaveLength(1);
    expect(out).toEqual([{ type: "lookup", label: "Searched your guide: a" }]);
    expect(log.mock.calls[0]![1]).toMatchObject({ stop: "aborted" });
  });

  it("aborted after the tools ran: starts no new round", async () => {
    const controller = new AbortController();
    const guide = fakeGuide();
    const abortingGuide: GuideToolRunner = {
      search: (q) => {
        const r = guide.search(q);
        controller.abort();
        return r;
      },
      read: (page, section) => guide.read(page, section),
    };
    const f = scripted([toolRound([search("1", "a")]), answer("never")]);
    const { assistant, log } = make(f);
    const out: AskEvent[] = [];
    for await (const e of assistant.ask(
      ctx,
      history,
      QUESTION,
      "hint",
      controller.signal,
      abortingGuide,
    )) {
      out.push(e);
    }
    expect(f.calls).toHaveLength(1);
    expect(out.some((e) => e.type === "done" || e.type === "error")).toBe(false);
    expect(log.mock.calls[0]![1]).toMatchObject({ stop: "aborted" });
  });
});

describe("Assistant web fetch", () => {
  it("shows the host of each opened page and counts every fetch", async () => {
    const f = scripted([
      {
        events: [
          start("server_tool_use", 0, { name: "web_fetch" }),
          delta(0, {
            type: "input_json_delta",
            partial_json: '{"url":"https://wiki.example.test/zorblax?x=1"}',
          }),
          stop(0),
          start("web_fetch_tool_result", 1),
          stop(1),
          start("server_tool_use", 2, { name: "web_fetch" }),
          delta(2, { type: "input_json_delta", partial_json: '{"url":"not a url"}' }),
          stop(2),
          start("text", 3),
          text(3, "Found it"),
          stop(3),
        ],
      },
    ]);
    const { assistant, log } = make(f);
    expect(await run(assistant)).toEqual([
      { type: "lookup", label: "Opened: wiki.example.test" },
      { type: "text", text: "Found it" },
      { type: "done", truncatedGuide: true },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ fetches: 2, searches: 0 });
  });
});

describe("Assistant tool loop logging", () => {
  it("sums usage over rounds and logs counts, never query, page, URL or answer text", async () => {
    const f = scripted([
      {
        events: [
          start("server_tool_use", 0, { name: "web_search" }),
          delta(0, { type: "input_json_delta", partial_json: '{"query":"SEARCHTEXT"}' }),
          stop(0),
          start("server_tool_use", 1, { name: "web_fetch" }),
          delta(1, {
            type: "input_json_delta",
            partial_json: '{"url":"https://urlhost.example.test/URLPATH"}',
          }),
          stop(1),
          ...toolUse(2, search("1", "QUERYTEXT")),
          ...toolUse(3, { id: "2", name: "read_guide_page", input: { page: "PAGETEXT" } }),
        ],
        final: {
          stop_reason: "tool_use",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 40,
          },
          content: [
            { type: "tool_use", id: "1", name: "search_guide", input: { query: "QUERYTEXT" } },
            { type: "tool_use", id: "2", name: "read_guide_page", input: { page: "PAGETEXT" } },
          ],
        },
      },
      answer("ANSWERTEXT", {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    ]);
    let t = 0;
    const { assistant, log } = make(f, () => (t += 100));
    await run(assistant);
    expect(log).toHaveBeenCalledTimes(1);
    const [msg, extra] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("ask");
    expect(extra).toEqual({
      model: "m-1",
      ms: 100,
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
      searches: 1,
      rounds: 2,
      guideCalls: 2,
      lookups: 2,
      fetches: 1,
      stop: "end_turn",
    });
    const dump = JSON.stringify(log.mock.calls);
    for (const secret of [
      QUESTION,
      "SEARCHTEXT",
      "urlhost",
      "URLPATH",
      "QUERYTEXT",
      "PAGETEXT",
      "ANSWERTEXT",
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("Assistant code-execution container", () => {
  const withContainer = (round: Round, id: string): Round => ({
    ...round,
    final: { ...round.final, container: { id, expires_at: "2026-10-16T23:00:00Z" } as never },
  });

  it("sends the container a tool round ran in on the next round only", async () => {
    const f = scripted([withContainer(toolRound([search("1", "a")]), "cont_1"), answer("ok")]);
    await run(make(f).assistant);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.params).not.toHaveProperty("container");
    expect(f.calls[1]!.params.container).toBe("cont_1");
  });

  it("carries the container through a pause_turn continuation and keeps the latest id", async () => {
    const paused: Round = {
      events: [],
      final: { stop_reason: "pause_turn", usage: {}, content: [] },
    };
    const f = scripted([
      withContainer(paused, "cont_1"),
      paused,
      withContainer(paused, "cont_2"),
      answer("ok"),
    ]);
    await run(make(f).assistant);
    expect(f.calls.map((c) => c.params.container)).toEqual([
      undefined,
      "cont_1",
      "cont_1",
      "cont_2",
    ]);
  });

  it("never carries a container into the next question", async () => {
    const f = scripted([
      withContainer(toolRound([search("1", "a")]), "cont_1"),
      answer("first"),
      answer("second"),
    ]);
    const { assistant } = make(f);
    await run(assistant);
    await run(assistant);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.params).not.toHaveProperty("container");
  });

  it("sends no container when no round reports one", async () => {
    const f = scripted([toolRound([search("1", "a")]), answer("ok")]);
    await run(make(f).assistant);
    expect(f.calls[1]!.params).not.toHaveProperty("container");
  });
});

describe("Assistant server tool labels", () => {
  it("shows a web search made from code, its input given at block start", async () => {
    const f = fake([
      ...codeExecution(0),
      ...nestedSearch(1, "zorblax drop"),
      start("web_search_tool_result", 2, { caller: CALLER }),
      stop(2),
      start("code_execution_tool_result", 3),
      stop(3),
      start("text", 4),
      text(4, "Answer."),
      stop(4),
    ]);
    const { assistant, log } = make(f);
    expect(await run(assistant)).toEqual([
      { type: "search", query: "zorblax drop" },
      { type: "text", text: "Answer." },
      { type: "done", truncatedGuide: true },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ searches: 1, fetches: 0 });
  });

  it("shows a direct web search once when its input streams after an empty start input", async () => {
    const f = fake([
      start("server_tool_use", 0, { id: "srv_1", name: "web_search", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: '{"query":' }),
      delta(0, { type: "input_json_delta", partial_json: '"zorblax key"}' }),
      stop(0),
    ]);
    const { assistant, log } = make(f);
    expect(await run(assistant)).toEqual([
      { type: "search", query: "zorblax key" },
      { type: "done", truncatedGuide: true },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ searches: 1 });
  });

  it("shows the host of a web fetch whose input is given at block start", async () => {
    const f = fake([
      start("server_tool_use", 0, {
        id: "srv_1",
        name: "web_fetch",
        input: { url: "https://wiki.example.test/zorblax" },
        caller: CALLER,
      }),
      stop(0),
    ]);
    const { assistant, log } = make(f);
    expect(await run(assistant)).toEqual([
      { type: "lookup", label: "Opened: wiki.example.test" },
      { type: "done", truncatedGuide: true },
    ]);
    expect(log.mock.calls[0]![1]).toMatchObject({ fetches: 1, searches: 0 });
  });
});

describe("Assistant narration and text shaping", () => {
  const texts = (events: AskEvent[]) => events.filter((e) => e.type === "text");

  it("drops a short text block followed by a tool call, adding no separator", async () => {
    const f = fake([
      start("text", 0),
      text(0, "Guide doesn't list a drop. Search web."),
      stop(0),
      ...nestedSearch(1, "zorblax drop"),
      start("web_search_tool_result", 2),
      stop(2),
      start("text", 3),
      text(3, "Answer."),
      stop(3),
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "search", query: "zorblax drop" },
      { type: "text", text: "Answer." },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("shows a short answer that is the last block", async () => {
    const f = fake([start("text", 0), text(0, "Short "), text(0, "answer."), stop(0)]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "text", text: "Short " },
      { type: "text", text: "answer." },
      { type: "done", truncatedGuide: true },
    ]);
  });

  it("streams a long text block live, before the block stops", async () => {
    const first = "a".repeat(200);
    const second = "b".repeat(100);
    let stopped = false;
    const client: StreamClient = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield start("text", 0);
          yield text(0, first);
          yield text(0, second);
          yield text(0, " end");
          stopped = true;
          yield stop(0);
        },
        finalMessage: async () => ({ stop_reason: "end_turn", usage: {}, content: [] }),
      }),
    };
    const assistant = new Assistant({ client, model: "m-1", effort: "low", log: vi.fn() });
    const gen = assistant.ask(ctx, history, QUESTION, "hint", new AbortController().signal, {
      search: () => "",
      read: () => ({ text: "", label: "", ok: true }),
    });
    expect((await gen.next()).value).toEqual({ type: "text", text: first });
    expect((await gen.next()).value).toEqual({ type: "text", text: second });
    expect(stopped).toBe(false);
    expect((await gen.next()).value).toEqual({ type: "text", text: " end" });
    expect((await gen.next()).value).toEqual({ type: "done", truncatedGuide: true });
  });

  it("joins consecutive text blocks split by citations exactly", async () => {
    const parts = ["Wight kings", " can all", " drop them.\nYou can also", " get them "];
    const f = fake(parts.flatMap((p, i) => [start("text", i), text(i, p), stop(i)]));
    const events = await run(make(f).assistant);
    expect(texts(events)).toEqual(parts.map((p) => ({ type: "text", text: p })));
    expect(events.at(-1)).toEqual({ type: "done", truncatedGuide: true });
  });

  it("separates text that follows a web search in the same round", async () => {
    const f = fake([
      start("text", 0),
      text(0, LONG),
      stop(0),
      ...nestedSearch(1, "zorblax"),
      start("web_search_tool_result", 2),
      stop(2),
      start("text", 3),
      text(3, "More."),
      stop(3),
    ]);
    expect(texts(await run(make(f).assistant))).toEqual([
      { type: "text", text: LONG },
      { type: "text", text: "\n\n" },
      { type: "text", text: "More." },
    ]);
  });

  it("drops a short text that ends a round going on to run guide tools, passing it back unchanged", async () => {
    const round1Content = [
      { type: "tool_use", id: "1", name: "search_guide", input: { query: "q" } },
      { type: "text", text: "Let me look that up." },
    ];
    const f = scripted([
      {
        events: [
          ...toolUse(0, search("1", "q")),
          start("text", 1),
          text(1, "Let me look that up."),
          stop(1),
        ],
        final: { stop_reason: "tool_use", usage: {}, content: round1Content },
      },
      answer("Found."),
    ]);
    expect(await run(make(f).assistant)).toEqual([
      { type: "lookup", label: "Searched your guide: q" },
      { type: "text", text: "Found." },
      { type: "done", truncatedGuide: true },
    ]);
    const messages = f.calls[1]!.params.messages as { content: unknown }[];
    expect(messages.at(-2)!.content).toBe(round1Content);
  });
});
