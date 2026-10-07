import { fetchJson, UpstreamError, type FetchLike } from "./fetch-json.js";

const BASE = "https://retroachievements.org/API";

export interface RaSummary {
  gameId: string | null;
  title: string | null;
  /** Epoch ms (UTC). */
  presenceAt: number | null;
  /** What the game says the player is doing now (rich presence), cleaned; null when absent. */
  presence: string | null;
}
export interface RaAchievementRaw {
  ID: number;
  Title: string;
  Description: string;
  Type: string | null;
  BadgeName: string;
  NumAwardedHardcore: number;
  DisplayOrder: number;
  DateEarnedHardcore?: string | null;
}
export interface RaGameProgress {
  title: string;
  consoleName: string;
  distinctPlayers: number;
  achievements: RaAchievementRaw[];
}

type Rec = Record<string, unknown>;

const badShape = (): UpstreamError => new UpstreamError("unexpected response shape", null);
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const isAbsent = (v: unknown): boolean => v === undefined || v === null;

function rec(v: unknown): Rec {
  if (!isRec(v)) throw badShape();
  return v;
}

const PRESENCE_MAX_CODE_POINTS = 300;

/** Nothing a person could see: format characters, separators and the blank letters. */
const INVISIBLE_ONLY = /^[\p{Cf}\p{Z}\u3164\u2800\u115F\u1160]*$/u;

/**
 * A rich-presence line made safe to show on one line: single spaces, trimmed. A line of at most
 * 300 code points is returned whole; a longer one is cut to its first 299 code points, trimmed
 * again, and ends in a single "…" so the cut is visible. Null when nothing visible is left.
 */
export function cleanPresence(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/[\p{Cc}\s]+/gu, " ").trim();
  const points = Array.from(flat);
  if (points.length <= PRESENCE_MAX_CODE_POINTS) return INVISIBLE_ONLY.test(flat) ? null : flat;
  const cut = points
    .slice(0, PRESENCE_MAX_CODE_POINTS - 1)
    .join("")
    .trim();
  return INVISIBLE_ONLY.test(cut) ? null : `${cut}\u2026`;
}

/** "YYYY-MM-DD HH:MM:SS" read as UTC to epoch ms; NaN if malformed. */
export function parseRaDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function parseAchievement(v: unknown): RaAchievementRaw {
  const a = rec(v);
  if (
    typeof a.ID !== "number" ||
    typeof a.Title !== "string" ||
    typeof a.Description !== "string" ||
    typeof a.BadgeName !== "string" ||
    typeof a.NumAwardedHardcore !== "number" ||
    typeof a.DisplayOrder !== "number"
  ) {
    throw badShape();
  }
  const out: RaAchievementRaw = {
    ID: a.ID,
    Title: a.Title,
    Description: a.Description,
    Type: typeof a.Type === "string" ? a.Type : null,
    BadgeName: a.BadgeName,
    NumAwardedHardcore: a.NumAwardedHardcore,
    DisplayOrder: a.DisplayOrder,
  };
  if (typeof a.DateEarnedHardcore === "string" || a.DateEarnedHardcore === null) {
    out.DateEarnedHardcore = a.DateEarnedHardcore;
  }
  return out;
}

export class RaClient {
  private readonly apiKey: string;
  private readonly username: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: { apiKey: string; username: string; fetchFn?: FetchLike }) {
    this.apiKey = opts.apiKey;
    this.username = opts.username;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private get(endpoint: string, params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams({ y: this.apiKey, u: this.username, ...params }).toString();
    return fetchJson(this.fetchFn, `${BASE}/${endpoint}?${query}`);
  }

  async summary(): Promise<RaSummary> {
    const body = rec(await this.get("API_GetUserSummary.php", { g: "1", a: "0" }));

    const last = body.LastGameID;
    if (last !== undefined && last !== null && typeof last !== "number") throw badShape();
    const gameId = typeof last === "number" && last !== 0 ? String(last) : null;

    const title =
      isRec(body.LastGame) && typeof body.LastGame.Title === "string" ? body.LastGame.Title : null;

    const at =
      typeof body.RichPresenceMsgDate === "string" ? parseRaDate(body.RichPresenceMsgDate) : NaN;
    return {
      gameId,
      title,
      presenceAt: Number.isNaN(at) ? null : at,
      presence: cleanPresence(body.RichPresenceMsg),
    };
  }

  async gameProgress(gameId: string): Promise<RaGameProgress | null> {
    const body = rec(await this.get("API_GetGameInfoAndUserProgress.php", { g: gameId, a: "1" }));
    // RA answers for an ID that does not exist with no title and no achievements list.
    if (isAbsent(body.Title) || isAbsent(body.Achievements)) return null;
    if (
      typeof body.Title !== "string" ||
      typeof body.ConsoleName !== "string" ||
      typeof body.NumDistinctPlayers !== "number" ||
      typeof body.Achievements !== "object" ||
      body.Achievements === null
    ) {
      throw badShape();
    }
    // RA sends an empty array, not an empty object, when a game has no achievements.
    const items = Object.values(body.Achievements);
    if (items.length === 0) return null;
    const achievements = items
      .map(parseAchievement)
      .sort((a, b) => a.DisplayOrder - b.DisplayOrder || a.ID - b.ID);
    return {
      title: body.Title,
      consoleName: body.ConsoleName,
      distinctPlayers: body.NumDistinctPlayers,
      achievements,
    };
  }
}
