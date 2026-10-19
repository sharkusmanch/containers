import type { GameRef, NowState, Source } from "../shared/types.js";
import type { RaSummary } from "./ra.js";
import type { SteamPresence } from "./steam.js";
import { type XboxPresence, XboxRateLimitError, type XboxTitleInfo } from "./xbox.js";

export interface Observed {
  game: GameRef;
  at: number;
}

/** One Xbox presence reading, with whether its game is a genuine Xbox Live title. */
export interface XboxReading {
  presence: XboxPresence;
  /** False also when the title's info could not be found for this reading. */
  isXboxLive: boolean;
}

export interface PickInput {
  steam: SteamPresence | null;
  ra: RaSummary | null;
  /** Null (or absent) when Xbox is off, disconnected, or its reading has expired. */
  xbox?: XboxReading | null;
  lastSteam: Observed | null;
  lastXbox?: Observed | null;
  now: number;
  freshMs?: number;
}

export interface Picked {
  game: GameRef | null;
  state: NowState;
  observedAt: number | null;
  /**
   * What the game reports the player is doing; set only for a RetroAchievements or Xbox game
   * being played now.
   */
  presence: string | null;
  /** The Xbox device of an Xbox game being played now ("Series X", "PC"); null otherwise. */
  device: string | null;
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

/** Xbox's device types as the page names them; null for one it does not know. */
const XBOX_DEVICES: Record<string, string> = { Scarlett: "Series X", WindowsOneCore: "PC" };

function xboxDevice(type: string | null): string | null {
  return type !== null && Object.hasOwn(XBOX_DEVICES, type) ? (XBOX_DEVICES[type] ?? null) : null;
}

/** The game an Xbox reading shows, when it is a genuine Xbox Live title. */
function xboxGame(reading: XboxReading): GameRef | null {
  const title = reading.presence.title;
  if (!reading.isXboxLive || title === null) return null;
  return { source: "xbox", id: title.id, title: title.name || `Xbox game ${title.id}` };
}

export function pickCurrent(input: PickInput): Picked {
  const { steam, ra, xbox = null, lastSteam, lastXbox = null, now, freshMs = 10 * 60_000 } = input;
  const quiet = { presence: null, device: null };

  const live = steam ? steamGame(steam) : null;
  if (live && live.id !== null) return { game: live, state: "playing", observedAt: now, ...quiet };

  const xboxLive = xbox ? xboxGame(xbox) : null;
  if (xbox && xboxLive) {
    return {
      game: xboxLive,
      state: "playing",
      observedAt: now,
      presence: xbox.presence.title?.richPresence ?? null,
      device: xboxDevice(xbox.presence.device),
    };
  }

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
      device: null,
    };
  }

  // A non-Steam shortcut has no id to look a guide up by, so it only wins when RA has nothing fresh.
  if (live) return { game: live, state: "playing", observedAt: now, ...quiet };

  // A presence time far in the future is not trusted for ordering; clamp it to now.
  const raForOrder = raSeen ? { ...raSeen, at: Math.min(raSeen.at, now) } : null;
  const last = [lastSteam, lastXbox, raForOrder]
    .filter((o): o is Observed => o !== null)
    .sort((a, b) => b.at - a.at)[0];
  if (last) return { game: last.game, state: "last-played", observedAt: last.at, ...quiet };
  return { game: null, state: "none", observedAt: null, ...quiet };
}

export interface DetectorSnapshot extends Picked {
  stale: boolean;
}

export interface DetectorOptions {
  steam: { presence(): Promise<SteamPresence> };
  ra: { summary(): Promise<RaSummary> };
  /** Absent when Xbox is off. `presence` answers null when there is no session right now. */
  xbox?: {
    presence(): Promise<XboxPresence | null>;
    titleInfo(id: string): Promise<XboxTitleInfo | null>;
  };
  /** Whether Xbox is signed in; Xbox is neither polled nor counted otherwise. Default: always. */
  xboxConnected?: () => boolean;
  now?: () => number;
  steamIntervalMs?: number;
  raIntervalMs?: number;
  /** Xbox presence poll interval while it works; failures double it up to `xboxMaxDelayMs`. */
  xboxIntervalMs?: number;
  xboxMaxDelayMs?: number;
  /**
   * A Steam or Xbox reading older than this, with no newer successful poll, no longer counts as
   * playing.
   */
  steamMaxAgeMs?: number;
  /** Called only when a source changes between working and failing. */
  onStatus?: (source: Source, ok: boolean) => void;
}

export class Detector {
  private readonly steamSource: DetectorOptions["steam"];
  private readonly raSource: DetectorOptions["ra"];
  private readonly clock: () => number;
  private readonly steamIntervalMs: number;
  private readonly raIntervalMs: number;
  private readonly steamMaxAgeMs: number;
  private readonly onStatus: ((source: Source, ok: boolean) => void) | undefined;
  private readonly xboxSource: DetectorOptions["xbox"];
  private readonly xboxConnected: () => boolean;
  private readonly xboxIntervalMs: number;
  private readonly xboxMaxDelayMs: number;

  private steam: SteamPresence | null = null;
  private ra: RaSummary | null = null;
  private lastSteam: Observed | null = null;
  private steamPolledAt: number | null = null;
  private steamFailed = false;
  private raFailed = false;
  private timers: NodeJS.Timeout[] = [];

  private xbox: XboxReading | null = null;
  private lastXbox: Observed | null = null;
  private xboxPolledAt: number | null = null;
  private xboxFailed = false;
  /** Wait before the next Xbox poll: the interval, longer after failures or a 429. */
  private xboxDelayMs: number;
  private xboxTimer: NodeJS.Timeout | null = null;
  /** Bumped by start and stop, so a poll still running from an earlier start schedules nothing. */
  private xboxRun = 0;
  private running = false;

  constructor(opts: DetectorOptions) {
    this.steamSource = opts.steam;
    this.raSource = opts.ra;
    this.clock = opts.now ?? Date.now;
    this.steamIntervalMs = opts.steamIntervalMs ?? 30_000;
    this.raIntervalMs = opts.raIntervalMs ?? 60_000;
    this.steamMaxAgeMs = opts.steamMaxAgeMs ?? 5 * 60_000;
    this.onStatus = opts.onStatus;
    this.xboxSource = opts.xbox;
    this.xboxConnected = opts.xboxConnected ?? (() => true);
    this.xboxIntervalMs = opts.xboxIntervalMs ?? 30_000;
    this.xboxMaxDelayMs = opts.xboxMaxDelayMs ?? 5 * 60_000;
    this.xboxDelayMs = this.xboxIntervalMs;
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

  /**
   * One Xbox presence reading, only while signed in. Never rejects. A failure (including no
   * session) doubles the wait before the next poll, up to the maximum; a 429 waits at least as
   * long as Xbox asked; a success resets it.
   */
  async pollXbox(): Promise<void> {
    const source = this.xboxSource;
    if (!source) return;
    if (!this.xboxConnected()) {
      this.xbox = null;
      this.xboxPolledAt = null;
      this.xboxDelayMs = this.xboxIntervalMs;
      // Not polling is not failing: the last Xbox game must not stay marked stale. Cleared
      // without a "recovered" line, since nothing recovered; the sign-in logs its own loss.
      this.xboxFailed = false;
      return;
    }
    try {
      const presence = await source.presence();
      if (presence === null) throw new Error("no xbox session");
      let isXboxLive = false;
      if (presence.title !== null) {
        // Unlisted or failed counts as not Xbox Live for this reading; the client caches both.
        const info = await source.titleInfo(presence.title.id).catch(() => null);
        isXboxLive = info?.isXboxLive === true;
      }
      const at = this.clock();
      const reading = { presence, isXboxLive };
      this.xbox = reading;
      this.xboxPolledAt = at;
      const game = xboxGame(reading);
      if (game) this.lastXbox = { game, at };
      this.xboxDelayMs = this.xboxIntervalMs;
      this.setXboxFailed(false);
    } catch (err) {
      const backoff = Math.min(this.xboxDelayMs * 2, this.xboxMaxDelayMs);
      this.xboxDelayMs =
        err instanceof XboxRateLimitError ? Math.max(backoff, err.retryAfterMs) : backoff;
      this.setXboxFailed(true);
    }
  }

  private setXboxFailed(failed: boolean): void {
    if (failed !== this.xboxFailed) this.onStatus?.("xbox", !failed);
    this.xboxFailed = failed;
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
    const xboxCurrent =
      this.xboxSource !== undefined &&
      this.xboxConnected() &&
      this.xboxPolledAt !== null &&
      now - this.xboxPolledAt <= this.steamMaxAgeMs;
    const picked = pickCurrent({
      steam: steamExpired ? null : this.steam,
      ra: this.ra,
      xbox: xboxCurrent ? this.xbox : null,
      lastSteam: this.lastSteam,
      lastXbox: this.lastXbox,
      now,
    });
    // Xbox failing makes only an Xbox answer stale; Steam and RA answers are unaffected.
    const xboxStale = this.xboxFailed && picked.game?.source === "xbox";
    return { ...picked, stale: this.steamFailed || this.raFailed || xboxStale };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollSteam();
    void this.pollRa();
    this.timers = [
      setInterval(() => void this.pollSteam(), this.steamIntervalMs).unref(),
      setInterval(() => void this.pollRa(), this.raIntervalMs).unref(),
    ];
    if (this.xboxSource) this.runXbox(++this.xboxRun);
  }

  /** Polls Xbox, then waits the delay that poll chose; a timer chain, not an interval. */
  private runXbox(run: number): void {
    void this.pollXbox().then(() => {
      if (run !== this.xboxRun) return;
      this.xboxTimer = setTimeout(() => this.runXbox(run), this.xboxDelayMs);
      this.xboxTimer.unref();
    });
  }

  stop(): void {
    this.running = false;
    this.xboxRun += 1;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.xboxTimer) clearTimeout(this.xboxTimer);
    this.xboxTimer = null;
  }
}
