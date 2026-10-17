import { findInPages, headingOf, lines, type PageText } from "./guide-pages.js";

export const SEARCH_LIMIT = 20;
export const READ_MAX = 30000;

const OUTLINE_MAX_LEVEL = 3;

interface Heading {
  level: number;
  text: string;
}

/** The non-empty headings of `text`, in order, down to `maxLevel`. */
function headingsOf(text: string, maxLevel = 6): Heading[] {
  const found: Heading[] = [];
  for (const line of lines(text)) {
    const h = headingOf(line);
    if (h && h.text !== null && h.level <= maxLevel) found.push({ level: h.level, text: h.text });
  }
  return found;
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** One line per page (`## <title> (<n> chars)`), then its level 1-3 headings indented by level. */
export function guideOutline(pages: PageText[]): string {
  const out: string[] = [];
  for (const p of pages) {
    out.push(`## ${p.title} (${p.text.length} chars)`);
    for (const h of headingsOf(p.text, OUTLINE_MAX_LEVEL)) {
      out.push(`${"  ".repeat(h.level)}- ${h.text}`);
    }
  }
  return out.join("\n");
}

export function searchGuide(pages: PageText[], query: string): string {
  const { matches, truncated } = findInPages(pages, query, SEARCH_LIMIT);
  if (matches.length === 0) return `No matches for "${query}".`;
  const out = matches.map((m) =>
    m.heading === null
      ? `- ${m.pageTitle}: ${m.snippet}`
      : `- ${m.pageTitle} › ${m.heading}: ${m.snippet}`,
  );
  if (truncated) out.push("(more matches not shown)");
  return out.join("\n");
}

/** The section headed by the first heading named `name`, through to the next heading of the same or a higher level. */
function sectionOf(
  text: string,
  name: string,
): { heading: string; body: string; subheadings: Heading[] } | null {
  const all = lines(text);
  let start = -1;
  let level = 0;
  let heading = "";
  for (let i = 0; i < all.length; i += 1) {
    const h = headingOf(all[i] as string);
    if (h && h.text !== null && sameName(h.text, name)) {
      start = i;
      level = h.level;
      heading = h.text;
      break;
    }
  }
  if (start === -1) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    const h = headingOf(all[i] as string);
    if (h && h.level <= level) {
      end = i;
      break;
    }
  }
  const body = all.slice(start, end).join("\n");
  return { heading, body, subheadings: headingsOf(all.slice(start + 1, end).join("\n")) };
}

/** `body` cut to READ_MAX at the last line boundary (hard when there is none), with a note on reading further. */
function limited(body: string, headings: Heading[]): string {
  if (body.length <= READ_MAX) return body;
  const newline = body.lastIndexOf("\n", READ_MAX);
  const kept = body.slice(0, newline > 0 ? newline : READ_MAX);
  const names = headings.map((h) => h.text).join("; ");
  const note =
    names === "" ? " — use search_guide to find text further on" : ` — read a section: ${names}`;
  return `${kept}\n[cut at ${READ_MAX.toLocaleString("en-US")} characters${note}]`;
}

export function readGuide(
  pages: PageText[],
  page: string,
  section?: string,
): { text: string; label: string; ok: boolean } {
  const wanted = section !== undefined && section.trim() !== "" ? section : undefined;
  const label = (title: string): string =>
    `Read guide: ${title}${wanted === undefined ? "" : ` › ${wanted}`}`;
  const found = pages.find((p) => sameName(p.title, page));
  if (!found) {
    const text =
      pages.length === 0
        ? "This game has no guide."
        : `No page called "${page}". Pages: ${pages.map((p) => p.title).join("; ")}`;
    return { text, label: label(page), ok: false };
  }
  if (wanted === undefined) {
    if (found.text.trim() === "") {
      return {
        text: "This page is empty; its content is in the pages under it.",
        label: label(found.title),
        ok: true,
      };
    }
    return {
      text: limited(found.text, headingsOf(found.text, OUTLINE_MAX_LEVEL)),
      label: label(found.title),
      ok: true,
    };
  }
  const read = sectionOf(found.text, wanted);
  if (!read) {
    const names = headingsOf(found.text, OUTLINE_MAX_LEVEL).map((h) => h.text);
    const available =
      names.length === 0 ? "The page has no headings." : `Sections: ${names.join("; ")}`;
    return {
      text: `No section called "${wanted}" on ${found.title}. ${available}`,
      label: label(found.title),
      ok: false,
    };
  }
  return {
    text: limited(read.body, read.subheadings),
    label: `Read guide: ${found.title} › ${read.heading}`,
    ok: true,
  };
}
