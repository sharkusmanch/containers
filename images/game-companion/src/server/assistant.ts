import Anthropic from "@anthropic-ai/sdk";
import type { AskEvent, AskHistoryEntry } from "../shared/types.js";
import { buildMessages, type BuiltContext } from "./assistant-context.js";

export type StreamEvent = { type: string; [k: string]: unknown };

/** The slice of the SDK the service uses. */
export interface StreamClient {
  stream(
    params: Record<string, unknown>,
    opts: { signal: AbortSignal },
  ): AsyncIterable<StreamEvent> & {
    finalMessage(): Promise<{
      stop_reason: string | null;
      usage: Record<string, unknown>;
      /** The response's content blocks, exactly as the SDK returns them. */
      content: unknown[];
      /** Set when the response ran code (dynamic-filtering web tools). */
      container?: { id?: unknown } | null;
    }>;
  };
}

/** Runs the guide tools against the hub's own pages. */
export interface GuideToolRunner {
  search(query: string): string;
  read(page: string, section?: string): { text: string; label: string; ok: boolean };
}

/** Thin wrapper over `client.beta.messages.stream`; builds the client only when called. */
export function sdkStreamClient(apiKey: string): StreamClient {
  const client = new Anthropic({ apiKey });
  return {
    stream: (params, opts) =>
      // fallbacks: "default" may be newer than the SDK's types; the cast is deliberate.
      client.beta.messages.stream(params as never, { signal: opts.signal }) as never,
  };
}

const UNAVAILABLE = "The assistant is unavailable right now. Try again in a minute.";
const REFUSED = "I can't help with that one.";
const TOO_MANY = "That needed too many lookups. Try a narrower question.";
const LIMIT_REACHED = "Lookup limit reached; answer with what you have.";
const WEB_SPENT =
  "Web lookups for this question are used up (3 searches, 2 pages). Answer from the guide and what you already found.";
const MAX_ROUNDS = 8;
const MAX_GUIDE_CALLS = 6;
// The question's web budget. The tools' max_uses caps each request only; this budget is kept
// softly across rounds so the tools (part of the cached prefix) never change.
const WEB_SEARCHES = 3;
const WEB_FETCHES = 2;
// Block types that call a tool: a short text block just before one is narration.
const TOOL_BLOCKS = new Set(["server_tool_use", "tool_use"]);
// The longest text block held back while it may still turn out to be narration.
const NARRATION_MAX = 280;
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

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

interface Block {
  type: string;
  name: string;
  /** A server tool's input when given whole at block start (calls made from code), else null. */
  input: Record<string, unknown> | null;
  /** A server tool's input streamed as JSON deltas. */
  json: string;
}

interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The string field `key` of a server tool block's input, or null when absent, empty or unparsable. */
function inputField(block: Block, key: string): string | null {
  let input = block.input;
  if (input === null) {
    try {
      const parsed: unknown = JSON.parse(block.json);
      input = isRecord(parsed) ? parsed : {};
    } catch {
      return null;
    }
  }
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** One guide tool call: the result for the model, and the on-screen label when it ran. */
function runGuideTool(
  guide: GuideToolRunner,
  name: string,
  input: Record<string, unknown>,
): { content: string; ok: boolean; label: string | null } {
  if (name === "search_guide") {
    if (typeof input.query !== "string") {
      return { content: "Invalid input: query must be a string.", ok: false, label: null };
    }
    return {
      content: guide.search(input.query),
      ok: true,
      label: `Searched your guide: ${input.query}`,
    };
  }
  if (name === "read_guide_page") {
    const { page, section } = input;
    if (typeof page !== "string" || (section !== undefined && typeof section !== "string")) {
      return {
        content: "Invalid input: page must be a string, and section a string when given.",
        ok: false,
        label: null,
      };
    }
    const read = guide.read(page, section);
    return { content: read.text, ok: read.ok, label: read.label };
  }
  return { content: `Unknown tool: ${name}.`, ok: false, label: null };
}

/**
 * Decides which answer text the player sees. A text block is held while it is short: if the next
 * block calls a tool it was narration ("Let me search the web.") and is dropped; otherwise it is
 * shown. Text after another kind of block is set off from earlier text by a blank line, while
 * consecutive text blocks (split by citations) join exactly.
 */
class TextShaper {
  /** The last character shown, "" before any. */
  private tail = "";
  /** Another kind of block came after the last text shown. */
  private apart = false;
  /** The current text block's chunks while held; null when there is none or it streams live. */
  private held: string[] | null = null;
  private heldLength = 0;

  /** A block starts: settles a held text block by the new block's type, then opens the new one. */
  start(type: string): string[] {
    const out = this.held === null || TOOL_BLOCKS.has(type) ? [] : this.release();
    this.held = type === "text" ? [] : null;
    this.heldLength = 0;
    if (type !== "text") this.apart = true;
    return out;
  }

  /** A text delta of the current text block. */
  text(t: string): string[] {
    if (t === "") return [];
    if (this.held === null) return this.show(t);
    this.held.push(t);
    this.heldLength += t.length;
    return this.heldLength > NARRATION_MAX ? this.release() : [];
  }

  /** The round ended: a held block is shown unless the round goes on to run tools. */
  end(toolsFollow: boolean): string[] {
    const out = this.held === null || toolsFollow ? [] : this.release();
    this.held = null;
    return out;
  }

  /** Shows the held chunks; the rest of the block, if any, streams live. */
  private release(): string[] {
    const chunks = this.held ?? [];
    this.held = null;
    return chunks.flatMap((t) => this.show(t));
  }

  private show(t: string): string[] {
    const out = this.apart && this.tail !== "" && !/\s/.test(this.tail) ? ["\n\n", t] : [t];
    this.apart = false;
    this.tail = t.slice(-1);
    return out;
  }
}

export class Assistant {
  private readonly client: StreamClient;
  private readonly model: string;
  private readonly effort: string;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly now: () => number;

  constructor(opts: {
    client: StreamClient;
    model: string;
    effort: string;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    now?: () => number;
  }) {
    this.client = opts.client;
    this.model = opts.model;
    this.effort = opts.effort;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Streams one answer, running guide tools between model rounds. Logs a single `ask` line with
   * counts only: never any question, answer, query, page or URL text.
   */
  async *ask(
    ctx: BuiltContext,
    history: AskHistoryEntry[],
    question: string,
    depth: "hint" | "full",
    signal: AbortSignal,
    guide: GuideToolRunner,
  ): AsyncGenerator<AskEvent> {
    const started = this.now();
    const info: Record<string, unknown> = { model: this.model };
    let searches = 0;
    let rounds = 0;
    let guideCalls = 0;
    let lookups = 0;
    let fetches = 0;
    const shaper = new TextShaper();
    let messages: unknown[] = buildMessages(ctx, history, question, depth);
    // Container-bound server tools reject a follow-up that omits the container the question's
    // earlier rounds ran in. Scoped to this question only.
    let container: string | null = null;
    // False while the body may still be suspended at a yield the consumer never resumes.
    let completed = false;
    try {
      for (;;) {
        if (signal.aborted) {
          info.stop = "aborted";
          return;
        }
        rounds += 1;
        const blocks = new Map<number, Block>();
        const stream = this.client.stream(
          {
            model: this.model,
            max_tokens: 8000,
            output_config: { effort: this.effort },
            system: [{ type: "text", text: ctx.system, cache_control: { type: "ephemeral" } }],
            messages,
            tools: TOOLS,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            ...(container === null ? {} : { container }),
          },
          { signal },
        );
        for await (const ev of stream) {
          if (signal.aborted) break;
          const index = typeof ev.index === "number" ? ev.index : -1;
          if (ev.type === "content_block_start") {
            const cb = (ev.content_block ?? {}) as Record<string, unknown>;
            const type = str(cb.type);
            // A server tool called from code arrives with its whole input and no JSON deltas.
            const input = isRecord(cb.input) && Object.keys(cb.input).length > 0 ? cb.input : null;
            blocks.set(index, { type, name: str(cb.name), input, json: "" });
            for (const t of shaper.start(type)) yield { type: "text", text: t };
          } else if (ev.type === "content_block_delta") {
            const d = (ev.delta ?? {}) as Record<string, unknown>;
            const block = blocks.get(index);
            if (d.type === "text_delta" && block?.type === "text") {
              for (const t of shaper.text(str(d.text))) yield { type: "text", text: t };
            } else if (d.type === "input_json_delta" && block?.type === "server_tool_use") {
              block.json += str(d.partial_json);
            }
          } else if (ev.type === "content_block_stop") {
            const block = blocks.get(index);
            blocks.delete(index);
            if (block?.type === "server_tool_use" && block.name === "web_search") {
              searches += 1;
              const query = inputField(block, "query");
              if (query !== null) yield { type: "search", query };
            } else if (block?.type === "server_tool_use" && block.name === "web_fetch") {
              fetches += 1;
              const url = inputField(block, "url");
              const host = url === null ? null : hostOf(url);
              if (host !== null) yield { type: "lookup", label: `Opened: ${host}` };
            }
          }
        }
        if (signal.aborted) {
          info.stop = "aborted";
          return;
        }
        const final = await stream.finalMessage();
        info.stop = final.stop_reason;
        const containerId = final.container?.id;
        if (typeof containerId === "string" && containerId !== "") container = containerId;
        for (const f of USAGE_FIELDS) {
          const n = final.usage[f];
          if (typeof n === "number") info[f] = ((info[f] as number | undefined) ?? 0) + n;
        }
        const calls =
          final.stop_reason === "tool_use"
            ? (final.content as Record<string, unknown>[]).filter((b) => b?.type === "tool_use")
            : [];
        for (const t of shaper.end(calls.length > 0)) yield { type: "text", text: t };
        if (final.stop_reason === "refusal") {
          yield { type: "error", message: REFUSED };
          completed = true;
          return;
        }
        // The content goes back exactly as returned, dropped narration included: preserved
        // thinking needs it unmodified.
        const assistantTurn = { role: "assistant", content: final.content };
        if ((final.stop_reason === "pause_turn" || calls.length > 0) && rounds === MAX_ROUNDS) {
          info.stop = "max_rounds";
          yield { type: "error", message: TOO_MANY };
          completed = true;
          return;
        }
        if (final.stop_reason === "pause_turn") {
          messages = [...messages, assistantTurn];
          continue;
        }
        if (calls.length === 0) {
          if (final.stop_reason === "max_tokens") {
            yield { type: "text", text: "\n(answer cut short)" };
          }
          yield { type: "done", truncatedGuide: ctx.truncatedGuide };
          completed = true;
          return;
        }
        const results: ToolResult[] = [];
        for (const call of calls) {
          if (signal.aborted) {
            info.stop = "aborted";
            return;
          }
          const id = str(call.id);
          guideCalls += 1;
          if (guideCalls > MAX_GUIDE_CALLS) {
            results.push({
              type: "tool_result",
              tool_use_id: id,
              content: LIMIT_REACHED,
              is_error: true,
            });
            continue;
          }
          const input =
            typeof call.input === "object" && call.input !== null
              ? (call.input as Record<string, unknown>)
              : {};
          const run = runGuideTool(guide, str(call.name), input);
          results.push({
            type: "tool_result",
            tool_use_id: id,
            content: run.content,
            ...(run.ok ? {} : { is_error: true as const }),
          });
          if (run.label !== null) {
            lookups += 1;
            yield { type: "lookup", label: run.label };
          }
        }
        const spent = searches >= WEB_SEARCHES || fetches >= WEB_FETCHES;
        const content = spent ? [...results, { type: "text", text: WEB_SPENT }] : results;
        messages = [...messages, assistantTurn, { role: "user", content }];
      }
    } catch (err) {
      if (signal.aborted) {
        info.stop = "aborted";
        return;
      }
      // The SDK's error classes set no `name`, so the class is named by its constructor. Only
      // the class and HTTP status are logged: the message may echo the request or the key.
      info.error =
        (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "Error";
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === "number") info.status = status;
      yield { type: "error", message: UNAVAILABLE };
      completed = true;
    } finally {
      // A consumer that stops at a yield after an abort (the route's `break`) ends the body here.
      if (!completed && signal.aborted) info.stop = "aborted";
      this.log("ask", {
        ...info,
        ms: this.now() - started,
        searches,
        rounds,
        guideCalls,
        lookups,
        fetches,
      });
    }
  }
}
