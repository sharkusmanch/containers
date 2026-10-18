import type { AskEvent, AskHistoryEntry } from "../shared/types.js";

/** The body of `POST <AGENT_URL>/ask`: exactly these fields. */
export interface AgentRequest {
  instructions: string;
  statusBlock: string;
  history: AskHistoryEntry[];
  question: string;
  depth: "hint" | "full";
  /** The guide the companion tools default to; null for a game with no guide. */
  hub: string | null;
}

/** "busy" when the agent refused the question (its 429), else the answer's events. */
export type AgentReply = "busy" | AsyncGenerator<AskEvent>;

export const AGENT_UNAVAILABLE = "The assistant is unavailable right now. Try again in a minute.";

/** How long the agent may take to send its response headers. */
const HEADERS_TIMEOUT_MS = 20_000;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One NDJSON line as an event to pass on, rebuilt from its known fields only. Null for anything
 * else: unparsable lines, unknown types, fields of the wrong type, and the agent's own pings
 * (the route sends its own).
 */
function parseEvent(line: string): AskEvent | null {
  if (line.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string" ? { type: "text", text: raw.text } : null;
    case "search":
      return typeof raw.query === "string" ? { type: "search", query: raw.query } : null;
    case "lookup":
      return typeof raw.label === "string" ? { type: "lookup", label: raw.label } : null;
    case "done":
      // The field means nothing now that no guide text is sent; only `true` is kept.
      return { type: "done", truncatedGuide: raw.truncatedGuide === true };
    case "error":
      return typeof raw.message === "string" ? { type: "error", message: raw.message } : null;
    default:
      return null;
  }
}

/** The events of a question that ended before any answer, or with nothing to show. */
async function* only(...events: AskEvent[]): AsyncGenerator<AskEvent> {
  yield* events;
}

/**
 * Asks the Claude Code agent service and streams its answer back as validated events. Logs one
 * `ask` line per question with the outcome only: never any question, answer or lookup text.
 */
export class AgentClient {
  private readonly url: string;
  private readonly token: string;
  private readonly headersTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly now: () => number;

  constructor(opts: {
    /** Base URL of the agent, without the `/ask` path. */
    url: string;
    token: string;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    headersTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => () => void;
    now?: () => number;
  }) {
    this.url = `${opts.url.replace(/\/+$/, "")}/ask`;
    this.token = opts.token;
    this.log = opts.log;
    this.headersTimeoutMs = opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? defaultTimer;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Waits for the agent's response headers (at most the headers timeout), so a busy agent can
   * still be answered with a real 429. Aborting `signal` aborts the agent request at any point.
   */
  async ask(body: AgentRequest, signal: AbortSignal): Promise<AgentReply> {
    const started = this.now();
    const done = (outcome: string, extra: Record<string, unknown> = {}): void =>
      this.log("ask", { outcome, ms: this.now() - started, ...extra });

    const upstream = new AbortController();
    const abort = (): void => upstream.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const cancelTimer = this.setTimer(() => {
      timedOut = true;
      upstream.abort();
    }, this.headersTimeoutMs);
    const release = (): void => {
      cancelTimer();
      signal.removeEventListener("abort", abort);
    };

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          instructions: body.instructions,
          statusBlock: body.statusBlock,
          history: body.history,
          question: body.question,
          depth: body.depth,
          hub: body.hub,
        } satisfies AgentRequest),
        signal: upstream.signal,
      });
    } catch {
      release();
      if (signal.aborted) {
        done("aborted");
        return only();
      }
      done("unavailable", { reason: timedOut ? "timeout" : "network" });
      return only({ type: "error", message: AGENT_UNAVAILABLE });
    }
    cancelTimer();

    if (res.status === 429 || !res.ok || res.body === null) {
      release();
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) {
        done("busy", { status: res.status });
        return "busy";
      }
      done("unavailable", { status: res.status });
      return only({ type: "error", message: AGENT_UNAVAILABLE });
    }
    return this.stream(res.body, signal, release, done);
  }

  private async *stream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    release: () => void,
    done: (outcome: string, extra?: Record<string, unknown>) => void,
  ): AsyncGenerator<AskEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let ended = false;
    // Stays "aborted" if the caller stops reading before the answer ends.
    let outcome: { name: string; reason?: string } = { name: "aborted" };
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        ended = chunk.done;
        buffered += ended ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split("\n");
        // The part after the last newline is incomplete until the stream ends.
        buffered = ended ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          const ev = parseEvent(line);
          if (ev === null) continue;
          if (signal.aborted) return;
          yield ev;
          if (ev.type === "done" || ev.type === "error") {
            outcome = { name: ev.type };
            return;
          }
        }
        if (ended || signal.aborted) break;
      }
      if (signal.aborted) return;
      outcome = { name: "unavailable", reason: ended ? "incomplete" : "stream" };
      yield { type: "error", message: AGENT_UNAVAILABLE };
    } finally {
      release();
      // Closes the agent request when the answer ends early or the caller stops reading.
      await reader.cancel().catch(() => undefined);
      done(outcome.name, outcome.reason === undefined ? {} : { reason: outcome.reason });
    }
  }
}
