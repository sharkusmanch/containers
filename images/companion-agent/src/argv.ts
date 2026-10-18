import { MCP_SECRET_ENV } from "./mcp-config.js";

/**
 * The built-in tools the agent gets, and no others: never Agent/Task (sub-agents get their own
 * tool policy), Write, Edit or NotebookEdit. `Skill` is what shows the model the skill list
 * (the plugins loaded with --plugin-dir, plus Claude Code's built-in skills); without it
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
  /** Plugin directories, each loaded with its own --plugin-dir. */
  skillsDirs: string[];
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
    ...run.skillsDirs.flatMap((dir) => ["--plugin-dir", dir]),
    ...(run.appendSystemPrompt === null ? [] : ["--append-system-prompt", run.appendSystemPrompt]),
    // The option lists above are variadic: `--` keeps the prompt from being read as one of them,
    // or as an option when it starts with a dash.
    "--",
    run.prompt,
  ];
}

// Copied from the service's environment when set; nothing else is (no AGENT_TOKEN, MCP tokens)
// except the names the operator lists in AGENT_CHILD_ENV.
const PASSED = ["PATH", "LANG", "TZ", "CLAUDE_CODE_OAUTH_TOKEN", "REDLIB_URL"] as const;

// Set by the service itself. CLAUDE_PLUGIN_ROOT is here only to keep it off AGENT_CHILD_ENV:
// Claude Code substitutes it per plugin inside each skill's text, and the service must not set a
// single value for several plugins.
const SET = [
  "HOME",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "ENABLE_TOOL_SEARCH",
] as const;

/** Names AGENT_CHILD_ENV may not list: the service controls them. */
export const CONTROLLED_ENV: ReadonlySet<string> = new Set([...PASSED, ...SET]);

/** Secrets the claude child must never get, whatever AGENT_CHILD_ENV says. */
export const SECRET_ENV: ReadonlySet<string> = new Set(["AGENT_TOKEN", ...MCP_SECRET_ENV]);

/** The environment of one claude run, built as an allowlist. */
export function childEnv(
  base: Record<string, string | undefined>,
  runHome: string,
  extraNames: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  // The extra names are refused here too, not only in loadConfig: a name the service controls or a
  // secret is never copied.
  const extra = extraNames.filter((name) => !CONTROLLED_ENV.has(name) && !SECRET_ENV.has(name));
  for (const key of [...PASSED, ...extra]) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = runHome;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  // MCP tools stay loaded up front: deferred behind ToolSearch (not in --tools) they would be
  // unreachable.
  env.ENABLE_TOOL_SEARCH = "false";
  // CLAUDE_PLUGIN_ROOT is never copied or set (it is in CONTROLLED_ENV, so no extra name copies
  // it): Claude Code expands it per plugin in skill text.
  return env;
}
