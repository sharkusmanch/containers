process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import { AskLimiter } from "../src/server/rate-limit.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

function limiter(start: number, perMinute = 10, perDay = 150) {
  const clock = { t: start };
  return { clock, l: new AskLimiter({ perMinute, perDay, now: () => clock.t }) };
}

describe("AskLimiter", () => {
  it("rejects the 11th question in a minute with the seconds until the oldest leaves", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 12));
    for (let i = 0; i < 10; i++) {
      expect(l.admit()).toEqual({ ok: true });
      clock.t += 1000;
    }
    // oldest admit was 10 s ago, so 50 s remain
    expect(l.admit()).toEqual({ ok: false, limit: "minute", retryAfterSec: 50 });
  });

  it("rounds retryAfterSec up and never reports less than 1", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 12), 1, 150);
    l.admit();
    clock.t += 59_500;
    expect(l.admit()).toEqual({ ok: false, limit: "minute", retryAfterSec: 1 });
  });

  it("admits again once the window has passed", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 12));
    for (let i = 0; i < 10; i++) l.admit();
    expect(l.admit().ok).toBe(false);
    clock.t += 61_000;
    expect(l.admit()).toEqual({ ok: true });
  });

  it("does not count a rejected question", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 12), 2, 3);
    l.admit();
    l.admit();
    expect(l.admit().ok).toBe(false);
    expect(l.admit().ok).toBe(false);
    clock.t += 61_000;
    expect(l.admit()).toEqual({ ok: true }); // the third and last of the day
    clock.t += 61_000;
    expect(l.admit()).toMatchObject({ ok: false, limit: "day" });
  });

  it("rejects the 151st question of a local day with the seconds to local midnight", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 8));
    for (let i = 0; i < 150; i++) {
      expect(l.admit()).toEqual({ ok: true });
      clock.t += 61_000;
    }
    const now = clock.t;
    const result = l.admit();
    const midnight = at(2026, 10, 16);
    expect(result).toEqual({
      ok: false,
      limit: "day",
      retryAfterSec: Math.ceil((midnight - now) / 1000),
    });
  });

  it("resets the day count at local midnight", () => {
    const { clock, l } = limiter(at(2026, 10, 15, 23, 0), 1000, 3);
    for (let i = 0; i < 3; i++) l.admit();
    expect(l.admit()).toMatchObject({ ok: false, limit: "day" });
    clock.t = at(2026, 10, 16, 0, 0, 1);
    expect(l.admit()).toEqual({ ok: true });
  });

  it("counts a day by local midnight, not UTC", () => {
    // 23:30 Pacific on the 15th is already the 16th in UTC.
    const { clock, l } = limiter(at(2026, 10, 15, 23, 30), 1000, 1);
    expect(l.admit()).toEqual({ ok: true });
    clock.t = at(2026, 10, 15, 23, 59);
    expect(l.admit()).toMatchObject({ ok: false, limit: "day" });
  });
});
