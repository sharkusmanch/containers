/** The events the companion accepts, one NDJSON line each. */
export type AskEvent =
  | { type: "text"; text: string }
  | { type: "search"; query: string }
  | { type: "lookup"; label: string }
  | { type: "ping" }
  | { type: "done"; truncatedGuide: false }
  | { type: "error"; message: string };

export const UNAVAILABLE = "The assistant is unavailable right now. Try again in a minute.";
export const REFUSED = "I can't help with that one.";

/** What the per-question log line reports: counts and totals only, never text. */
export interface RunSummary {
  turns: number | null;
  /** Tool calls by tool name. */
  tools: Record<string, number>;
  /** The result's subtype, or null when no result came. */
  result: string | null;
  costUsd: number | null;
  usage: Record<string, number>;
}

// Block types that call a tool: a short text block just before one is narration.
const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use"]);
// The longest text block held back while it may still turn out to be narration.
const NARRATION_MAX = 280;
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;
const SERVER_LABELS: Record<string, string> = {
  retroachievements: "RetroAchievements",
  romm: "RomM",
  syncthing: "Syncthing",
  outline: "Outline",
};

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** What the screen shows for one tool call, or null for tools it does not show. */
export function toolEvent(name: string, input: Json): AskEvent | null {
  if (name === "WebSearch") {
    const query = nonEmpty(input.query);
    return query === null ? null : { type: "search", query };
  }
  if (name === "WebFetch") {
    const url = nonEmpty(input.url);
    const host = url === null ? null : hostOf(url);
    return host === null ? null : { type: "lookup", label: `Opened: ${host}` };
  }
  if (name === "Bash") return { type: "lookup", label: "Ran a command" };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp === null) return null;
  const [, server = "", tool = ""] = mcp;
  if (server === "companion") {
    const query = nonEmpty(input.query);
    if (tool === "search_guide" && query !== null) {
      return { type: "lookup", label: `Searched your guide: ${query}` };
    }
    const page = nonEmpty(input.page);
    if (tool === "read_guide_page" && page !== null) {
      const section = nonEmpty(input.section);
      const label = section === null ? `Read guide: ${page}` : `Read guide: ${page} › ${section}`;
      return { type: "lookup", label };
    }
    return { type: "lookup", label: "Checked your guide" };
  }
  const server_ = SERVER_LABELS[server] ?? server;
  return { type: "lookup", label: `${server_}: ${tool.replaceAll("_", " ")}` };
}

/**
 * Decides which answer text the player sees. A text block is held while it is short: if the next
 * block calls a tool it was narration ("I'll check the guide.") and is dropped; otherwise it is
 * shown. Text after another kind of block is set off from earlier text by a blank line, while
 * consecutive text blocks join exactly.
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

  /** A message ended: a held block is shown unless the message goes on to run tools. */
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

/**
 * Turns `claude -p --output-format stream-json --verbose --include-partial-messages` output,
 * one line at a time, into AskEvents. Exactly one `done` or `error` ends every answer: from the
 * `result` line, or from `finish()` when the stream ended without one.
 */
export class Translator {
  /** True once the answer's `done` or `error` was produced. */
  finished = false;
  private readonly shaper = new TextShaper();
  private readonly seen = new Set<string>();
  private stopReason: string | null = null;
  private readonly info: RunSummary = {
    turns: null,
    tools: {},
    result: null,
    costUsd: null,
    usage: {},
  };

  line(raw: string): AskEvent[] {
    if (this.finished || raw.trim() === "") return [];
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [];
    }
    // Sub-agent output is not part of the answer (the agent is never given sub-agents anyway).
    if (!isRecord(msg) || (msg.parent_tool_use_id ?? null) !== null) return [];
    switch (msg.type) {
      case "stream_event":
        return isRecord(msg.event) ? this.streamEvent(msg.event) : [];
      case "assistant":
        return isRecord(msg.message) ? this.toolCalls(msg.message) : [];
      case "result":
        return this.result(msg);
      default:
        return [];
    }
  }

  /** The stream ended: the unavailable error unless the answer already ended. */
  finish(): AskEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ type: "error", message: UNAVAILABLE }];
  }

  summary(): RunSummary {
    return { ...this.info, tools: { ...this.info.tools }, usage: { ...this.info.usage } };
  }

  private streamEvent(e: Json): AskEvent[] {
    let texts: string[] = [];
    if (e.type === "content_block_start" && isRecord(e.content_block)) {
      texts = this.shaper.start(String(e.content_block.type));
    } else if (e.type === "content_block_delta" && isRecord(e.delta)) {
      if (e.delta.type === "text_delta" && typeof e.delta.text === "string") {
        texts = this.shaper.text(e.delta.text);
      }
    } else if (e.type === "message_delta" && isRecord(e.delta)) {
      const reason = e.delta.stop_reason;
      if (typeof reason === "string") this.stopReason = reason;
    } else if (e.type === "message_stop") {
      texts = this.shaper.end(this.stopReason === "tool_use");
    }
    return texts.map((text) => ({ type: "text", text }));
  }

  /** Each tool call is shown once, when its whole input is known. */
  private toolCalls(message: Json): AskEvent[] {
    const out: AskEvent[] = [];
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    for (const block of content) {
      if (!isRecord(block) || !TOOL_BLOCKS.has(String(block.type))) continue;
      const id = String(block.id);
      const name = String(block.name);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.info.tools[name] = (this.info.tools[name] ?? 0) + 1;
      const shown = toolEvent(name, isRecord(block.input) ? block.input : {});
      if (shown !== null) out.push(shown);
    }
    return out;
  }

  private result(msg: Json): AskEvent[] {
    this.finished = true;
    this.info.result = typeof msg.subtype === "string" ? msg.subtype : null;
    if (typeof msg.num_turns === "number") this.info.turns = msg.num_turns;
    if (typeof msg.total_cost_usd === "number") this.info.costUsd = msg.total_cost_usd;
    const usage = isRecord(msg.usage) ? msg.usage : {};
    for (const f of USAGE_FIELDS) {
      const n = usage[f];
      if (typeof n === "number") this.info.usage[f] = n;
    }
    const out: AskEvent[] = this.shaper.end(false).map((text) => ({ type: "text", text }));
    if (msg.stop_reason === "refusal" || this.stopReason === "refusal") {
      out.push({ type: "error", message: REFUSED });
    } else if (msg.is_error === true || msg.subtype !== "success") {
      out.push({ type: "error", message: UNAVAILABLE });
    } else {
      out.push({ type: "done", truncatedGuide: false });
    }
    return out;
  }
}
