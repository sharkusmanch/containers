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
import { labelArgs } from "../src/argv.js";
import { buildLabelPrompt } from "../src/label.js";
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
    skillsDirs: ["/agent/skills/redlib", "/agent/skills/vibepollo"],
    childEnvNames: ["VIBEPOLLO_TOKEN", "VIBEPOLLO_HOST"],
    homeDir: home,
    timeoutMs: 10_000,
    labelTimeoutMs: 10_000,
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
      VIBEPOLLO_TOKEN: "ro-token-test",
      REDLIB_URL: "http://redlib.test",
      LANG: "C.UTF-8",
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

/** The fake's records: in the project folder for a question, beside the run HOME for a label. */
function records(harness: Harness = h): FakeRecord[] {
  return [harness.project, harness.home].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.startsWith("fake-"))
      .flatMap((f) => {
        // A record the fake is still writing is read on a later look.
        try {
          return [JSON.parse(readFileSync(join(dir, f), "utf8")) as FakeRecord];
        } catch {
          return [];
        }
      }),
  );
}

/** What is left in the service HOME besides the fake's records. */
const homeLeft = (): string[] => readdirSync(h.home).filter((f) => !f.startsWith("fake-"));

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

  it("refuses a NUL byte in the body with 400 and starts nothing", async () => {
    const res = await ask(body("q\u0000"));
    expect(res.status).toBe(400);
    expect(h.agent.running).toBe(0);
    expect(records()).toEqual([]);
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
      "--plugin-dir",
      "/agent/skills/vibepollo",
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
    expect(rec.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(rec.env.VIBEPOLLO_TOKEN).toBe("ro-token-test");
    expect(rec.env.VIBEPOLLO_HOST).toBeUndefined();
    expect(rec.env.AGENT_TOKEN).toBeUndefined();
    expect(rec.env.COMPANION_MCP_TOKEN).toBeUndefined();
    // The run's HOME is removed once claude has exited.
    await until(() => !existsSync(runHome));
  });

  it("passes the researched depth to claude", async () => {
    const res = await ask(
      body(`replay:${fixturePath("websearch.jsonl")}`, { depth: "researched" }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const [rec] = records();
    expect(rec?.argv.at(-1)).toContain("\n\nAnswer depth: researched\n\n");
  });

  it("refuses an unknown depth with 400 and starts nothing", async () => {
    const res = await ask(body("replay:/nonexistent", { depth: "deep" }));
    expect(res.status).toBe(400);
    expect(records()).toEqual([]);
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

  it("frees the slot, removes the run HOME and logs once when spawn throws", async () => {
    // A NUL in the executable path makes spawn() throw synchronously.
    await restart({ claudeBin: "/bin/claude\u0000" });
    expect(await events(await ask(body("q")))).toEqual([{ type: "error", message: UNAVAILABLE }]);
    await until(() => h.agent.running === 0);
    expect(readdirSync(h.home)).toEqual([]);
    expect(h.logs.filter((l) => l.msg === "ask")).toHaveLength(1);
    await h.agent.shutdown();
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
    // claude ignores SIGTERM (only the SIGKILL after the grace period stops it); its grandchild
    // is in another session, out of reach of the group kill.
    await until(() => !alive(rec.pid) && !alive(rec.grandchild ?? 0));
    await until(() => h.agent.running === 0);
    expect(h.logs.find((l) => l.msg === "ask")?.extra.outcome).toBe("timeout");
  });

  it("kills a grandchild that ignores SIGTERM, in its own session, on timeout", async () => {
    await restart({ timeoutMs: 300 });
    const list = await events(await ask(body("hang-stubborn")));
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    await until(() => !alive(rec?.pid ?? 0) && !alive(rec?.grandchild ?? 0));
    await until(() => h.agent.running === 0);
  });

  it("kills what a finished run left running in the background", async () => {
    const list = await events(await ask(body(`replay-bg:${fixturePath("websearch.jsonl")}`)));
    expect(list[list.length - 1]).toEqual({ type: "done", truncatedGuide: false });
    const [rec] = records();
    expect(rec?.grandchild).toBeDefined();
    await until(() => h.agent.running === 0);
    expect(alive(rec?.grandchild ?? 0)).toBe(false);
  });

  it("finishes a run whose claude exited while a grandchild keeps its stdout open", async () => {
    await restart({ timeoutMs: 2500 });
    const started = Date.now();
    const list = await events(await ask(body("exit-held")));
    // Ended by the grace period after claude's exit, not by the 2.5 s timeout.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(list[list.length - 1]).toEqual({ type: "error", message: UNAVAILABLE });
    const [rec] = records();
    expect(rec?.grandchild).toBeDefined();
    await until(() => h.agent.running === 0);
    expect(alive(rec?.grandchild ?? 0)).toBe(false);
    expect(readdirSync(h.home)).toEqual([]);
    const lines = h.logs.filter((l) => l.msg === "ask");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.extra.outcome).toBe("no_result");
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

function label(
  payload: string,
  opts: { token?: string | null; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${h.url}/label`, {
    method: "POST",
    headers,
    body: payload,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

const titlesBody = (titles: unknown): string => JSON.stringify({ titles });

/** What `claude -p --output-format json` prints: one result object. */
function labelReply(name: string, result: string, fields: Record<string, unknown> = {}): string {
  return writeStream(name, [
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      num_turns: 1,
      total_cost_usd: 0.0004,
      usage: { input_tokens: 120, output_tokens: 30 },
      ...fields,
    }),
  ]);
}

describe("labels", () => {
  it("answers the valid labels from haiku's reply", async () => {
    const file = join(h.dir, "labels.json");
    const first = `replay:${file}`;
    labelReply(
      "labels.json",
      `Here you go: ${JSON.stringify({
        [first]: "Walk",
        "Boss Guide": "Bosses",
        "Trophy Guide": "Trophies!",
        Other: "Other",
      })}`,
    );
    const res = await label(titlesBody([first, "Boss Guide", " Trophy Guide ", "Boss Guide"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ labels: { [first]: "Walk", "Boss Guide": "Bosses" } });
  });

  it("starts haiku with no tools, in its own HOME, with only the environment it needs", async () => {
    const file = labelReply("labels.json", "{}");
    const titles = [`replay:${file}`, "Boss Guide"];
    const res = await label(titlesBody(titles));
    expect(res.status).toBe(200);
    const [rec] = records();
    if (!rec) throw new Error("no record");
    expect(rec.argv).toEqual(labelArgs(buildLabelPrompt(titles)));
    const runHome = rec.env.HOME ?? "";
    expect(runHome.startsWith(join(h.home, "run-"))).toBe(true);
    // No house rules: claude runs in its empty HOME, not the project folder.
    expect(rec.cwd).toBe(runHome);
    // No REDLIB_URL, no AGENT_CHILD_ENV names (VIBEPOLLO_TOKEN), no tokens of the service.
    expect(rec.env).toEqual({
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      HOME: runHome,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    await until(() => !existsSync(runHome));
  });

  it("reads the result from the verbose array form as well", async () => {
    const file = join(h.dir, "array.json");
    const first = `replay:${file}`;
    writeFileSync(
      file,
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", subtype: "success", is_error: false, result: `{"${first}": "Arr"}` },
      ]),
    );
    const res = await label(titlesBody([first]));
    expect(await res.json()).toEqual({ labels: { [first]: "Arr" } });
  });

  it("answers an empty map when the reply holds no JSON object", async () => {
    const file = labelReply("none.json", "I can't label these.");
    const res = await label(titlesBody([`replay:${file}`]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: {} });
  });

  it.each([
    ["broken JSON", "{"],
    ["no titles field", JSON.stringify({ title: "Maps" })],
    ["an empty list", titlesBody([])],
    ["41 titles", titlesBody(Array.from({ length: 41 }, (_, i) => `Page ${i}`))],
    ["a non-string title", titlesBody(["Maps", 1])],
    ["a blank title", titlesBody(["  "])],
    ["a 201-character title", titlesBody(["x".repeat(201)])],
  ])("refuses %s with 400 and starts nothing", async (_name, payload) => {
    const res = await label(payload);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid body" });
    expect(h.agent.running).toBe(0);
    expect(records()).toEqual([]);
  });

  it("refuses a missing token with 401 and starts nothing", async () => {
    const res = await label(titlesBody(["Maps"]), { token: null });
    expect(res.status).toBe(401);
    expect(records()).toEqual([]);
  });

  it("answers GET with 405", async () => {
    expect((await fetch(`${h.url}/label`)).status).toBe(405);
  });

  it("runs one label request at a time: a second gets 429 with Retry-After", async () => {
    const first = label(titlesBody(["sleep:600"]));
    await until(() => records().length === 1);
    const second = await label(titlesBody(["sleep:10"]));
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "busy" });
    const retry = Number(second.headers.get("retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(10);
    expect(records()).toHaveLength(1);
    // The sleeping fake prints no result: the CLI failed.
    expect((await first).status).toBe(502);
    await until(() => h.agent.running === 0);
    const file = labelReply("again.json", "{}");
    expect((await label(titlesBody([`replay:${file}`]))).status).toBe(200);
  });

  it("is not held up by questions in progress", async () => {
    const asks = [await ask(body("sleep:600")), await ask(body("sleep:600"))];
    const file = labelReply("labels.json", "{}");
    expect((await label(titlesBody([`replay:${file}`]))).status).toBe(200);
    await Promise.all(asks.map((r) => r.text()));
  });

  it("answers 502 when claude reports an error", async () => {
    const file = labelReply("error.json", "", {
      is_error: true,
      subtype: "error_during_execution",
    });
    const res = await label(titlesBody([`replay:${file}`]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("answers 502 when claude cannot start", async () => {
    await restart({ claudeBin: join(h.dir, "no-such-claude") });
    const res = await label(titlesBody(["Maps"]));
    expect(res.status).toBe(502);
    await until(() => h.agent.running === 0);
    expect(homeLeft()).toEqual([]);
  });

  it("answers 502 and kills everything when haiku times out", async () => {
    await restart({ labelTimeoutMs: 300 });
    const started = Date.now();
    const res = await label(titlesBody(["hang"]));
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(3000);
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    await until(() => !alive(rec?.pid ?? 0) && !alive(rec?.grandchild ?? 0));
    await until(() => h.agent.running === 0);
    expect(homeLeft()).toEqual([]);
    expect(h.logs.find((l) => l.msg === "label")?.extra.outcome).toBe("timeout");
  });

  it("kills haiku when the client disconnects", async () => {
    const controller = new AbortController();
    const pending = label(titlesBody(["hang"]), { signal: controller.signal }).catch(() => null);
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    controller.abort();
    await pending;
    await until(() => !alive(rec?.pid ?? 0) && !alive(rec?.grandchild ?? 0));
    await until(() => h.agent.running === 0);
    expect(h.logs.find((l) => l.msg === "label")?.extra.outcome).toBe("aborted");
  });

  it("kills a running label request on shutdown", async () => {
    const pending = label(titlesBody(["hang"])).catch(() => null);
    await until(() => records()[0]?.grandchild !== undefined);
    const [rec] = records();
    await h.agent.shutdown();
    expect(alive(rec?.pid ?? 0)).toBe(false);
    expect(alive(rec?.grandchild ?? 0)).toBe(false);
    const res = await pending;
    if (res !== null) expect(res.status).toBe(502);
  });

  it("logs one line with counts and cost, never a title or label", async () => {
    const file = join(h.dir, "labels.json");
    const first = `replay:${file}`;
    labelReply("labels.json", JSON.stringify({ [first]: "SECRETLB", "TITLE-MARKER": "Marker" }));
    await (await label(titlesBody([first, "TITLE-MARKER", "Unlabelled"]))).json();
    await until(() => h.logs.some((l) => l.msg === "label"));
    const lines = h.logs.filter((l) => l.msg === "label");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.extra).toMatchObject({
      outcome: "done",
      titles: 3,
      labels: 2,
      result: "success",
      costUsd: 0.0004,
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    expect(typeof lines[0]?.extra.ms).toBe("number");
    const all = JSON.stringify(h.logs);
    for (const secret of ["SECRETLB", "TITLE-MARKER", "Marker", "Unlabelled", "replay:"]) {
      expect(all).not.toContain(secret);
    }
  });
});
