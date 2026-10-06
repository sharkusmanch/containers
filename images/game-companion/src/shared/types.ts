export type Source = "steam" | "ra";

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
  /** Hubs whose (source, gameId) equals the game. Empty when there is no guide. */
  hubs: GuideHub[];
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
}

export interface AchievementsResponse {
  source: Source;
  id: string;
  title: string;
  total: number;
  unlocked: number;
  stale: boolean;
  achievements: Achievement[];
}

export interface ErrorResponse {
  error: string;
}
