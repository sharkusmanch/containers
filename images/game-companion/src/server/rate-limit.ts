export type Admission =
  { ok: true } | { ok: false; limit: "minute" | "day"; retryAfterSec: number };

const MINUTE_MS = 60_000;

const startOfLocalDay = (ms: number, offsetDays = 0): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
};

/** Spend guard: a rolling per-minute cap and a per-local-calendar-day cap, both in memory. */
export class AskLimiter {
  private readonly perMinute: number;
  private readonly perDay: number;
  private readonly now: () => number;
  /** Admit times inside the current 60 s window, oldest first. */
  private recent: number[] = [];
  private dayStart = Number.NEGATIVE_INFINITY;
  private dayCount = 0;

  constructor(opts: { perMinute: number; perDay: number; now?: () => number }) {
    this.perMinute = opts.perMinute;
    this.perDay = opts.perDay;
    this.now = opts.now ?? Date.now;
  }

  /** Counts the question when admitted; a rejected question is not counted. */
  admit(): Admission {
    const now = this.now();
    const today = startOfLocalDay(now);
    if (today !== this.dayStart) {
      this.dayStart = today;
      this.dayCount = 0;
    }
    this.recent = this.recent.filter((t) => t > now - MINUTE_MS);

    if (this.dayCount >= this.perDay) {
      return { ok: false, limit: "day", retryAfterSec: secondsUntil(startOfLocalDay(now, 1), now) };
    }
    if (this.recent.length >= this.perMinute) {
      return {
        ok: false,
        limit: "minute",
        retryAfterSec: secondsUntil(this.recent[0]! + MINUTE_MS, now),
      };
    }
    this.recent.push(now);
    this.dayCount += 1;
    return { ok: true };
  }
}

const secondsUntil = (target: number, now: number): number =>
  Math.max(1, Math.ceil((target - now) / 1000));
