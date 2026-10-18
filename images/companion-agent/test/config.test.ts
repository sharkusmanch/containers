import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies the defaults", () => {
    expect(loadConfig({ AGENT_TOKEN: "t", HOME: "/home/agent" })).toEqual({
      port: 8080,
      agentToken: "t",
      claudeBin: "claude",
      model: "opus",
      projectDir: "/agent/project",
      skillsDir: "/agent/skills/redlib",
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
      skillsDir: "/s",
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
