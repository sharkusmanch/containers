import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabelService, type LabelAgent, type LabelResult } from "../src/server/labels.js";
import type { GuidePage } from "../src/shared/types.js";

// The real rename and writeFile, with seams so a test can make one fail or count them.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
const fsp = await import("node:fs/promises");

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 3_600_000;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "labels-"));
  file = join(dir, "labels.json");
  vi.mocked(fsp.rename).mockClear();
  vi.mocked(fsp.writeFile).mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A clock and timers the test moves by hand. */
function manualTime() {
  let t = T0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return () => timers.delete(id);
    },
    /** Delays of the timers still pending, from now. */
    pending: (): number[] => [...timers.values()].map((e) => e.at - t),
    advance(ms: number): void {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (first === undefined) break;
        timers.delete(first[0]);
        t = first[1].at;
        first[1].fn();
      }
      t = end;
    },
  };
}

const page = (title: string, children: GuidePage[] = []): GuidePage => ({
  title,
  url: `/doc/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-ID`,
  children,
});

/** An agent that labels each title with its first four letters. */
function fakeAgent(answer?: (titles: string[]) => Promise<LabelResult> | LabelResult) {
  const calls: string[][] = [];
  const agent: LabelAgent = {
    label: vi.fn(async (titles: string[]) => {
      calls.push([...titles]);
      if (answer) return answer(titles);
      return {
        kind: "labels" as const,
        labels: Object.fromEntries(titles.map((t) => [t, t.replace(/\W/g, "").slice(0, 4)])),
      };
    }),
  };
  return { agent, calls };
}

function service(
  agent: LabelAgent | null,
  time = manualTime(),
  log: (msg: string, extra?: Record<string, unknown>) => void = vi.fn(),
) {
  const s = new LabelService({ file, agent, log, now: time.now, setTimer: time.setTimer });
  return { s, time, log };
}

const labelsOf = (pages: GuidePage[]): Record<string, string | undefined> =>
  Object.fromEntries(
    pages.flatMap(function walk(p): [string, string | undefined][] {
      return [[p.title, p.label], ...p.children.flatMap(walk)];
    }),
  );

describe("LabelService annotate", () => {
  it("labels the standard pages from the common mapping without asking the agent", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    const pages = s.annotate([
      page("Achievement Checklist", [page("Notes")]),
      page("Collectibles"),
    ]);
    expect(labelsOf(pages)).toEqual({
      "Achievement Checklist": "Checklist",
      Notes: "Notes",
      Collectibles: "Collect",
    });
    expect(time.pending()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns copies and leaves the pages it was given alone", async () => {
    const { s } = service(fakeAgent().agent);
    await s.load();
    const given = [page("Notes", [page("Collectibles")])];
    const before = structuredClone(given);
    const out = s.annotate(given);
    expect(given).toEqual(before);
    expect(out[0]).not.toBe(given[0]);
    expect(out[0]?.url).toBe(given[0]?.url);
  });

  it("answers at once, then asks the agent once per new title after the 2 s debounce", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    const tree = [page("Walkthrough", [page("Boss Guide")]), page("Notes")];
    expect(labelsOf(s.annotate(tree))).toEqual({
      Walkthrough: undefined,
      "Boss Guide": undefined,
      Notes: "Notes",
    });
    s.annotate([page("Walkthrough"), page("Boss Guide")]);
    time.advance(1999);
    expect(calls).toEqual([]);
    time.advance(1);
    await s.settled();
    expect(calls).toEqual([["Walkthrough", "Boss Guide"]]);
    expect(labelsOf(s.annotate(tree))).toEqual({
      Walkthrough: "Walk",
      "Boss Guide": "Boss",
      Notes: "Notes",
    });
    expect(time.pending()).toEqual([]);
  });

  it("restarts the debounce when another title arrives", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(1500);
    s.annotate([page("Walkthrough")]);
    s.annotate([page("Side Quests")]);
    time.advance(1500);
    expect(calls).toEqual([]);
    time.advance(500);
    await s.settled();
    expect(calls).toEqual([["Walkthrough", "Side Quests"]]);
  });

  it("asks in batches of at most 40, one at a time", async () => {
    const gates: (() => void)[] = [];
    const { agent, calls } = fakeAgent(
      (titles) =>
        new Promise((resolve) =>
          gates.push(() =>
            resolve({
              kind: "labels",
              labels: Object.fromEntries(titles.map((t) => [t, t.slice(-3)])),
            }),
          ),
        ),
    );
    const { s, time } = service(agent);
    await s.load();
    const titles = Array.from({ length: 95 }, (_, i) => `Page ${String(i).padStart(3, "0")}`);
    s.annotate(titles.map((t) => page(t)));
    time.advance(2000);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual(titles.slice(0, 40));
    gates[0]?.();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(titles.slice(40, 80));
    gates[1]?.();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual(titles.slice(80));
    gates[2]?.();
    await s.settled();
    expect(labelsOf(s.annotate([page("Page 094")]))).toEqual({ "Page 094": "094" });
  });

  it("never queues a title the agent would refuse (blank or over 200 characters)", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("   "), page("x".repeat(201))]);
    expect(time.pending()).toEqual([]);
    time.advance(5000);
    expect(calls).toEqual([]);
  });

  it("sends trimmed titles and caches under the exact title", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page(" Walkthrough ")]);
    time.advance(2000);
    await s.settled();
    expect(calls).toEqual([["Walkthrough"]]);
    expect(labelsOf(s.annotate([page(" Walkthrough ")]))).toEqual({ " Walkthrough ": "Walk" });
  });
});

describe("LabelService answers", () => {
  it("checks the agent's labels again and keeps only valid ones for titles it asked about", async () => {
    const { agent } = fakeAgent(() => ({
      kind: "labels",
      labels: { Walkthrough: "Walkthrough", "Boss Guide": " Bosses ", Other: "Oth", Notes: "N" },
    }));
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough"), page("Boss Guide")]);
    time.advance(2000);
    await s.settled();
    expect(labelsOf(s.annotate([page("Walkthrough"), page("Boss Guide"), page("Other")]))).toEqual({
      Walkthrough: undefined,
      "Boss Guide": "Bosses",
      Other: undefined,
    });
  });

  it("backs off an hour for every title of a failed batch", async () => {
    let fail = true;
    const { agent, calls } = fakeAgent((titles) =>
      fail
        ? { kind: "failed" }
        : { kind: "labels", labels: Object.fromEntries(titles.map((t) => [t, "Ok"])) },
    );
    const { s, time, log } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(calls).toHaveLength(1);
    fail = false;
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([]);
    time.advance(HOUR - 1);
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([]);
    time.advance(1);
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(calls).toHaveLength(2);
    expect(labelsOf(s.annotate([page("Walkthrough")]))).toEqual({ Walkthrough: "Ok" });
    expect(log).toHaveBeenCalledWith("labels failed", expect.objectContaining({ titles: 1 }));
  });

  it("backs off an hour for a title the agent gave no valid label", async () => {
    const { agent, calls } = fakeAgent(() => ({ kind: "labels", labels: {} }));
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([]);
    time.advance(HOUR);
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(calls).toHaveLength(2);
  });

  it("treats a rejected call as a failure", async () => {
    const { agent } = fakeAgent(() => Promise.reject(new Error("boom")));
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([]);
  });

  it("waits the agent's Retry-After after a 429, then asks again for the same titles", async () => {
    let busy = true;
    const { agent, calls } = fakeAgent((titles) => {
      if (busy) {
        busy = false;
        return { kind: "busy", retryAfterMs: 120_000 };
      }
      return { kind: "labels", labels: Object.fromEntries(titles.map((t) => [t, "Ok"])) };
    });
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(calls).toEqual([["Walkthrough"]]);
    expect(time.pending()).toEqual([120_000]);
    // A new title meanwhile does not bring the next call forward.
    s.annotate([page("Side Quests")]);
    expect(time.pending()).toEqual([120_000]);
    time.advance(119_999);
    expect(calls).toHaveLength(1);
    time.advance(1);
    await s.settled();
    expect(calls[1]).toEqual(["Walkthrough", "Side Quests"]);
    expect(labelsOf(s.annotate([page("Walkthrough")]))).toEqual({ Walkthrough: "Ok" });
  });

  it("logs counts only, never a title or a label", async () => {
    const { agent } = fakeAgent(() => ({ kind: "labels", labels: { "Secret Title": "Hush" } }));
    const { s, time, log } = service(agent);
    await s.load();
    s.annotate([page("Secret Title")]);
    time.advance(2000);
    await s.settled();
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toMatch(/Secret|Hush/);
  });
});

describe("LabelService cache file", () => {
  it("saves labels to labels.json and a new service reads them back", async () => {
    const { s, time } = service(fakeAgent().agent);
    await s.load();
    s.annotate([page("Walkthrough"), page("Boss Guide")]);
    time.advance(2000);
    await s.settled();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      labels: { Walkthrough: "Walk", "Boss Guide": "Boss" },
      unlabelled: {},
    });
    expect(await readdir(dir)).toEqual(["labels.json"]);

    const { agent, calls } = fakeAgent();
    const again = service(agent);
    await again.s.load();
    expect(labelsOf(again.s.annotate([page("Walkthrough")]))).toEqual({ Walkthrough: "Walk" });
    expect(again.time.pending()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("writes through a temp file and rename, so a failed write leaves the old file whole", async () => {
    await writeFile(file, JSON.stringify({ Notes2: "Old" }));
    const { s, time, log } = service(fakeAgent().agent);
    await s.load();
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error("disk full"));
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ Notes2: "Old" });
    expect(await readdir(dir)).toEqual(["labels.json"]);
    expect(log).toHaveBeenCalledWith("label cache write failed");
    // The label is still used from memory.
    expect(labelsOf(s.annotate([page("Walkthrough")]))).toEqual({ Walkthrough: "Walk" });
    expect(vi.mocked(fsp.rename).mock.calls[0]?.[1]).toBe(file);
  });

  it("starts empty without a file", async () => {
    const { s, log } = service(fakeAgent().agent);
    await expect(s.load()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["broken JSON", "{not json"],
    ["an array", "[1]"],
    ["null", "null"],
  ])("starts empty, and logs, with %s in the file", async (_name, body) => {
    await writeFile(file, body);
    const { s, time, log } = service(fakeAgent().agent);
    await expect(s.load()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("label cache unreadable; starting empty");
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([2000]);
  });

  it("drops entries that are not valid labels", async () => {
    await writeFile(
      file,
      JSON.stringify({ Walkthrough: "Walkthrough", "Boss Guide": 3, "Side Quests": "Side" }),
    );
    const { s } = service(fakeAgent().agent);
    await s.load();
    expect(
      labelsOf(s.annotate([page("Walkthrough"), page("Boss Guide"), page("Side Quests")])),
    ).toEqual({ Walkthrough: undefined, "Boss Guide": undefined, "Side Quests": "Side" });
  });
});

describe("LabelService without an agent", () => {
  it("gives the common mapping only: no cache, nothing queued", async () => {
    await writeFile(file, JSON.stringify({ Walkthrough: "Walk" }));
    const { s, time } = service(null);
    await s.load();
    expect(labelsOf(s.annotate([page("Walkthrough"), page("Notes")]))).toEqual({
      Walkthrough: undefined,
      Notes: "Notes",
    });
    expect(time.pending()).toEqual([]);
    await s.settled();
  });
});

/** The cache file as saved. */
const saved = async (): Promise<{
  labels: Record<string, string>;
  unlabelled: Record<string, number>;
}> =>
  JSON.parse(await readFile(file, "utf8")) as {
    labels: Record<string, string>;
    unlabelled: Record<string, number>;
  };

describe("LabelService tries (generate once)", () => {
  it("counts an answer without a usable label as a try, kept across restarts; two tries end it", async () => {
    const first = fakeAgent(() => ({ kind: "labels", labels: { Walkthrough: "Walkthrough!" } }));
    const one = service(first.agent);
    await one.s.load();
    one.s.annotate([page("Walkthrough")]);
    one.time.advance(2000);
    await one.s.settled();
    expect(first.calls).toHaveLength(1);
    expect((await saved()).unlabelled).toEqual({ Walkthrough: 1 });

    // After a restart the second try goes out at once (the hour's wait was in memory).
    const second = fakeAgent(() => ({ kind: "labels", labels: {} }));
    const two = service(second.agent);
    await two.s.load();
    two.s.annotate([page("Walkthrough")]);
    two.time.advance(2000);
    await two.s.settled();
    expect(second.calls).toEqual([["Walkthrough"]]);
    expect((await saved()).unlabelled).toEqual({ Walkthrough: 2 });

    const third = fakeAgent();
    const three = service(third.agent);
    await three.s.load();
    const pages = [page("Walkthrough")];
    expect(labelsOf(three.s.annotate(pages))).toEqual({ Walkthrough: undefined });
    expect(three.s.labelsPending(pages)).toBe(false);
    expect(three.time.pending()).toEqual([]);
    three.time.advance(10 * HOUR);
    three.s.annotate(pages);
    expect(three.time.pending()).toEqual([]);
    expect(third.calls).toEqual([]);
  });

  it("asks a second time after an hour within one run, then never again", async () => {
    const { agent, calls } = fakeAgent(() => ({ kind: "labels", labels: {} }));
    const { s, time } = service(agent);
    await s.load();
    for (let i = 0; i < 2; i++) {
      s.annotate([page("Walkthrough")]);
      time.advance(2000);
      await s.settled();
      time.advance(HOUR);
    }
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("does not count failures, busy answers or rejected calls as tries", async () => {
    const results: LabelResult[] = [{ kind: "busy", retryAfterMs: 5000 }, { kind: "failed" }];
    const { agent, calls } = fakeAgent(() => results.shift() ?? { kind: "failed" });
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough"), page("Boss Guide")]);
    time.advance(2000);
    await s.settled();
    time.advance(5000);
    await s.settled();
    expect(calls).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
    const again = service(fakeAgent().agent);
    await again.s.load();
    again.s.annotate([page("Walkthrough")]);
    expect(again.time.pending()).toEqual([2000]);
  });

  it("forgets a title's tries once it gets a label", async () => {
    await writeFile(file, JSON.stringify({ labels: {}, unlabelled: { Walkthrough: 1 } }));
    const { s, time } = service(fakeAgent().agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(await saved()).toEqual({ labels: { Walkthrough: "Walk" }, unlabelled: {} });
  });

  it("refuses a label equal to a common mapping name for another title, as a try", async () => {
    const { agent } = fakeAgent(() => ({
      kind: "labels",
      labels: { Walkthrough: "Notes", "Boss Guide": "checklist", "Side Quests": "Side" },
    }));
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough"), page("Boss Guide"), page("Side Quests")]);
    time.advance(2000);
    await s.settled();
    expect(await saved()).toEqual({
      labels: { "Side Quests": "Side" },
      unlabelled: { Walkthrough: 1, "Boss Guide": 1 },
    });
  });

  it("drops a cached label equal to a common mapping name on load", async () => {
    await writeFile(file, JSON.stringify({ Walkthrough: "Blind", "Side Quests": "Side" }));
    const { s } = service(fakeAgent().agent);
    await s.load();
    expect(labelsOf(s.annotate([page("Walkthrough"), page("Side Quests")]))).toEqual({
      Walkthrough: undefined,
      "Side Quests": "Side",
    });
  });

  it("reads both the old flat file and the current shape", async () => {
    await writeFile(
      file,
      JSON.stringify({ labels: { Walkthrough: "Walk" }, unlabelled: { "Boss Guide": 2, X: "no" } }),
    );
    const { s, time } = service(fakeAgent().agent);
    await s.load();
    expect(labelsOf(s.annotate([page("Walkthrough"), page("Boss Guide")]))).toEqual({
      Walkthrough: "Walk",
      "Boss Guide": undefined,
    });
    expect(time.pending()).toEqual([]);
  });
});

describe("LabelService per guide", () => {
  it("never shows one generated label on two pages of a guide: the later falls back", async () => {
    await writeFile(
      file,
      JSON.stringify({ "Boss Guide": "Boss", "Boss Rush": "boss", "Side Quests": "Side" }),
    );
    const { s } = service(fakeAgent().agent);
    await s.load();
    expect(
      labelsOf(s.annotate([page("Boss Guide", [page("Boss Rush")]), page("Side Quests")])),
    ).toEqual({ "Boss Guide": "Boss", "Boss Rush": undefined, "Side Quests": "Side" });
    // Each guide on its own may use it.
    expect(labelsOf(s.annotate([page("Boss Rush")]))).toEqual({ "Boss Rush": "boss" });
  });
});

describe("LabelService labelsPending", () => {
  it("is true while a title of the tree is queued or being asked about, then false", async () => {
    let open: () => void = () => undefined;
    const { agent, calls } = fakeAgent(
      (titles) =>
        new Promise((resolve) => {
          open = () =>
            resolve({ kind: "labels", labels: Object.fromEntries(titles.map((t) => [t, "Ok"])) });
        }),
    );
    const { s, time } = service(agent);
    await s.load();
    const tree = [page("Notes"), page("Walkthrough")];
    expect(s.labelsPending([page("Notes")])).toBe(false);
    s.annotate(tree);
    expect(s.labelsPending(tree)).toBe(true);
    time.advance(2000);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // In flight: still pending, and not queued a second time.
    s.annotate(tree);
    expect(s.labelsPending(tree)).toBe(true);
    expect(time.pending()).toEqual([]);
    open();
    await s.settled();
    expect(calls).toHaveLength(1);
    expect(s.labelsPending(tree)).toBe(false);
    s.annotate(tree);
    expect(s.labelsPending(tree)).toBe(false);
  });

  it("is false for a title waiting out a failure", async () => {
    const { agent } = fakeAgent(() => ({ kind: "failed" }));
    const { s, time } = service(agent);
    await s.load();
    const tree = [page("Walkthrough")];
    s.annotate(tree);
    time.advance(2000);
    await s.settled();
    s.annotate(tree);
    expect(s.labelsPending(tree)).toBe(false);
  });

  it("is false without an agent", async () => {
    const { s } = service(null);
    await s.load();
    const tree = [page("Walkthrough")];
    s.annotate(tree);
    expect(s.labelsPending(tree)).toBe(false);
  });
});

describe("LabelService file safety", () => {
  it("keeps labels in memory but never writes when the file cannot be read (not missing)", async () => {
    await mkdir(file); // reading it fails with EISDIR, not ENOENT
    const { s, time, log } = service(fakeAgent().agent);
    await s.load();
    expect(log).toHaveBeenCalledWith("label cache unreadable; not saving");
    s.annotate([page("Walkthrough")]);
    time.advance(2000);
    await s.settled();
    expect(labelsOf(s.annotate([page("Walkthrough")]))).toEqual({ Walkthrough: "Walk" });
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
  });

  it("removes stale temp files of the cache on load, and nothing else", async () => {
    await writeFile(join(dir, "labels.json.123.4.tmp"), "{");
    await writeFile(join(dir, "labels.json.9.1.tmp"), "{");
    await writeFile(join(dir, "platforms.json.1.1.tmp"), "{");
    await writeFile(join(dir, "xbox-token.json"), "{}");
    const { s } = service(fakeAgent().agent);
    await s.load();
    expect((await readdir(dir)).sort()).toEqual(["platforms.json.1.1.tmp", "xbox-token.json"]);
  });

  it("close cancels a waiting request and waits for the work under way", async () => {
    const { agent, calls } = fakeAgent();
    const { s, time } = service(agent);
    await s.load();
    s.annotate([page("Walkthrough")]);
    expect(time.pending()).toEqual([2000]);
    await s.close();
    expect(time.pending()).toEqual([]);
    s.annotate([page("Side Quests")]);
    expect(time.pending()).toEqual([]);
    expect(calls).toEqual([]);
  });
});
