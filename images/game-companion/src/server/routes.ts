import type { IncomingMessage, ServerResponse } from "node:http";
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
  /** Null when no API key is configured. */
  ask: null | {
    /** Origin of OUTLINE_BASE_URL: the one page origin allowed to post questions. */
    origin: string;
    admit(): Admission;
    /** Null when the hub or game is not allowed (same gating as achievement lookups). */
    start(req: AskRequest, signal: AbortSignal): Promise<AsyncGenerator<AskEvent> | null>;
  };
}

/** Bounds on the trimmed search text, in characters (code points). */
const FIND_MIN = 2;
const FIND_MAX = 100;

const BASE = "/companion";
const ASK_PATH = `${BASE}/api/ask`;

/** Largest request body the ask route reads, in bytes. */
const ASK_BODY_MAX = 32768;
const QUESTION_MAX = 1000;
const ANSWER_MAX = 8000;
const HISTORY_MAX = 10;

/** Icons load straight from these hosts in the browser; nothing else is allowed. */
export const IMAGE_HOSTS = [
  "https://steamcdn-a.akamaihd.net",
  "https://*.steamstatic.com",
  "https://media.retroachievements.org",
];

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' ${IMAGE_HOSTS.join(" ")}`,
  "connect-src 'self'",
  "frame-src 'self' https:",
  "manifest-src 'self'",
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
    if (!isObject(game) || (game.source !== "steam" && game.source !== "ra")) return null;
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
  if (depth !== "hint" && depth !== "full") return null;
  return { hubId, game: gameRef, history: turns, question: trimmed, depth };
}

/**
 * The one POST route. Checks run in a fixed order and each fails before any later work. This is
 * the only code that reads request headers, and only content-type, content-length and origin.
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

  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return early(415, "unsupported media type");
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
  if (parsed === null) return json(res, 400, { error: "bad request" });

  const admission = ask.admit();
  if (!admission.ok) {
    return send(
      res,
      429,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "rate limited", limit: admission.limit }),
      { "cache-control": "no-store", "retry-after": String(admission.retryAfterSec) },
    );
  }

  const controller = new AbortController();
  // `res` closing before it finished is the client leaving; `req` closes once the body is read.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const events = await ask.start(parsed, controller.signal);
  if (events === null) return json(res, 404, { error: "unknown game" });

  res.writeHead(
    200,
    securityHeaders("application/x-ndjson; charset=utf-8", { "cache-control": "no-store" }),
  );
  try {
    for await (const ev of events) {
      if (controller.signal.aborted) break;
      res.write(`${JSON.stringify(ev)}\n`);
    }
  } finally {
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
        const m = /^api\/achievements\/(steam|ra)\/(\d{1,10})$/.exec(rest);
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
