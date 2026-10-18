import { existsSync } from "node:fs";
import { basename } from "node:path";
import { CONTROLLED_ENV, SECRET_ENV } from "./argv.js";

export interface Config {
  port: number;
  agentToken: string;
  claudeBin: string;
  model: string;
  /** claude's working directory, holding CLAUDE.md. */
  projectDir: string;
  /** The plugin directories (redlib, vibepollo, ...), each loaded with its own --plugin-dir. */
  skillsDirs: string[];
  /** Extra env var names copied from the service's environment into the claude child. */
  childEnvNames: string[];
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

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** AGENT_SKILLS_DIRS, else AGENT_SKILLS_DIR (the single-plugin form), else the redlib default. */
function skillsDirs(env: Record<string, string | undefined>): string[] {
  const many = list(env.AGENT_SKILLS_DIRS);
  if (many.length > 0) return many;
  const one = env.AGENT_SKILLS_DIR;
  return one === undefined || one === "" ? ["/agent/skills/redlib"] : [one];
}

function childEnvNames(env: Record<string, string | undefined>): string[] {
  const names = list(env.AGENT_CHILD_ENV);
  for (const name of names) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`AGENT_CHILD_ENV: "${name}" is not a valid variable name (A-Z, 0-9, _)`);
    }
    if (CONTROLLED_ENV.has(name) || SECRET_ENV.has(name)) {
      throw new Error(`AGENT_CHILD_ENV: ${name} is controlled by the service and cannot be listed`);
    }
  }
  return names;
}

/** The basenames of the plugin directories that exist, and of those that do not. */
export function skillsStatus(
  dirs: readonly string[],
  exists: (dir: string) => boolean = existsSync,
): { loaded: string[]; missing: string[] } {
  const loaded: string[] = [];
  const missing: string[] = [];
  for (const dir of dirs) (exists(dir) ? loaded : missing).push(basename(dir));
  return { loaded, missing };
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
    skillsDirs: skillsDirs(env),
    childEnvNames: childEnvNames(env),
    homeDir: required(env, "HOME"),
    timeoutMs: positiveInt(env, "AGENT_TIMEOUT_MS", 180_000),
    killGraceMs: 3_000,
    pingMs: 15_000,
    maxConcurrent: 2,
    maxBodyBytes: 64 * 1024,
  };
}
