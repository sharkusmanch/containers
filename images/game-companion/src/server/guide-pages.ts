import type { FindMatch, FindResponse, GuideMarksResponse } from "../shared/types.js";
import type { PageRef } from "./guide-index.js";

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
// `![alt](url)`, delimited like LINK.
const IMAGE = /!\[[^[\]]*\]\((?:[^()]|\([^()]*\))*\)/g;
// One pass over what is left: a backslash escape, a backtick, or a run of emphasis/strike marks.
const MARKS = /\\([!-/:-@[-`{-~])|`|[*_~]+/g;
// A heading line is read up to this many characters; the rest could never reach the 160-character cap.
const HEADING_READ_MAX = 500;

const CHECKBOX_LINE = /^[ \t]*[-*][ \t]+\[[ xX]\]/;
const WARNING_SIGN = "⚠";
const BOLD_SPAN = /\*\*(.+?)\*\*/;
const LEADING_SIGNS = /^(?:\s|\u26A0\uFE0F?)+/;

/** A name as the guide shows it: no leading warning sign, link syntax or code marks. */
function markName(raw: string): string {
  return raw
    .replace(LEADING_SIGNS, "")
    .replace(LINK, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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
  text = plainHeading(text);
  return text === "" ? null : cutEnd(text);
}

/**
 * A heading as the wiki renders it, as far as the markdown marks go: link text without its
 * address, no images, no emphasis, strike or code marks, escaped characters kept as written.
 * A run of marks only counts when it opens or closes a word, so `snake_case` and `2*3` stay.
 */
function plainHeading(raw: string): string {
  let text = raw.slice(0, HEADING_READ_MAX);
  if (isHigh(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
  text = text.replace(IMAGE, "").replace(LINK, "$1");
  return text
    .replace(MARKS, (match, escaped: string | undefined, offset: number, whole: string) => {
      if (escaped !== undefined) return escaped;
      if (match === "`") return "";
      const before = whole[offset - 1];
      const after = whole[offset + match.length];
      const opens = after !== undefined && !/\s/.test(after) && !/[\p{L}\p{N}]/u.test(before ?? "");
      const closes =
        before !== undefined && !/\s/.test(before) && !/[\p{L}\p{N}]/u.test(after ?? "");
      return opens || closes ? "" : match;
    })
    .trim();
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The first 160 characters, ending in an ellipsis when cut; never ends on half a pair. */
function cutEnd(text: string): string {
  if (text.length <= SNIPPET_MAX) return text;
  let cut = SNIPPET_MAX - 1;
  if (isHigh(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Where `loweredIndex` in the lower-cased text falls in the original (lower-casing can change lengths). */
function originalIndex(text: string, loweredIndex: number): number {
  let lowered = 0;
  let i = 0;
  while (i < text.length && lowered < loweredIndex) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    lowered += ch.toLocaleLowerCase().length;
    i += ch.length;
  }
  return i;
}

/** A 160-character window of `clean` showing the first occurrence of `needle` (lower-case). */
function windowAround(clean: string, needle: string): string {
  const found = clean.toLocaleLowerCase().indexOf(needle);
  const at = found === -1 ? 0 : originalIndex(clean, found);
  const mid = at + Math.floor(needle.length / 2);
  // A leading ellipsis costs one character, so a window that reaches the end holds 159.
  let start = Math.max(0, Math.min(mid - SNIPPET_MAX / 2, clean.length - (SNIPPET_MAX - 1)));
  let end: number;
  if (start === 0) {
    end = SNIPPET_MAX - 1;
  } else if (start === clean.length - (SNIPPET_MAX - 1)) {
    end = clean.length;
  } else {
    end = start + SNIPPET_MAX - 2;
  }
  if (start > 0 && isLow(clean.charCodeAt(start))) start += 1;
  if (end < clean.length && isHigh(clean.charCodeAt(end - 1))) end -= 1;
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

function snippetOf(line: string, needle: string): string {
  const clean = line
    .replace(LEADING_MARKERS, "")
    .replace(LINK, "$1")
    .replace(EMPHASIS_AND_CODE, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= SNIPPET_MAX ? clean : windowAround(clean, needle);
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
        snippet: snippetOf(line, needle),
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
      const span = BOLD_SPAN.exec(line)?.[1];
      const name = span === undefined ? "" : markName(span);
      if (name) names.add(name);
    }
  }
  return [...names];
}

export interface GuidePageServiceOptions {
  index: { pageRefs(hubId: string): PageRef[] | null };
  /** The Outline client; null when no key is configured. */
  source: { docText(id: string): Promise<string> } | null;
  now?: () => number;
  /** Starts a timer and returns a function that cancels it. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** How long a complete set of a hub's pages is served without reloading. Default ten minutes. */
  ttlMs?: number;
  /** The same for a set still missing a page, so it is retried soon. Default one minute. */
  partialTtlMs?: number;
  /** How long a request with no held copy waits for a load. Default six seconds. */
  loadDeadlineMs?: number;
  /** Hubs held at once, oldest evicted first. Default 24. */
  maxHubs?: number;
  /** Total length of held page text across all hubs, oldest hubs evicted first. Default 30 million. */
  maxChars?: number;
  /** Process-wide ceiling on hub loads in any rolling minute. Default 6. */
  maxLoadsPerMinute?: number;
  /** Pages fetched at the same time within one load. Default 4. */
  concurrency?: number;
}

interface CacheEntry {
  pages: PageText[];
  at: number;
  ttlMs: number;
  chars: number;
}

interface Loaded {
  pages: PageText[];
  /** Every page of the hub has text, fetched now or kept from the held copy. */
  complete: boolean;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

export class GuidePageService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PageText[]>>();
  /** Start times of recent hub loads, oldest first. */
  private readonly loadTimes: number[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly ttlMs: number;
  private readonly partialTtlMs: number;
  private readonly loadDeadlineMs: number;
  private readonly maxHubs: number;
  private readonly maxChars: number;
  private readonly maxLoadsPerMinute: number;
  private readonly concurrency: number;

  constructor(private readonly opts: GuidePageServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? defaultTimer;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.partialTtlMs = opts.partialTtlMs ?? 60_000;
    this.loadDeadlineMs = opts.loadDeadlineMs ?? 6_000;
    this.maxHubs = opts.maxHubs ?? 24;
    this.maxChars = opts.maxChars ?? 30_000_000;
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
    if (cached && this.now() - cached.at < cached.ttlMs) return cached.pages;

    if (cached) {
      // Expired but held: answer from it now (the wiki may be slow) and refresh behind it,
      // if no refresh is running and the limiter allows one.
      if (!this.inFlight.has(hubId)) void this.startLoad(hubId, source, refs, cached);
      return cached.pages;
    }

    const load = this.inFlight.get(hubId) ?? this.startLoad(hubId, source, refs, undefined);
    if (!load) throw new Error("guide page load limit reached");
    return this.withDeadline(load);
  }

  /** Starts a load unless the limiter refuses; it fills the cache whenever it finishes. */
  private startLoad(
    hubId: string,
    source: { docText(id: string): Promise<string> },
    refs: PageRef[],
    held: CacheEntry | undefined,
  ): Promise<PageText[]> | null {
    if (!this.takeLoadSlot()) return null;
    const load = this.load(source, refs, held?.pages)
      .then(({ pages, complete }) => {
        this.store(hubId, {
          pages,
          at: this.now(),
          ttlMs: complete ? this.ttlMs : this.partialTtlMs,
          chars: pages.reduce((n, p) => n + p.text.length, 0),
        });
        return pages;
      })
      .finally(() => this.inFlight.delete(hubId));
    // Nobody may be waiting any more (background refresh, or a request past its deadline).
    load.catch(() => undefined);
    this.inFlight.set(hubId, load);
    return load;
  }

  /** Rejects, with a fixed message, when the load takes longer than the deadline. */
  private withDeadline(load: Promise<PageText[]>): Promise<PageText[]> {
    return new Promise((resolve, reject) => {
      const cancel = this.setTimer(
        () => reject(new Error("guide pages still loading")),
        this.loadDeadlineMs,
      );
      load.then(
        (pages) => {
          cancel();
          resolve(pages);
        },
        (err: unknown) => {
          cancel();
          reject(err instanceof Error ? err : new Error("guide pages unavailable"));
        },
      );
    });
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

  /**
   * The hub's pages, in the refs' order. A page that fails keeps the text the held copy has
   * for it. Rejects, with a fixed message, when no page could be fetched at all.
   */
  private async load(
    source: { docText(id: string): Promise<string> },
    refs: PageRef[],
    held: PageText[] | undefined,
  ): Promise<Loaded> {
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
    if (texts.every((t) => t === null)) throw new Error("guide pages unavailable");

    const heldText = new Map((held ?? []).map((p) => [p.id, p.text]));
    const pages: PageText[] = [];
    refs.forEach((ref, i) => {
      const text = texts[i] ?? heldText.get(ref.id);
      if (text !== undefined) pages.push({ id: ref.id, title: ref.title, url: ref.url, text });
    });
    return { pages, complete: pages.length === refs.length };
  }

  private store(hubId: string, entry: CacheEntry): void {
    this.cache.delete(hubId);
    this.cache.set(hubId, entry);
    let chars = 0;
    for (const e of this.cache.values()) chars += e.chars;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.maxHubs && chars <= this.maxChars) break;
      // The hub just stored stays, even when it alone is over the bound.
      if (key === hubId) continue;
      chars -= (this.cache.get(key) as CacheEntry).chars;
      this.cache.delete(key);
    }
  }
}
