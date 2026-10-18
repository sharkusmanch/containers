import { describe, expect, it } from "vitest";
import { REFUSED, Translator, UNAVAILABLE, type AskEvent } from "../src/translate.js";
import { ev, fixture, textBlock, toolCall } from "./helpers.js";

function run(lines: string[]): { events: AskEvent[]; t: Translator } {
  const t = new Translator();
  const events = lines.flatMap((l) => t.line(l));
  return { events, t };
}

/** Joins adjacent text events so assertions do not depend on chunking. */
function merged(events: AskEvent[]): AskEvent[] {
  const out: AskEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "text" && last?.type === "text") last.text += e.text;
    else out.push(e.type === "text" ? { ...e } : e);
  }
  return out;
}

const finalText = (raw: string): string => {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const res = lines.find((l) => l.type === "result");
  return res?.result as string;
};

describe("Translator on recorded claude 2.1.302 streams", () => {
  it("turns a WebSearch call into a search event and streams the answer", () => {
    const raw = fixture("websearch.jsonl");
    const { events, t } = run(raw.split("\n"));
    expect(merged(events)).toEqual([
      { type: "search", query: "Dragon Quest VIII PS2 release year" },
      { type: "text", text: finalText(raw) },
      { type: "done", truncatedGuide: false },
    ]);
    // Streamed as it arrived, not in one piece.
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(10);
    expect(t.summary()).toEqual({
      turns: 2,
      tools: { WebSearch: 1 },
      result: "success",
      costUsd: 0.08841320000000001,
      usage: {
        input_tokens: 4,
        output_tokens: 471,
        cache_read_input_tokens: 7034,
        cache_creation_input_tokens: 8207,
      },
    });
  });

  it("drops narration before a tool, labels guide and shell calls", () => {
    const raw = fixture("mcp-bash.jsonl");
    const { events, t } = run(raw.split("\n"));
    expect(merged(events)).toEqual([
      { type: "lookup", label: "Searched your guide: chest" },
      { type: "lookup", label: "Ran a command" },
      { type: "text", text: finalText(raw) },
      { type: "done", truncatedGuide: false },
    ]);
    expect(t.summary()).toMatchObject({
      turns: 3,
      tools: { mcp__companion__search_guide: 1, Bash: 1 },
      result: "success",
      costUsd: 0.0523498,
    });
  });
});

describe("narration and separators", () => {
  it("shows a short text block that ends the message", () => {
    const { events } = run([
      ...textBlock(0, "Short answer."),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
      ev.result(),
    ]);
    expect(merged(events)).toEqual([
      { type: "text", text: "Short answer." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("shows text longer than 280 characters even when a tool follows", () => {
    const long = "x".repeat(200);
    const { events } = run([
      ...textBlock(0, long, long),
      ...toolCall(1, "t1", "Bash", { command: "true" }),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
      ...textBlock(0, "After."),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
      ev.result(),
    ]);
    expect(merged(events)).toEqual([
      { type: "text", text: long + long },
      { type: "lookup", label: "Ran a command" },
      { type: "text", text: "\n\nAfter." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("adds no separator when the earlier text ends in whitespace", () => {
    const long = "y".repeat(290) + "\n";
    const { events } = run([
      ...textBlock(0, long),
      ...toolCall(1, "t1", "Bash", { command: "true" }),
      ...textBlock(0, "Next."),
      ev.messageStop(),
      ev.result(),
    ]);
    expect(merged(events)).toEqual([
      { type: "text", text: long },
      { type: "lookup", label: "Ran a command" },
      { type: "text", text: "Next." },
      { type: "done", truncatedGuide: false },
    ]);
  });

  it("joins consecutive text blocks exactly and sets text apart after thinking", () => {
    const { events } = run([
      ...textBlock(0, "One "),
      ...textBlock(1, "two"),
      ev.start(2, { type: "thinking", thinking: "" }),
      ev.stop(2),
      ...textBlock(3, "three"),
      ev.messageStop(),
      ev.result(),
    ]);
    expect(merged(events)).toEqual([
      { type: "text", text: "One two\n\nthree" },
      { type: "done", truncatedGuide: false },
    ]);
  });
});

describe("tool labels", () => {
  const labelOf = (name: string, input: Record<string, unknown>): AskEvent[] =>
    run(toolCall(0, "id1", name, input)).events;

  it.each([
    ["mcp__companion__read_guide_page", { page: "Chapter 2" }, "Read guide: Chapter 2"],
    [
      "mcp__companion__read_guide_page",
      { page: "Chapter 2", section: "The Well" },
      "Read guide: Chapter 2 › The Well",
    ],
    ["mcp__companion__search_guide", { query: "lever" }, "Searched your guide: lever"],
    ["mcp__companion__guide_outline", {}, "Checked your guide"],
    ["mcp__companion__companion_status", { hub: "h1" }, "Checked your guide"],
    ["mcp__companion__list_guides", {}, "Checked your guide"],
    ["mcp__retroachievements__get_user_profile", {}, "RetroAchievements: get user profile"],
    ["mcp__romm__search_roms", { q: "x" }, "RomM: search roms"],
    ["mcp__syncthing__syncthing_folder_status", {}, "Syncthing: syncthing folder status"],
    ["mcp__outline__fetch", { id: "d" }, "Outline: fetch"],
    [
      "WebFetch",
      { url: "https://www.example.com/a/b?c=d", prompt: "p" },
      "Opened: www.example.com",
    ],
    ["Bash", { command: "ls" }, "Ran a command"],
  ])("%s %j → %s", (name, input, label) => {
    expect(labelOf(name, input)).toEqual([{ type: "lookup", label }]);
  });

  it("emits a search event for WebSearch", () => {
    expect(labelOf("WebSearch", { query: "boss weakness" })).toEqual([
      { type: "search", query: "boss weakness" },
    ]);
  });

  it.each([
    ["Read", { file_path: "/agent/skills/redlib/skills/x/SKILL.md" }],
    ["Grep", { pattern: "x" }],
    ["Glob", { pattern: "*" }],
    ["Skill", { skill: "redlib:browsing-reddit-via-redlib" }],
    ["WebFetch", { url: "not a url" }],
    ["WebSearch", { query: "" }],
  ])("shows nothing for %s %j", (name, input) => {
    expect(labelOf(name, input)).toEqual([]);
  });

  it("labels a tool call once even when its assistant event repeats", () => {
    const { events, t } = run([
      ev.toolUse("same", "Bash", { command: "a" }),
      ev.toolUse("same", "Bash", { command: "a" }),
    ]);
    expect(events).toEqual([{ type: "lookup", label: "Ran a command" }]);
    expect(t.summary().tools).toEqual({ Bash: 1 });
  });

  it("counts tools that show nothing", () => {
    const { t } = run([ev.toolUse("a", "Read", { file_path: "/x" }), ev.toolUse("b", "Read", {})]);
    expect(t.summary().tools).toEqual({ Read: 2 });
  });
});

describe("endings", () => {
  it("turns an is_error result into the unavailable error", () => {
    const { events, t } = run([ev.result({ is_error: true, result: "API Error: 401" })]);
    expect(events).toEqual([{ type: "error", message: UNAVAILABLE }]);
    expect(t.summary().result).toBe("success");
  });

  it("turns an error subtype into the unavailable error", () => {
    const { events, t } = run([
      ...textBlock(0, "Partial"),
      ev.result({ subtype: "error_max_turns" }),
    ]);
    expect(merged(events)).toEqual([
      { type: "text", text: "Partial" },
      { type: "error", message: UNAVAILABLE },
    ]);
    expect(t.summary().result).toBe("error_max_turns");
  });

  it("answers a refusal with the refusal message", () => {
    const { events } = run([
      ev.messageDelta("refusal"),
      ev.messageStop(),
      ev.result({ stop_reason: "refusal" }),
    ]);
    expect(events).toEqual([{ type: "error", message: REFUSED }]);
  });

  it("ends with the unavailable error when no result came", () => {
    const t = new Translator();
    t.line(textBlock(0, "Half")[0] ?? "");
    expect(t.finish()).toEqual([{ type: "error", message: UNAVAILABLE }]);
    expect(t.finish()).toEqual([]);
  });

  it("ignores everything after the result, and finish adds nothing", () => {
    const t = new Translator();
    expect(t.line(ev.result())).toEqual([{ type: "done", truncatedGuide: false }]);
    expect(t.line(ev.toolUse("x", "Bash", {}))).toEqual([]);
    expect(t.line(ev.result({ is_error: true }))).toEqual([]);
    expect(t.finish()).toEqual([]);
    expect(t.finished).toBe(true);
  });

  it("ignores unparsable lines and sub-agent events", () => {
    const sub = JSON.stringify({
      ...JSON.parse(ev.toolUse("s", "Bash", {})),
      parent_tool_use_id: "p",
    });
    const { events } = run(["not json", "", "[1,2]", sub]);
    expect(events).toEqual([]);
  });
});
