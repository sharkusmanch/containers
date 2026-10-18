import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export const fixturePath = (name: string): string =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

export const fakeClaudePath = new URL("./fake-claude.mjs", import.meta.url).pathname;

/** Hand-written stream-json lines in the shapes claude 2.1.302 prints. */
export const ev = {
  start: (index: number, block: Record<string, unknown>): string =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: block },
      parent_tool_use_id: null,
    }),
  text: (index: number, text: string): string =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    }),
  stop: (index: number): string =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index },
      parent_tool_use_id: null,
    }),
  messageDelta: (stopReason: string): string =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: stopReason } },
      parent_tool_use_id: null,
    }),
  messageStop: (): string =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
    }),
  toolUse: (id: string, name: string, input: Record<string, unknown>): string =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: null,
    }),
  result: (fields: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 3, output_tokens: 5 },
      ...fields,
    }),
};

/** One tool call as claude streams it: block start, the assistant event, block stop. */
export function toolCall(
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
): string[] {
  return [
    ev.start(index, { type: "tool_use", id, name, input: {} }),
    ev.toolUse(id, name, input),
    ev.stop(index),
  ];
}

/** One whole text block. */
export function textBlock(index: number, ...chunks: string[]): string[] {
  return [
    ev.start(index, { type: "text", text: "" }),
    ...chunks.map((c) => ev.text(index, c)),
    ev.stop(index),
  ];
}
