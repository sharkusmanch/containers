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
});
