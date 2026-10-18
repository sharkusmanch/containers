import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { AgentServer } from "../src/server.js";
import { REFUSED, UNAVAILABLE, type AskEvent } from "../src/translate.js";
import { ev, fakeClaudePath, fixturePath, textBlock } from "./helpers.js";

const TOKEN = "test-agent-token";

interface Harness {
  agent: AgentServer;
  url: string;
  dir: string;
  project: string;
  home: string;
  logs: { msg: string; extra: Record<string, unknown> }[];
}

let h: Harness;

async function start(overrides: Partial<Config> = {}, claudeMd = true): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
  const project = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(project);
  mkdirSync(home);
  if (claudeMd) writeFileSync(join(project, "CLAUDE.md"), "# House rules\n");
  const config: Config = {
    port: 0,
    agentToken: TOKEN,
    claudeBin: fakeClaudePath,
    model: "opus",
    projectDir: project,
    skillsDir: "/agent/skills/redlib",
    homeDir: home,
    timeoutMs: 10_000,
    killGraceMs: 200,
    pingMs: 15_000,
    maxConcurrent: 2,
    maxBodyBytes: 65_536,
    ...overrides,
  };
  const logs: Harness["logs"] = [];
  const agent = new AgentServer({
    config,
    mcpConfigPath: join(dir, "mcp.json"),
    allowedTools: ["mcp__companion__search_guide"],
    baseEnv: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
      AGENT_TOKEN: TOKEN,
      COMPANION_MCP_TOKEN: "mcp-secret",
    },
    log: (msg, extra = {}) => logs.push({ msg, extra }),
  });
  await new Promise<void>((resolve) => agent.server.listen(0, "127.0.0.1", resolve));
  const { port } = agent.server.address() as AddressInfo;
  return { agent, url: `http://127.0.0.1:${port}`, dir, project, home, logs };
}

beforeEach(async () => {
  h = await start();
});

async function stop(harness: Harness): Promise<void> {
  await harness.agent.shutdown();
  rmSync(harness.dir, { recursive: true, force: true });
}

afterEach(async () => {
  await stop(h);
});

/** Replaces the default harness with one using other settings. */
async function restart(overrides: Partial<Config>): Promise<void> {
  await stop(h);
  h = await start(overrides);
}

const body = (question: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    instructions: "Fallback rules.",
    statusBlock: "Game: STATUS-MARKER",
    history: [{ question: "HISTORY-Q", answer: "HISTORY-A" }],
    question,
    depth: "hint",
    hub: "hub-9",
    ...extra,
  });

function ask(
  payload: string,
  opts: { token?: string | null; signal?: AbortSignal; harness?: Harness } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${(opts.harness ?? h).url}/ask`, {
    method: "POST",
    headers,
    body: payload,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

async function events(res: Response): Promise<AskEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as AskEvent);
}

const merged = (list: AskEvent[]): AskEvent[] =>
  list.reduce<AskEvent[]>((out, e) => {
    const last = out[out.length - 1];
    if (e.type === "text" && last?.type === "text") last.text += e.text;
    else out.push(e.type === "text" ? { ...e } : e);
    return out;
  }, []);

interface FakeRecord {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
  grandchild?: number;
}

function records(harness: Harness = h): FakeRecord[] {
  return readdirSync(harness.project)
    .filter((f) => f.startsWith("fake-"))
    .map((f) => JSON.parse(readFileSync(join(harness.project, f), "utf8")) as FakeRecord);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function writeStream(name: string, lines: string[]): string {
  const file = join(h.dir, name);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("requests", () => {
  it("answers the health check", async () => {
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each([
    ["no token", null],
    ["a wrong token", "nope"],
    ["a longer wrong token", TOKEN + "x"],
  ])("refuses %s with 401", async (_name, token) => {
    const res = await ask(body("replay:/nonexistent"), { token });
    expect(res.status).toBe(401);
    expect(records()).toEqual([]);
  });

  it("refuses a body over 64 KiB with 413", async () => {
    const res = await ask(body("x".repeat(70_000)));
    expect(res.status).toBe(413);
    expect(records()).toEqual([]);
  });

  it.each([
    ["broken JSON", "{"],
    ["a bad shape", JSON.stringify({ question: "q" })],
  ])("refuses %s with 400", async (_name, payload) => {
    const res = await ask(payload);
    expect(res.status).toBe(400);
  });

  it("answers other paths and methods with 404 and 405", async () => {
    expect((await fetch(`${h.url}/other`)).status).toBe(404);
    expect((await fetch(`${h.url}/ask`)).status).toBe(405);
  });
});

describe("answering", () => {
  it("streams a recorded answer as NDJSON AskEvents", async () => {
    const res = await ask(body(`replay:${fixturePath("mcp-bash.jsonl")}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const list = merged(await events(res));
    expect(list[0]).toEqual({ type: "lookup", label: "Searched your guide: chest" });
    expect(list[1]).toEqual({ type: "lookup", label: "Ran a command" });
    expect(list[2]?.type).toBe("text");
    expect(list[3]).toEqual({ type: "done", truncatedGuide: false });
    expect(list).toHaveLength(4);
  });

  it("starts claude locked down, in the project folder, with a private HOME", async () => {
    const res = await ask(body(`replay:${fixturePath("websearch.jsonl")}`));
    await res.text();
    const [rec] = records();
    expect(rec).toBeDefined();
    if (!rec) return;
    expect(rec.cwd).toBe(h.project);
    expect(rec.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "opus",
      "--mcp-config",
      join(h.dir, "mcp.json"),
      "--strict-mcp-config",
      "--tools",
      "Bash,WebSearch,WebFetch,Read,Grep,Glob,Skill",
      "--allowedTools",
      "Bash,WebSearch,WebFetch,Read,Grep,Glob,Skill,mcp__companion__search_guide",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--setting-sources",
      "user,project",
      "--plugin-dir",
      "/agent/skills/redlib",
      "--",
      [
        "Game: STATUS-MARKER",
        "Earlier question: HISTORY-Q\nEarlier answer: HISTORY-A",
        "Answer depth: hint",
        "Guide hub id: hub-9",
        `Question: replay:${fixturePath("websearch.jsonl")}`,
      ].join("\n\n"),
    ]);
    const runHome = rec.env.HOME ?? "";
    expect(runHome.startsWith(join(h.home, "run-"))).toBe(true);
    expect(rec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
    expect(rec.env.CLAUDE_PLUGIN_ROOT).toBe("/agent/skills/redlib");
    expect(rec.env.AGENT_TOKEN).toBeUndefined();
    expect(rec.env.COMPANION_MCP_TOKEN).toBeUndefined();
    // The run's HOME is removed once claude has exited.
    await until(() => !existsSync(runHome));
  });

  it("passes the instructions as a system prompt when the project has no CLAUDE.md", async () => {
    const bare = await start({}, false);
    try {
      const res = await ask(body(`replay:${fixturePath("websearch.jsonl")}`), { harness: bare });
      await res.text();
      const [rec] = records(bare);
      const i = rec?.argv.indexOf("--append-system-prompt") ?? -1;
      expect(i).toBeGreaterThan(0);
      expect(rec?.argv[i + 1]).toBe("Fallback rules.");
    } finally {
      await stop(bare);
    }
  });

  it("does not pass the instructions when CLAUDE.md exists", async () => {
    await (await ask(body(`replay:${fixturePath("websearch.jsonl")}`))).text();
    expect(records()[0]?.argv).not.toContain("--append-system-prompt");
  });

  it("ends with the refusal message on a refusal", async () => {
    const file = writeStream("refusal.jsonl", [
      ev.messageDelta("refusal"),
      ev.messageStop(),
      ev.result({ stop_reason: "refusal" }),
    ]);
    expect(await events(await ask(body(`replay:${file}`)))).toEqual([
      { type: "error", message: REFUSED },
    ]);
  });

  it("ends with the unavailable error on an error result", async () => {
    const file = writeStream("error.jsonl", [
      ev.result({ is_error: true, subtype: "error_during_execution" }),
    ]);
    expect(await events(await ask(body(`replay:${file}`)))).toEqual([
      { type: "error", message: UNAVAILABLE },
    ]);
  });

  it("ends with the unavailable error when claude exits without a result", async () => {
    const file = writeStream("cut.jsonl", textBlock(0, "Half an answer that is long enough? no"));
    const list = await events(await ask(body(`replay:${file}`)));
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
    expect(list.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
    await until(() => h.logs.some((l) => l.msg === "ask"));
    expect(h.logs.find((l) => l.msg === "ask")?.extra.outcome).toBe("no_result");
  });

  it("ends with the unavailable error and frees the slot when claude cannot start", async () => {
    await restart({ claudeBin: join(h.dir, "no-such-claude") });
    expect(await events(await ask(body("q")))).toEqual([{ type: "error", message: UNAVAILABLE }]);
    await until(() => h.agent.running === 0);
    expect(h.logs.find((l) => l.msg === "ask")?.extra.outcome).toBe("no_result");
  });

  it("sends pings while claude is silent", async () => {
    await restart({ pingMs: 40 });
    const list = await events(await ask(body("sleep:300")));
    expect(list.filter((e) => e.type === "ping").length).toBeGreaterThanOrEqual(3);
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
  });
});

describe("limits and killing", () => {
  it("refuses a third question with 429 while two run, then accepts again", async () => {
    const first = await ask(body("sleep:600"));
    const second = await ask(body("sleep:600"));
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await ask(body("sleep:10"));
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "busy" });
    await Promise.all([first.text(), second.text()]);
    await until(() => h.agent.running === 0);
    const fourth = await ask(body(`replay:${fixturePath("websearch.jsonl")}`));
    expect(fourth.status).toBe(200);
    await fourth.text();
  });

  it("kills the whole process group when a question times out", async () => {
    await restart({ timeoutMs: 300 });
    const started = Date.now();
    const list = await events(await ask(body("hang")));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    if (!rec?.grandchild) throw new Error("no record");
    // Both ignore SIGTERM: only the SIGKILL after the grace period stops them.
    await until(() => !alive(rec.pid) && !alive(rec.grandchild ?? 0));
    await until(() => h.agent.running === 0);
    expect(h.logs.find((l) => l.msg === "ask")?.extra.outcome).toBe("timeout");
  });

  it("kills the process group when the client disconnects", async () => {
    const controller = new AbortController();
    const res = await ask(body("hang"), { signal: controller.signal });
    expect(res.status).toBe(200);
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    controller.abort();
    await until(() => !alive(rec?.pid ?? 0) && !alive(rec?.grandchild ?? 0));
    await until(() => h.agent.running === 0);
    expect(h.logs.find((l) => l.msg === "ask")?.extra.outcome).toBe("aborted");
  });

  it("kills running questions on shutdown and ends their answers", async () => {
    const res = await ask(body("hang"));
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    const reading = events(res);
    await h.agent.shutdown();
    expect(alive(rec?.pid ?? 0)).toBe(false);
    expect(alive(rec?.grandchild ?? 0)).toBe(false);
    const list = await reading;
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
  });
});

describe("logging", () => {
  it("logs one line per question with counts and cost, never the text", async () => {
    await (await ask(body(`replay:${fixturePath("mcp-bash.jsonl")}`))).text();
    await until(() => h.logs.some((l) => l.msg === "ask"));
    const lines = h.logs.filter((l) => l.msg === "ask");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.extra).toMatchObject({
      outcome: "done",
      turns: 3,
      tools: { mcp__companion__search_guide: 1, Bash: 1 },
      result: "success",
      costUsd: 0.0523498,
      usage: { input_tokens: 6, output_tokens: 221 },
    });
    expect(typeof lines[0]?.extra.ms).toBe("number");
    const all = JSON.stringify(h.logs);
    for (const secret of [
      "STATUS-MARKER",
      "HISTORY-Q",
      "HISTORY-A",
      "replay:",
      "chest",
      "echo ok",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it("logs refused requests by status only", async () => {
    await ask(body("q"), { token: "bad" });
    expect(h.logs).toEqual([{ msg: "refused", extra: { status: 401 } }]);
  });
});
