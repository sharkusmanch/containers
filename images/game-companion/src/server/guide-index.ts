import type { GuideHub, GuidePage, Source } from "../shared/types.js";
import type { OutlineDoc, OutlineNode } from "./outline.js";

export interface HubIdentity {
  source: Source;
  gameId: string;
}

// A table row whose first cell is exactly the label, bold on both sides or on neither
// (`**Steam App ID**` or `Steam App ID`). The label must start the cell, so `DLC App ID`
// does not match, and a half-bold `**Steam App ID` does not either. Case-sensitive.
// Only spaces and tabs may separate the pieces: the label and its cell share one line.
const RA_ROW = /^\|[ \t]*(?:\*\*RA Game ID\*\*|RA Game ID)[ \t]*\|([^\n]*)$/gm;
const STEAM_ROW = /^\|[ \t]*(?:\*\*(?:Steam )?App ID\*\*|(?:Steam )?App ID)[ \t]*\|([^\n]*)$/gm;
const RA_LINK = /retroachievements\.org\/game\/(\d{1,10})(?!\d)/;
const STEAM_LINK = /store\.steampowered\.com\/app\/(\d{1,10})(?!\d)/;

/**
 * The ID in a cell: the number in the game's own store or RetroAchievements link when there is
 * one, otherwise the first run of 1–10 digits, ignoring digits inside a longer number.
 */
function cellId(cell: string, link: RegExp): string | null {
  const m = link.exec(cell) ?? /(?<!\d)(\d{1,10})(?!\d)/.exec(cell);
  return m ? (m[1] as string) : null;
}

function firstRowId(text: string, row: RegExp, link: RegExp): string | null {
  for (const m of text.matchAll(row)) {
    const id = cellId(m[1] as string, link);
    if (id) return id;
  }
  return null;
}

export function parseHubIdentity(text: string): HubIdentity | null {
  const unix = text.replace(/\r\n/g, "\n");
  const ra = firstRowId(unix, RA_ROW, RA_LINK);
  if (ra) return { source: "ra", gameId: ra };
  const steam = firstRowId(unix, STEAM_ROW, STEAM_LINK);
  if (steam) return { source: "steam", gameId: steam };
  return null;
}

export function platformLabel(title: string, identity: HubIdentity | null): string {
  if (!identity) return "Other";
  if (identity.source === "steam") return "Steam";
  const m = /\(([^()—–-]+?)\s*[—–-]\s*RetroAchievements\)\s*$/.exec(title);
  return m ? `RA · ${(m[1] as string).trim()}` : "RA";
}

export function normaliseTitle(title: string): string {
  return (
    title
      .replace(/\([^()]*\)\s*$/, "")
      .normalize("NFKD")
      // Written with escapes on purpose: strips combining marks U+0300 to U+036F.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

export function parseNowPlaying(scheduleText: string): string[] {
  const lines = scheduleText.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Now Playing\s*$/.test(l));
  if (start === -1) return [];
  const titles: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\*\*(.+?)\*\*/.exec(line);
    if (m) titles.push((m[1] as string).trim());
  }
  return titles;
}

export interface GuideSource {
  listChildren(parentDocumentId: string): Promise<OutlineDoc[]>;
  collectionTree(collectionId: string): Promise<OutlineNode[]>;
  docText(id: string): Promise<string>;
}

interface Entry {
  hub: GuideHub;
  pages: GuidePage[];
}

const SAFE_URL = /^\/doc\/[A-Za-z0-9_-]+$/;

/** Same-origin Outline document paths only; the browser applies the same rule before framing. */
export function isSafeGuideUrl(url: string): boolean {
  return SAFE_URL.test(url);
}

function toPages(nodes: OutlineNode[]): GuidePage[] {
  return nodes
    .filter((n) => isSafeGuideUrl(n.url))
    .map((n) => ({ title: n.title, url: n.url, children: toPages(n.children) }));
}

function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = findNode(n.children, id);
    if (inner) return inner;
  }
  return null;
}

export interface AutoRefreshOptions {
  /** Delay between attempts while the index has never been built. Default 15 s. */
  retryMs?: number;
  /** Delay between refreshes once it has been built. Default one hour. */
  intervalMs?: number;
  onResult?: (ok: boolean) => void;
}

interface AutoRefreshState {
  opts: AutoRefreshOptions;
  timer: NodeJS.Timeout | null;
}

export class GuideIndex {
  private readonly source: GuideSource | null;
  private readonly collectionId: string;
  private readonly guidesParentId: string;
  private readonly scheduleDocId: string | null;
  private readonly now: () => number;
  private readonly minRefreshMs: number;
  private entries: Entry[] = [];
  private built = false;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<boolean> | null = null;
  private auto: AutoRefreshState | null = null;

  constructor(opts: {
    source: GuideSource | null;
    collectionId: string;
    guidesParentId: string;
    scheduleDocId: string | null;
    now?: () => number;
    minRefreshMs?: number;
  }) {
    this.source = opts.source;
    this.collectionId = opts.collectionId;
    this.guidesParentId = opts.guidesParentId;
    this.scheduleDocId = opts.scheduleDocId;
    this.now = opts.now ?? Date.now;
    this.minRefreshMs = opts.minRefreshMs ?? 60_000;
  }

  refresh(): Promise<boolean> {
    if (!this.source) return Promise.resolve(false);
    this.inFlight ??= this.build(this.source).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Refreshes now, retries quickly until the first success, then refreshes hourly. */
  startAutoRefresh(opts: AutoRefreshOptions = {}): void {
    if (!this.source || this.auto) return;
    this.auto = { opts, timer: null };
    this.autoStep(this.auto);
  }

  stopAutoRefresh(): void {
    if (this.auto?.timer) clearTimeout(this.auto.timer);
    this.auto = null;
  }

  private autoStep(state: AutoRefreshState): void {
    const { retryMs = 15_000, intervalMs = 60 * 60_000, onResult } = state.opts;
    void this.refresh()
      .catch(() => false)
      .then((ok) => {
        if (this.auto !== state) return;
        try {
          onResult?.(ok);
        } catch {
          // A broken callback must not end the refresh chain.
        }
        state.timer = setTimeout(() => this.autoStep(state), this.built ? intervalMs : retryMs);
        state.timer.unref();
      });
  }

  requestRefresh(): void {
    const t = this.now();
    if (t - this.lastAttempt < this.minRefreshMs) return;
    this.lastAttempt = t;
    this.refresh().catch(() => undefined);
  }

  available(): boolean {
    return this.built;
  }

  hubs(): GuideHub[] {
    return this.entries
      .map((e) => e.hub)
      .sort(
        (a, b) => Number(b.nowPlaying) - Number(a.nowPlaying) || a.title.localeCompare(b.title),
      );
  }

  lookup(source: Source, gameId: string): GuideHub[] {
    return this.entries.map((e) => e.hub).filter((h) => h.source === source && h.gameId === gameId);
  }

  tree(hubId: string): { hub: GuideHub; pages: GuidePage[] } | null {
    const entry = this.entries.find((e) => e.hub.hubId === hubId);
    return entry ? { hub: entry.hub, pages: entry.pages } : null;
  }

  private async build(source: GuideSource): Promise<boolean> {
    let docs: OutlineDoc[];
    let tree: OutlineNode[];
    try {
      [docs, tree] = await Promise.all([
        source.listChildren(this.guidesParentId),
        source.collectionTree(this.collectionId),
      ]);
    } catch {
      return false;
    }

    const playing = new Set<string>();
    if (this.scheduleDocId) {
      try {
        for (const title of parseNowPlaying(await source.docText(this.scheduleDocId))) {
          playing.add(normaliseTitle(title));
        }
      } catch {
        // No schedule means no hub is flagged; the index is still usable.
      }
    }

    const children = findNode(tree, this.guidesParentId)?.children ?? [];
    this.entries = docs
      .filter((d) => isSafeGuideUrl(d.url))
      .map((d) => {
        const identity = parseHubIdentity(d.text);
        const hub: GuideHub = {
          hubId: d.id,
          title: d.title,
          url: d.url,
          source: identity?.source ?? null,
          gameId: identity?.gameId ?? null,
          platformLabel: platformLabel(d.title, identity),
          nowPlaying: playing.has(normaliseTitle(d.title)),
        };
        const node = children.find((c) => c.id === d.id);
        return { hub, pages: node ? toPages(node.children) : [] };
      });
    this.built = true;
    return true;
  }
}
