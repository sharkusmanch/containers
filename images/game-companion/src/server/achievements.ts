import type { Achievement, AchievementsResponse, Source } from "../shared/types.js";
import { parseRaDate, type RaGameProgress } from "./ra.js";
import type { SteamGameData } from "./steam.js";

const ICON_HOSTS = ["steamcdn-a.akamaihd.net", "media.retroachievements.org"];
const ICON_SUFFIXES = [".steamstatic.com"];

export function safeIcon(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  return ICON_HOSTS.includes(host) || ICON_SUFFIXES.some((s) => host.endsWith(s)) ? url : null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function normaliseSteam(appId: string, data: SteamGameData): AchievementsResponse {
  const progress = new Map(data.player.map((p) => [p.apiname, p]));
  const achievements: Achievement[] = data.schema.map((s) => {
    const p = progress.get(s.name);
    const unlocked = p?.achieved === 1;
    const pct = data.percents.get(s.name);
    return {
      id: s.name,
      name: s.displayName,
      description: s.description ?? null,
      icon: safeIcon(unlocked ? s.icon : s.icongray),
      unlocked,
      unlockedAt:
        unlocked && p && p.unlocktime > 0 ? new Date(p.unlocktime * 1000).toISOString() : null,
      unlockPercent: pct === undefined ? null : round1(pct),
      hidden: s.hidden === 1,
      missable: false,
    };
  });
  return {
    source: "steam",
    id: appId,
    title: data.title,
    total: achievements.length,
    unlocked: achievements.filter((a) => a.unlocked).length,
    stale: false,
    achievements,
  };
}

export function normaliseRa(gameId: string, data: RaGameProgress): AchievementsResponse {
  const achievements: Achievement[] = data.achievements.map((a) => {
    const earned = a.DateEarnedHardcore ? parseRaDate(a.DateEarnedHardcore) : NaN;
    const unlocked = !Number.isNaN(earned);
    const badge = /^[A-Za-z0-9_]+$/.test(a.BadgeName) ? a.BadgeName : null;
    return {
      id: String(a.ID),
      name: a.Title,
      description: a.Description || null,
      icon: badge
        ? `https://media.retroachievements.org/Badge/${badge}${unlocked ? "" : "_lock"}.png`
        : null,
      unlocked,
      unlockedAt: unlocked ? new Date(earned).toISOString() : null,
      unlockPercent:
        data.distinctPlayers > 0
          ? Math.min(100, round1((a.NumAwardedHardcore / data.distinctPlayers) * 100))
          : null,
      hidden: a.Type === "progression" || a.Type === "win_condition",
      missable: a.Type === "missable",
    };
  });
  return {
    source: "ra",
    id: gameId,
    title: data.title,
    total: achievements.length,
    unlocked: achievements.filter((a) => a.unlocked).length,
    stale: false,
    achievements,
  };
}

export interface AchievementServiceOptions {
  steam: { gameData(appId: string): Promise<SteamGameData | null> };
  ra: { gameProgress(id: string): Promise<RaGameProgress | null> };
  now?: () => number;
  ttlMs?: number;
  /** How long a failed first fetch is remembered before upstream is tried again. */
  failTtlMs?: number;
  /** How long a stale copy is served without trying upstream again after a failed refresh. */
  staleRetryMs?: number;
  maxEntries?: number;
  /** Process-wide ceiling on upstream fetches in any rolling minute, across all keys. */
  maxFetchesPerMinute?: number;
  /** The same ceiling for priority fetches, which never draw on the general one. */
  maxPriorityFetchesPerMinute?: number;
}

export interface GetOptions {
  /** For a game the owner is playing: drawn from its own fetch budget. */
  priority?: boolean;
}

interface CacheEntry {
  value: AchievementsResponse | null;
  at: number;
  /** The last refresh failed; `value` is an older copy that is served marked stale. */
  stale: boolean;
}

interface Failure {
  error: unknown;
  at: number;
}

export class AchievementService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, Failure>();
  private readonly inFlight = new Map<string, Promise<AchievementsResponse | null>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failTtlMs: number;
  private readonly staleRetryMs: number;
  private readonly maxEntries: number;
  private readonly maxFetchesPerMinute: number;
  private readonly maxPriorityFetchesPerMinute: number;
  /** Start times of recent upstream fetches, oldest first, one list per budget. */
  private readonly fetchTimes: number[] = [];
  private readonly priorityFetchTimes: number[] = [];

  constructor(private readonly opts: AchievementServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 45_000;
    this.failTtlMs = opts.failTtlMs ?? 30_000;
    this.staleRetryMs = opts.staleRetryMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 300;
    this.maxFetchesPerMinute = opts.maxFetchesPerMinute ?? 6;
    this.maxPriorityFetchesPerMinute = opts.maxPriorityFetchesPerMinute ?? 6;
  }

  async get(
    source: Source,
    id: string,
    opts: GetOptions = {},
  ): Promise<AchievementsResponse | null> {
    const key = `${source}:${id}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < (cached.stale ? this.staleRetryMs : this.ttlMs)) {
      return cached.stale && cached.value ? { ...cached.value, stale: true } : cached.value;
    }

    const failed = this.failures.get(key);
    if (failed && this.now() - failed.at < this.failTtlMs) throw failed.error;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.refresh(source, id, key, cached, opts.priority === true).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, request);
    return request;
  }

  private async refresh(
    source: Source,
    id: string,
    key: string,
    cached: CacheEntry | undefined,
    priority: boolean,
  ): Promise<AchievementsResponse | null> {
    if (!this.takeFetchSlot(priority)) {
      // Over the ceiling: serve what we have, untouched, so the next call asks again.
      if (cached) return cached.value && { ...cached.value, stale: true };
      throw new Error("upstream fetch limit reached");
    }
    try {
      const value = await this.fetch(source, id);
      this.failures.delete(key);
      this.store(this.cache, key, { value, at: this.now(), stale: false });
      return value;
    } catch (err) {
      if (cached) {
        // Re-stamp the old copy so the next calls answer from it instead of waiting on upstream again.
        this.store(this.cache, key, { ...cached, at: this.now(), stale: true });
        return cached.value && { ...cached.value, stale: true };
      }
      this.store(this.failures, key, { error: err, at: this.now() });
      throw err;
    }
  }

  private takeFetchSlot(priority: boolean): boolean {
    const times = priority ? this.priorityFetchTimes : this.fetchTimes;
    const max = priority ? this.maxPriorityFetchesPerMinute : this.maxFetchesPerMinute;
    const t = this.now();
    while (times.length > 0 && t - (times[0] as number) >= 60_000) times.shift();
    if (times.length >= max) return false;
    times.push(t);
    return true;
  }

  private async fetch(source: Source, id: string): Promise<AchievementsResponse | null> {
    if (source === "steam") {
      const data = await this.opts.steam.gameData(id);
      return data && normaliseSteam(id, data);
    }
    const data = await this.opts.ra.gameProgress(id);
    return data && normaliseRa(id, data);
  }

  private store<T>(map: Map<string, T>, key: string, entry: T): void {
    map.delete(key);
    map.set(key, entry);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
