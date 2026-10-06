import type { FindMatch, FindResponse, GuideMarksResponse } from "../shared/types.js";

export interface PageText {
  id: string;
  title: string;
  url: string;
  text: string;
}

const DEFAULT_LIMIT = 20;
const SNIPPET_MAX = 160;

// The patterns below are written to run in linear time on any line: every quantified group
// is delimited by a character it cannot contain, so a long run of brackets or parentheses
// from a page cannot make a match backtrack across the line.
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/s;
// Quote marks, then one list marker (bullet or number) and an optional checkbox.
const LEADING_MARKERS = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
// `[text](url)`, where the url may hold one level of parentheses.
const LINK = /\[([^[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const EMPHASIS_AND_CODE = /\*\*|__|`/g;

const CHECKBOX_LINE = /^[ \t]*[-*][ \t]+\[[ xX]\]/;
const WARNING_SIGN = "⚠";
const BOLD_SPAN = /\*\*(.+?)\*\*/;

const lines = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n");

function headingText(line: string): string | null | undefined {
  const m = HEADING.exec(line);
  if (!m) return undefined;
  let text = (m[1] ?? "").trim();
  // A closing run of `#` is a marker only when a space precedes it ("C#" keeps its hash).
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end < text.length && end > 0 && /\s/.test(text[end - 1] as string)) {
    text = text.slice(0, end).trimEnd();
  }
  return text === "" ? null : text;
}

function snippetOf(line: string): string {
  const clean = line
    .replace(LEADING_MARKERS, "")
    .replace(LINK, "$1")
    .replace(EMPHASIS_AND_CODE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= SNIPPET_MAX) return clean;
  let cut = SNIPPET_MAX - 1;
  // Never end on half of a surrogate pair.
  const last = clean.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${clean.slice(0, cut)}…`;
}

/**
 * Where the pages mention `query`: the whole trimmed query as one case-insensitive substring,
 * compared with each line as plain text (never as a pattern).
 */
export function findInPages(
  pages: PageText[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): FindResponse {
  const needle = query.trim().toLocaleLowerCase();
  const matches: FindMatch[] = [];
  if (needle === "") return { matches, truncated: false };
  for (const page of pages) {
    let heading: string | null = null;
    for (const line of lines(page.text)) {
      const own = headingText(line);
      if (!line.toLocaleLowerCase().includes(needle)) {
        if (own !== undefined) heading = own;
        continue;
      }
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({
        pageTitle: page.title,
        pageUrl: page.url,
        heading,
        snippet: snippetOf(line),
      });
      // A heading line is found under the heading above it, and heads what follows.
      if (own !== undefined) heading = own;
    }
  }
  return { matches, truncated: false };
}

/** Names the guide marks with the warning sign on a checkbox line, lower-cased, first-seen order. */
export function missableMarks(pages: PageText[]): string[] {
  const names = new Set<string>();
  for (const page of pages) {
    for (const line of lines(page.text)) {
      if (!CHECKBOX_LINE.test(line) || !line.includes(WARNING_SIGN)) continue;
      const name = BOLD_SPAN.exec(line)?.[1]?.trim().toLowerCase();
      if (name) names.add(name);
    }
  }
  return [...names];
}

interface PageRef {
  id: string;
  title: string;
  url: string;
}

export interface GuidePageServiceOptions {
  index: { pageRefs(hubId: string): PageRef[] | null };
  /** The Outline client; null when no key is configured. */
  source: { docText(id: string): Promise<string> } | null;
  now?: () => number;
  /** How long a hub's loaded pages are served without reloading. Default ten minutes. */
  ttlMs?: number;
  /** Hubs held at once, oldest evicted first. Default 8. */
  maxHubs?: number;
  /** Process-wide ceiling on hub loads in any rolling minute. Default 6. */
  maxLoadsPerMinute?: number;
  /** Pages fetched at the same time within one load. Default 4. */
  concurrency?: number;
}

interface CacheEntry {
  pages: PageText[];
  at: number;
}

export class GuidePageService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PageText[]>>();
  /** Start times of recent hub loads, oldest first. */
  private readonly loadTimes: number[] = [];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxHubs: number;
  private readonly maxLoadsPerMinute: number;
  private readonly concurrency: number;

  constructor(private readonly opts: GuidePageServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxHubs = opts.maxHubs ?? 8;
    this.maxLoadsPerMinute = opts.maxLoadsPerMinute ?? 6;
    this.concurrency = opts.concurrency ?? 4;
  }

  /** Null for an unknown hub. Rejects when the pages cannot be loaded and no copy is held. */
  async find(hubId: string, query: string): Promise<FindResponse | null> {
    if (this.opts.index.pageRefs(hubId) === null) return null;
    // Nothing can match, so there is nothing to load.
    if (query.trim() === "") return { matches: [], truncated: false };
    const pages = await this.pages(hubId);
    return pages && findInPages(pages, query);
  }

  async marks(hubId: string): Promise<GuideMarksResponse | null> {
    const pages = await this.pages(hubId);
    return pages && { missable: missableMarks(pages) };
  }

  private async pages(hubId: string): Promise<PageText[] | null> {
    const refs = this.opts.index.pageRefs(hubId);
    if (refs === null) return null;
    const source = this.opts.source;
    if (source === null || refs.length === 0) return [];

    const cached = this.cache.get(hubId);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.pages;

    const pending = this.inFlight.get(hubId);
    if (pending) return pending;

    if (!this.takeLoadSlot()) {
      // Over the ceiling: serve what we hold, untouched, so the next call asks again.
      if (cached) return cached.pages;
      throw new Error("guide page load limit reached");
    }
    const load = this.load(source, refs)
      .then((pages) => {
        this.store(hubId, { pages, at: this.now() });
        return pages;
      })
      .catch((err: unknown) => {
        if (cached) return cached.pages;
        throw err;
      })
      .finally(() => this.inFlight.delete(hubId));
    this.inFlight.set(hubId, load);
    return load;
  }

  private takeLoadSlot(): boolean {
    const t = this.now();
    while (this.loadTimes.length > 0 && t - (this.loadTimes[0] as number) >= 60_000) {
      this.loadTimes.shift();
    }
    if (this.loadTimes.length >= this.maxLoadsPerMinute) return false;
    this.loadTimes.push(t);
    return true;
  }

  /** Every page that loads, in the refs' order. Rejects, with a fixed message, when none does. */
  private async load(
    source: { docText(id: string): Promise<string> },
    refs: PageRef[],
  ): Promise<PageText[]> {
    const texts: (string | null)[] = new Array<string | null>(refs.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < refs.length) {
        const i = next;
        next += 1;
        try {
          const text = await source.docText((refs[i] as PageRef).id);
          if (typeof text === "string") texts[i] = text;
        } catch {
          // This page is skipped; an upstream message must never travel on.
        }
      }
    };
    const workers = Math.max(1, Math.min(this.concurrency, refs.length));
    await Promise.all(Array.from({ length: workers }, worker));

    const pages: PageText[] = [];
    refs.forEach((ref, i) => {
      const text = texts[i];
      if (text !== null && text !== undefined) {
        pages.push({ id: ref.id, title: ref.title, url: ref.url, text });
      }
    });
    if (pages.length === 0) throw new Error("guide pages unavailable");
    return pages;
  }

  private store(hubId: string, entry: CacheEntry): void {
    this.cache.delete(hubId);
    this.cache.set(hubId, entry);
    while (this.cache.size > this.maxHubs) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
