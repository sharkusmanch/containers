import { describe, expect, it } from "vitest";
import {
  findInPages,
  GuidePageService,
  missableMarks,
  type PageText,
} from "../src/server/guide-pages.js";

// Code-unit mode (no `u` flag): matches a half of a surrogate pair standing alone.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const page = (id: string, text: string, title = `Page ${id}`): PageText => ({
  id,
  title,
  url: `/doc/${id}`,
  text,
});

describe("findInPages", () => {
  it("matches case-insensitively and reports the page", () => {
    const r = findInPages([page("a", "Collect the Sample Quest item")], "SAMPLE quest");
    expect(r).toEqual({
      matches: [
        {
          pageTitle: "Page a",
          pageUrl: "/doc/a",
          heading: null,
          snippet: "Collect the Sample Quest item",
        },
      ],
      truncated: false,
    });
  });

  it("gives one match per line, even when the line repeats the text", () => {
    const r = findInPages([page("a", "foo foo foo\nbar\nfoo")], "foo");
    expect(r.matches.map((m) => m.snippet)).toEqual(["foo foo foo", "foo"]);
  });

  it("searches pages in the given order and lines top to bottom", () => {
    const r = findInPages([page("b", "x one\nx two"), page("a", "x three")], "x");
    expect(r.matches.map((m) => m.snippet)).toEqual(["x one", "x two", "x three"]);
    expect(r.matches.map((m) => m.pageUrl)).toEqual(["/doc/b", "/doc/b", "/doc/a"]);
  });

  it("treats CRLF as a line break", () => {
    const r = findInPages([page("a", "# Head\r\nfind me\r\nother")], "find me");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.snippet).toBe("find me");
    expect(r.matches[0]?.heading).toBe("Head");
  });

  describe("heading", () => {
    it("is null before any heading", () => {
      expect(findInPages([page("a", "intro needle")], "needle").matches[0]?.heading).toBeNull();
    });

    it("is the nearest heading above, markers removed", () => {
      const text = "# Top\nneedle one\n### Deep  heading ##\nneedle two\n## Next\n- needle three";
      const r = findInPages([page("a", text)], "needle");
      expect(r.matches.map((m) => m.heading)).toEqual(["Top", "Deep  heading", "Next"]);
    });

    it("does not leak from an earlier page", () => {
      const r = findInPages([page("a", "# Section A\nbody"), page("b", "needle")], "needle");
      expect(r.matches[0]?.heading).toBeNull();
    });

    it("keeps a trailing # that belongs to the text", () => {
      const r = findInPages([page("a", "## Learning C#\nneedle")], "needle");
      expect(r.matches[0]?.heading).toBe("Learning C#");
    });

    it("needs a space after the markers and at most six of them", () => {
      const text = "#nospace\n####### seven\nneedle";
      expect(findInPages([page("a", text)], "needle").matches[0]?.heading).toBeNull();
    });

    it("lets a heading line match, with the heading above it", () => {
      const r = findInPages([page("a", "# One\n## Needle Two")], "needle");
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0]).toMatchObject({ heading: "One", snippet: "## Needle Two" });
    });
  });

  describe("snippet", () => {
    const snip = (line: string, q = "x"): string | undefined =>
      findInPages([page("a", line)], q).matches[0]?.snippet;

    it.each([
      ["- [ ] x task", "x task"],
      ["- [x] x done", "x done"],
      ["  - [X] x nested", "x nested"],
      ["* x bullet", "x bullet"],
      ["> x quote", "x quote"],
      ["1. x numbered", "x numbered"],
      ["12. x numbered", "x numbered"],
      ["> - [ ] x quoted task", "x quoted task"],
    ])("removes the leading marker of %j", (line, expected) => {
      expect(snip(line)).toBe(expected);
    });

    it("removes bold, underscore-bold and code markers", () => {
      expect(snip("**x** and __x__ and `x`")).toBe("x and x and x");
    });

    it("turns a markdown link into its text", () => {
      expect(snip("see [x page](https://example.test/a_(b)) now")).toBe("see x page now");
      expect(snip("[x](/doc/abc) and [y](/doc/def)")).toBe("x and y");
    });

    it("collapses whitespace", () => {
      expect(snip("x   a \t b")).toBe("x a b");
    });

    it("keeps a heading line's markers (it is a line like any other)", () => {
      expect(snip("## x head")).toBe("## x head");
    });

    it("cuts at 160 characters with an ellipsis", () => {
      const long = `x${"a".repeat(300)}`;
      const s = snip(long) as string;
      expect(s).toHaveLength(160);
      expect(s.endsWith("…")).toBe(true);
      expect(s.slice(0, 159)).toBe(long.slice(0, 159));
    });

    it("leaves a line of exactly 160 characters whole", () => {
      const exact = `x${"a".repeat(159)}`;
      expect(snip(exact)).toBe(exact);
    });

    it("shows a match near the end of a long line, cutting only the start", () => {
      const line = `${"a".repeat(380)} Needle ${"b".repeat(10)}`;
      const s = snip(line, "needle") as string;
      expect(s.length).toBeLessThanOrEqual(160);
      expect(s).toContain("Needle");
      expect(s.startsWith("…")).toBe(true);
      expect(s.endsWith("…")).toBe(false);
      expect(s.endsWith("b".repeat(10))).toBe(true);
    });

    it("centres a match in the middle of a long line, cutting both ends", () => {
      const line = `${"a".repeat(200)}Needle${"b".repeat(200)}`;
      const s = snip(line, "needle") as string;
      expect(s).toHaveLength(160);
      expect(s.startsWith("…a")).toBe(true);
      expect(s.endsWith("b…")).toBe(true);
      const at = s.indexOf("Needle");
      expect(at).toBeGreaterThan(60);
      expect(at + 6).toBeLessThan(100);
    });

    it("starts at the line's start when the match is near it", () => {
      const line = `Needle ${"b".repeat(300)}`;
      const s = snip(line, "needle") as string;
      expect(s).toHaveLength(160);
      expect(s.startsWith("Needle b")).toBe(true);
      expect(s.endsWith("…")).toBe(true);
    });

    it("falls back to the start when the cleaned line no longer holds the text", () => {
      const line = `${"a".repeat(300)} [x](/doc/needle)`;
      const s = snip(line, "/doc/needle") as string;
      expect(s).toHaveLength(160);
      expect(s.startsWith("aaa")).toBe(true);
    });

    it("never splits a surrogate pair at the end of the cut", () => {
      const line = `x${"a".repeat(157)}\u{1F600}${"b".repeat(200)}`;
      const s = snip(line) as string;
      expect(LONE_SURROGATE.test(s)).toBe(false);
      expect(s.endsWith("…")).toBe(true);
      expect(s.length).toBeLessThanOrEqual(160);
    });

    it("never splits a surrogate pair at the start of the window", () => {
      // The window start lands between the two halves of the emoji.
      const line = `${"a".repeat(250)}\u{1F600}${"b".repeat(151)} needle`;
      const s = snip(line, "needle") as string;
      expect(LONE_SURROGATE.test(s)).toBe(false);
      expect(s.startsWith("…")).toBe(true);
      expect(s).toContain("needle");
      expect(s.length).toBeLessThanOrEqual(160);
    });

    it("matches case-insensitively where lower-casing changes the length", () => {
      expect(snip("\u0130stanbul Target", "target")).toBe("\u0130stanbul Target");
      expect(snip("Target \u0130\u0130\u0130", "\u0130\u0130")).toBe("Target \u0130\u0130\u0130");
    });

    it("keeps the match in view when earlier characters change length when lower-cased", () => {
      const line = `${"\u0130".repeat(150)}${"x".repeat(150)} TARGET ${"y".repeat(200)}`;
      const s = snip(line, "target") as string;
      expect(s).toContain("TARGET");
      expect(s.length).toBeLessThanOrEqual(160);
    });

    it("stays fast on a long run of unclosed brackets", () => {
      const evil = `x${"[a](".repeat(20000)}`;
      const t = Date.now();
      expect(snip(evil)).toHaveLength(160);
      expect(Date.now() - t).toBeLessThan(1000);
    });
  });

  it("cuts a very long heading to 160 characters", () => {
    const r = findInPages([page("a", `## ${"h".repeat(300)}\nneedle`)], "needle");
    const h = r.matches[0]?.heading as string;
    expect(h).toHaveLength(160);
    expect(h.endsWith("…")).toBe(true);
    const short = findInPages([page("a", `## ${"h".repeat(160)}\nneedle`)], "needle");
    expect(short.matches[0]?.heading).toBe("h".repeat(160));
  });

  it("stops at the limit and says there was more", () => {
    const text = Array.from({ length: 5 }, (_, i) => `hit ${i}`).join("\n");
    const r = findInPages([page("a", text)], "hit", 3);
    expect(r.matches.map((m) => m.snippet)).toEqual(["hit 0", "hit 1", "hit 2"]);
    expect(r.truncated).toBe(true);
  });

  it("is not truncated when the matches exactly fill the limit", () => {
    const r = findInPages([page("a", "hit 0\nhit 1")], "hit", 2);
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it("returns at most twenty matches by default", () => {
    const text = Array.from({ length: 25 }, (_, i) => `hit ${i}`).join("\n");
    const r = findInPages([page("a", text)], "hit");
    expect(r.matches).toHaveLength(20);
    expect(r.truncated).toBe(true);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    const pages = [page("a", "anything at all\n  \n")];
    expect(findInPages(pages, "")).toEqual({ matches: [], truncated: false });
    expect(findInPages(pages, "   \t ")).toEqual({ matches: [], truncated: false });
  });

  it("trims the query", () => {
    expect(findInPages([page("a", "alpha beta")], "  alpha beta  ").matches).toHaveLength(1);
  });

  it("treats regular-expression characters literally", () => {
    const pages = [page("a", "a.*( b\nplain text\n[x]")];
    expect(findInPages(pages, ".*(").matches.map((m) => m.snippet)).toEqual(["a.*( b"]);
    expect(findInPages(pages, "[x").matches).toHaveLength(1);
    expect(findInPages(pages, ".*").matches).toHaveLength(1);
  });
});

describe("missableMarks", () => {
  const marks = (...lines: string[]): string[] => missableMarks([page("a", lines.join("\n"))]);

  it("reads the bold name of a checkbox line carrying the warning sign", () => {
    expect(marks("- [ ] **Sample Trophy** ⚠ missable in chapter 2")).toEqual(["sample trophy"]);
    expect(marks("- [x] ⚠ **Another One** done")).toEqual(["another one"]);
  });

  it("accepts the sign with the variation selector, any indent and either bullet", () => {
    expect(marks("  - [ ] **First** ⚠️", "\t* [x] **Second** ⚠")).toEqual(["first", "second"]);
  });

  it("takes the first bold span", () => {
    expect(marks("- [ ] **Alpha** then **Beta** ⚠")).toEqual(["alpha"]);
  });

  it("trims and lower-cases the name", () => {
    expect(marks("- [ ] **  Mixed CASE Name  ** ⚠")).toEqual(["mixed case name"]);
  });

  it("ignores the sign on a line that is not a checkbox", () => {
    expect(marks("**Plain** ⚠", "- **Bullet** ⚠", "| **Row** | ⚠ |", "## **Head** ⚠")).toEqual([]);
  });

  it("ignores a marked line without a bold span", () => {
    expect(marks("- [ ] No bold here ⚠")).toEqual([]);
  });

  it("ignores a bold span with no text", () => {
    expect(marks("- [ ] ** ** ⚠")).toEqual([]);
  });

  it("does not count the word missable without the sign", () => {
    expect(marks("- [ ] **Sample Trophy** missable")).toEqual([]);
  });

  it("cleans the name before lower-casing it", () => {
    expect(marks("- [ ] **⚠️ Sample Feat** — text")).toEqual(["sample feat"]);
    expect(marks("- [ ] **\u26A0 Plain Sign** ⚠")).toEqual(["plain sign"]);
    expect(marks("- [ ] ** ⚠  ⚠️  Twice ** x")).toEqual(["twice"]);
    expect(marks("- [ ] **[Linked Name](/doc/abc)** ⚠")).toEqual(["linked name"]);
    expect(marks("- [ ] **`Code` Name** ⚠")).toEqual(["code name"]);
    expect(marks("- [ ] **Spaced \t  Out   Name** ⚠")).toEqual(["spaced out name"]);
  });

  it("ignores a name that is empty after cleaning", () => {
    expect(marks("- [ ] **⚠️** ⚠", "- [ ] **` `** ⚠", "- [ ] **[](/doc/a)** ⚠")).toEqual([]);
  });

  it("collapses duplicates, keeping first-seen order, across pages", () => {
    const pages = [
      page("a", "- [ ] **Beta** ⚠\n- [ ] **Alpha** ⚠"),
      page("b", "- [x] **BETA** ⚠\n- [ ] **Gamma** ⚠"),
    ];
    expect(missableMarks(pages)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("handles CRLF line endings", () => {
    expect(missableMarks([page("a", "- [ ] **Crlf** ⚠\r\n- [ ] **Two** ⚠\r\n")])).toEqual([
      "crlf",
      "two",
    ]);
  });
});

describe("GuidePageService", () => {
  type Ref = { id: string; title: string; url: string };
  const ref = (id: string): Ref => ({ id, title: `Page ${id}`, url: `/doc/${id}` });

  function setup(
    over: {
      hubs?: Record<string, string[]>;
      texts?: Record<string, string>;
      failing?: Set<string>;
    } = {},
  ) {
    const hubs = over.hubs ?? { h1: ["a", "b"] };
    const texts = over.texts ?? { a: "# Intro\nalpha needle", b: "- [ ] **Beta** ⚠\nbeta needle" };
    const failing = over.failing ?? new Set<string>();
    const state = {
      clock: 1_000_000,
      loads: [] as string[],
      active: 0,
      maxActive: 0,
      /** While set, every page fetch waits for it (a hung wiki). */
      gate: null as Promise<void> | null,
      timers: [] as { fn: () => void; ms: number; cancelled: boolean }[],
    };
    const index = {
      pageRefs: (hubId: string): Ref[] | null => (hubs[hubId] ? hubs[hubId].map(ref) : null),
    };
    const source = {
      docText: async (id: string): Promise<string> => {
        state.loads.push(id);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise((r) => setTimeout(r, 1));
        if (state.gate) await state.gate;
        state.active -= 1;
        if (failing.has(id)) throw new Error("upstream said: secret-token-123");
        return texts[id] ?? "";
      },
    };
    const make = (opts: Partial<ConstructorParameters<typeof GuidePageService>[0]> = {}) =>
      new GuidePageService({
        index,
        source,
        now: () => state.clock,
        setTimer: (fn, ms) => {
          const t = { fn, ms, cancelled: false };
          state.timers.push(t);
          return () => {
            t.cancelled = true;
          };
        },
        ...opts,
      });
    return { state, make, failing, texts, hubs };
  }

  it("finds text across a hub's pages and reads its marks", async () => {
    const { make } = setup();
    const svc = make();
    const found = await svc.find("h1", "NEEDLE");
    expect(found?.matches.map((m) => [m.pageUrl, m.heading, m.snippet])).toEqual([
      ["/doc/a", "Intro", "alpha needle"],
      ["/doc/b", null, "beta needle"],
    ]);
    expect(await svc.marks("h1")).toEqual({ missable: ["beta"] });
  });

  it("answers null for an unknown hub", async () => {
    const { make, state } = setup();
    const svc = make();
    expect(await svc.find("nope", "needle")).toBeNull();
    expect(await svc.marks("nope")).toBeNull();
    expect(state.loads).toEqual([]);
  });

  it("serves from the cache within the TTL and reloads after it", async () => {
    const { make, state } = setup();
    const svc = make({ ttlMs: 60_000 });
    await svc.find("h1", "needle");
    await svc.marks("h1");
    state.clock += 59_999;
    await svc.find("h1", "other");
    expect(state.loads).toEqual(["a", "b"]);
    state.clock += 1;
    await svc.find("h1", "needle");
    expect(state.loads).toEqual(["a", "b", "a", "b"]);
  });

  it("defaults to a ten minute TTL", async () => {
    const { make, state } = setup();
    const svc = make();
    await svc.marks("h1");
    state.clock += 10 * 60_000 - 1;
    await svc.marks("h1");
    expect(state.loads).toHaveLength(2);
    state.clock += 1;
    await svc.marks("h1");
    expect(state.loads).toHaveLength(4);
  });

  it("shares one load between concurrent requests", async () => {
    const { make, state } = setup();
    const svc = make();
    const [a, b, c] = await Promise.all([
      svc.find("h1", "needle"),
      svc.find("h1", "alpha"),
      svc.marks("h1"),
    ]);
    expect(a?.matches).toHaveLength(2);
    expect(b?.matches).toHaveLength(1);
    expect(c).toEqual({ missable: ["beta"] });
    expect(state.loads).toEqual(["a", "b"]);
  });

  it("loads at most `concurrency` pages at a time, four by default", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const four = setup({ hubs: { h1: ids } });
    await four.make().marks("h1");
    expect(four.state.loads).toHaveLength(10);
    expect(four.state.maxActive).toBe(4);

    const two = setup({ hubs: { h1: ids } });
    await two.make({ concurrency: 2 }).marks("h1");
    expect(two.state.maxActive).toBe(2);
  });

  it("skips a page that fails and serves the rest", async () => {
    const { make } = setup({ failing: new Set(["a"]) });
    const found = await make().find("h1", "needle");
    expect(found?.matches.map((m) => m.pageUrl)).toEqual(["/doc/b"]);
  });

  it("rejects when every page fails and no copy is held, without upstream text", async () => {
    const { make } = setup({ failing: new Set(["a", "b"]) });
    const err = await make()
      .find("h1", "needle")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("secret-token-123");
  });

  it("serves the held copy when a refresh fails entirely", async () => {
    const { make, state, failing } = setup();
    const svc = make({ ttlMs: 1000 });
    await svc.find("h1", "needle");
    failing.add("a").add("b");
    state.clock += 5000;
    const again = await svc.find("h1", "needle");
    expect(again?.matches).toHaveLength(2);
    expect(state.loads).toEqual(["a", "b", "a", "b"]);
  });

  it("refuses the seventh hub load in a minute and serves a held copy instead", async () => {
    const hubs = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`h${i}`, [`p${i}`]]));
    const { make, state } = setup({ hubs, texts: { p0: "needle zero" } });
    const svc = make({ ttlMs: 1000, maxHubs: 20 });
    for (let i = 0; i < 6; i += 1) await svc.find(`h${i}`, "needle");
    expect(state.loads).toHaveLength(6);

    // No copy of the seventh hub: refused.
    await expect(svc.find("h6", "needle")).rejects.toThrow();
    expect(state.loads).toHaveLength(6);

    // A held (now expired) copy is served rather than refused.
    state.clock += 5000;
    const stale = await svc.find("h0", "needle");
    expect(stale?.matches.map((m) => m.snippet)).toEqual(["needle zero"]);
    expect(state.loads).toHaveLength(6);

    // The window rolls: a minute on, the earlier loads no longer count.
    state.clock += 60_000;
    await svc.find("h6", "needle");
    expect(state.loads).toHaveLength(7);
  });

  it("does not spend a slot on a refused request or a cached answer", async () => {
    const hubs = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`h${i}`, [`p${i}`]]));
    const { make, state } = setup({ hubs });
    const svc = make({ maxLoadsPerMinute: 2, maxHubs: 20 });
    await svc.find("h0", "x");
    await svc.find("h1", "x");
    for (let i = 0; i < 5; i += 1) {
      await svc.find("h0", "x");
      await expect(svc.find("h2", "x")).rejects.toThrow();
    }
    state.clock += 60_000;
    await svc.find("h2", "x");
    expect(state.loads).toEqual(["p0", "p1", "p2"]);
  });

  it("counts a failed load against the limit", async () => {
    const { make, state } = setup({ failing: new Set(["a", "b"]) });
    const svc = make({ maxLoadsPerMinute: 2 });
    await expect(svc.find("h1", "x")).rejects.toThrow();
    await expect(svc.find("h1", "x")).rejects.toThrow();
    await expect(svc.find("h1", "x")).rejects.toThrow();
    expect(state.loads).toHaveLength(4);
  });

  it("keeps at most maxHubs hubs, evicting the oldest first", async () => {
    const hubs = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`h${i}`, [`p${i}`]]));
    const { make, state } = setup({ hubs });
    const svc = make({ maxHubs: 2 });
    await svc.find("h0", "x");
    await svc.find("h1", "x");
    await svc.find("h2", "x");
    expect(state.loads).toEqual(["p0", "p1", "p2"]);
    await svc.find("h1", "x");
    await svc.find("h2", "x");
    expect(state.loads).toHaveLength(3);
    await svc.find("h0", "x");
    expect(state.loads).toEqual(["p0", "p1", "p2", "p0"]);
  });

  it("answers empty for a known hub when there is no source", async () => {
    const svc = new GuidePageService({
      index: { pageRefs: (id) => (id === "h1" ? [ref("a")] : null) },
      source: null,
    });
    expect(await svc.find("h1", "needle")).toEqual({ matches: [], truncated: false });
    expect(await svc.marks("h1")).toEqual({ missable: [] });
    expect(await svc.find("nope", "needle")).toBeNull();
    expect(await svc.marks("nope")).toBeNull();
  });

  it("does not load anything for an empty query", async () => {
    const { make, state } = setup();
    expect(await make().find("h1", "  ")).toEqual({ matches: [], truncated: false });
    expect(state.loads).toEqual([]);
  });

  it("answers empty for a hub with no pages without loading or spending a slot", async () => {
    const { make, state } = setup({ hubs: { h1: [] } });
    const svc = make({ maxLoadsPerMinute: 1 });
    expect(await svc.marks("h1")).toEqual({ missable: [] });
    expect(await svc.find("h1", "needle")).toEqual({ matches: [], truncated: false });
    expect(state.loads).toEqual([]);
  });

  describe("a slow wiki", () => {
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const hang = (state: { gate: Promise<void> | null }): (() => void) => {
      let release = () => {};
      state.gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        state.gate = null;
        release();
      };
    };

    it("answers an expired copy at once and refreshes in the background", async () => {
      const { make, state, texts } = setup();
      const svc = make({ ttlMs: 1000 });
      await svc.find("h1", "needle");
      state.clock += 5000;
      texts.a = "# Intro\nalpha needle changed";
      const release = hang(state);
      const quick = await svc.find("h1", "alpha");
      expect(quick?.matches[0]?.snippet).toBe("alpha needle");
      expect(state.loads).toEqual(["a", "b", "a", "b"]);
      // Still refreshing: more requests share it and are answered from the copy.
      await svc.marks("h1");
      expect(state.loads).toHaveLength(4);
      release();
      await settle();
      expect((await svc.find("h1", "alpha"))?.matches[0]?.snippet).toBe("alpha needle changed");
      expect(state.loads).toHaveLength(4);
    });

    it("keeps the held copy when the background refresh fails, without an unhandled rejection", async () => {
      const { make, state, failing } = setup();
      const svc = make({ ttlMs: 1000 });
      await svc.find("h1", "needle");
      failing.add("a").add("b");
      state.clock += 5000;
      expect((await svc.find("h1", "needle"))?.matches).toHaveLength(2);
      await settle();
      expect((await svc.find("h1", "needle"))?.matches).toHaveLength(2);
    });

    it("does nothing in the background when the limiter refuses", async () => {
      const { make, state } = setup();
      const svc = make({ ttlMs: 1000, maxLoadsPerMinute: 1 });
      await svc.find("h1", "needle");
      state.clock += 5000;
      expect((await svc.find("h1", "needle"))?.matches).toHaveLength(2);
      await settle();
      expect(state.loads).toEqual(["a", "b"]);
    });

    it("makes a request with no copy wait at most the deadline, while the load carries on", async () => {
      const { make, state } = setup();
      const svc = make();
      const release = hang(state);
      const first = svc.find("h1", "needle");
      const second = svc.marks("h1");
      const rejected = Promise.all([
        first.then(
          () => "ok",
          (e: unknown) => (e as Error).message,
        ),
        second.then(
          () => "ok",
          (e: unknown) => (e as Error).message,
        ),
      ]);
      await settle();
      const timers = state.timers.filter((t) => !t.cancelled);
      expect(timers.map((t) => t.ms)).toEqual([6000, 6000]);
      for (const t of timers) t.fn();
      const results = await rejected;
      expect(results[0]).not.toBe("ok");
      expect(results[1]).not.toBe("ok");
      expect(results.join(" ")).not.toContain("secret");
      expect(state.loads).toEqual(["a", "b"]);

      release();
      await settle();
      // The load finished in the background and filled the cache.
      expect((await svc.find("h1", "needle"))?.matches).toHaveLength(2);
      expect(state.loads).toEqual(["a", "b"]);
    });

    it("answers a request that beats the deadline and cancels its timer", async () => {
      const { make, state } = setup();
      const svc = make({ loadDeadlineMs: 1234 });
      expect((await svc.find("h1", "needle"))?.matches).toHaveLength(2);
      expect(state.timers.map((t) => [t.ms, t.cancelled])).toEqual([[1234, true]]);
    });

    it("does not let a load that fails after the deadline become an unhandled rejection", async () => {
      const { make, state, failing } = setup({ failing: new Set(["a", "b"]) });
      const svc = make();
      const release = hang(state);
      const pending = svc.find("h1", "needle").catch((e: unknown) => (e as Error).message);
      await settle();
      for (const t of state.timers) t.fn();
      await pending;
      release();
      await settle();
      expect(failing.size).toBe(2);
    });
  });

  describe("partial loads", () => {
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("keeps the held text of a page the refresh lost, and treats the result as complete", async () => {
      const { make, state, failing } = setup();
      const svc = make({ ttlMs: 10_000, partialTtlMs: 100 });
      await svc.find("h1", "needle");
      state.clock += 10_000;
      failing.add("a");
      await svc.find("h1", "needle");
      await settle();
      state.clock += 5000;
      const found = await svc.find("h1", "needle");
      expect(found?.matches.map((m) => m.snippet)).toEqual(["alpha needle", "beta needle"]);
      expect(await svc.marks("h1")).toEqual({ missable: ["beta"] });
      // Complete, so the full TTL applies: no reload 5 s later.
      expect(state.loads).toHaveLength(4);
    });

    it("caches a result still missing a page only for partialTtlMs", async () => {
      const { make, state, failing } = setup({ failing: new Set(["a"]) });
      const svc = make({ ttlMs: 600_000, partialTtlMs: 60_000 });
      expect((await svc.find("h1", "needle"))?.matches.map((m) => m.pageUrl)).toEqual(["/doc/b"]);
      state.clock += 59_999;
      await svc.find("h1", "needle");
      expect(state.loads).toEqual(["a", "b"]);
      failing.clear();
      state.clock += 1;
      // Expired: the partial copy answers at once and the retry runs behind it.
      await svc.find("h1", "needle");
      await settle();
      expect(state.loads).toEqual(["a", "b", "a", "b"]);
      const full = await svc.find("h1", "needle");
      expect(full?.matches.map((m) => m.pageUrl)).toEqual(["/doc/a", "/doc/b"]);
      state.clock += 540_000;
      await svc.find("h1", "needle");
      expect(state.loads).toHaveLength(4);
    });

    it("defaults the partial TTL to a minute", async () => {
      const { make, state } = setup({ failing: new Set(["a"]) });
      const svc = make();
      await svc.find("h1", "needle");
      state.clock += 59_999;
      await svc.find("h1", "needle");
      expect(state.loads).toHaveLength(2);
      state.clock += 1;
      await svc.find("h1", "needle");
      expect(state.loads).toHaveLength(4);
    });

    it("does not call a load that fetched nothing complete just because a copy fills every page", async () => {
      const { make, state, failing } = setup();
      const svc = make({ ttlMs: 1000 });
      await svc.find("h1", "needle");
      failing.add("a").add("b");
      state.clock += 5000;
      await svc.find("h1", "needle");
      await settle();
      // The failed refresh left the old copy (and its age) alone, so the next request retries.
      await svc.find("h1", "needle");
      await settle();
      expect(state.loads).toHaveLength(6);
    });
  });

  describe("memory bound", () => {
    it("evicts the oldest hubs first when held text exceeds maxChars, never the one just stored", async () => {
      const hubs = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`h${i}`, [`p${i}`]]));
      const texts = Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [`p${i}`, "x".repeat(10)]),
      );
      const { make, state } = setup({ hubs, texts });
      const svc = make({ maxChars: 25 });
      for (const h of ["h0", "h1", "h2", "h3"]) await svc.find(h, "x");
      expect(state.loads).toEqual(["p0", "p1", "p2", "p3"]);
      await svc.find("h3", "x");
      await svc.find("h2", "x");
      expect(state.loads).toHaveLength(4);
      await svc.find("h0", "x");
      expect(state.loads).toHaveLength(5);
    });

    it("keeps a single hub larger than maxChars", async () => {
      const { make, state } = setup({ texts: { a: "x".repeat(100), b: "y".repeat(100) } });
      const svc = make({ maxChars: 10 });
      await svc.find("h1", "x");
      await svc.find("h1", "x");
      expect(state.loads).toEqual(["a", "b"]);
    });

    it("holds 24 hubs by default", async () => {
      const hubs = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`h${i}`, [`p${i}`]]));
      const { make, state } = setup({ hubs });
      const svc = make({ maxLoadsPerMinute: 100 });
      for (let i = 0; i < 25; i += 1) await svc.find(`h${i}`, "x");
      expect(state.loads).toHaveLength(25);
      await svc.find("h1", "x");
      expect(state.loads).toHaveLength(25);
      await svc.find("h0", "x");
      expect(state.loads).toHaveLength(26);
    });
  });

  it("frees limiter slots as the window rolls, not all at once", async () => {
    const hubs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`h${i}`, [`p${i}`]]));
    const { make, state } = setup({ hubs });
    const svc = make({ maxLoadsPerMinute: 2 });
    await svc.find("h0", "x"); // t = 0
    state.clock += 30_000;
    await svc.find("h1", "x"); // t = 30 s
    state.clock += 31_000; // t = 61 s: the first load has left the window, the second has not
    await svc.find("h2", "x");
    await expect(svc.find("h3", "x")).rejects.toThrow();
    expect(state.loads).toEqual(["p0", "p1", "p2"]);
  });
});
