/**
 * The built-in tools the agent gets, and no others: never Agent/Task (sub-agents get their own
 * tool policy), Write, Edit or NotebookEdit. `Skill` is what shows the model the skill list
 * (the redlib plugin loaded with --plugin-dir, plus Claude Code's built-in skills); without it
 * the model sees no skills at all.
 */
export const BUILTIN_TOOLS = [
  "Bash",
  "WebSearch",
  "WebFetch",
  "Read",
  "Grep",
  "Glob",
  "Skill",
] as const;

export interface ClaudeRun {
  model: string;
  mcpConfigPath: string;
  /** Allowlisted `mcp__<server>__<tool>` names. */
  allowedTools: string[];
  skillsDir: string;
  /** The request's instructions when the project folder has no CLAUDE.md, else null. */
  appendSystemPrompt: string | null;
  prompt: string;
}

/** The `claude` arguments for one question. The prompt comes last, after `--`. */
export function claudeArgs(run: ClaudeRun): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    run.model,
    "--mcp-config",
    run.mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    BUILTIN_TOOLS.join(","),
    "--allowedTools",
    [...BUILTIN_TOOLS, ...run.allowedTools].join(","),
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--setting-sources",
    "user,project",
    "--plugin-dir",
    run.skillsDir,
    ...(run.appendSystemPrompt === null ? [] : ["--append-system-prompt", run.appendSystemPrompt]),
    // The option lists above are variadic: `--` keeps the prompt from being read as one of them,
    // or as an option when it starts with a dash.
    "--",
    run.prompt,
  ];
}

// Copied from the service's environment when set; nothing else is (no AGENT_TOKEN, MCP tokens).
const PASSED = ["PATH", "LANG", "TZ", "CLAUDE_CODE_OAUTH_TOKEN", "REDLIB_URL"] as const;

/** The environment of one claude run, built as an allowlist. */
export function childEnv(
  base: Record<string, string | undefined>,
  runHome: string,
  skillsDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = runHome;
  // The redlib skill runs `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/redlib.py`.
  env.CLAUDE_PLUGIN_ROOT = skillsDir;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  // MCP tools stay loaded up front: deferred behind ToolSearch (not in --tools) they would be
  // unreachable.
  env.ENABLE_TOOL_SEARCH = "false";
  return env;
}
