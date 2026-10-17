import { describe, expect, it } from "vitest";
import type { PageText } from "../src/server/guide-pages.js";
import {
  guideOutline,
  READ_MAX,
  readGuide,
  SEARCH_LIMIT,
  searchGuide,
} from "../src/server/guide-tools.js";

const page = (title: string, text: string): PageText => ({
  id: title.toLowerCase().replace(/\s+/g, "-"),
  title,
  url: `/doc/${title}`,
  text,
});

const WALK = [
  "Intro line about the vale.",
  "# Part One",
  "Start at the gate.",
  "## Glass Garden",
  "Find the **Rare Bloom** here.",
  "### Fountain",
  "The fountain hides a key.",
  "#### Deep Detail",
  "Too deep for the outline.",
  "## Mill Road",
  "Walk east.",
  "# Part Two",
  "Cross the bridge.",
  "## Glass Garden",
  "A second garden.",
].join("\n");

const PAGES = [page("Walkthrough", WALK), page("Notes", "Just a note about a lantern.")];

describe("guideOutline", () => {
  it("lists each page with its size and its level 1-3 headings indented by level", () => {
    expect(guideOutline(PAGES)).toBe(
      [
        `## Walkthrough (${WALK.length} chars)`,
        "  - Part One",
        "    - Glass Garden",
        "      - Fountain",
        "    - Mill Road",
        "  - Part Two",
        "    - Glass Garden",
        `## Notes (${"Just a note about a lantern.".length} chars)`,
      ].join("\n"),
    );
  });

  it("uses the plain heading text and skips empty headings", () => {
    const p = page("Odd", "## **Bold** [Link](http://x.test)\n##\ntext");
    expect(guideOutline([p])).toBe(`## Odd (${p.text.length} chars)\n    - Bold Link`);
  });

  it("is empty for no pages", () => {
    expect(guideOutline([])).toBe("");
  });
});

describe("searchGuide", () => {
  it("shows page, heading and snippet for a match under a heading", () => {
    expect(searchGuide(PAGES, "rare bloom")).toBe(
      "- Walkthrough › Glass Garden: Find the Rare Bloom here.",
    );
  });

  it("omits the heading for a match before any heading", () => {
    expect(searchGuide(PAGES, "about the vale")).toBe("- Walkthrough: Intro line about the vale.");
  });

  it("says when nothing matches", () => {
    expect(searchGuide(PAGES, "dragon")).toBe('No matches for "dragon".');
  });

  it("says nothing matches for a blank query", () => {
    expect(searchGuide(PAGES, "   ")).toBe('No matches for "   ".');
  });

  it("caps at the limit and says more were not shown", () => {
    const many = page(
      "Many",
      Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => `moon ${i}`).join("\n"),
    );
    const out = searchGuide([many], "moon").split("\n");
    expect(out).toHaveLength(SEARCH_LIMIT + 1);
    expect(out[SEARCH_LIMIT]).toBe("(more matches not shown)");
    expect(out[0]).toBe("- Many: moon 0");
  });

  it("does not add the note when exactly the limit matches", () => {
    const exact = page(
      "Exact",
      Array.from({ length: SEARCH_LIMIT }, (_, i) => `moon ${i}`).join("\n"),
    );
    const out = searchGuide([exact], "moon").split("\n");
    expect(out).toHaveLength(SEARCH_LIMIT);
    expect(out.at(-1)).not.toContain("more matches");
  });
});

describe("readGuide", () => {
  it("reads a whole page", () => {
    expect(readGuide(PAGES, "Notes")).toEqual({
      text: "Just a note about a lantern.",
      label: "Read guide: Notes",
      ok: true,
    });
  });

  it("matches the page title trimmed and case-insensitively, labelling it as stored", () => {
    const r = readGuide(PAGES, "  walkthrough ");
    expect(r.ok).toBe(true);
    expect(r.text).toBe(WALK);
    expect(r.label).toBe("Read guide: Walkthrough");
  });

  it("takes the first page when titles repeat", () => {
    const r = readGuide([page("Dup", "first"), page("Dup", "second")], "dup");
    expect(r.text).toBe("first");
  });

  it("reads a section up to the next heading of the same or a higher level", () => {
    const r = readGuide(PAGES, "Walkthrough", "Mill Road");
    expect(r).toEqual({
      text: "## Mill Road\nWalk east.",
      label: "Read guide: Walkthrough › Mill Road",
      ok: true,
    });
  });

  it("includes nested sections", () => {
    const r = readGuide(PAGES, "Walkthrough", "glass garden");
    expect(r.text).toBe(
      [
        "## Glass Garden",
        "Find the **Rare Bloom** here.",
        "### Fountain",
        "The fountain hides a key.",
        "#### Deep Detail",
        "Too deep for the outline.",
      ].join("\n"),
    );
  });

  it("includes everything below a level 1 section until the next level 1 heading", () => {
    const part = readGuide(PAGES, "Walkthrough", " PART one ");
    expect(part.text.startsWith("# Part One\n")).toBe(true);
    expect(part.text.endsWith("Walk east.")).toBe(true);
    expect(part.text).not.toContain("Cross the bridge.");
    expect(part.label).toBe("Read guide: Walkthrough › Part One");
  });

  it("matches a heading with markdown marks by its plain text", () => {
    const p = page("Marks", "# **Bold** [Link](http://x.test)\nbody\n# Next");
    const r = readGuide([p], "Marks", "bold link");
    expect(r.text).toBe("# **Bold** [Link](http://x.test)\nbody");
    expect(r.label).toBe("Read guide: Marks › Bold Link");
  });

  it("reads the first of two sections with the same name", () => {
    const r = readGuide(PAGES, "Walkthrough", "Glass Garden");
    expect(r.text).not.toContain("A second garden.");
  });

  it("treats a blank section as the whole page", () => {
    expect(readGuide(PAGES, "Notes", "  ").text).toBe("Just a note about a lantern.");
  });

  it("reports an unknown page with the page titles", () => {
    expect(readGuide(PAGES, "Bestiary")).toEqual({
      text: 'No page called "Bestiary". Pages: Walkthrough; Notes',
      label: "Read guide: Bestiary",
      ok: false,
    });
  });

  it("reports an unknown section with the page's headings", () => {
    expect(readGuide(PAGES, "walkthrough", "Cellar")).toEqual({
      text: 'No section called "Cellar" on Walkthrough. Sections: Part One; Glass Garden; Fountain; Mill Road; Part Two; Glass Garden',
      label: "Read guide: Walkthrough › Cellar",
      ok: false,
    });
  });

  it("reports an unknown section on a page with no headings", () => {
    const r = readGuide(PAGES, "Notes", "Cellar");
    expect(r.ok).toBe(false);
    expect(r.text).toBe('No section called "Cellar" on Notes. The page has no headings.');
  });

  it("says an empty page's content is in the pages under it", () => {
    for (const body of ["", "  \n\t\n "]) {
      expect(readGuide([page("Chapter One", body)], "chapter one")).toEqual({
        text: "This page is empty; its content is in the pages under it.",
        label: "Read guide: Chapter One",
        ok: true,
      });
    }
  });

  it("reports that there is no guide when there are no pages", () => {
    expect(readGuide([], "Notes")).toEqual({
      text: "This game has no guide.",
      label: "Read guide: Notes",
      ok: false,
    });
  });

  describe("long reads", () => {
    const bigPage = (): PageText => {
      const rows = Array.from(
        { length: 400 },
        (_, i) => `row ${String(i).padStart(3, "0")} ${"x".repeat(92)}`,
      );
      return page(
        "Big",
        ["# Alpha", ...rows.slice(0, 200), "## Beta", ...rows.slice(200), "# Gamma", "end"].join(
          "\n",
        ),
      );
    };

    it("cuts at the last line boundary within the limit and lists the headings", () => {
      const p = bigPage();
      expect(p.text.length).toBeGreaterThan(READ_MAX);
      const r = readGuide([p], "Big");
      const note = "\n[cut at 30,000 characters — read a section: Alpha; Beta; Gamma]";
      expect(r.ok).toBe(true);
      expect(r.text.endsWith(note)).toBe(true);
      const body = r.text.slice(0, -note.length);
      expect(body.length).toBeLessThanOrEqual(READ_MAX);
      expect(p.text.startsWith(`${body}\n`)).toBe(true);
      expect(p.text.slice(body.length + 1, body.length + 1 + READ_MAX)).not.toBe("");
      expect(body.length).toBeGreaterThan(READ_MAX - 200);
    });

    it("cuts hard when the first 30,000 characters hold no newline", () => {
      const p = page("Flat", `# Only\n${"y".repeat(READ_MAX + 10)}`);
      const solid = page("Solid", "z".repeat(READ_MAX + 10));
      const r = readGuide([solid], "Solid");
      expect(r.text).toBe(
        `${"z".repeat(READ_MAX)}\n[cut at 30,000 characters — use search_guide to find text further on]`,
      );
      expect(readGuide([p], "Flat").text).toBe(
        "# Only\n[cut at 30,000 characters — read a section: Only]",
      );
    });

    it("does not cut a page of exactly the limit", () => {
      const exact = page("Exact", "a".repeat(READ_MAX));
      expect(readGuide([exact], "Exact").text).toBe("a".repeat(READ_MAX));
    });

    it("points at search_guide when a cut section has no sub-headings", () => {
      const rows = Array.from({ length: 400 }, (_, i) => `row ${i} ${"x".repeat(92)}`);
      const p = page("Plain", ["# Top", ...rows, "# Next", "end"].join("\n"));
      const r = readGuide([p], "Plain", "Top");
      expect(r.ok).toBe(true);
      expect(
        r.text.endsWith("\n[cut at 30,000 characters — use search_guide to find text further on]"),
      ).toBe(true);
      expect(r.text).not.toContain("read a section");
    });

    it("lists the section's sub-headings when a section was cut", () => {
      const rows = Array.from({ length: 400 }, (_, i) => `row ${i} ${"x".repeat(92)}`);
      const p = page(
        "Sec",
        [
          "# Top",
          "## Inner A",
          ...rows.slice(0, 200),
          "### Inner B",
          ...rows.slice(200),
          "# Next",
        ].join("\n"),
      );
      const r = readGuide([p], "Sec", "Top");
      expect(
        r.text.endsWith("\n[cut at 30,000 characters — read a section: Inner A; Inner B]"),
      ).toBe(true);
    });
  });
});
