import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMcp } from "../src/mcp-config.js";

const shipped: unknown = JSON.parse(
  readFileSync(new URL("../allowed-tools.json", import.meta.url), "utf8"),
);

const allowed = {
  companion: ["search_guide", "read_guide_page"],
  retroachievements: ["get_game"],
  romm: ["search_roms"],
  syncthing: ["syncthing_overview"],
  outline: ["fetch"],
};

describe("buildMcp", () => {
  it("builds every configured server with its bearer header and allowlist", () => {
    const { config, allowedTools } = buildMcp(
      {
        COMPANION_MCP_URL: "http://companion.test:8080/companion/mcp",
        COMPANION_MCP_TOKEN: "ctok",
        RETROACHIEVEMENTS_MCP_URL: "http://ra.test/mcp",
        ROMM_MCP_URL: "http://romm.test/mcp",
        ROMM_MCP_TOKEN: "rtok",
        SYNCTHING_MCP_URL: "http://st.test/mcp",
        SYNCTHING_MCP_TOKEN: "stok",
        OUTLINE_MCP_URL: "http://outline.test/mcp",
        OUTLINE_API_KEY: "otok",
      },
      allowed,
    );
    expect(config).toEqual({
      mcpServers: {
        companion: {
          type: "http",
          url: "http://companion.test:8080/companion/mcp",
          headers: { authorization: "Bearer ctok" },
        },
        retroachievements: { type: "http", url: "http://ra.test/mcp" },
        romm: {
          type: "http",
          url: "http://romm.test/mcp",
          headers: { authorization: "Bearer rtok" },
        },
        syncthing: {
          type: "http",
          url: "http://st.test/mcp",
          headers: { authorization: "Bearer stok" },
        },
        outline: {
          type: "http",
          url: "http://outline.test/mcp",
          headers: { authorization: "Bearer otok" },
        },
      },
    });
    expect(allowedTools).toEqual([
      "mcp__companion__search_guide",
      "mcp__companion__read_guide_page",
      "mcp__retroachievements__get_game",
      "mcp__romm__search_roms",
      "mcp__syncthing__syncthing_overview",
      "mcp__outline__fetch",
    ]);
  });

  it("omits servers whose URL is unset, whatever their allowlist", () => {
    const { config, allowedTools } = buildMcp(
      { COMPANION_MCP_URL: "http://c.test/mcp", COMPANION_MCP_TOKEN: "t", ROMM_MCP_URL: "" },
      { ...allowed, romm: [] },
    );
    expect(Object.keys(config.mcpServers)).toEqual(["companion"]);
    expect(allowedTools).toEqual([
      "mcp__companion__search_guide",
      "mcp__companion__read_guide_page",
    ]);
  });

  it("refuses a configured server with no allowed tools", () => {
    expect(() =>
      buildMcp(
        { ROMM_MCP_URL: "http://r.test/mcp", ROMM_MCP_TOKEN: "t" },
        { ...allowed, romm: [] },
      ),
    ).toThrow(/romm/);
    expect(() =>
      buildMcp({ RETROACHIEVEMENTS_MCP_URL: "http://ra.test/mcp" }, { companion: ["x"] }),
    ).toThrow(/retroachievements/);
  });

  it("refuses a configured server without its token", () => {
    expect(() => buildMcp({ COMPANION_MCP_URL: "http://c.test/mcp" }, allowed)).toThrow(
      /COMPANION_MCP_TOKEN/,
    );
    expect(() => buildMcp({ OUTLINE_MCP_URL: "http://o.test/mcp" }, allowed)).toThrow(
      /OUTLINE_API_KEY/,
    );
  });

  it.each([
    ["not an object", []],
    ["an unknown server", { ...allowed, vibepollo: ["close_app"] }],
    ["a non-list", { ...allowed, romm: "search_roms" }],
    ["a wildcard", { ...allowed, romm: ["*"] }],
    ["a name with spaces", { ...allowed, romm: ["search roms"] }],
  ])("refuses an allowlist with %s", (_name, list) => {
    expect(() => buildMcp({}, list)).toThrow(/allowed-tools/);
  });

  it("accepts the shipped allowlist, which never names a write tool", () => {
    const env = {
      COMPANION_MCP_URL: "http://c.test/mcp",
      COMPANION_MCP_TOKEN: "t",
      RETROACHIEVEMENTS_MCP_URL: "http://ra.test/mcp",
      ROMM_MCP_URL: "http://r.test/mcp",
      ROMM_MCP_TOKEN: "t",
      SYNCTHING_MCP_URL: "http://s.test/mcp",
      SYNCTHING_MCP_TOKEN: "t",
      OUTLINE_MCP_URL: "http://o.test/mcp",
      OUTLINE_API_KEY: "t",
    };
    const { allowedTools } = buildMcp(env, shipped);
    expect(allowedTools).toContain("mcp__companion__companion_status");
    expect(allowedTools).toHaveLength(5 + 15 + 8 + 26 + 7);
    for (const name of allowedTools) {
      expect(name).not.toMatch(/create|update|delete|write|_config$|ignores/);
    }
  });
});
