import type { GameRef, NowState } from "../shared/types.js";
import type { RaSummary } from "./ra.js";
import type { SteamPresence } from "./steam.js";

export interface Observed {
  game: GameRef;
  at: number;
}

export interface PickInput {
  steam: SteamPresence | null;
  ra: RaSummary | null;
  lastSteam: Observed | null;
  now: number;
  freshMs?: number;
}

export interface Picked {
  game: GameRef | null;
  state: NowState;
  observedAt: number | null;
  /** What the game reports the player is doing; set only for a RetroAchievements game being played now. */
  presence: string | null;
}

/** Tolerated clock difference between this host and RetroAchievements. */
const SKEW_MS = 2 * 60_000;

export function isSteamAppId(id: string): boolean {
  return /^\d{1,10}$/.test(id);
}

function steamGame(p: SteamPresence): GameRef | null {
  if (p.appId === null) return null;
  const id = isSteamAppId(p.appId) ? p.appId : null;
  return { source: "steam", id, title: p.name ?? (id ? `Steam app ${id}` : "Unknown game") };
}

export function pickCurrent(input: PickInput): Picked {
  const { steam, ra, lastSteam, now, freshMs = 10 * 60_000 } = input;

  const live = steam ? steamGame(steam) : null;
  if (live && live.id !== null)
    return { game: live, state: "playing", observedAt: now, presence: null };

  const raSeen: Observed | null =
    ra && ra.gameId !== null && ra.presenceAt !== null
      ? {
          game: { source: "ra", id: ra.gameId, title: ra.title ?? `RA game ${ra.gameId}` },
          at: ra.presenceAt,
        }
      : null;

  if (raSeen && raSeen.at <= now + SKEW_MS && now - raSeen.at <= freshMs) {
    return {
      game: raSeen.game,
      state: "playing",
      observedAt: raSeen.at,
      presence: ra?.presence ?? null,
    };
  }

  // A non-Steam shortcut has no id to look a guide up by, so it only wins when RA has nothing fresh.
  if (live) return { game: live, state: "playing", observedAt: now, presence: null };

  // A presence time far in the future is not trusted for ordering; clamp it to now.
  const raForOrder = raSeen ? { ...raSeen, at: Math.min(raSeen.at, now) } : null;
  const last = [lastSteam, raForOrder]
    .filter((o): o is Observed => o !== null)
    .sort((a, b) => b.at - a.at)[0];
  if (last) return { game: last.game, state: "last-played", observedAt: last.at, presence: null };
  return { game: null, state: "none", observedAt: null, presence: null };
}

export interface DetectorSnapshot extends Picked {
  stale: boolean;
}

export interface DetectorOptions {
  steam: { presence(): Promise<SteamPresence> };
  ra: { summary(): Promise<RaSummary> };
  now?: () => number;
  steamIntervalMs?: number;
  raIntervalMs?: number;
  /** A Steam reading older than this, with no newer successful poll, no longer counts as playing. */
  steamMaxAgeMs?: number;
  /** Called only when a source changes between working and failing. */
  onStatus?: (source: "steam" | "ra", ok: boolean) => void;
}

export class Detector {
  private readonly steamSource: DetectorOptions["steam"];
  private readonly raSource: DetectorOptions["ra"];
  private readonly clock: () => number;
  private readonly steamIntervalMs: number;
  private readonly raIntervalMs: number;
  private readonly steamMaxAgeMs: number;
  private readonly onStatus: ((source: "steam" | "ra", ok: boolean) => void) | undefined;

  private steam: SteamPresence | null = null;
  private ra: RaSummary | null = null;
  private lastSteam: Observed | null = null;
  private steamPolledAt: number | null = null;
  private steamFailed = false;
  private raFailed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: DetectorOptions) {
    this.steamSource = opts.steam;
    this.raSource = opts.ra;
    this.clock = opts.now ?? Date.now;
    this.steamIntervalMs = opts.steamIntervalMs ?? 30_000;
    this.raIntervalMs = opts.raIntervalMs ?? 60_000;
    this.steamMaxAgeMs = opts.steamMaxAgeMs ?? 5 * 60_000;
    this.onStatus = opts.onStatus;
  }

  async pollSteam(): Promise<void> {
    try {
      const presence = await this.steamSource.presence();
      const game = steamGame(presence);
      const at = this.clock();
      this.steam = presence;
      this.steamPolledAt = at;
      // A shortcut has no id to find a guide by, so it is never remembered as the last game.
      if (game && game.id !== null) this.lastSteam = { game, at };
      this.setSteamFailed(false);
    } catch {
      this.setSteamFailed(true);
    }
  }

  async pollRa(): Promise<void> {
    try {
      this.ra = await this.raSource.summary();
      this.setRaFailed(false);
    } catch {
      this.setRaFailed(true);
    }
  }

  private setSteamFailed(failed: boolean): void {
    if (failed !== this.steamFailed) this.onStatus?.("steam", !failed);
    this.steamFailed = failed;
  }

  private setRaFailed(failed: boolean): void {
    if (failed !== this.raFailed) this.onStatus?.("ra", !failed);
    this.raFailed = failed;
  }

  current(): DetectorSnapshot {
    const now = this.clock();
    // A reading that can no longer be refreshed is not evidence the game is still running.
    const steamExpired =
      this.steamPolledAt !== null && now - this.steamPolledAt > this.steamMaxAgeMs;
    const picked = pickCurrent({
      steam: steamExpired ? null : this.steam,
      ra: this.ra,
      lastSteam: this.lastSteam,
      now,
    });
    return { ...picked, stale: this.steamFailed || this.raFailed };
  }

  start(): void {
    if (this.timers.length > 0) return;
    void this.pollSteam();
    void this.pollRa();
    this.timers = [
      setInterval(() => void this.pollSteam(), this.steamIntervalMs).unref(),
      setInterval(() => void this.pollRa(), this.raIntervalMs).unref(),
    ];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
