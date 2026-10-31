// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/web/api.js";
import { createAssistantView, type AssistantView } from "../src/web/assistant-view.js";
import type { AskEvent, AskRequest } from "../src/shared/types.js";

interface Call {
  req: AskRequest;
  signal: AbortSignal;
  emit(e: AskEvent): void;
  resolve(): void;
  reject(err: unknown): void;
}

function fakeAsk() {
  const calls: Call[] = [];
  const api = {
    ask: (req: AskRequest, signal: AbortSignal, onEvent: (e: AskEvent) => void) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ req, signal, emit: onEvent, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  };
  return { api, calls };
}

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const target = { hubId: "hA", game: { source: "ra" as const, id: "20" } };
const KEY = "game-companion:v1:ask:game:ra:20";

let view: AssistantView;
let fake: ReturnType<typeof fakeAsk>;
let storage: ReturnType<typeof memory>;

const q = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  view.element.querySelector(sel) as T;
const input = () => q<HTMLTextAreaElement>(".ask-input");
const starters = () => [...view.element.querySelectorAll<HTMLButtonElement>(".ask-starter")];
const turns = () => [...view.element.querySelectorAll<HTMLElement>(".ask-turn")];
const lastAnswer = () => turns().at(-1)?.querySelector(".ask-answer") as HTMLElement;
const stored = () => JSON.parse(storage.getItem(KEY) ?? "null") as unknown;

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
function press(key: string, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  input().dispatchEvent(ev);
  return ev;
}
async function answer(call: Call | undefined, ...events: AskEvent[]): Promise<void> {
  for (const e of events) call?.emit(e);
  call?.resolve();
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = "";
  fake = fakeAsk();
  storage = memory();
  view = createAssistantView(document, { api: fake.api, storage });
  document.body.append(view.element);
  view.setScope("game:ra:20", target);
});

describe("assistant view: sending", () => {
  it("sends each starter's exact text as a hint question with the request target", () => {
    expect(starters().map((b) => b.textContent)).toEqual([
      "What should I do next?",
      "Anything missable around here?",
      "Where do I go now?",
    ]);
    starters()[1]?.click();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.req).toEqual({
      hubId: "hA",
      game: { source: "ra", id: "20" },
      history: [],
      question: "Anything missable around here?",
      depth: "hint",
    });
  });

  it("sends the typed question on Enter and clears the box; Shift+Enter is left to the box", () => {
    type("  Where is the key?  ");
    const shifted = press("Enter", true);
    expect(shifted.defaultPrevented).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const plain = press("Enter");
    expect(plain.defaultPrevented).toBe(true);
    expect(fake.calls.map((c) => [c.req.question, c.req.depth])).toEqual([
      ["Where is the key?", "hint"],
    ]);
    expect(input().value).toBe("");
  });

  it("sends from the Send button as well", () => {
    type("How do I open the gate?");
    q(".ask-send").click();
    expect(fake.calls[0]?.req.question).toBe("How do I open the gate?");
  });

  it("does not send an empty or whitespace-only question", () => {
    press("Enter");
    type("   \n  ");
    press("Enter");
    q(".ask-send").click();
    expect(fake.calls).toHaveLength(0);
  });

  it("shows a counter from 900 characters and stops the text at 1,000", () => {
    const counter = q(".ask-counter");
    expect(input().maxLength).toBe(1000);
    type("a".repeat(899));
    expect(counter.hidden).toBe(true);
    type("a".repeat(900));
    expect(counter.hidden).toBe(false);
    expect(counter.textContent).toBe("900/1000");
    type("a".repeat(1005));
    expect(input().value).toHaveLength(1000);
    expect(counter.textContent).toBe("1000/1000");
    type("b");
    expect(counter.hidden).toBe(true);
  });
});

describe("assistant view: streaming", () => {
  it("disables every input while streaming, shows Stop, and re-enables after done", async () => {
    starters()[0]?.click();
    const controls = [input(), ...starters(), q<HTMLButtonElement>(".ask-new")];
    expect(controls.every((c) => (c as HTMLButtonElement).disabled)).toBe(true);
    expect(q(".ask-stop").hidden).toBe(false);
    expect(q(".ask-send").hidden).toBe(true);
    starters()[1]?.click();
    expect(fake.calls).toHaveLength(1);
    await answer(
      fake.calls[0],
      { type: "text", text: "Go north." },
      { type: "done", truncatedGuide: false },
    );
    expect(controls.every((c) => !(c as HTMLButtonElement).disabled)).toBe(true);
    expect(q(".ask-stop").hidden).toBe(true);
    expect(q(".ask-send").hidden).toBe(false);
  });

  it("appends text as it arrives, splitting paragraphs and bullets, all as plain text", async () => {
    starters()[0]?.click();
    const call = fake.calls[0];
    call?.emit({ type: "text", text: "First <b>x</b> line\nstill first" });
    expect(lastAnswer().textContent).toBe("First <b>x</b> line\nstill first");
    call?.emit({ type: "text", text: "\n\n- one\n- two\n\nLast." });
    const body = lastAnswer();
    expect(body.querySelector("b")).toBeNull();
    const blocks = [...body.querySelectorAll(".ask-body > *")].map((n) => n.tagName);
    expect(blocks).toEqual(["P", "UL", "P"]);
    expect(body.querySelector("p")?.textContent).toBe("First <b>x</b> line\nstill first");
    expect([...body.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(body.querySelectorAll("p")[1]?.textContent).toBe("Last.");
    await answer(call, { type: "done", truncatedGuide: false });
  });

  it("shows a web search above the answer", async () => {
    starters()[0]?.click();
    fake.calls[0]?.emit({ type: "text", text: "Hmm." });
    fake.calls[0]?.emit({ type: "search", query: "sample boss weakness" });
    const searches = [...lastAnswer().querySelectorAll(".ask-search")];
    expect(searches.map((s) => s.textContent)).toEqual(["Searched the web: sample boss weakness"]);
    const children = [...lastAnswer().children].map((c) => c.className);
    expect(children.indexOf("ask-searches")).toBeLessThan(children.indexOf("ask-body"));
    await answer(fake.calls[0], { type: "done", truncatedGuide: false });
  });

  it("shows guide lookups with web searches in arrival order, as plain text", async () => {
    starters()[0]?.click();
    const call = fake.calls[0];
    call?.emit({ type: "lookup", label: "Searched your guide: <b>lantern</b>" });
    call?.emit({ type: "search", query: "sample boss weakness" });
    call?.emit({ type: "lookup", label: "Read guide: Notes › Items" });
    call?.emit({ type: "lookup" } as unknown as AskEvent);
    call?.emit({ type: "lookup", label: 5 } as unknown as AskEvent);
    const searches = lastAnswer().querySelector(".ask-searches");
    expect(
      [...(searches?.querySelectorAll(".ask-search") ?? [])].map((s) => s.textContent),
    ).toEqual([
      "Searched your guide: <b>lantern</b>",
      "Searched the web: sample boss weakness",
      "Read guide: Notes › Items",
    ]);
    expect(searches?.querySelector("b")).toBeNull();
    await answer(call, { type: "done", truncatedGuide: false });
  });

  it("Stop aborts the request, keeps what arrived with (stopped), and saves it", async () => {
    type("Where now?");
    press("Enter");
    const call = fake.calls[0] as Call;
    call.emit({ type: "text", text: "Head to the" });
    q(".ask-stop").click();
    expect(call.signal.aborted).toBe(true);
    await settle();
    expect(lastAnswer().querySelector(".ask-body")?.textContent).toBe("Head to the (stopped)");
    expect(input().disabled).toBe(false);
    expect(stored()).toEqual([{ question: "Where now?", answer: "Head to the (stopped)" }]);
  });

  it("a stopped answer with no text is shown as (stopped) and not saved", async () => {
    starters()[2]?.click();
    q(".ask-stop").click();
    await settle();
    expect(lastAnswer().textContent).toBe("(stopped)");
    expect(storage.getItem(KEY)).toBeNull();
    expect(starters()[2]?.disabled).toBe(false);
  });
});

describe("assistant view: errors", () => {
  it("shows an error event inline, keeps the partial text, does not save, re-enables", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "Partial" },
      { type: "error", message: "I can't help with that one." },
    );
    expect(lastAnswer().querySelector(".ask-body")?.textContent).toBe("Partial");
    expect(lastAnswer().querySelector(".ask-error")?.textContent).toBe(
      "I can't help with that one.",
    );
    expect(storage.getItem(KEY)).toBeNull();
    expect(input().disabled).toBe(false);
    expect(q(".ask-full")).toBeNull();
  });

  it.each([
    [new ApiError(429, "day", 3600), "Daily question limit reached. Try again after midnight."],
    [new ApiError(429, "minute", 42), "Too many questions. Try again in 42 seconds."],
    [new ApiError(503), "The assistant isn't set up."],
    [new ApiError(413), "This chat is too long. Start a New chat."],
    [new ApiError(400), "The assistant is unavailable right now."],
    [new ApiError(404), "The assistant is unavailable right now."],
    [new ApiError(500), "The assistant is unavailable right now."],
    [new TypeError("Failed to fetch"), "The assistant is unavailable right now."],
  ])("maps a thrown %o to its message", async (err, text) => {
    starters()[0]?.click();
    fake.calls[0]?.reject(err);
    await settle();
    expect(lastAnswer().querySelector(".ask-error")?.textContent).toBe(text);
    expect(storage.getItem(KEY)).toBeNull();
    expect(input().disabled).toBe(false);
  });

  it("shows no inline error for a 401 (the signed-out banner says it), saves nothing, re-enables", async () => {
    starters()[0]?.click();
    fake.calls[0]?.reject(new ApiError(401));
    await settle();
    expect(lastAnswer().querySelector(".ask-error")).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
    expect(input().disabled).toBe(false);
  });

  it("treats a stream that ends without done as unavailable and does not save", async () => {
    starters()[0]?.click();
    await answer(fake.calls[0], { type: "text", text: "Half" });
    expect(lastAnswer().querySelector(".ask-error")?.textContent).toBe(
      "The assistant is unavailable right now.",
    );
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("offers Full answer again under the hint answer after a later question fails", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "A hint." },
      { type: "done", truncatedGuide: false },
    );
    type("And then?");
    press("Enter");
    expect(q(".ask-full")).toBeNull();
    await answer(fake.calls[1], { type: "error", message: "Upstream trouble." });
    const full = q<HTMLButtonElement>(".ask-full");
    expect(full).not.toBeNull();
    expect(turns()[0]?.contains(full)).toBe(true);
    expect(full.disabled).toBe(false);
  });

  it("offers Full answer again under the hint answer after a later question is stopped with no text", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "A hint." },
      { type: "done", truncatedGuide: false },
    );
    starters()[1]?.click();
    q(".ask-stop").click();
    await settle();
    expect(turns()[0]?.contains(q(".ask-full"))).toBe(true);
  });

  it("ignores ping events", async () => {
    starters()[0]?.click();
    const call = fake.calls[0]!;
    call.emit({ type: "text", text: "Hint." });
    const before = lastAnswer().innerHTML;
    call.emit({ type: "ping" });
    expect(lastAnswer().innerHTML).toBe(before);
    expect(q(".ask-stop").hidden).toBe(false);
    await answer(call, { type: "ping" }, { type: "done", truncatedGuide: false });
    expect(lastAnswer().querySelector(".ask-error")).toBeNull();
    expect(stored()).toEqual([{ question: "What should I do next?", answer: "Hint." }]);
  });

  it("does not save a done answer whose text is blank", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "  \n " },
      { type: "done", truncatedGuide: false },
    );
    expect(storage.getItem(KEY)).toBeNull();
    expect(lastAnswer().querySelector(".ask-error")?.textContent).toBe(
      "The assistant is unavailable right now.",
    );
  });
});

describe("assistant view: default depth", () => {
  it("sends typed questions and starters as hints until told otherwise", async () => {
    type("Where is the key?");
    press("Enter");
    await answer(fake.calls[0], { type: "done", truncatedGuide: false });
    starters()[0]?.click();
    expect(fake.calls.map((c) => c.req.depth)).toEqual(["hint", "hint"]);
  });

  it("sends a typed question at the researched depth once set", async () => {
    view.setDefaultDepth("researched");
    type("Where is the key?");
    press("Enter");
    expect(fake.calls.map((c) => [c.req.question, c.req.depth])).toEqual([
      ["Where is the key?", "researched"],
    ]);
    await answer(fake.calls[0], { type: "done", truncatedGuide: false });
    type("And the door?");
    q(".ask-send").click();
    expect(fake.calls[1]?.req.depth).toBe("researched");
  });

  it("sends a starter at the researched depth once set, and as a hint again when set back", async () => {
    view.setDefaultDepth("researched");
    starters()[2]?.click();
    expect(fake.calls[0]?.req).toEqual({
      ...target,
      history: [],
      question: "Where do I go now?",
      depth: "researched",
    });
    await answer(fake.calls[0], { type: "done", truncatedGuide: false });
    view.setDefaultDepth("hint");
    starters()[0]?.click();
    expect(fake.calls[1]?.req.depth).toBe("hint");
  });

  it("still offers Full answer after a researched answer, and sends it as full", async () => {
    view.setDefaultDepth("researched");
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "All of it, up to here." },
      { type: "done", truncatedGuide: false },
    );
    const full = q<HTMLButtonElement>(".ask-full");
    expect(full.textContent).toBe("Full answer");
    full.click();
    expect(fake.calls[1]?.req).toEqual({
      ...target,
      history: [{ question: "What should I do next?", answer: "All of it, up to here." }],
      question: "Give me the full answer.",
      depth: "full",
    });
  });

  it("leaves the depth given to ask alone", () => {
    view.setDefaultDepth("researched");
    expect(view.ask("How do I get the lamp?", "hint")).toBe(true);
    expect(fake.calls[0]?.req.depth).toBe("hint");
  });
});

describe("assistant view: full answer and history", () => {
  it("offers Full answer after a hint answer and sends the follow-up with the history", async () => {
    starters()[0]?.click();
    expect(q(".ask-full")).toBeNull();
    await answer(
      fake.calls[0],
      { type: "text", text: "A hint." },
      { type: "done", truncatedGuide: false },
    );
    const full = q<HTMLButtonElement>(".ask-full");
    expect(full.textContent).toBe("Full answer");
    expect(turns().at(-1)?.contains(full)).toBe(true);
    full.click();
    expect(fake.calls[1]?.req).toEqual({
      ...target,
      history: [{ question: "What should I do next?", answer: "A hint." }],
      question: "Give me the full answer.",
      depth: "full",
    });
    expect(q(".ask-full")).toBeNull();
    await answer(
      fake.calls[1],
      { type: "text", text: "Everything." },
      { type: "done", truncatedGuide: false },
    );
    expect(q(".ask-full")).toBeNull();
    expect(stored()).toEqual([
      { question: "What should I do next?", answer: "A hint." },
      { question: "Give me the full answer.", answer: "Everything." },
    ]);
  });

  it("sends earlier turns as history and keeps at most 10", async () => {
    for (let i = 0; i < 12; i += 1) {
      type(`Question ${i}`);
      press("Enter");
      await answer(
        fake.calls[i],
        { type: "text", text: `Answer ${i}` },
        { type: "done", truncatedGuide: false },
      );
    }
    expect(fake.calls[11]?.req.history).toHaveLength(10);
    expect(fake.calls[11]?.req.history[0]).toEqual({ question: "Question 1", answer: "Answer 1" });
    const saved = stored() as { question: string }[];
    expect(saved).toHaveLength(10);
    expect(saved[0]?.question).toBe("Question 2");
    expect(saved[9]?.question).toBe("Question 11");
  });

  it("sends at most 8,000 characters of an earlier answer", async () => {
    starters()[0]?.click();
    const long = "é".repeat(8100);
    await answer(
      fake.calls[0],
      { type: "text", text: long },
      { type: "done", truncatedGuide: false },
    );
    starters()[0]?.click();
    expect([...(fake.calls[1]?.req.history[0]?.answer ?? "")]).toHaveLength(8000);
    expect((stored() as { answer: string }[])[0]?.answer).toBe(long);
  });

  it("leaves the oldest history out of a request that would pass 30,000 bytes, keeping it stored", () => {
    const line = "Go left — then up.\n";
    const long = line.repeat(Math.ceil(7000 / line.length)).slice(0, 7000);
    const entries = Array.from({ length: 10 }, (_, i) => ({
      question: `Question ${i}`,
      answer: `${i}${long}`.slice(0, 7000),
    }));
    storage.setItem(KEY, JSON.stringify(entries));
    view.setScope(null, null);
    view.setScope("game:ra:20", target);
    starters()[0]?.click();
    const req = fake.calls[0]!.req;
    expect(new TextEncoder().encode(JSON.stringify(req)).length).toBeLessThanOrEqual(30000);
    expect(req.history.length).toBeGreaterThan(0);
    expect(req.history.length).toBeLessThan(10);
    expect(req.history).toEqual(entries.slice(-req.history.length));
    expect(stored()).toEqual(entries);
    expect(turns()).toHaveLength(11);
  });

  it("keeps a conversation per scope and restores it on setScope", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "Alpha hint." },
      { type: "done", truncatedGuide: false },
    );
    view.setScope("hZ", { hubId: "hZ", game: null });
    expect(turns()).toHaveLength(0);
    starters()[2]?.click();
    expect(fake.calls[1]?.req).toMatchObject({ hubId: "hZ", game: null, history: [] });
    await answer(
      fake.calls[1],
      { type: "text", text: "Zeta hint." },
      { type: "done", truncatedGuide: false },
    );
    view.setScope("game:ra:20", target);
    expect(turns().map((t) => t.querySelector(".ask-question")?.textContent)).toEqual([
      "What should I do next?",
    ]);
    expect(lastAnswer().textContent).toBe("Alpha hint.");
    expect(q(".ask-full")).not.toBeNull();
    expect(JSON.parse(storage.getItem("game-companion:v1:ask:hZ") ?? "[]")).toEqual([
      { question: "Where do I go now?", answer: "Zeta hint." },
    ]);
  });

  it("restores a conversation that is already in storage, ignoring blank entries", () => {
    storage.setItem(
      "game-companion:v1:ask:hX",
      JSON.stringify([
        { question: "Q1", answer: "- a\n- b" },
        { question: " ", answer: "x" },
        { question: "Q2", answer: "" },
        "junk",
        { question: "Give me the full answer.", answer: "All of it." },
      ]),
    );
    view.setScope("hX", { hubId: "hX", game: null });
    expect(turns()).toHaveLength(2);
    expect([...turns()[0]!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
    // The last answer was already the full one.
    expect(q(".ask-full")).toBeNull();
  });

  it("New chat clears the conversation and its storage", async () => {
    starters()[0]?.click();
    await answer(
      fake.calls[0],
      { type: "text", text: "Hint." },
      { type: "done", truncatedGuide: false },
    );
    q(".ask-new").click();
    expect(turns()).toHaveLength(0);
    expect(stored()).toEqual([]);
    starters()[0]?.click();
    expect(fake.calls[1]?.req.history).toEqual([]);
  });

  it("switching scope while streaming stops the answer and files it under its own scope", async () => {
    starters()[0]?.click();
    fake.calls[0]?.emit({ type: "text", text: "Partly" });
    view.setScope("hZ", { hubId: "hZ", game: null });
    expect(fake.calls[0]?.signal.aborted).toBe(true);
    expect(input().disabled).toBe(false);
    expect(q(".ask-stop").hidden).toBe(true);
    await settle();
    expect(turns()).toHaveLength(0);
    expect(stored()).toEqual([{ question: "What should I do next?", answer: "Partly (stopped)" }]);
  });

  it("keeps the conversation and stream when setScope repeats the same scope", async () => {
    starters()[0]?.click();
    view.setScope("game:ra:20", { hubId: null, game: target.game });
    expect(fake.calls[0]?.signal.aborted).toBe(false);
    await answer(
      fake.calls[0],
      { type: "text", text: "Hint." },
      { type: "done", truncatedGuide: false },
    );
    expect(turns()).toHaveLength(1);
    starters()[0]?.click();
    expect(fake.calls[1]?.req.hubId).toBeNull();
  });

  it("a null scope disables every input and says to pick a game", () => {
    view.setScope(null, null);
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe("Pick a game first");
    expect(starters().every((b) => b.disabled)).toBe(true);
    expect(view.element.textContent).toContain("Pick a game first");
    starters()[0]?.click();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("assistant view: ask()", () => {
  it("sends the text as a normal hint turn, stored with Full answer offered", async () => {
    expect(view.ask('How do I get "Gate"? Open it.', "hint")).toBe(true);
    expect(fake.calls[0]?.req).toEqual({
      hubId: "hA",
      game: { source: "ra", id: "20" },
      history: [],
      question: 'How do I get "Gate"? Open it.',
      depth: "hint",
    });
    expect(turns()).toHaveLength(1);
    await answer(
      fake.calls[0],
      { type: "text", text: "Use the key." },
      { type: "done", truncatedGuide: false },
    );
    expect(stored()).toEqual([
      { question: 'How do I get "Gate"? Open it.', answer: "Use the key." },
    ]);
    expect(q(".ask-full")).not.toBeNull();
  });

  it("returns false and sends nothing while streaming, blank, or with no game", () => {
    expect(view.ask("   ", "hint")).toBe(false);
    expect(view.ask("First", "hint")).toBe(true);
    expect(view.ask("Second", "hint")).toBe(false);
    expect(fake.calls).toHaveLength(1);
    view.setScope(null, null);
    expect(view.ask("Third", "hint")).toBe(false);
  });

  it("cuts a question over the 1,000-character limit", () => {
    expect(view.ask("a".repeat(1200), "hint")).toBe(true);
    expect(fake.calls[0]?.req.question).toHaveLength(1000);
  });

  it("reports busy changes: true when a stream starts, false when it ends", async () => {
    const seen: boolean[] = [];
    const own = createAssistantView(document, {
      api: fake.api,
      storage,
      onBusyChange: (busy) => seen.push(busy),
    });
    own.setScope("game:ra:20", target);
    expect(seen).toEqual([]);
    own.ask("Where?", "hint");
    expect(seen).toEqual([true]);
    await answer(
      fake.calls[0],
      { type: "text", text: "There." },
      { type: "done", truncatedGuide: false },
    );
    expect(seen).toEqual([true, false]);
  });
});
