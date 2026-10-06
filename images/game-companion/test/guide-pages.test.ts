import { describe, expect, it } from "vitest";
import {
  findInPages,
  GuidePageService,
  missableMarks,
  type PageText,
} from "../src/server/guide-pages.js";

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

    it("stays fast on a long run of unclosed brackets", () => {
      const evil = `x${"[a](".repeat(20000)}`;
      const t = Date.now();
      expect(snip(evil)).toHaveLength(160);
      expect(Date.now() - t).toBeLessThan(1000);
    });
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
    const state = { clock: 1_000_000, loads: [] as string[], active: 0, maxActive: 0 };
    const index = {
      pageRefs: (hubId: string): Ref[] | null => (hubs[hubId] ? hubs[hubId].map(ref) : null),
    };
    const source = {
      docText: async (id: string): Promise<string> => {
        state.loads.push(id);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise((r) => setTimeout(r, 1));
        state.active -= 1;
        if (failing.has(id)) throw new Error("upstream said: secret-token-123");
        return texts[id] ?? "";
      },
    };
    const make = (opts: Partial<ConstructorParameters<typeof GuidePageService>[0]> = {}) =>
      new GuidePageService({ index, source, now: () => state.clock, ...opts });
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
});
