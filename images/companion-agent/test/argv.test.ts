import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, claudeArgs, childEnv } from "../src/argv.js";

const base = {
  model: "opus",
  mcpConfigPath: "/tmp/mcp.json",
  allowedTools: ["mcp__companion__search_guide", "mcp__romm__get_rom"],
  skillsDir: "/agent/skills/redlib",
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
      "/agent/skills/redlib",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TZ: "UTC",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      REDLIB_URL: "http://redlib.test",
      HOME: "/home/agent/run-1",
      CLAUDE_PLUGIN_ROOT: "/agent/skills/redlib",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
  });

  it("keeps MCP tools loaded up front, never deferred behind ToolSearch (not in --tools)", () => {
    const env = childEnv({ ENABLE_TOOL_SEARCH: "true" }, "/home/agent/run-1", "/agent/skills");
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
    expect(BUILTIN_TOOLS).not.toContain("ToolSearch");
  });
});
