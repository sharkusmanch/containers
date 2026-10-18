import { describe, expect, it } from "vitest";
import { buildPrompt, parseAskRequest, type AskRequest } from "../src/prompt.js";

const valid: AskRequest = {
  instructions: "Be brief.",
  statusBlock: "Game: Example Quest (Steam)\nState: playing",
  history: [{ question: "Where is the key?", answer: "Under the mat." }],
  question: "And the door?",
  depth: "hint",
  hub: "hub-1",
};

describe("parseAskRequest", () => {
  it("accepts the companion's body and keeps only its fields", () => {
    expect(parseAskRequest({ ...valid, extra: 1 })).toEqual(valid);
    expect(parseAskRequest({ ...valid, hub: null, history: [], depth: "full" })).toEqual({
      ...valid,
      hub: null,
      history: [],
      depth: "full",
    });
  });

  it.each([
    ["not an object", "x"],
    ["an array", [valid]],
    ["no question", { ...valid, question: undefined }],
    ["a blank question", { ...valid, question: "  " }],
    ["a bad depth", { ...valid, depth: "medium" }],
    ["a numeric hub", { ...valid, hub: 3 }],
    ["a missing hub", { ...valid, hub: undefined }],
    ["a non-string status block", { ...valid, statusBlock: null }],
    ["non-string instructions", { ...valid, instructions: 1 }],
    ["history not an array", { ...valid, history: {} }],
    ["a bad history entry", { ...valid, history: [{ question: "q" }] }],
  ])("rejects %s", (_name, body) => {
    expect(parseAskRequest(body)).toBeNull();
  });
});

describe("buildPrompt", () => {
  it("puts status, history, depth, hub and question in order", () => {
    expect(buildPrompt(valid)).toBe(
      [
        "Game: Example Quest (Steam)\nState: playing",
        "Earlier question: Where is the key?\nEarlier answer: Under the mat.",
        "Answer depth: hint",
        "Guide hub id: hub-1",
        "Question: And the door?",
      ].join("\n\n"),
    );
  });

  it("says none for a game with no guide and skips empty parts", () => {
    expect(buildPrompt({ ...valid, statusBlock: "", history: [], hub: null, depth: "full" })).toBe(
      "Answer depth: full\n\nGuide hub id: none\n\nQuestion: And the door?",
    );
  });
});
