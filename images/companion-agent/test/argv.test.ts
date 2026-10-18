import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, claudeArgs, childEnv } from "../src/argv.js";

const base = {
  model: "opus",
  mcpConfigPath: "/tmp/mcp.json",
  allowedTools: ["mcp__companion__search_guide", "mcp__romm__get_rom"],
  skillsDirs: ["/agent/skills/redlib"],
  prompt: "-Question: starts with a dash",
};

describe("claudeArgs", () => {
  it("builds the locked-down headless command with the prompt last", () => {
    expect(claudeArgs({ ...base, appendSystemPrompt: null })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "opus",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--tools",
      "Bash,WebSearch,WebFetch,Read,Grep,Glob,Skill",
      "--allowedTools",
      "Bash,WebSearch,WebFetch,Read,Grep,Glob,Skill,mcp__companion__search_guide,mcp__romm__get_rom",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--setting-sources",
      "user,project",
      "--plugin-dir",
      "/agent/skills/redlib",
      "--",
      "-Question: starts with a dash",
    ]);
  });

  it("passes each skills dir as its own --plugin-dir, in order", () => {
    const args = claudeArgs({
      ...base,
      skillsDirs: ["/agent/skills/redlib", "/agent/skills/vibepollo"],
      appendSystemPrompt: null,
    });
    const dirs = args.flatMap((a, i) => (args[i - 1] === "--plugin-dir" ? [a] : []));
    expect(dirs).toEqual(["/agent/skills/redlib", "/agent/skills/vibepollo"]);
    expect(args.filter((a) => a === "--plugin-dir")).toHaveLength(2);
    expect(args.slice(-2)).toEqual(["--", base.prompt]);
  });

  it("passes the instructions as an appended system prompt when asked", () => {
    const args = claudeArgs({ ...base, appendSystemPrompt: "House rules." });
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toBe("House rules.");
    expect(args.slice(-2)).toEqual(["--", base.prompt]);
  });

  it("never offers sub-agents or file-writing tools", () => {
    for (const forbidden of ["Agent", "Task", "Write", "Edit", "NotebookEdit"]) {
      expect(BUILTIN_TOOLS).not.toContain(forbidden);
    }
  });

  it("offers and allows the Skill tool, so the model sees the redlib skill", () => {
    const args = claudeArgs({ ...base, appendSystemPrompt: null });
    const listAfter = (flag: string): string[] => (args[args.indexOf(flag) + 1] ?? "").split(",");
    expect(listAfter("--tools")).toContain("Skill");
    expect(listAfter("--allowedTools")).toContain("Skill");
  });
});

describe("childEnv", () => {
  it("passes only what claude and the skill need", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/agent",
        LANG: "C.UTF-8",
        TZ: "UTC",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        REDLIB_URL: "http://redlib.test",
        AGENT_TOKEN: "secret",
        COMPANION_MCP_TOKEN: "secret",
        OUTLINE_API_KEY: "secret",
      },
      "/home/agent/run-1",
      [],
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TZ: "UTC",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      REDLIB_URL: "http://redlib.test",
      HOME: "/home/agent/run-1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
  });

  it("keeps MCP tools loaded up front, never deferred behind ToolSearch (not in --tools)", () => {
    const env = childEnv({ ENABLE_TOOL_SEARCH: "true" }, "/home/agent/run-1", []);
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
    expect(BUILTIN_TOOLS).not.toContain("ToolSearch");
  });

  it("leaves CLAUDE_PLUGIN_ROOT to Claude Code, which substitutes it per plugin", () => {
    const env = childEnv({ CLAUDE_PLUGIN_ROOT: "/elsewhere" }, "/home/agent/run-1", []);
    expect(env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
  });

  it("copies the extra names that are set and skips those that are not", () => {
    const env = childEnv(
      { VIBEPOLLO_TOKEN: "ro-token", AGENT_TOKEN: "secret", PATH: "/usr/bin" },
      "/home/agent/run-1",
      ["VIBEPOLLO_TOKEN", "VIBEPOLLO_HOST"],
    );
    expect(env.VIBEPOLLO_TOKEN).toBe("ro-token");
    expect("VIBEPOLLO_HOST" in env).toBe(false);
    expect(env.AGENT_TOKEN).toBeUndefined();
  });

  it("never lets an extra name override what the service controls", () => {
    const env = childEnv(
      { HOME: "/server-home", ENABLE_TOOL_SEARCH: "true" },
      "/home/agent/run-1",
      ["HOME", "ENABLE_TOOL_SEARCH"],
    );
    expect(env.HOME).toBe("/home/agent/run-1");
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
  });
});
