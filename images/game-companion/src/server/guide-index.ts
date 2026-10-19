import type { GuideHub, GuidePage, Source } from "../shared/types.js";
import type { OutlineDoc, OutlineNode } from "./outline.js";
import type { PlatformMemory } from "./platform-memory.js";

/** The IDs a hub's own rows name; null for a row it does not have. */
export interface HubIdentity {
  steam: string | null;
  ra: string | null;
  xbox: string | null;
  /** The platform the `Tracked on` row names; null with no row or an unknown value. */
  trackedOn: "steam" | "xbox" | null;
}

// A table row whose first cell is exactly the label, bold on both sides or on neither
// (`**Steam App ID**` or `Steam App ID`). The label must start the cell, so `DLC App ID`
// does not match, and a half-bold `**Steam App ID` does not either. Case-sensitive.
// Only spaces and tabs may separate the pieces: the label and its cell share one line.
const RA_ROW = /^\|[ \t]*(?:\*\*RA Game ID\*\*|RA Game ID)[ \t]*\|([^\n]*)$/gm;
const STEAM_ROW = /^\|[ \t]*(?:\*\*(?:Steam )?App ID\*\*|(?:Steam )?App ID)[ \t]*\|([^\n]*)$/gm;
const XBOX_ROW = /^\|[ \t]*(?:\*\*Xbox Title ID\*\*|Xbox Title ID)[ \t]*\|([^\n]*)$/gm;
const TRACKED_ROW = /^\|[ \t]*(?:\*\*Tracked on\*\*|Tracked on)[ \t]*\|([^\n]*)$/gm;
const RA_LINK = /retroachievements\.org\/game\/(\d{1,10})(?!\d)/;
const STEAM_LINK = /store\.steampowered\.com\/app\/(\d{1,10})(?!\d)/;

/**
 * The ID in a cell: the number in the game's own store or RetroAchievements link when there is
 * one, otherwise the first run of 1–10 digits, ignoring digits inside a longer number.
 */
function cellId(cell: string, link: RegExp | null): string | null {
  const m = link?.exec(cell) ?? /(?<!\d)(\d{1,10})(?!\d)/.exec(cell);
  return m ? (m[1] as string) : null;
}

function firstRowId(text: string, row: RegExp, link: RegExp | null): string | null {
  for (const m of text.matchAll(row)) {
    const id = cellId(m[1] as string, link);
    if (id) return id;
  }
  return null;
}

/** The first `Tracked on` row whose cell is exactly Steam or Xbox (bold or not, any case). */
function trackedOn(text: string): "steam" | "xbox" | null {
  for (const m of text.matchAll(TRACKED_ROW)) {
    const cell = (m[1] as string).split("|")[0] as string;
    const value = cell.replace(/\*\*/g, "").trim().toLowerCase();
    if (value === "steam" || value === "xbox") return value;
  }
  return null;
}

export function parseHubIdentity(text: string): HubIdentity | null {
  const unix = text.replace(/\r\n/g, "\n");
  const identity: HubIdentity = {
    steam: firstRowId(unix, STEAM_ROW, STEAM_LINK),
    ra: firstRowId(unix, RA_ROW, RA_LINK),
    xbox: firstRowId(unix, XBOX_ROW, null),
    trackedOn: null,
  };
  // A RetroAchievements-only guide has no Steam or Xbox list to track.
  if (!(identity.ra && !identity.steam && !identity.xbox)) identity.trackedOn = trackedOn(unix);
  return identity.steam || identity.ra || identity.xbox ? identity : null;
}

/** "Steam", "Xbox", "Steam + Xbox", an RA label from the title, or "Other" with no platform. */
export function platformLabel(title: string, platforms: readonly Source[]): string {
  if (platforms.includes("ra")) {
    const m = /\(([^()—–-]+?)\s*[—–-]\s*RetroAchievements\)\s*$/.exec(title);
    return m ? `RA · ${(m[1] as string).trim()}` : "RA";
  }
  const steam = platforms.includes("steam");
  const xbox = platforms.includes("xbox");
  if (steam && xbox) return "Steam + Xbox";
  if (steam) return "Steam";
  if (xbox) return "Xbox";
  return "Other";
}

export function normaliseTitle(title: string): string {
  return (
    title
      // Before NFKD, which would turn ™ into the letters "TM".
      .replace(/[™®©]/g, "")
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

/** A page of a hub with its Outline document id. */
export interface PageRef {
  id: string;
  title: string;
  url: string;
}

/** A hub as its own document describes it; what the platform memory adds is applied on read. */
interface Entry {
  hubId: string;
  title: string;
  url: string;
  identity: HubIdentity | null;
  nowPlaying: boolean;
  pages: GuidePage[];
  refs: PageRef[];
}

/** A guide that has an RA row and no Steam row is RetroAchievements-only. */
const raOnly = (identity: HubIdentity | null): boolean =>
  identity !== null && identity.ra !== null && identity.steam === null;

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

/** The pages `toPages` keeps, flattened depth-first, each with its document id. */
function toRefs(nodes: OutlineNode[]): PageRef[] {
  return nodes
    .filter((n) => isSafeGuideUrl(n.url))
    .flatMap((n) => [{ id: n.id, title: n.title, url: n.url }, ...toRefs(n.children)]);
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
  private readonly memory: Pick<PlatformMemory, "get" | "byXboxTitle"> | null;
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
    /** What each hub was last detected on; absent when Xbox is off. */
    memory?: Pick<PlatformMemory, "get" | "byXboxTitle"> | null;
  }) {
    this.source = opts.source;
    this.collectionId = opts.collectionId;
    this.guidesParentId = opts.guidesParentId;
    this.scheduleDocId = opts.scheduleDocId;
    this.now = opts.now ?? Date.now;
    this.minRefreshMs = opts.minRefreshMs ?? 60_000;
    this.memory = opts.memory ?? null;
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
      .map((e) => this.hubOf(e))
      .sort(
        (a, b) => Number(b.nowPlaying) - Number(a.nowPlaying) || a.title.localeCompare(b.title),
      );
  }

  /**
   * Hubs for a game. Steam and RA: the hubs whose own game it is. Xbox: hubs whose Xbox Title ID
   * row names it; else hubs remembered for it; else the one hub, not RetroAchievements-only and
   * not tied to another Xbox title, whose normalised title equals the game's. Two or more by name
   * is no match, never a guess.
   */
  lookup(source: Source, gameId: string, title?: string): GuideHub[] {
    if (source !== "xbox") {
      return this.entries
        .map((e) => this.hubOf(e))
        .filter((h) => h.source === source && h.gameId === gameId);
    }
    const byRow = this.entries.filter((e) => e.identity?.xbox === gameId);
    if (byRow.length > 0) return byRow.map((e) => this.hubOf(e));
    const remembered = new Set(this.memory?.byXboxTitle(gameId) ?? []);
    const byMemory = this.entries.filter((e) => remembered.has(e.hubId));
    if (byMemory.length > 0) return byMemory.map((e) => this.hubOf(e));
    const wanted = title === undefined ? "" : normaliseTitle(title);
    if (wanted === "") return [];
    // A hub tied to an Xbox title (by its row, or remembered from a detection) is that title's
    // guide only: a same-named title is a different game (e.g. a newer edition).
    const byName = this.entries.filter(
      (e) =>
        !raOnly(e.identity) &&
        !e.identity?.xbox &&
        (this.memory?.get(e.hubId)?.xboxTitleId ?? null) === null &&
        normaliseTitle(e.title) === wanted,
    );
    return byName.length === 1 ? byName.map((e) => this.hubOf(e)) : [];
  }

  tree(hubId: string): { hub: GuideHub; pages: GuidePage[] } | null {
    const entry = this.entries.find((e) => e.hubId === hubId);
    return entry ? { hub: this.hubOf(entry), pages: entry.pages } : null;
  }

  /** The pages `tree(hubId)` returns, flattened depth-first, with their document ids. */
  pageRefs(hubId: string): PageRef[] | null {
    const entry = this.entries.find((e) => e.hubId === hubId);
    return entry ? [...entry.refs] : null;
  }

  /** The hub with its platforms: its rows, plus an Xbox title remembered from a detection. */
  private hubOf(entry: Entry): GuideHub {
    const identity = entry.identity;
    const remembered = this.memory?.get(entry.hubId) ?? null;
    const xboxTitleId = identity?.xbox ?? remembered?.xboxTitleId ?? null;
    const platforms: Source[] = [];
    if (identity?.steam) platforms.push("steam");
    if (xboxTitleId !== null) platforms.push("xbox");
    if (identity?.ra) platforms.push("ra");
    // The hub's own game: its RA row first (as before Xbox), then Steam, then Xbox.
    const own: [Source, string] | null = identity?.ra
      ? ["ra", identity.ra]
      : identity?.steam
        ? ["steam", identity.steam]
        : identity?.xbox
          ? ["xbox", identity.xbox]
          : null;
    return {
      hubId: entry.hubId,
      title: entry.title,
      url: entry.url,
      source: own?.[0] ?? null,
      gameId: own?.[1] ?? null,
      xboxTitleId,
      platforms,
      lastPlatform: remembered?.last ?? null,
      trackedOn: identity?.trackedOn ?? null,
      platformLabel: platformLabel(entry.title, platforms),
      nowPlaying: entry.nowPlaying,
    };
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
        const node = children.find((c) => c.id === d.id);
        return {
          hubId: d.id,
          title: d.title,
          url: d.url,
          identity: parseHubIdentity(d.text),
          nowPlaying: playing.has(normaliseTitle(d.title)),
          pages: node ? toPages(node.children) : [],
          refs: node ? toRefs(node.children) : [],
        };
      });
    this.built = true;
    return true;
  }
}
