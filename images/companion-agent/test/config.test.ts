import { describe, expect, it } from "vitest";
import { loadConfig, skillsStatus } from "../src/config.js";

describe("loadConfig", () => {
  it("applies the defaults", () => {
    expect(loadConfig({ AGENT_TOKEN: "t", HOME: "/home/agent" })).toEqual({
      port: 8080,
      agentToken: "t",
      claudeBin: "claude",
      model: "opus",
      projectDir: "/agent/project",
      skillsDirs: ["/agent/skills/redlib"],
      childEnvNames: [],
      homeDir: "/home/agent",
      timeoutMs: 180_000,
      killGraceMs: 3_000,
      pingMs: 15_000,
      maxConcurrent: 2,
      maxBodyBytes: 65_536,
    });
  });

  it("reads the overrides", () => {
    expect(
      loadConfig({
        AGENT_TOKEN: "t",
        HOME: "/h",
        PORT: "9000",
        CLAUDE_BIN: "/opt/claude",
        AGENT_MODEL: "sonnet",
        AGENT_PROJECT_DIR: "/p",
        AGENT_SKILLS_DIR: "/s",
        AGENT_TIMEOUT_MS: "5000",
      }),
    ).toMatchObject({
      port: 9000,
      claudeBin: "/opt/claude",
      model: "sonnet",
      projectDir: "/p",
      skillsDirs: ["/s"],
      timeoutMs: 5000,
    });
  });

  it.each([
    ["no token", { HOME: "/h" }, /AGENT_TOKEN/],
    ["an empty token", { AGENT_TOKEN: "", HOME: "/h" }, /AGENT_TOKEN/],
    ["no HOME", { AGENT_TOKEN: "t" }, /HOME/],
    ["a bad port", { AGENT_TOKEN: "t", HOME: "/h", PORT: "x" }, /PORT/],
    ["a bad timeout", { AGENT_TOKEN: "t", HOME: "/h", AGENT_TIMEOUT_MS: "0" }, /AGENT_TIMEOUT_MS/],
  ])("refuses %s", (_name, env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});

const ok = { AGENT_TOKEN: "t", HOME: "/h" };

describe("loadConfig: skills", () => {
  it("splits AGENT_SKILLS_DIRS on commas, trimming and dropping empty items", () => {
    expect(
      loadConfig({ ...ok, AGENT_SKILLS_DIRS: " /agent/skills/redlib, /agent/skills/vibepollo ,," })
        .skillsDirs,
    ).toEqual(["/agent/skills/redlib", "/agent/skills/vibepollo"]);
  });

  it("keeps AGENT_SKILLS_DIR working when AGENT_SKILLS_DIRS is unset or empty", () => {
    expect(loadConfig({ ...ok, AGENT_SKILLS_DIR: "/s" }).skillsDirs).toEqual(["/s"]);
    expect(loadConfig({ ...ok, AGENT_SKILLS_DIR: "/s", AGENT_SKILLS_DIRS: "" }).skillsDirs).toEqual(
      ["/s"],
    );
  });

  it("prefers AGENT_SKILLS_DIRS when both are set", () => {
    expect(
      loadConfig({ ...ok, AGENT_SKILLS_DIR: "/old", AGENT_SKILLS_DIRS: "/a,/b" }).skillsDirs,
    ).toEqual(["/a", "/b"]);
  });

  it("falls back to the default when AGENT_SKILLS_DIRS holds only separators", () => {
    expect(loadConfig({ ...ok, AGENT_SKILLS_DIRS: " , " }).skillsDirs).toEqual([
      "/agent/skills/redlib",
    ]);
  });
});

describe("skillsStatus", () => {
  it("lists the basenames of the plugin dirs that exist and of those that are missing", () => {
    const exists = (dir: string): boolean => dir !== "/agent/skills/gone";
    expect(
      skillsStatus(
        ["/agent/skills/redlib", "/agent/skills/gone", "/agent/skills/vibepollo"],
        exists,
      ),
    ).toEqual({ loaded: ["redlib", "vibepollo"], missing: ["gone"] });
  });
});

describe("loadConfig: AGENT_CHILD_ENV", () => {
  it("parses a comma-separated list of names", () => {
    expect(
      loadConfig({ ...ok, AGENT_CHILD_ENV: " VIBEPOLLO_TOKEN, VIBEPOLLO_HOST,," }).childEnvNames,
    ).toEqual(["VIBEPOLLO_TOKEN", "VIBEPOLLO_HOST"]);
  });

  it("is empty when unset or empty", () => {
    expect(loadConfig({ ...ok, AGENT_CHILD_ENV: "" }).childEnvNames).toEqual([]);
  });

  it.each([
    ["a lowercase name", "vibepollo_token"],
    ["a name starting with a digit", "1TOKEN"],
    ["a name with a dash", "A-B"],
    ["an assignment", "A=b"],
  ])("refuses %s", (_name, value) => {
    expect(() => loadConfig({ ...ok, AGENT_CHILD_ENV: value })).toThrow(/AGENT_CHILD_ENV.*valid/);
  });

  it.each([
    "HOME",
    "PATH",
    "LANG",
    "TZ",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "REDLIB_URL",
    "CLAUDE_PLUGIN_ROOT",
    "ENABLE_TOOL_SEARCH",
    "DISABLE_AUTOUPDATER",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ])("refuses %s, which the service controls", (name) => {
    expect(() => loadConfig({ ...ok, AGENT_CHILD_ENV: `VIBEPOLLO_HOST,${name}` })).toThrow(
      new RegExp(`AGENT_CHILD_ENV.*${name}`),
    );
  });

  it.each([
    "AGENT_TOKEN",
    "COMPANION_MCP_TOKEN",
    "ROMM_MCP_TOKEN",
    "SYNCTHING_MCP_TOKEN",
    "OUTLINE_API_KEY",
  ])("refuses %s, a secret that must never reach the child", (name) => {
    expect(() => loadConfig({ ...ok, AGENT_CHILD_ENV: name })).toThrow(
      new RegExp(`AGENT_CHILD_ENV.*${name}`),
    );
  });

  it("allows other names containing TOKEN", () => {
    expect(loadConfig({ ...ok, AGENT_CHILD_ENV: "VIBEPOLLO_TOKEN" }).childEnvNames).toEqual([
      "VIBEPOLLO_TOKEN",
    ]);
  });
});
