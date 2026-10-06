import { fetchJson, UpstreamError, type FetchLike } from "./fetch-json.js";

const BASE = "https://api.steampowered.com";

export interface SteamPresence {
  appId: string | null;
  name: string | null;
}
export interface SteamPlayerAchievement {
  apiname: string;
  achieved: number;
  unlocktime: number;
}
export interface SteamSchemaAchievement {
  name: string;
  displayName: string;
  description?: string;
  hidden: number;
  icon: string;
  icongray: string;
}
export interface SteamGameData {
  title: string;
  player: SteamPlayerAchievement[];
  schema: SteamSchemaAchievement[];
  percents: Map<string, number>;
}

type Rec = Record<string, unknown>;

const badShape = (): UpstreamError => new UpstreamError("unexpected response shape", null);
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function rec(v: unknown): Rec {
  if (!isRec(v)) throw badShape();
  return v;
}

function parsePlayer(v: unknown): SteamPlayerAchievement {
  const a = rec(v);
  if (
    typeof a.apiname !== "string" ||
    typeof a.achieved !== "number" ||
    typeof a.unlocktime !== "number"
  ) {
    throw badShape();
  }
  return { apiname: a.apiname, achieved: a.achieved, unlocktime: a.unlocktime };
}

function parseSchema(v: unknown): SteamSchemaAchievement {
  const a = rec(v);
  if (
    typeof a.name !== "string" ||
    typeof a.displayName !== "string" ||
    typeof a.hidden !== "number" ||
    typeof a.icon !== "string" ||
    typeof a.icongray !== "string"
  ) {
    throw badShape();
  }
  const out: SteamSchemaAchievement = {
    name: a.name,
    displayName: a.displayName,
    hidden: a.hidden,
    icon: a.icon,
    icongray: a.icongray,
  };
  if (typeof a.description === "string") out.description = a.description;
  return out;
}

/** Global percentages are decoration: any failure or odd shape yields an empty map. */
function parsePercents(result: PromiseSettledResult<unknown>): Map<string, number> {
  const percents = new Map<string, number>();
  if (
    result.status === "rejected" ||
    !isRec(result.value) ||
    !isRec(result.value.achievementpercentages)
  ) {
    return percents;
  }
  const list = result.value.achievementpercentages.achievements;
  if (!Array.isArray(list)) return percents;
  for (const item of list as unknown[]) {
    if (!isRec(item) || typeof item.name !== "string") continue;
    const value = Number(item.percent);
    if (Number.isFinite(value)) percents.set(item.name, value);
  }
  return percents;
}

export class SteamClient {
  private readonly apiKey: string;
  private readonly steamId: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: { apiKey: string; steamId: string; fetchFn?: FetchLike }) {
    this.apiKey = opts.apiKey;
    this.steamId = opts.steamId;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private get(path: string, params: Record<string, string>): Promise<unknown> {
    return fetchJson(this.fetchFn, `${BASE}/${path}/?${new URLSearchParams(params).toString()}`);
  }

  async presence(): Promise<SteamPresence> {
    const body = await this.get("ISteamUser/GetPlayerSummaries/v2", {
      key: this.apiKey,
      steamids: this.steamId,
    });
    const players = rec(rec(body).response).players;
    if (!Array.isArray(players)) throw badShape();
    if (players.length === 0) return { appId: null, name: null };
    const player = rec(players[0] as unknown);
    return {
      appId: typeof player.gameid === "string" ? player.gameid : null,
      name: typeof player.gameextrainfo === "string" ? player.gameextrainfo : null,
    };
  }

  async gameData(appId: string): Promise<SteamGameData | null> {
    const [player, schema, percents] = await Promise.allSettled([
      this.get("ISteamUserStats/GetPlayerAchievements/v1", {
        key: this.apiKey,
        steamid: this.steamId,
        appid: appId,
      }),
      this.get("ISteamUserStats/GetSchemaForGame/v2", {
        key: this.apiKey,
        appid: appId,
        l: "english",
      }),
      this.get("ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2", { gameid: appId }),
    ]);

    // The player call is judged first: a 400/403 means the app has no stats, whatever the others said.
    if (player.status === "rejected") {
      const reason: unknown = player.reason;
      if (reason instanceof UpstreamError && (reason.status === 400 || reason.status === 403))
        return null;
      throw reason;
    }
    if (schema.status === "rejected") throw schema.reason;

    const game = rec(rec(schema.value).game);
    const schemaList = isRec(game.availableGameStats)
      ? game.availableGameStats.achievements
      : undefined;
    if (!Array.isArray(schemaList)) return null;

    const stats = rec(rec(player.value).playerstats);
    if (!Array.isArray(stats.achievements)) throw badShape();
    const title = typeof stats.gameName === "string" ? stats.gameName : game.gameName;
    if (typeof title !== "string") throw badShape();

    return {
      title,
      player: (stats.achievements as unknown[]).map(parsePlayer),
      schema: (schemaList as unknown[]).map(parseSchema),
      percents: parsePercents(percents),
    };
  }
}
