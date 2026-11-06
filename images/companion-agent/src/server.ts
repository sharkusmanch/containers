import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { childEnv, claudeArgs, labelArgs, labelEnv } from "./argv.js";
import type { Config } from "./config.js";
import { buildLabelPrompt, parseLabelRequest, parseLabels } from "./label.js";
import { buildPrompt, parseAskRequest, type AskRequest } from "./prompt.js";
import { signalByHome } from "./reap.js";
import { REFUSED, Translator, UNAVAILABLE, type AskEvent } from "./translate.js";

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface AgentOptions {
  config: Config;
  mcpConfigPath: string;
  /** Allowlisted `mcp__<server>__<tool>` names. */
  allowedTools: string[];
  /** The service's environment; the child gets an allowlisted part of it. */
  baseEnv: Record<string, string | undefined>;
  log: Log;
  now?: () => number;
}

type Outcome = "done" | "refused" | "error" | "no_result" | "timeout" | "aborted" | "shutdown";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The most a label run may print; past it the run fails. */
const LABEL_OUTPUT_MAX = 256 * 1024;

/** Signals a whole process group; a group that is already gone is fine. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}

/**
 * Kills whatever a run left running (SIGTERM, then SIGKILL after the grace period when anything
 * was found), then removes its HOME.
 */
async function sweepHome(home: string, graceMs: number): Promise<void> {
  if (signalByHome(home, "SIGTERM") > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    signalByHome(home, "SIGKILL");
  }
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/** One question: a claude process and the NDJSON answer it streams into. */
class Run {
  readonly exited: Promise<void>;
  private outcome: Outcome | null = null;
  private child: ChildProcess | null = null;
  /** This run's HOME, once created: every process of the run carries it. */
  private home: string | null = null;
  private readonly translator = new Translator();
  private pingTimer: NodeJS.Timeout | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  /** Started when claude exits; finishes the run if its stdout never closes. */
  private exitTimer: NodeJS.Timeout | undefined;
  private terminating = false;
  private finalized = false;
  private markExited!: () => void;
  private readonly started: number;

  constructor(
    private readonly opts: AgentOptions,
    private readonly res: ServerResponse,
    private readonly onExit: (run: Run) => void,
  ) {
    this.started = (opts.now ?? Date.now)();
    this.exited = new Promise((resolve) => (this.markExited = resolve));
  }

  async start(req: AskRequest): Promise<void> {
    const { config } = this.opts;
    this.res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    });
    // Headers now: the companion waits for them only briefly.
    this.res.flushHeaders();
    this.armPing();
    this.res.on("close", () => {
      if (!this.res.writableEnded) this.stop("aborted");
    });
    this.timeoutTimer = setTimeout(() => this.stop("timeout"), config.timeoutMs);

    let home: string;
    try {
      home = await mkdtemp(join(config.homeDir, "run-"));
    } catch {
      this.stop("error");
      this.finalize();
      return;
    }
    this.home = home;
    if (this.outcome !== null) {
      this.finalize();
      return;
    }
    const hasClaudeMd = existsSync(join(config.projectDir, "CLAUDE.md"));
    const args = claudeArgs({
      model: config.model,
      mcpConfigPath: this.opts.mcpConfigPath,
      allowedTools: this.opts.allowedTools,
      skillsDirs: config.skillsDirs,
      appendSystemPrompt: hasClaudeMd ? null : req.instructions,
      prompt: buildPrompt(req),
    });
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(config.claudeBin, args, {
        cwd: config.projectDir,
        env: childEnv(this.opts.baseEnv, home, config.childEnvNames),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Invalid arguments throw instead of emitting "error": nothing was started.
      this.finalize();
      return;
    }
    this.child = child;
    child.on("error", () => {
      // Spawning failed (no such binary): there is no process to wait for.
      if (child.pid === undefined) this.finalize();
    });
    child.on("exit", () => {
      // Anything the leader left behind in its group goes with it.
      signalGroup(child.pid, "SIGKILL");
      // A process that left the group can still hold stdout open, and then "close" never comes:
      // after the grace period the run is finished anyway (finalize's cleanUp sweeps its HOME).
      this.exitTimer = setTimeout(() => {
        child.stdout.destroy();
        this.finalize();
      }, this.opts.config.killGraceMs);
    });
    child.on("close", () => this.finalize());
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      for (const e of this.translator.line(line)) this.write(e);
    });
  }

  /** Ends the answer early (when it has not ended) and kills the process group. */
  stop(outcome: Outcome): void {
    if (this.outcome === null && !this.translator.finished) {
      this.outcome = outcome;
      if (outcome !== "aborted") this.write({ type: "error", message: UNAVAILABLE });
      this.translator.finish();
      this.endResponse();
    }
    this.terminate();
  }

  private terminate(): void {
    const pid = this.child?.pid;
    if (this.terminating || pid === undefined || this.child?.exitCode !== null) return;
    this.terminating = true;
    this.signalAll(pid, "SIGTERM");
    this.killTimer = setTimeout(() => this.signalAll(pid, "SIGKILL"), this.opts.config.killGraceMs);
  }

  /** claude's process group, and every process of the run that left it (Bash commands). */
  private signalAll(pid: number, signal: NodeJS.Signals): void {
    signalGroup(pid, signal);
    if (this.home !== null) signalByHome(this.home, signal);
  }

  private write(e: AskEvent): void {
    if (this.res.writableEnded) return;
    this.res.write(`${JSON.stringify(e)}\n`);
    if (e.type === "done" || e.type === "error") {
      this.outcome ??= e.type === "done" ? "done" : e.message === REFUSED ? "refused" : "error";
      this.endResponse();
    } else {
      this.armPing();
    }
  }

  private armPing(): void {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => this.write({ type: "ping" }), this.opts.config.pingMs);
  }

  private endResponse(): void {
    clearTimeout(this.pingTimer);
    if (!this.res.writableEnded) this.res.end();
  }

  /** claude has exited (or never started): end the answer, log, clean up, free the slot. */
  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const ending = this.translator.finish();
    if (ending.length > 0) this.outcome ??= "no_result";
    for (const e of ending) this.write(e);
    this.endResponse();
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.killTimer);
    clearTimeout(this.exitTimer);
    const s = this.translator.summary();
    this.opts.log("ask", {
      outcome: this.outcome,
      ms: (this.opts.now ?? Date.now)() - this.started,
      turns: s.turns,
      tools: s.tools,
      result: s.result,
      costUsd: s.costUsd,
      usage: s.usage,
    });
    void this.cleanUp().then(() => {
      this.onExit(this);
      this.markExited();
    });
  }

  /**
   * Kills whatever the run left running (SIGTERM, then SIGKILL after the grace period when
   * anything was found), then removes its HOME. The slot stays taken until then.
   */
  private async cleanUp(): Promise<void> {
    if (this.home !== null) await sweepHome(this.home, this.opts.config.killGraceMs);
  }
}

type LabelOutcome = "done" | "error" | "timeout" | "aborted" | "shutdown";

/** The `result` message of `claude -p --output-format json` output (one object, or an array). */
function resultMessage(stdout: string): Json | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isRecord(m) && m.type === "result") return m;
  }
  return null;
}

/**
 * One label request: a haiku run with no tools whose JSON result is turned into labels. Answers
 * `200 {"labels"}` once claude has exited with a result, else `502` (failure, timeout, shutdown).
 * The process handling (own group, own HOME, kill on timeout or disconnect) is the question's.
 */
class LabelRun {
  readonly exited: Promise<void>;
  readonly started: number;
  private outcome: LabelOutcome | null = null;
  private child: ChildProcess | null = null;
  private home: string | null = null;
  private readonly output: Buffer[] = [];
  private outputSize = 0;
  private labelCount: number | null = null;
  private result: Json | null = null;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private exitTimer: NodeJS.Timeout | undefined;
  private terminating = false;
  private finalized = false;
  private markExited!: () => void;

  constructor(
    private readonly opts: AgentOptions,
    private readonly res: ServerResponse,
    private readonly titles: string[],
    private readonly onExit: () => void,
  ) {
    this.started = (opts.now ?? Date.now)();
    this.exited = new Promise((resolve) => (this.markExited = resolve));
  }

  /** When the run will have been killed by its timeout at the latest. */
  get deadline(): number {
    return this.started + this.opts.config.labelTimeoutMs;
  }

  async start(): Promise<void> {
    const { config } = this.opts;
    this.res.on("close", () => {
      if (!this.res.writableEnded) this.stop("aborted");
    });
    this.timeoutTimer = setTimeout(() => this.stop("timeout"), config.labelTimeoutMs);

    let home: string;
    try {
      home = await mkdtemp(join(config.homeDir, "run-"));
    } catch {
      this.stop("error");
      this.finalize();
      return;
    }
    this.home = home;
    if (this.outcome !== null) {
      this.finalize();
      return;
    }
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      // The run's empty HOME is also its working directory: no house rules or project settings.
      child = spawn(config.claudeBin, labelArgs(buildLabelPrompt(this.titles)), {
        cwd: home,
        env: labelEnv(this.opts.baseEnv, home),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      this.finalize();
      return;
    }
    this.child = child;
    child.on("error", () => {
      if (child.pid === undefined) this.finalize();
    });
    child.on("exit", () => {
      signalGroup(child.pid, "SIGKILL");
      this.exitTimer = setTimeout(() => {
        child.stdout.destroy();
        this.finalize();
      }, config.killGraceMs);
    });
    child.on("close", () => this.finalize());
    child.stdout.on("data", (chunk: Buffer) => {
      this.outputSize += chunk.length;
      if (this.outputSize > LABEL_OUTPUT_MAX) this.stop("error");
      else this.output.push(chunk);
    });
  }

  /** Fails the request (when it has not been answered) and kills the process group. */
  stop(outcome: LabelOutcome): void {
    if (this.outcome === null) {
      this.outcome = outcome;
      this.fail();
    }
    this.terminate();
  }

  private fail(): void {
    if (this.outcome !== "aborted" && !this.res.headersSent) {
      json(this.res, 502, { error: "unavailable" });
    }
  }

  private terminate(): void {
    const pid = this.child?.pid;
    if (this.terminating || pid === undefined || this.child?.exitCode !== null) return;
    this.terminating = true;
    this.signalAll(pid, "SIGTERM");
    this.killTimer = setTimeout(() => this.signalAll(pid, "SIGKILL"), this.opts.config.killGraceMs);
  }

  private signalAll(pid: number, signal: NodeJS.Signals): void {
    signalGroup(pid, signal);
    if (this.home !== null) signalByHome(this.home, signal);
  }

  /** claude has exited (or never started): answer, log, clean up, free the slot. */
  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.outcome === null) {
      const result = resultMessage(Buffer.concat(this.output).toString("utf8"));
      this.result = result;
      if (
        result !== null &&
        result.subtype === "success" &&
        result.is_error !== true &&
        typeof result.result === "string"
      ) {
        const labels = parseLabels(result.result, this.titles);
        this.outcome = "done";
        this.labelCount = Object.keys(labels).length;
        json(this.res, 200, { labels });
      } else {
        this.outcome = "error";
        this.fail();
      }
    }
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.killTimer);
    clearTimeout(this.exitTimer);
    const r = this.result;
    const usage: Record<string, number> = {};
    if (r !== null && isRecord(r.usage)) {
      for (const [k, v] of Object.entries(r.usage)) if (typeof v === "number") usage[k] = v;
    }
    this.opts.log("label", {
      outcome: this.outcome,
      ms: (this.opts.now ?? Date.now)() - this.started,
      titles: this.titles.length,
      labels: this.labelCount,
      result: r !== null && typeof r.subtype === "string" ? r.subtype : null,
      costUsd: r !== null && typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
      usage,
    });
    const home = this.home;
    void (home === null ? Promise.resolve() : sweepHome(home, this.opts.config.killGraceMs)).then(
      () => {
        this.onExit();
        this.markExited();
      },
    );
  }
}

/**
 * `POST /ask` runs one `claude -p` per question and streams its answer as NDJSON AskEvents.
 * At most `maxConcurrent` questions run at once. `POST /label` runs haiku, one request at a time,
 * to name guide pages for the rail. Logs carry counts only, never any question, answer, tool
 * input, title or label text.
 */
export class AgentServer {
  readonly server: Server;
  private readonly runs = new Set<Run>();
  private labelRun: LabelRun | null = null;
  private closing = false;
  private readonly tokenDigest: Buffer;

  constructor(private readonly opts: AgentOptions) {
    this.tokenDigest = digest(opts.config.agentToken);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "internal" });
        else res.end();
      });
    });
  }

  /** Questions and label runs whose claude process has not exited yet. */
  get running(): number {
    return this.runs.size + (this.labelRun === null ? 0 : 1);
  }

  /** Stops accepting, ends every running answer and waits for each process group to die. */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.server.close();
    this.server.closeIdleConnections();
    const runs = [...this.runs];
    for (const run of runs) run.stop("shutdown");
    const label = this.labelRun;
    label?.stop("shutdown");
    await Promise.all([...runs.map((r) => r.exited), label?.exited]);
  }

  private refuse(res: ServerResponse, status: number, body: unknown): void {
    this.opts.log("refused", { status });
    json(res, status, body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
    if (path !== "/ask" && path !== "/label") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!this.authorized(req.headers.authorization)) {
      return this.refuse(res, 401, { error: "unauthorized" });
    }
    const raw = await this.readBody(req);
    if (raw === null) {
      res.setHeader("connection", "close");
      return this.refuse(res, 413, { error: "too large" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (path === "/label") return this.label(res, parsed);
    const ask = parseAskRequest(parsed);
    if (ask === null) return this.refuse(res, 400, { error: "invalid body" });
    if (this.closing) return this.refuse(res, 503, { error: "shutting down" });
    if (this.runs.size >= this.opts.config.maxConcurrent) {
      return this.refuse(res, 429, { error: "busy" });
    }
    const run = new Run(this.opts, res, (r) => this.runs.delete(r));
    this.runs.add(run);
    await run.start(ask);
  }

  /** One label run at a time; another request meanwhile gets 429 with the time it may take. */
  private async label(res: ServerResponse, parsed: unknown): Promise<void> {
    const titles = parseLabelRequest(parsed);
    if (titles === null) return this.refuse(res, 400, { error: "invalid body" });
    if (this.closing) return this.refuse(res, 503, { error: "shutting down" });
    if (this.labelRun !== null) {
      const left = this.labelRun.deadline - (this.opts.now ?? Date.now)();
      res.setHeader("retry-after", String(Math.max(1, Math.ceil(left / 1000))));
      return this.refuse(res, 429, { error: "busy" });
    }
    const run = new LabelRun(this.opts, res, titles, () => {
      if (this.labelRun === run) this.labelRun = null;
    });
    this.labelRun = run;
    await run.start();
  }

  private authorized(header: string | undefined): boolean {
    const match = /^Bearer (.+)$/.exec(header ?? "");
    if (match?.[1] === undefined) return false;
    return timingSafeEqual(digest(match[1]), this.tokenDigest);
  }

  /** The body as text, or null when it is over the limit. */
  private async readBody(req: IncomingMessage): Promise<string | null> {
    const max = this.opts.config.maxBodyBytes;
    if (Number(req.headers["content-length"] ?? 0) > max) {
      req.resume();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) {
        req.resume();
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
