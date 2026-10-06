import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AchievementsResponse,
  FindResponse,
  GuideMarksResponse,
  GuidesResponse,
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
}

/** Bounds on the trimmed search text, in characters (code points). */
const FIND_MIN = 2;
const FIND_MAX = 100;

const BASE = "/companion";

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
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": CSP,
    ...extra,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body), {
    "cache-control": "no-store",
  });
}

export function createHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed", {
          allow: "GET, HEAD",
        });
      }
      const raw = req.url ?? "/";
      const q = raw.indexOf("?");
      const path = q === -1 ? raw : raw.slice(0, q);
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
      const subMatch = /^api\/guides\/([A-Za-z0-9-]{1,64})\/(find|marks)$/.exec(rest);
      if (subMatch) {
        const hubId = subMatch[1] as string;
        if (subMatch[2] === "marks") {
          const marks = await deps.marks(hubId);
          return marks ? json(res, 200, marks) : json(res, 404, { error: "unknown guide" });
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
