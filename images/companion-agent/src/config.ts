export interface Config {
  port: number;
  agentToken: string;
  claudeBin: string;
  model: string;
  /** claude's working directory, holding CLAUDE.md. */
  projectDir: string;
  /** The redlib plugin directory, loaded with --plugin-dir. */
  skillsDir: string;
  /** The service's writable HOME; each run gets its own directory inside it. */
  homeDir: string;
  timeoutMs: number;
  /** Time between SIGTERM and SIGKILL to a run's process group. */
  killGraceMs: number;
  /** Ping interval while nothing was written. */
  pingMs: number;
  maxConcurrent: number;
  maxBodyBytes: number;
}

function positiveInt(env: Record<string, string | undefined>, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`${key} is required`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const or = (key: string, dflt: string): string => {
    const v = env[key];
    return v === undefined || v === "" ? dflt : v;
  };
  return {
    port: positiveInt(env, "PORT", 8080),
    agentToken: required(env, "AGENT_TOKEN"),
    claudeBin: or("CLAUDE_BIN", "claude"),
    model: or("AGENT_MODEL", "opus"),
    projectDir: or("AGENT_PROJECT_DIR", "/agent/project"),
    skillsDir: or("AGENT_SKILLS_DIR", "/agent/skills/redlib"),
    homeDir: required(env, "HOME"),
    timeoutMs: positiveInt(env, "AGENT_TIMEOUT_MS", 180_000),
    killGraceMs: 3_000,
    pingMs: 15_000,
    maxConcurrent: 2,
    maxBodyBytes: 64 * 1024,
  };
}
