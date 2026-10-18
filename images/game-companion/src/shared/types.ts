export type Source = "steam" | "ra" | "xbox";

/** A detected game. `id` is null for a Steam non-Steam shortcut, which has no real app ID. */
export interface GameRef {
  source: Source;
  id: string | null;
  title: string;
}

/** One page in a guide hub's tree. `url` is a same-origin path starting with `/doc/`. */
export interface GuidePage {
  title: string;
  url: string;
  children: GuidePage[];
}

export interface GuideHub {
  hubId: string;
  title: string;
  url: string;
  source: Source | null;
  gameId: string | null;
  /** "Steam", "RA · GC", or "Other" when the hub carries no ID row. */
  platformLabel: string;
  nowPlaying: boolean;
}

export type NowState = "playing" | "last-played" | "none";

export interface NowResponse {
  game: GameRef | null;
  state: NowState;
  /** True when the newest poll of a source failed and this is older data. */
  stale: boolean;
  observedAt: string | null;
  /**
   * What the game reports the player is doing right now (RetroAchievements rich presence).
   * Null unless that game is being played now.
   */
  presence: string | null;
  /** Hubs whose (source, gameId) equals the game. Empty when there is no guide. */
  hubs: GuideHub[];
  /** True when the server has an agent to ask, so the Ask panel can be offered. */
  assistant: boolean;
}

export interface GuidesResponse {
  /** False until the first successful Outline index build. */
  available: boolean;
  hubs: GuideHub[];
}

export interface HubTreeResponse {
  hub: GuideHub;
  pages: GuidePage[];
  /** Page titles to pin by default, in order, from the server configuration. */
  defaultPins: string[];
  /**
   * Titles of pages that are for typing in, from the server configuration. Reader mode is never
   * applied on them.
   */
  editablePages: string[];
}

export interface Achievement {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  unlocked: boolean;
  unlockedAt: string | null;
  /** 0–100, one decimal place; null when unknown. */
  unlockPercent: number | null;
  hidden: boolean;
  missable: boolean;
  /**
   * RetroAchievements' own label: part of the story path, or beating the game. Null for
   * everything else and for every Steam achievement.
   */
  kind: "progression" | "win" | null;
  /** Xbox only: the Gamerscore this achievement is worth. */
  gamerscore?: number;
  /** Xbox only: a counter such as 3/10, null when the achievement has none. */
  progress?: { current: number; target: number } | null;
}

export interface AchievementsResponse {
  /** RA account whose hardcore progress is reported; absent for Steam. */
  accountIdentity?: string;
  /** RA last successful upstream fetch time; unchanged by retries/stale cache reads. */
  fetchedAt?: string;
  source: Source;
  id: string;
  title: string;
  total: number;
  unlocked: number;
  stale: boolean;
  achievements: Achievement[];
  /** Xbox only: Gamerscore earned and available in this list. */
  gamerscore?: { current: number; total: number };
  /** Xbox only: the title has Gamerscore but Xbox returned no list (Xbox 360 back-compat). */
  noList?: boolean;
}

/** One place where a guide page mentions the searched text. */
export interface FindMatch {
  pageTitle: string;
  /** Same-origin path of the page, starting with `/doc/`. */
  pageUrl: string;
  /** Text of the nearest heading above the match, or null. */
  heading: string | null;
  /** The matching line with markdown markers removed, at most 160 characters. */
  snippet: string;
}

export interface FindResponse {
  matches: FindMatch[];
  /** True when more matches existed than were returned. */
  truncated: boolean;
}

export interface GuideMarksResponse {
  /** Lower-cased achievement names that the guide marks as missable. */
  missable: string[];
}

/** A guide heading whose text matches part of the game's status line. */
export interface WhereMatch {
  pageTitle: string;
  /** Same-origin path of the page, starting with `/doc/`. */
  pageUrl: string;
  /** The heading's text, markdown marks removed. */
  heading: string;
  /** The part of the heading that matched, as written in the heading. */
  phrase: string;
}

export interface GuideWhereResponse {
  /** Best match first, at most 5. */
  matches: WhereMatch[];
}

/** How far a reader has got through the checklist of one guide page. */
export interface PageProgress {
  /** Same-origin path of the page, starting with `/doc/`. */
  url: string;
  completed: number;
  total: number;
}

export interface GuideProgressResponse {
  /** Pages that hold at least one checkbox, in guide order. */
  pages: PageProgress[];
}

export interface ErrorResponse {
  error: string;
}

export interface AskHistoryEntry {
  question: string;
  answer: string;
}

export interface AskRequest {
  hubId: string | null;
  game: { source: Source; id: string } | null;
  history: AskHistoryEntry[];
  question: string;
  depth: "hint" | "full";
}

export type AskEvent =
  | { type: "search"; query: string }
  /** A guide lookup or a web page opened, as its on-screen label. */
  | { type: "lookup"; label: string }
  | { type: "text"; text: string }
  | { type: "done"; truncatedGuide: boolean }
  | { type: "error"; message: string }
  /** Keeps a silent stream open through proxies; carries nothing. */
  | { type: "ping" };
