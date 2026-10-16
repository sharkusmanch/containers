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
    finalMessage(): Promise<{ stop_reason: string | null; usage: Record<string, unknown> }>;
  };
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
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

interface Block {
  type: string;
  name: string;
  json: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function searchQuery(json: string): string | null {
  try {
    const query = (JSON.parse(json) as { query?: unknown }).query;
    return typeof query === "string" && query !== "" ? query : null;
  } catch {
    return null;
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

  /** Streams one answer. Logs a single `ask` line with counts only: never any question or answer text. */
  async *ask(
    ctx: BuiltContext,
    history: AskHistoryEntry[],
    question: string,
    depth: "hint" | "full",
    signal: AbortSignal,
  ): AsyncGenerator<AskEvent> {
    const started = this.now();
    const info: Record<string, unknown> = { model: this.model };
    let searches = 0;
    const blocks = new Map<number, Block>();
    // False while the body may still be suspended at a yield the consumer never resumes.
    let completed = false;
    try {
      const stream = this.client.stream(
        {
          model: this.model,
          max_tokens: 8000,
          output_config: { effort: this.effort },
          system: [{ type: "text", text: ctx.system, cache_control: { type: "ephemeral" } }],
          messages: buildMessages(ctx, history, question, depth),
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      for await (const ev of stream) {
        if (signal.aborted) break;
        const index = typeof ev.index === "number" ? ev.index : -1;
        if (ev.type === "content_block_start") {
          const cb = (ev.content_block ?? {}) as Record<string, unknown>;
          blocks.set(index, { type: str(cb.type), name: str(cb.name), json: "" });
        } else if (ev.type === "content_block_delta") {
          const d = (ev.delta ?? {}) as Record<string, unknown>;
          const block = blocks.get(index);
          if (d.type === "text_delta" && block?.type === "text") {
            yield { type: "text", text: str(d.text) };
          } else if (d.type === "input_json_delta" && block?.type === "server_tool_use") {
            block.json += str(d.partial_json);
          }
        } else if (ev.type === "content_block_stop") {
          const block = blocks.get(index);
          blocks.delete(index);
          if (block?.type === "server_tool_use" && block.name === "web_search") {
            searches += 1;
            const query = searchQuery(block.json);
            if (query !== null) yield { type: "search", query };
          }
        }
      }
      if (signal.aborted) {
        info.stop = "aborted";
        return;
      }
      const final = await stream.finalMessage();
      info.stop = final.stop_reason;
      for (const f of USAGE_FIELDS) info[f] = final.usage[f];
      if (final.stop_reason === "refusal") {
        yield { type: "error", message: REFUSED };
        completed = true;
        return;
      }
      if (final.stop_reason === "max_tokens") yield { type: "text", text: "\n(answer cut short)" };
      yield { type: "done", truncatedGuide: ctx.truncatedGuide };
      completed = true;
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
      this.log("ask", { ...info, ms: this.now() - started, searches });
    }
  }
}
