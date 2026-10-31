import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessage, type McpTools, protocolVersionOk, tokenMatches } from "./mcp.js";
import type { Admission } from "./rate-limit.js";
import type {
  AchievementsResponse,
  AskEvent,
  AskRequest,
  FindResponse,
  GuideMarksResponse,
  GuideProgressResponse,
  GuidesResponse,
  GuideWhereResponse,
  HubTreeResponse,
  NowResponse,
  Source,
  XboxAuthState,
  XboxAuthStatus,
} from "../shared/types.js";
import { serveStatic } from "./static.js";

export interface RouteDeps {
  staticDir: string;
  now(): NowResponse;
  guides(): GuidesResponse;
  hubTree(hubId: string): HubTreeResponse | null;
  /** Requests an index refresh. Rate limiting is the implementer's job, not the route's. */
  refreshGuides(): void;
  /** Null when the game has no achievement data at all. Throws when a first fetch fails. */
  achievements(source: Source, id: string): Promise<AchievementsResponse | null>;
  /** Null for an unknown hub. `query` is only ever compared with text the server holds. */
  find(hubId: string, query: string): Promise<FindResponse | null>;
  /** Null for an unknown hub. */
  marks(hubId: string): Promise<GuideMarksResponse | null>;
  /**
   * Null for an unknown hub. Takes the hub id and nothing else: the status text it is matched
   * against is the server's own, never the caller's.
   */
  where(hubId: string): Promise<GuideWhereResponse | null>;
  /** Null for an unknown hub. `refresh` is true only for the fixed flag `?refresh=1`. */
  progress(hubId: string, opts: { refresh: boolean }): Promise<GuideProgressResponse | null>;
  /** Null when no agent is configured. */
  ask: null | {
    /** Origin of OUTLINE_BASE_URL: the one page origin allowed to post questions. */
    origin: string;
    /** Whether the hub is known and the game may be looked up (same gating as achievements). */
    allowed(req: AskRequest): boolean;
    admit(): Admission;
    /**
     * The answer's events, or "busy" when the agent refused the question. Null when `allowed`
     * would refuse; kept as a defence against a change between the calls.
     */
    start(req: AskRequest, signal: AbortSignal): Promise<AsyncIterable<AskEvent> | "busy" | null>;
  };
  /** Absent or null while no MCP token is configured: the MCP endpoint then answers 404. */
  mcp?: null | {
    /** The bearer token the MCP endpoint requires. */
    token: string;
    /** Reported as the server version on `initialize`. */
    version: string;
    tools: McpTools;
  };
  /** Absent or null without an Xbox client ID: status then reads "off" and nothing else answers. */
  xbox?: null | {
    /** The one page origin allowed to start, cancel or end a sign-in (the Ask route's). */
    origin: string;
    status(): XboxAuthStatus;
    /** Rejects when Microsoft would not start a sign-in. */
    connect(): Promise<XboxAuthStatus>;
    cancel(): XboxAuthStatus;
    disconnect(): Promise<XboxAuthStatus>;
  };
  /** Starts a timer and returns a function that cancels it. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** Bounds on the trimmed search text, in characters (code points). */
const FIND_MIN = 2;
const FIND_MAX = 100;

const BASE = "/companion";
const ASK_PATH = `${BASE}/api/ask`;
const MCP_PATH = `${BASE}/mcp`;
const XBOX_PATH = `${BASE}/api/xbox`;
const METRICS_PATH = `${BASE}/metrics`;
const XBOX_ACTIONS = ["connect", "cancel", "disconnect"] as const;
type XboxAction = (typeof XBOX_ACTIONS)[number];

/** Largest request body the ask route reads, in bytes. */
const ASK_BODY_MAX = 32768;
/** Largest request body an Xbox sign-in action reads, in bytes; the body is `{}`. */
const XBOX_BODY_MAX = 1024;
/** Largest request body the MCP route reads, in bytes. */
const MCP_BODY_MAX = 65536;
const QUESTION_MAX = 1000;
const ANSWER_MAX = 8000;
const HISTORY_MAX = 10;
/**
 * A streaming answer writes a ping line after this long without any other line, so a proxy that
 * closes a silent response (ingress-nginx after 60 seconds) keeps it open.
 */
const KEEPALIVE_MS = 15000;
const PING = `${JSON.stringify({ type: "ping" } satisfies AskEvent)}\n`;
/** The Retry-After of a question the agent was too busy to take. */
const AGENT_BUSY_RETRY_SEC = 30;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/** Icons load straight from these hosts in the browser; nothing else is allowed. */
export const IMAGE_HOSTS = [
  "https://steamcdn-a.akamaihd.net",
  "https://*.steamstatic.com",
  "https://media.retroachievements.org",
  "https://images-eds-ssl.xboxlive.com",
  "https://store-images.s-microsoft.com",
];

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' ${IMAGE_HOSTS.join(" ")}`,
  "connect-src 'self'",
  "frame-src 'self' https:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = (type: string, extra: Record<string, string>): Record<string, string> => ({
  "content-type": type,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy": CSP,
  ...extra,
});

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, securityHeaders(type, extra));
  res.end(res.req.method === "HEAD" ? undefined : body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body), {
    "cache-control": "no-store",
  });
}

/** The request body, or null once it passes `max` bytes (the rest is not read). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;

/** Validates by hand; keeps only the known keys. Null for anything out of bounds. */
function parseAsk(raw: unknown): AskRequest | null {
  if (!isObject(raw)) return null;
  const { hubId, game, history, question, depth } = raw;
  if (hubId !== null && (typeof hubId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(hubId))) {
    return null;
  }
  let gameRef: AskRequest["game"] = null;
  if (game !== null) {
    if (
      !isObject(game) ||
      (game.source !== "steam" && game.source !== "ra" && game.source !== "xbox")
    ) {
      return null;
    }
    if (typeof game.id !== "string" || !/^\d{1,10}$/.test(game.id)) return null;
    gameRef = { source: game.source, id: game.id };
  }
  if (hubId === null && gameRef === null) return null;
  if (!Array.isArray(history) || history.length > HISTORY_MAX) return null;
  const turns: AskRequest["history"] = [];
  for (const h of history as unknown[]) {
    if (!isObject(h) || typeof h.question !== "string" || typeof h.answer !== "string") return null;
    if (chars(h.question) > QUESTION_MAX || chars(h.answer) > ANSWER_MAX) return null;
    turns.push({ question: h.question, answer: h.answer });
  }
  if (typeof question !== "string") return null;
  const trimmed = question.trim();
  if (trimmed === "" || chars(trimmed) > QUESTION_MAX) return null;
  if (depth !== "hint" && depth !== "researched" && depth !== "full") return null;
  return { hubId, game: gameRef, history: turns, question: trimmed, depth };
}

const mediaType = (req: IncomingMessage): string | undefined =>
  (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();

const XBOX_OFF: XboxAuthStatus = {
  state: "off",
  gamertag: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  lostSince: null,
};

/**
 * Prometheus text for the Xbox sign-in: three gauges from the state alone, no labels. Never
 * carries the gamertag or anything else personal.
 */
function xboxMetrics(state: XboxAuthState): string {
  const gauge = (name: string, help: string, on: boolean): string =>
    `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${on ? 1 : 0}\n`;
  return (
    gauge("game_companion_xbox_configured", "1 when Xbox is enabled.", state !== "off") +
    gauge(
      "game_companion_xbox_connected",
      "1 when the Xbox sign-in works.",
      state === "connected",
    ) +
    gauge("game_companion_xbox_signin_lost", "1 when the Xbox sign-in was lost.", state === "lost")
  );
}

/** Copies only the fields the browser may see, whatever else the object carries. */
const xboxBody = (s: XboxAuthStatus): XboxAuthStatus => ({
  state: s.state,
  gamertag: s.gamertag,
  userCode: s.userCode,
  verificationUri: s.verificationUri,
  expiresAt: s.expiresAt,
  lostSince: s.lostSince,
});

/**
 * Starts, cancels or ends the Xbox sign-in for the browser. Checks run in a fixed order and each
 * fails before any later work; the origin and content-type checks are the Ask route's. Answers
 * the sign-in status and nothing else.
 */
async function handleXboxAction(
  deps: RouteDeps,
  action: XboxAction | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const early = (status: number, error: string, extra: Record<string, string> = {}): void =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify({ error }), {
      "cache-control": "no-store",
      connection: "close",
      ...extra,
    });
  const xbox = deps.xbox;
  // Without a client ID, and for an unknown action, there is no endpoint here at all.
  if (!xbox || action === null) return early(404, "not found");
  if (req.method !== "POST") {
    return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
      allow: "POST",
      connection: "close",
    });
  }
  if (mediaType(req) !== "application/json") return early(415, "unsupported media type");
  if (req.headers.origin !== xbox.origin) return early(403, "forbidden");
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > XBOX_BODY_MAX) return early(413, "too large");
  const body = await readBody(req, XBOX_BODY_MAX);
  if (body === null) return early(413, "too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parsed = null;
  }
  if (!isObject(parsed)) return json(res, 400, { error: "bad request" });

  if (action === "cancel") return json(res, 200, xboxBody(xbox.cancel()));
  if (action === "disconnect") {
    let ended: XboxAuthStatus;
    try {
      ended = await xbox.disconnect();
    } catch {
      // Fixed text: still signed in, because the stored sign-in could not be removed.
      return json(res, 500, { error: "xbox disconnect failed" });
    }
    return json(res, 200, xboxBody(ended));
  }
  let started: XboxAuthStatus;
  try {
    started = await xbox.connect();
  } catch {
    // Fixed text: the reason may carry what Microsoft said.
    return json(res, 502, { error: "xbox sign-in could not be started" });
  }
  return json(res, 200, xboxBody(started));
}

/**
 * The MCP endpoint, for the agent pod only (not for browsers). Checks run in a fixed order and
 * each fails before any later work. Reads only the authorization, content-type, content-length
 * and mcp-protocol-version headers.
 */
async function handleMcp(
  deps: RouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const mcp = deps.mcp;
  const early = (status: number, body: unknown, extra: Record<string, string> = {}): void =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(body), {
      "cache-control": "no-store",
      connection: "close",
      ...extra,
    });
  if (!mcp) return early(404, { error: "not found" });
  if (req.method !== "POST") {
    return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
      allow: "POST",
      connection: "close",
    });
  }
  if (!tokenMatches(req.headers.authorization, mcp.token)) {
    return early(401, { error: "unauthorized" });
  }
  if (mediaType(req) !== "application/json") return early(415, { error: "unsupported media type" });
  const version = req.headers["mcp-protocol-version"];
  if (!protocolVersionOk(typeof version === "string" ? version : undefined)) {
    return early(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Unsupported protocol version" },
    });
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MCP_BODY_MAX) {
    return early(413, { error: "too large" });
  }
  const body = await readBody(req, MCP_BODY_MAX);
  if (body === null) return early(413, { error: "too large" });

  let msg: unknown;
  try {
    msg = JSON.parse(body.toString("utf8"));
  } catch {
    return json(res, 200, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
  const reply = await handleMessage(msg, { tools: mcp.tools, version: mcp.version });
  if (reply === null) {
    res.writeHead(202, { "x-content-type-options": "nosniff", "cache-control": "no-store" });
    res.end();
    return;
  }
  return json(res, 200, reply);
}

/**
 * The browser's POST route. Checks run in a fixed order and each fails before any later work. Apart
 * from the MCP route, this is the only code that reads request headers, and only content-type,
 * content-length and origin.
 */
async function handleAsk(
  deps: RouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", { allow: "POST" });
  }
  // A rejection made before the body is read closes the connection, so an unread body is
  // dropped with it instead of being drained.
  const early = (status: number, error: string): void =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify({ error }), {
      "cache-control": "no-store",
      connection: "close",
    });

  if (mediaType(req) !== "application/json") return early(415, "unsupported media type");
  const ask = deps.ask;
  // Without a configured assistant there is no origin to compare against and nothing to spend.
  if (ask !== null && req.headers.origin !== ask.origin) return early(403, "forbidden");
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > ASK_BODY_MAX) return early(413, "too large");
  const body = await readBody(req, ASK_BODY_MAX);
  if (body === null) return early(413, "too large");

  if (ask === null) return json(res, 503, { error: "assistant unavailable" });
  let parsed: AskRequest | null;
  try {
    parsed = parseAsk(JSON.parse(body.toString("utf8")));
  } catch {
    parsed = null;
  }
  // An unknown hub or a game that may not be looked up is a bad request, and costs no slot.
  if (parsed === null || !ask.allowed(parsed)) return json(res, 400, { error: "bad request" });

  const tooMany = (limit: "minute" | "day", retryAfterSec: number): void =>
    send(
      res,
      429,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "rate limited", limit }),
      { "cache-control": "no-store", "retry-after": String(retryAfterSec) },
    );
  const admission = ask.admit();
  if (!admission.ok) return tooMany(admission.limit, admission.retryAfterSec);

  const controller = new AbortController();
  // `res` closing before it finished is the client leaving; `req` closes once the body is read.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  // Waits for the agent to take the question, so a busy agent still gets a real 429.
  const events = await ask.start(parsed, controller.signal);
  if (events === null) return json(res, 404, { error: "unknown game" });
  if (events === "busy") return tooMany("minute", AGENT_BUSY_RETRY_SEC);

  res.writeHead(
    200,
    securityHeaders("application/x-ndjson; charset=utf-8", { "cache-control": "no-store" }),
  );
  res.flushHeaders();

  // Restarted after every line written, so a ping goes out only after a silent interval.
  const setTimer = deps.setTimer ?? defaultTimer;
  let cancelPing: (() => void) | null = null;
  const stopPing = (): void => {
    cancelPing?.();
    cancelPing = null;
  };
  const armPing = (): void => {
    stopPing();
    cancelPing = setTimer(() => {
      cancelPing = null;
      if (controller.signal.aborted || res.writableEnded) return;
      res.write(PING);
      armPing();
    }, KEEPALIVE_MS);
  };
  res.on("close", stopPing);
  armPing();
  try {
    for await (const ev of events) {
      if (controller.signal.aborted) break;
      res.write(`${JSON.stringify(ev)}\n`);
      armPing();
    }
  } finally {
    stopPing();
    res.end();
  }
}

export function createHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const raw = req.url ?? "/";
      const q = raw.indexOf("?");
      const path = q === -1 ? raw : raw.slice(0, q);
      if (path === ASK_PATH) return await handleAsk(deps, req, res);
      if (path === MCP_PATH) return await handleMcp(deps, req, res);
      if (path === METRICS_PATH) {
        if (req.method !== "GET") {
          return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
            allow: "GET",
          });
        }
        const state = deps.xbox ? deps.xbox.status().state : "off";
        return send(res, 200, "text/plain; version=0.0.4; charset=utf-8", xboxMetrics(state), {
          "cache-control": "no-store",
        });
      }
      if (path.startsWith(`${XBOX_PATH}/`)) {
        const name = path.slice(XBOX_PATH.length + 1);
        const action = XBOX_ACTIONS.find((a) => a === name) ?? null;
        return await handleXboxAction(deps, action, req, res);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
          allow: "GET, HEAD",
        });
      }
      const query = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));

      if (path === BASE)
        return send(res, 308, "text/plain; charset=utf-8", "", { location: `${BASE}/` });
      if (!path.startsWith(`${BASE}/`)) return json(res, 404, { error: "not found" });
      const rest = path.slice(BASE.length + 1);

      if (rest === "healthz") return json(res, 200, { ok: true });
      if (rest === "api/now") return json(res, 200, deps.now());
      if (rest === "api/xbox") {
        return json(res, 200, deps.xbox ? xboxBody(deps.xbox.status()) : XBOX_OFF);
      }
      if (rest === "api/guides") {
        if (query.get("refresh") === "1") deps.refreshGuides();
        return json(res, 200, deps.guides());
      }
      const subMatch = /^api\/guides\/([A-Za-z0-9-]{1,64})\/(find|marks|where|progress)$/.exec(
        rest,
      );
      if (subMatch) {
        const hubId = subMatch[1] as string;
        if (subMatch[2] === "marks") {
          const marks = await deps.marks(hubId);
          return marks ? json(res, 200, marks) : json(res, 404, { error: "unknown guide" });
        }
        if (subMatch[2] === "where") {
          const where = await deps.where(hubId);
          return where ? json(res, 200, where) : json(res, 404, { error: "unknown guide" });
        }
        if (subMatch[2] === "progress") {
          const progress = await deps.progress(hubId, { refresh: query.get("refresh") === "1" });
          return progress ? json(res, 200, progress) : json(res, 404, { error: "unknown guide" });
        }
        const q = query.get("q");
        const length = q === null ? 0 : [...q.trim()].length;
        if (q === null || length < FIND_MIN || length > FIND_MAX) {
          return json(res, 400, { error: "bad request" });
        }
        const found = await deps.find(hubId, q);
        return found ? json(res, 200, found) : json(res, 404, { error: "unknown guide" });
      }
      const hubMatch = /^api\/guides\/([A-Za-z0-9-]{1,64})$/.exec(rest);
      if (hubMatch) {
        const tree = deps.hubTree(hubMatch[1] as string);
        return tree ? json(res, 200, tree) : json(res, 404, { error: "unknown guide" });
      }
      if (rest.startsWith("api/achievements/")) {
        const m = /^api\/achievements\/(steam|ra|xbox)\/(\d{1,10})$/.exec(rest);
        if (!m) return json(res, 400, { error: "bad request" });
        const data = await deps.achievements(m[1] as Source, m[2] as string);
        return data ? json(res, 200, data) : json(res, 404, { error: "no achievements" });
      }
      if (rest.startsWith("api/")) return json(res, 404, { error: "not found" });

      const file = await serveStatic(deps.staticDir, rest === "" ? "index.html" : rest);
      if (!file) return json(res, 404, { error: "not found" });
      return send(res, 200, file.contentType, file.body, { "cache-control": "no-cache" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}
