import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const base = {
  STEAM_API_KEY: "k",
  STEAM_ID: "76561190000000000",
  RA_API_KEY: "r",
  RA_USERNAME: "tester",
  OUTLINE_BASE_URL: "https://outline.example.test",
  OUTLINE_COLLECTION_ID: "c1",
  OUTLINE_GUIDES_PARENT_ID: "p1",
};

describe("loadConfig", () => {
  it("defaults to a closed additional RA allowlist", () => {
    expect(loadConfig(base).additionalRaGameIds).toEqual([]);
  });
  it("reads the three explicitly configured Red game IDs", () => {
    expect(
      loadConfig({ ...base, RA_ADDITIONAL_GAME_IDS: "724,16084,11632,724" }).additionalRaGameIds,
    ).toEqual(["724", "16084", "11632"]);
  });
  it.each(["0", "-1", "01", "abc", "724,,16084", "724;16084", "9007199254740992"])(
    "rejects malformed RA allowlist %s",
    (raw) => {
      expect(() => loadConfig({ ...base, RA_ADDITIONAL_GAME_IDS: raw })).toThrow(
        /RA_ADDITIONAL_GAME_IDS/,
      );
    },
  );
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.staticDir).toBe("dist/web");
    expect(c.outlineApiKey).toBeNull();
    expect(c.outlineScheduleDocId).toBeNull();
  });

  it("reads optional values", () => {
    const c = loadConfig({
      ...base,
      PORT: "9000",
      OUTLINE_API_KEY: "o",
      OUTLINE_SCHEDULE_DOC_ID: "s1",
    });
    expect(c.port).toBe(9000);
    expect(c.outlineApiKey).toBe("o");
    expect(c.outlineScheduleDocId).toBe("s1");
  });

  it("has no default pinned pages unless configured", () => {
    expect(loadConfig(base).defaultPinnedPages).toEqual([]);
    expect(loadConfig({ ...base, DEFAULT_PINNED_PAGES: "" }).defaultPinnedPages).toEqual([]);
  });

  it("reads default pinned pages: trimmed, without empty entries or duplicates", () => {
    expect(loadConfig({ ...base, DEFAULT_PINNED_PAGES: "A, B ,,A" }).defaultPinnedPages).toEqual([
      "A",
      "B",
    ]);
  });

  it("has no editable pages unless configured", () => {
    expect(loadConfig(base).editablePages).toEqual([]);
    expect(loadConfig({ ...base, EDITABLE_PAGES: "" }).editablePages).toEqual([]);
  });

  it("reads editable pages: trimmed, without empty entries or duplicates", () => {
    expect(loadConfig({ ...base, EDITABLE_PAGES: "Notes, Scratch ,,Notes" }).editablePages).toEqual(
      ["Notes", "Scratch"],
    );
  });

  it("names every missing required variable", () => {
    expect(() => loadConfig({})).toThrow(/STEAM_API_KEY.*STEAM_ID.*RA_API_KEY.*RA_USERNAME/s);
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
  });

  it("strips a trailing slash from the Outline base URL", () => {
    expect(
      loadConfig({ ...base, OUTLINE_BASE_URL: "https://o.example.test/" }).outlineBaseUrl,
    ).toBe("https://o.example.test");
  });

  it("defaults the assistant settings", () => {
    const c = loadConfig(base);
    expect(c.anthropicApiKey).toBeNull();
    expect(c.assistantModel).toBe("claude-opus-5-5");
    expect(c.assistantEffort).toBe("low");
    expect(c.assistantPerMinute).toBe(10);
    expect(c.assistantPerDay).toBe(150);
    expect(c.assistantGuideChars).toBe(120000);
  });

  it("reads the assistant settings", () => {
    const c = loadConfig({
      ...base,
      ANTHROPIC_API_KEY: "a",
      ASSISTANT_MODEL: "some-model",
      ASSISTANT_EFFORT: "high",
      ASSISTANT_PER_MINUTE: "3",
      ASSISTANT_PER_DAY: "20",
      ASSISTANT_GUIDE_CHARS: "5000",
    });
    expect(c.anthropicApiKey).toBe("a");
    expect(c.assistantModel).toBe("some-model");
    expect(c.assistantEffort).toBe("high");
    expect(c.assistantPerMinute).toBe(3);
    expect(c.assistantPerDay).toBe(20);
    expect(c.assistantGuideChars).toBe(5000);
  });

  it("treats an empty ANTHROPIC_API_KEY as absent", () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "" }).anthropicApiKey).toBeNull();
  });

  it("rejects an unknown assistant effort", () => {
    expect(() => loadConfig({ ...base, ASSISTANT_EFFORT: "extreme" })).toThrow(/ASSISTANT_EFFORT/);
  });

  it.each(["0", "-1", "1.5", "abc", " "])("rejects ASSISTANT_PER_DAY=%j", (raw) => {
    expect(() => loadConfig({ ...base, ASSISTANT_PER_DAY: raw })).toThrow(/ASSISTANT_PER_DAY/);
  });

  it.each(["ASSISTANT_PER_MINUTE", "ASSISTANT_GUIDE_CHARS"])("rejects a bad %s", (name) => {
    expect(() => loadConfig({ ...base, [name]: "0" })).toThrow(new RegExp(name));
  });
});
