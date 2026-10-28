// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PMNode } from "../src/web/guide-checkbox.js";
import { tick } from "../src/web/guide-tick.js";
import { OutlineError, type GuideDocument, type OutlineApi } from "../src/web/outline-api.js";
import { SETTLE_MS, createReader, type Reader, type ReaderDeps } from "../src/web/reader.js";

// The real tick, wrapped so one test can make it throw.
vi.mock("../src/web/guide-tick.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/web/guide-tick.js")>();
  return { ...real, tick: vi.fn(real.tick) };
});

const ORIGIN = "https://wiki.example";
const A = "/doc/area-a-1";
const B = "/doc/area-b-2";
const MD_A = ["## Area", "", "- [ ] Potion", "- [ ] Ether", "- [x] Done", "", "Plain words"].join(
  "\n",
);
const MD_B = ["## Other", "", "Second page text"].join("\n");

const text = (value: string): PMNode => ({ type: "text", text: value });

/** A synthetic page: "## " headings, "- [ ] " checkbox lines, "[label](/doc/x)" links, paragraphs. */
function dataFor(md: string): PMNode {
  const content: PMNode[] = [];
  let list: PMNode | null = null;
  for (const line of md.split("\n")) {
    const box = /^- \[([ x])\] (.*)$/.exec(line);
    if (box) {
      if (list === null) {
        list = { type: "checkbox_list", content: [] };
        content.push(list);
      }
      list.content?.push({
        type: "checkbox_item",
        attrs: { checked: box[1] === "x" },
        content: [{ type: "paragraph", content: [text(box[2] ?? "")] }],
      });
      continue;
    }
    list = null;
    if (line === "") continue;
    const link = /^\[(.*)\]\((.*)\)$/.exec(line);
    if (line.startsWith("## ")) {
      content.push({ type: "heading", attrs: { level: 2 }, content: [text(line.slice(3))] });
    } else if (link) {
      const label = { ...text(link[1] ?? ""), marks: [{ type: "link", attrs: { href: link[2] } }] };
      content.push({ type: "paragraph", content: [label] });
    } else {
      content.push({ type: "paragraph", content: [text(line)] });
    }
  }
  return { type: "doc", content };
}

interface Page {
  md: string;
  revision: number;
  /** Replaces the JSON the page answers with (to make rendering throw). */
  data?: PMNode;
}

interface Held {
  id: string;
  signal: AbortSignal | undefined;
  release(): void;
}

interface Fake extends OutlineApi {
  pages: Record<string, Page>;
  /** While true, `document` answers only when the test calls `release` on its entry. */
  hold: boolean;
  held: Held[];
  fail: { document?: Error[]; markdown?: Error[]; patch?: Error[] };
  land: boolean;
  /** Runs once a patch has landed: another writer's edit before the read-back. */
  afterPatch?: ((page: Page) => void) | undefined;
  patches: { id: string; findText: string; text: string; lastRevision: number }[];
}

function fake(): Fake {
  const api: Fake = {
    pages: { "1": { md: MD_A, revision: 5 }, "2": { md: MD_B, revision: 9 } },
    hold: false,
    held: [],
    fail: {},
    land: true,
    patches: [],
    document(id, signal) {
      const answer = (): GuideDocument => {
        const err = api.fail.document?.shift();
        if (err !== undefined) throw err;
        const page = api.pages[id];
        if (page === undefined) throw new OutlineError(404, "not-found");
        return {
          id,
          title: `Page ${id}`,
          url: `/doc/page-${id}`,
          revision: page.revision,
          data: page.data ?? dataFor(page.md),
        };
      };
      if (!api.hold) return Promise.resolve().then(answer);
      return new Promise((resolve, reject) => {
        api.held.push({
          id,
          signal,
          release: () => {
            try {
              resolve(answer());
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          },
        });
      });
    },
    async markdown(id) {
      const err = api.fail.markdown?.shift();
      if (err !== undefined) throw err;
      const page = api.pages[id] as Page;
      return { text: page.md, revision: page.revision };
    },
    async patch(id, edit) {
      api.patches.push({ id, ...edit });
      const err = api.fail.patch?.shift();
      if (err !== undefined) throw err;
      const page = api.pages[id] as Page;
      if (api.land) {
        page.md = page.md.replace(edit.findText, () => edit.text);
        page.revision += 1;
      }
      api.afterPatch?.(page);
    },
  };
  return api;
}

const readers: Reader[] = [];

function setup(
  url = A,
  over: { outline?: Fake; openPage?: (url: string) => boolean } = {},
): {
  api: Fake;
  reader: Reader;
  onSaved: ReturnType<typeof vi.fn>;
  showInOutline: ReturnType<typeof vi.fn>;
} {
  const api = over.outline ?? fake();
  const onSaved = vi.fn();
  const showInOutline = vi.fn();
  const deps: ReaderDeps = {
    doc: document,
    outline: api,
    origin: ORIGIN,
    openPage: over.openPage ?? (() => true),
    showInOutline,
    onSaved,
  };
  const reader = createReader(deps, url);
  readers.push(reader);
  document.body.append(reader.element);
  return { api, reader, onSaved, showInOutline };
}

/** Lets every pending promise callback run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const body = (r: Reader): HTMLElement => r.element.querySelector(".reader-body") as HTMLElement;
const status = (r: Reader): HTMLElement => r.element.querySelector(".reader-status") as HTMLElement;
const box = (r: Reader, i: number): HTMLElement =>
  r.element.querySelector(`.cb[data-cb="${i}"]`) as HTMLElement;

/**
 * Gives the reader's scroller a writable scrollTop (jsdom does not lay out). Replacing the body's
 * markup scrolls back to the top, as a browser may when the content is swapped.
 */
function scrollable(r: Reader): void {
  let top = 0;
  Object.defineProperty(r.element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const target = body(r);
  Object.defineProperty(target, "innerHTML", {
    configurable: true,
    get: () => inner?.get?.call(target) as string,
    set: (html: string) => {
      top = 0;
      inner?.set?.call(target, html);
    },
  });
}

afterEach(() => {
  for (const r of readers.splice(0)) r.dispose();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("createReader", () => {
  it("builds the reader markup", () => {
    const { reader } = setup();
    expect(reader.element.className).toBe("reader");
    const bar = reader.element.querySelector(".reader-bar");
    expect(bar?.querySelector("button.reader-outline")?.textContent).toBe("Show in Outline");
    expect(bar?.querySelector("button.reader-outline")?.getAttribute("type")).toBe("button");
    expect(bar?.querySelector(".reader-status")?.getAttribute("role")).toBe("status");
    expect(reader.element.querySelector("article.reader-body")).not.toBeNull();
    expect(reader.url).toBe(A);
  });

  it("renders the document and clears the status", async () => {
    const { reader } = setup();
    expect(status(reader).textContent).toBe("Loading…");
    await settle();
    expect(body(reader).querySelector("h2")?.textContent).toBe("Area");
    expect(body(reader).querySelectorAll(".cb")).toHaveLength(3);
    expect(status(reader).textContent).toBe("");
    expect(reader.element.innerHTML).not.toContain("style=");
  });

  it("ignores a load answer for a page it has left", async () => {
    const api = fake();
    api.hold = true;
    const { reader } = setup(A, { outline: api });
    reader.load(A); // the same page, still loading: no second request
    expect(api.held).toHaveLength(1);
    reader.load(B);
    const [a, b] = [api.held[0], api.held[1]];
    expect(a?.id).toBe("1");
    expect(a?.signal?.aborted).toBe(true);
    b?.release();
    await settle();
    a?.release();
    await settle();
    expect(reader.url).toBe(B);
    expect(body(reader).textContent).toContain("Second page text");
    expect(body(reader).textContent).not.toContain("Potion");
    expect(status(reader).textContent).toBe("");
  });

  it("ignores every stale answer when pages change quickly", async () => {
    const api = fake();
    api.hold = true;
    const { reader } = setup(A, { outline: api });
    reader.load(B);
    reader.load(A);
    reader.load(B);
    expect(api.held.map((h) => h.id)).toEqual(["1", "2", "1", "2"]);
    api.held[3]?.release();
    await settle();
    for (const held of api.held.slice(0, 3).reverse()) held.release();
    await settle();
    expect(body(reader).textContent).toContain("Second page text");
  });

  it.each([
    ["not-found", new OutlineError(404, "not-found"), "This page wasn't found."],
    ["other", new OutlineError(500, "other"), "Couldn't load this page. Check your connection."],
    ["network", new OutlineError(0, "other"), "Couldn't load this page. Check your connection."],
    [
      "unreadable answer",
      new OutlineError(200, "other"),
      "This page can't be shown here. Use Show in Outline.",
    ],
  ])("shows a load error (%s) with an empty body", async (_kind, err, copy) => {
    const api = fake();
    api.fail.document = [err];
    const { reader } = setup(A, { outline: api });
    await settle();
    expect(status(reader).textContent).toBe(copy);
    expect(body(reader).innerHTML).toBe("");
  });

  it("asks to sign in when signed out on load", async () => {
    const api = fake();
    api.fail.document = [new OutlineError(401, "signed-out")];
    const { reader } = setup(A, { outline: api });
    await settle();
    expect(status(reader).innerHTML).toBe(
      'Sign in to Outline to read this page. <a href="/" target="_blank" rel="noopener noreferrer">Sign in</a>',
    );
    expect(body(reader).innerHTML).toBe("");
  });

  it("says the page can't be shown when rendering throws", async () => {
    const api = fake();
    (api.pages["1"] as Page).data = { type: "doc", content: [null as unknown as PMNode] };
    const { reader } = setup(A, { outline: api });
    await settle();
    expect(status(reader).textContent).toBe("This page can't be shown here. Use Show in Outline.");
    expect(body(reader).innerHTML).toBe("");
  });

  it("loads again after a failed load of the same page", async () => {
    const api = fake();
    api.fail.document = [new OutlineError(500, "other")];
    const { reader } = setup(A, { outline: api });
    await settle();
    reader.load(A);
    await settle();
    expect(status(reader).textContent).toBe("");
    expect(body(reader).querySelectorAll(".cb")).toHaveLength(3);
  });

  it("marks a tapped box pending, then checked after save", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    box(reader, 0).click();
    expect(box(reader, 0).getAttribute("aria-busy")).toBe("true");
    expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
    await settle();
    expect(api.patches).toHaveLength(1);
    expect(api.patches[0]?.lastRevision).toBe(5);
    expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
    expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(status(reader).textContent).toBe("");
  });

  it("ignores a tap on a box that is already saving", async () => {
    const { api, reader } = setup();
    await settle();
    box(reader, 0).click();
    box(reader, 0).click();
    expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
    await settle();
    expect(api.patches).toHaveLength(1);
  });

  it("ignores a stray second tap on a box until SETTLE_MS after its save, then takes it", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { api, reader } = setup();
      await settle();
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(1);
      // Some phones deliver a second click to the redrawn box right after the save: not an untick.
      now += 150;
      box(reader, 0).click();
      now += SETTLE_MS - 151;
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(1);
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      now += 1;
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(2);
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
    } finally {
      clock.mockRestore();
    }
  });

  it("does not hold a box when the clock steps back", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { api, reader } = setup();
      await settle();
      box(reader, 0).click();
      await settle();
      now -= 60_000;
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("forgets the hold when the page is left and opened again", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { api, reader } = setup();
      await settle();
      box(reader, 0).click();
      await settle();
      reader.load(B);
      await settle();
      reader.load(A);
      await settle();
      now += 100;
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not hold back a tap on another box right after a save", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { api, reader } = setup();
      await settle();
      box(reader, 0).click();
      await settle();
      now += 100;
      box(reader, 1).click();
      await settle();
      expect(api.patches).toHaveLength(2);
      expect(box(reader, 1).getAttribute("aria-checked")).toBe("true");
    } finally {
      clock.mockRestore();
    }
  });

  it("unticks a ticked box", async () => {
    const { api, reader } = setup();
    await settle();
    box(reader, 2).click();
    expect(box(reader, 2).getAttribute("aria-checked")).toBe("false");
    await settle();
    expect(api.pages["1"]?.md).toContain("- [ ] Done");
  });

  describe("reverts the box and shows the message", () => {
    it("on refused", async () => {
      const { api, reader, onSaved } = setup();
      await settle();
      (api.pages["1"] as Page).md += "\n- [ ] Extra";
      box(reader, 1).click();
      await settle();
      expect(box(reader, 1).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 1).hasAttribute("aria-busy")).toBe(false);
      expect(status(reader).textContent).toBe(
        "Couldn't match this item safely. Tick it in Outline.",
      );
      expect(api.patches).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("on signed-out", async () => {
      const { api, reader } = setup();
      await settle();
      api.fail.patch = [new OutlineError(403, "signed-out")];
      box(reader, 0).click();
      await settle();
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      expect(status(reader).innerHTML).toBe(
        'Sign in to Outline to tick boxes. <a href="/" target="_blank" rel="noopener noreferrer">Sign in</a>',
      );
      // The loaded copy stays readable.
      expect(body(reader).querySelector("h2")?.textContent).toBe("Area");
    });

    it("on failed", async () => {
      const { api, reader } = setup();
      await settle();
      api.fail.markdown = [new OutlineError(0, "other")];
      box(reader, 0).click();
      await settle();
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      expect(status(reader).textContent).toBe(
        "Couldn't save. Check your connection and try again.",
      );
    });

    it("on an unexpected error from the save, as on failed", async () => {
      const { reader, onSaved } = setup();
      await settle();
      vi.mocked(tick).mockRejectedValueOnce(new TypeError("boom"));
      box(reader, 0).click();
      await settle();
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      expect(status(reader).textContent).toBe(
        "Couldn't save. Check your connection and try again.",
      );
      expect(onSaved).not.toHaveBeenCalled();
      // The box can be tapped again, and saves.
      box(reader, 0).click();
      await settle();
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it("on failed with a read-back, re-rendering from it", async () => {
      const { api, reader, onSaved } = setup();
      await settle();
      api.land = false;
      (api.pages["1"] as Page).md = MD_A.replace("Plain words", "Read back words");
      box(reader, 0).click();
      await settle();
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      expect(body(reader).textContent).toContain("Read back words");
      expect(status(reader).textContent).toBe(
        "Couldn't save. Check your connection and try again.",
      );
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("on conflict, re-rendering from the fresh document", async () => {
      const { api, reader } = setup();
      await settle();
      const page = api.pages["1"] as Page;
      page.md += "\n- [ ] Elixir";
      page.revision = 8;
      box(reader, 0).click();
      await settle();
      expect(api.patches).toHaveLength(0);
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("false");
      expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
      expect(body(reader).querySelectorAll(".cb")).toHaveLength(4);
      expect(status(reader).textContent).toBe(
        "This page changed elsewhere and was refreshed. Tap again.",
      );
      // The next tap is made against the refreshed revision.
      box(reader, 1).click();
      expect(status(reader).textContent).toBe("");
      await settle();
      expect(api.patches[0]?.lastRevision).toBe(8);
    });
  });

  it("queues a second tap until the first is saved", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    box(reader, 0).click();
    box(reader, 1).click();
    expect(box(reader, 1).getAttribute("aria-busy")).toBe("true");
    await settle();
    expect(api.patches.map((p) => p.lastRevision)).toEqual([5, 6]);
    expect(api.pages["1"]?.md).toContain("- [x] Potion\n- [x] Ether");
    expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
    expect(box(reader, 1).getAttribute("aria-checked")).toBe("true");
    expect(reader.element.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("keeps a queued box pending while an earlier save re-renders the page", async () => {
    const { api, reader } = setup();
    await settle();
    api.hold = true;
    box(reader, 0).click();
    box(reader, 1).click();
    await settle();
    api.held.shift()?.release(); // the read-back of the first save
    await settle();
    expect(api.patches).toHaveLength(2);
    expect(box(reader, 0).hasAttribute("aria-busy")).toBe(false);
    expect(box(reader, 1).getAttribute("aria-busy")).toBe("true");
    expect(box(reader, 1).getAttribute("aria-checked")).toBe("true");
    api.held.shift()?.release();
    await settle();
    expect(box(reader, 1).hasAttribute("aria-busy")).toBe(false);
  });

  it("drops queued taps after a conflict", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    const page = api.pages["1"] as Page;
    page.revision = 7;
    box(reader, 0).click();
    box(reader, 1).click();
    await settle();
    expect(api.patches).toHaveLength(0);
    expect(box(reader, 1).getAttribute("aria-checked")).toBe("false");
    expect(box(reader, 1).hasAttribute("aria-busy")).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each([
    ["an item is inserted above it", "- [ ] Inserted\n- [ ] Ether"],
    ["its text changes", "- [ ] Hi-Ether"],
    ["a twin with the same text is inserted above it", "- [ ] Ether\n- [ ] Ether"],
  ])(
    "does not tick a queued item when another writer's edit arrives with a save (%s)",
    async (_case, replacement) => {
      const { api, reader, onSaved } = setup();
      await settle();
      api.afterPatch = (page) => {
        api.afterPatch = undefined;
        page.md = page.md.replace("- [ ] Ether", replacement);
        page.revision += 1;
      };
      box(reader, 0).click();
      box(reader, 1).click();
      await settle();
      expect(api.patches).toHaveLength(1);
      expect(api.pages["1"]?.md).not.toMatch(/- \[x\] (Inserted|Hi-Ether|Ether)/);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(status(reader).textContent).toBe(
        "This page changed elsewhere and was refreshed. Tap again.",
      );
      expect(box(reader, 0).getAttribute("aria-checked")).toBe("true");
      expect(box(reader, 1).getAttribute("aria-checked")).toBe("false");
      expect(reader.element.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
      // Taps queued behind it are dropped too.
      expect(api.patches).toHaveLength(1);
    },
  );

  it("does not apply a save confirmed after the page was left, but still reports it", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    api.hold = true;
    box(reader, 0).click();
    await settle();
    expect(api.patches).toHaveLength(1);
    const readBack = api.held.shift();
    reader.load(B);
    api.held.shift()?.release();
    await settle();
    const shownB = body(reader).innerHTML;
    expect(shownB).toContain("Second page text");
    readBack?.release();
    await settle();
    expect(body(reader).innerHTML).toBe(shownB);
    expect(status(reader).textContent).toBe("");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("does not apply a save confirmed after dispose, but still reports it", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    api.hold = true;
    const before = box(reader, 0);
    before.click();
    await settle();
    reader.dispose();
    const markup = body(reader).innerHTML;
    api.held.shift()?.release();
    await settle();
    expect(body(reader).innerHTML).toBe(markup);
    expect(box(reader, 0)).toBe(before);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("ignores a box with a missing or empty index", async () => {
    const { api, reader } = setup();
    await settle();
    body(reader).insertAdjacentHTML(
      "beforeend",
      '<button type="button" class="cb" id="none" aria-checked="false"></button>' +
        '<button type="button" class="cb" id="empty" aria-checked="false" data-cb=""></button>',
    );
    for (const id of ["none", "empty"]) {
      const odd = body(reader).querySelector(`#${id}`) as HTMLElement;
      odd.click();
      expect(odd.hasAttribute("aria-busy")).toBe(false);
      expect(odd.getAttribute("aria-checked")).toBe("false");
    }
    await settle();
    expect(api.patches).toHaveLength(0);
  });

  it("keeps scroll position across a re-render after save", async () => {
    const { reader } = setup();
    scrollable(reader);
    await settle();
    reader.element.scrollTop = 420;
    const before = box(reader, 0);
    before.click();
    await settle();
    expect(box(reader, 0)).not.toBe(before);
    expect(reader.element.scrollTop).toBe(420);
  });

  it("opens a known guide link in the companion", async () => {
    const openPage = vi.fn((url: string) => url === "/doc/known-2");
    const api = fake();
    (api.pages["1"] as Page).md = "[Known](/doc/known-2)\n\n[Unknown](/doc/unknown-3)";
    const { reader } = setup(A, { outline: api, openPage });
    await settle();
    const [known, unknown] = [...body(reader).querySelectorAll("a[data-doc]")];
    const first = new MouseEvent("click", { bubbles: true, cancelable: true });
    known?.dispatchEvent(first);
    expect(openPage).toHaveBeenCalledWith("/doc/known-2");
    expect(first.defaultPrevented).toBe(true);
    const second = new MouseEvent("click", { bubbles: true, cancelable: true });
    unknown?.dispatchEvent(second);
    expect(openPage).toHaveBeenCalledWith("/doc/unknown-3");
    expect(second.defaultPrevented).toBe(false);
  });

  describe("hash links", () => {
    let scrolled: Element[] = [];
    beforeEach(() => {
      scrolled = [];
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    const click = (link: Element | null | undefined): MouseEvent => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
      return event;
    };

    it("scrolls to a bare hash's heading inside a closed toggle, opening it", async () => {
      const api = fake();
      const openPage = vi.fn(() => true);
      (api.pages["1"] as Page).data = {
        type: "doc",
        content: [
          {
            type: "container_toggle",
            content: [
              { type: "paragraph", content: [text("More")] },
              { type: "heading", attrs: { level: 2 }, content: [text("Area Two")] },
            ],
          },
          {
            type: "paragraph",
            content: [
              { ...text("jump"), marks: [{ type: "link", attrs: { href: "#h-area-two" } }] },
            ],
          },
        ],
      };
      const { reader } = setup(A, { outline: api, openPage });
      await settle();
      const details = body(reader).querySelector("details") as HTMLDetailsElement;
      expect(details.open).toBe(false);
      const event = click(body(reader).querySelector("a[data-hash]"));
      expect(event.defaultPrevented).toBe(true);
      expect(openPage).not.toHaveBeenCalled();
      expect(scrolled).toEqual([body(reader).querySelector("#h-area-two")]);
      expect(details.open).toBe(true);
    });

    it("scrolls in place for a link to the page already shown", async () => {
      const api = fake();
      const openPage = vi.fn(() => true);
      (api.pages["1"] as Page).md = `${MD_A}\n\n[Top](/doc/area-a-1#h-area)`;
      const { reader } = setup(A, { outline: api, openPage });
      await settle();
      const event = click(body(reader).querySelector("a[data-doc]"));
      expect(event.defaultPrevented).toBe(true);
      expect(openPage).not.toHaveBeenCalled();
      expect(scrolled).toEqual([body(reader).querySelector("h2")]);
    });

    it("does nothing but stop the navigation for a bare hash that names no element", async () => {
      const api = fake();
      (api.pages["1"] as Page).md = "[Gone](#h-nowhere)";
      const { reader } = setup(A, { outline: api });
      await settle();
      expect(click(body(reader).querySelector("a[data-hash]")).defaultPrevented).toBe(true);
      expect(scrolled).toEqual([]);
    });

    it("opens another page and scrolls to the hash once it is loaded", async () => {
      const api = fake();
      api.hold = true;
      (api.pages["1"] as Page).md = "[Other](/doc/area-b-2#h-other)";
      let shown: Reader | null = null;
      const openPage = vi.fn((url: string) => {
        shown?.load(url);
        return true;
      });
      const { reader } = setup(A, { outline: api, openPage });
      shown = reader;
      api.held[0]?.release();
      await settle();
      const event = click(body(reader).querySelector("a[data-doc]"));
      expect(event.defaultPrevented).toBe(true);
      expect(openPage).toHaveBeenCalledWith("/doc/area-b-2");
      expect(scrolled).toEqual([]);
      api.held[1]?.release();
      await settle();
      expect(body(reader).textContent).toContain("Second page text");
      expect(scrolled).toEqual([body(reader).querySelector("#h-other")]);
    });

    it("scrolls the reader the page opens in, when that is another reader", async () => {
      const api = fake();
      (api.pages["1"] as Page).md = "[Other](/doc/area-b-2#h-other)";
      let other: Reader | null = null;
      const openPage = (url: string): boolean => {
        other = setup(url, { outline: api }).reader;
        return true;
      };
      const { reader } = setup(A, { outline: api, openPage });
      await settle();
      click(body(reader).querySelector("a[data-doc]"));
      await settle();
      const opened = other as Reader | null;
      expect(opened).not.toBeNull();
      expect(scrolled).toEqual([opened && body(opened).querySelector("#h-other")]);
    });

    it("scrolls a reader already showing the linked page", async () => {
      const api = fake();
      (api.pages["1"] as Page).md = "[Other](/doc/area-b-2#h-other)";
      const already = setup(B, { outline: api }).reader;
      const { reader } = setup(A, { outline: api, openPage: () => true });
      await settle();
      click(body(reader).querySelector("a[data-doc]"));
      expect(scrolled).toEqual([body(already).querySelector("#h-other")]);
    });

    it("forgets the hash when the page does not open in the companion", async () => {
      const api = fake();
      (api.pages["1"] as Page).md = "[Other](/doc/area-b-2#h-other)";
      const { reader } = setup(A, { outline: api, openPage: () => false });
      await settle();
      expect(click(body(reader).querySelector("a[data-doc]")).defaultPrevented).toBe(false);
      reader.load(B);
      await settle();
      expect(scrolled).toEqual([]);
    });
  });

  it("Show in Outline calls showInOutline with the current url", async () => {
    const { reader, showInOutline } = setup();
    reader.load(B);
    await settle();
    (reader.element.querySelector(".reader-outline") as HTMLElement).click();
    expect(showInOutline).toHaveBeenCalledWith(B);
  });

  it("restores the reading position when a page is loaded again", async () => {
    const { reader } = setup();
    scrollable(reader);
    await settle();
    reader.element.scrollTop = 300;
    reader.load(B);
    await settle();
    expect(reader.element.scrollTop).toBe(0);
    reader.element.scrollTop = 50;
    reader.load(A);
    await settle();
    expect(reader.element.scrollTop).toBe(300);
    reader.dispose();
    // Another reader opening the same page picks the position up too.
    const other = setup(B).reader;
    scrollable(other);
    await settle();
    expect(other.element.scrollTop).toBe(50);
  });

  it("does not start ticks for a page it has left, nor apply their results", async () => {
    const { api, reader, onSaved } = setup();
    await settle();
    box(reader, 0).click();
    reader.load(B);
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(body(reader).textContent).toContain("Second page text");
    expect(api.pages["2"]?.md).toBe(MD_B);
  });

  it("stops listening after dispose", async () => {
    const { reader, showInOutline } = setup();
    await settle();
    const button = box(reader, 0);
    reader.dispose();
    button.click();
    (reader.element.querySelector(".reader-outline") as HTMLElement).click();
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(showInOutline).not.toHaveBeenCalled();
  });

  describe("locate", () => {
    it("locate waits for the current load, then finds inside the body", async () => {
      const api = fake();
      api.hold = true;
      const { reader } = setup(A, { outline: api });
      let done: boolean | null = null;
      void reader.locate("plain words", "Area", "text").then((found) => {
        done = found;
      });
      await settle();
      expect(done).toBeNull();
      api.held[0]?.release();
      await settle();
      expect(done).toBe(true);
      expect(await reader.locate("No such words", null, "text")).toBe(false);
      expect(await reader.locate("Area", null, "heading")).toBe(true);
      expect(await reader.locate("Arena Gate", null, "heading", "Area")).toBe(true);
    });

    it("searches only the body, not the reader bar", async () => {
      const { reader } = setup();
      expect(await reader.locate("Show in Outline", null, "text")).toBe(false);
    });

    it("resolves false after 10 s when the load never finishes", async () => {
      vi.useFakeTimers();
      const api = fake();
      api.hold = true;
      const { reader } = setup(A, { outline: api });
      let done: boolean | null = null;
      void reader.locate("plain words", null, "text").then((found) => {
        done = found;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(false);
    });

    it("waits for a page loaded while it was waiting", async () => {
      const api = fake();
      api.hold = true;
      const { reader } = setup(A, { outline: api });
      const found = reader.locate("second page", null, "text");
      reader.load(B);
      api.held[0]?.release();
      await settle();
      api.held[1]?.release();
      expect(await found).toBe(true);
    });
  });
});
