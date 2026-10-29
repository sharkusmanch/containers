import type { Achievement, AchievementsResponse } from "../shared/types.js";
import { groupAchievements, type GroupDef } from "./achievement-groups.js";
import { safeIcon } from "./safe-icon.js";
import { UpstreamError } from "./fetch-json.js";
import { cleanPresence } from "./ra.js";
import type { XboxAuth } from "./xbox-auth.js";

const PRESENCE_URL = "https://userpresence.xboxlive.com/users/xuid";
const TITLEHUB_URL = "https://titlehub.xboxlive.com/users/xuid";
const ACHIEVEMENTS_URL = "https://achievements.xboxlive.com/users/xuid";
/** The public Microsoft Store catalog: names the product an achievement came with. No sign-in. */
const CATALOG_URL = "https://displaycatalog.mp.microsoft.com/v7.0/products/lookup";
const TITLE_HISTORY_ITEMS = 100;
const ACHIEVEMENT_ITEMS = 1000;
const REQUEST_TIMEOUT_MS = 6_000;
const TITLE_TTL_MS = 24 * 3_600_000;
const TITLE_FAIL_TTL_MS = 5 * 60_000;
/** Short: a lookup runs after the achievements call, and both must fit the browser's deadline. */
const CATALOG_TIMEOUT_MS = 3_000;
const PRODUCT_TTL_MS = 7 * 24 * 3_600_000;
const PRODUCT_FAIL_TTL_MS = 3_600_000;
/** Used when Microsoft sends a 429 without a usable Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** Titlehub devices that make a title a genuine Xbox Live game; `Win32` alone does not. */
const XBOX_DEVICES = ["XboxSeries", "XboxOne", "PC"];

export interface XboxPresence {
  online: boolean;
  /**
   * Xbox's device type: "Scarlett" (Series X), "XboxOne", "WindowsOneCore" (the Ally / a PC) or
   * anything newer; null when unknown.
   */
  device: string | null;
  /** The title with `placement: "Full"`, else null. */
  title: { id: string; name: string; richPresence: string | null } | null;
}

export interface XboxTitleInfo {
  id: string;
  name: string;
  /** Has Xbox achievements/Gamerscore, or runs on an Xbox device (not only `Win32`). */
  isXboxLive: boolean;
  image: string | null;
  /** The title's total Gamerscore, when titlehub reports one. */
  totalGamerscore?: number;
  /** The Gamerscore earned in the title so far. */
  currentGamerscore?: number;
  /** Titlehub's device types for the title, e.g. "XboxSeries", "PC". */
  devices?: string[];
  /** When the account last played the title (ISO 8601), when titlehub says. */
  lastPlayed?: string;
}

/** A product from the store catalog: `kind` is "Game" for a game, e.g. "Durable" for DLC. */
export interface XboxProduct {
  kind: string | null;
  title: string | null;
}

/** The parsed achievements response; each item's fields are read defensively by `normaliseXbox`. */
export interface XboxAchievementList {
  achievements: unknown[];
}

/** Xbox Live answered 429. `retryAfterMs` is how long it asked us to wait. */
export class XboxRateLimitError extends UpstreamError {
  constructor(readonly retryAfterMs: number) {
    super("upstream returned 429", 429);
    this.name = "XboxRateLimitError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const badShape = (): UpstreamError => new UpstreamError("unexpected response shape", null);

function retryAfterMs(header: string | null, now: number): number {
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = header === null ? NaN : Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - now);
}

type LookupOutcome = "ok" | "failed" | "no-session";

interface TitleEntry {
  info: XboxTitleInfo | null;
  expiresAt: number;
}

interface ProductEntry {
  product: XboxProduct | null;
  expiresAt: number;
}

export interface XboxClientOptions {
  auth: Pick<XboxAuth, "session">;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Read-only Xbox Live calls for the signed-in account: presence, title info and achievements.
 * Sign-in is `XboxAuth`'s job; presence and title info answer null when there is no session
 * right now, and achievements rejects.
 * Errors never carry a URL (it holds the XUID) or a header (it holds the token).
 */
export class XboxClient {
  private readonly auth: Pick<XboxAuth, "session">;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly titleCache = new Map<string, TitleEntry>();
  private readonly productCache = new Map<string, ProductEntry>();
  private readonly productLookups = new Map<string, Promise<XboxProduct | null>>();
  private titleLookup: Promise<LookupOutcome> | null = null;
  /** Every title of the last good history call, with when it goes stale. */
  private history: XboxTitleInfo[] | null = null;
  private historyLoadedAt = 0;
  private historyExpiresAt = 0;
  private historyFailedUntil = 0;
  /** Set when the last history call was answered 429: the backoff is then Xbox's own wait. */
  private historyRateLimited = false;

  constructor(opts: XboxClientOptions) {
    this.auth = opts.auth;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  async presence(): Promise<XboxPresence | null> {
    const session = await this.auth.session();
    if (!session) return null;
    const body = await this.get(`${PRESENCE_URL}(${session.xuid})?level=all`, session.headers, {
      "x-xbl-contract-version": "3",
    });
    if (!isRec(body)) throw badShape();
    return parsePresence(body);
  }

  async titleInfo(titleId: string): Promise<XboxTitleInfo | null> {
    const cached = this.fresh(titleId);
    if (cached) return cached.info;
    // Concurrent lookups share one titlehub call.
    this.titleLookup ??= this.loadTitleHistory().finally(() => {
      this.titleLookup = null;
    });
    const outcome = await this.titleLookup;
    const loaded = this.fresh(titleId);
    if (loaded) return loaded.info;
    // Not listed (titlehub may not know a new game yet) or the call failed: ask again later.
    if (outcome !== "no-session")
      this.titleCache.set(titleId, { info: null, expiresAt: this.now() + TITLE_FAIL_TTL_MS });
    return null;
  }

  /**
   * Every title in the account's history (one cached call, shared with `titleInfo`), in
   * titlehub's order. `maxAgeMs` asks for a history loaded no longer ago than that; otherwise
   * the cached one serves for 24 hours. A failed call is not repeated for five minutes (after a
   * 429, for as long as Xbox asked), and meanwhile the history already held is served. Null when
   * there is no session or there is no history to serve; rejects with `XboxRateLimitError`
   * (carrying the wait left) when that is because Xbox answered 429.
   */
  async titles(opts: { maxAgeMs?: number } = {}): Promise<XboxTitleInfo[] | null> {
    const held = (): XboxTitleInfo[] | null =>
      this.history !== null && this.now() < this.historyExpiresAt ? [...this.history] : null;
    const cached = held();
    const young = opts.maxAgeMs === undefined || this.now() - this.historyLoadedAt < opts.maxAgeMs;
    if (cached !== null && young) return cached;
    if (this.now() >= this.historyFailedUntil) {
      this.titleLookup ??= this.loadTitleHistory().finally(() => {
        this.titleLookup = null;
      });
      if ((await this.titleLookup) === "no-session") return null;
    }
    const served = held();
    if (served === null && this.historyRateLimited) {
      throw new XboxRateLimitError(Math.max(0, this.historyFailedUntil - this.now()));
    }
    return served;
  }

  /**
   * Rejects when there is no session: a lost sign-in is a failure (the last list is served
   * stale), never "no achievements".
   */
  async achievements(titleId: string): Promise<XboxAchievementList> {
    const session = await this.auth.session();
    if (!session) throw new UpstreamError("xbox is not signed in", null);
    const query = new URLSearchParams({
      titleId,
      maxItems: String(ACHIEVEMENT_ITEMS),
    }).toString();
    const body = await this.get(
      `${ACHIEVEMENTS_URL}(${session.xuid})/achievements?${query}`,
      session.headers,
      { "x-xbl-contract-version": "4" },
    );
    if (!isRec(body) || !Array.isArray(body.achievements)) throw badShape();
    return { achievements: body.achievements };
  }

  /**
   * Names the products (GUIDs from achievement records) from the public store catalog: no
   * sign-in, nothing of the account sent. Never rejects: a product that could not be looked up is
   * null, and is not asked about again for an hour; one found is kept for 7 days.
   */
  async products(ids: readonly string[]): Promise<Map<string, XboxProduct | null>> {
    const found = await Promise.all(ids.map((id) => this.product(id)));
    return new Map(ids.map((id, i) => [id, found[i] ?? null]));
  }

  private product(id: string): Promise<XboxProduct | null> {
    const cached = this.productCache.get(id);
    if (cached && this.now() < cached.expiresAt) return Promise.resolve(cached.product);
    let pending = this.productLookups.get(id);
    if (!pending) {
      pending = this.lookUpProduct(id).finally(() => this.productLookups.delete(id));
      this.productLookups.set(id, pending);
    }
    return pending;
  }

  private async lookUpProduct(id: string): Promise<XboxProduct | null> {
    let product: XboxProduct | null;
    try {
      const query = new URLSearchParams({
        alternateId: "LegacyXboxProductId",
        value: id,
        market: "US",
        languages: "en-US",
        fieldsTemplate: "details",
      }).toString();
      const body = await this.get(`${CATALOG_URL}?${query}`, {}, {}, CATALOG_TIMEOUT_MS);
      product = parseProduct(body);
    } catch {
      // Unreachable (not yet allowed out, say), timed out, refused or rate-limited: a fallback name.
      product = null;
    }
    const ttl = product === null ? PRODUCT_FAIL_TTL_MS : PRODUCT_TTL_MS;
    this.productCache.set(id, { product, expiresAt: this.now() + ttl });
    return product;
  }

  private fresh(titleId: string): TitleEntry | null {
    const entry = this.titleCache.get(titleId);
    return entry && this.now() < entry.expiresAt ? entry : null;
  }

  /** One history call fills the cache for every title it lists, for 24 hours. */
  private async loadTitleHistory(): Promise<LookupOutcome> {
    try {
      const session = await this.auth.session();
      if (!session) return "no-session";
      const body = await this.get(
        `${TITLEHUB_URL}(${session.xuid})/titles/titlehistory/decoration/achievement,image,detail?maxItems=${TITLE_HISTORY_ITEMS}`,
        session.headers,
        {
          "x-xbl-contract-version": "2",
          "x-xbl-client-name": "XboxApp",
          "x-xbl-client-type": "UWA",
        },
      );
      if (!isRec(body) || !Array.isArray(body.titles)) throw badShape();
      const expiresAt = this.now() + TITLE_TTL_MS;
      const infos: XboxTitleInfo[] = [];
      for (const item of body.titles) {
        const info = parseTitle(item);
        if (!info) continue;
        infos.push(info);
        this.titleCache.set(info.id, { info, expiresAt });
      }
      this.history = infos;
      this.historyLoadedAt = this.now();
      this.historyExpiresAt = expiresAt;
      this.historyRateLimited = false;
      return "ok";
    } catch (err) {
      this.historyRateLimited = err instanceof XboxRateLimitError;
      this.historyFailedUntil =
        this.now() + (err instanceof XboxRateLimitError ? err.retryAfterMs : TITLE_FAIL_TTL_MS);
      return "failed";
    }
  }

  private async get(
    url: string,
    sessionHeaders: Record<string, string>,
    extra: Record<string, string>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          headers: { ...sessionHeaders, ...extra },
          signal: controller.signal,
        });
      } catch {
        throw new UpstreamError(
          controller.signal.aborted ? "upstream timed out" : "upstream unreachable",
          null,
        );
      }
      if (response.status === 429)
        throw new XboxRateLimitError(retryAfterMs(response.headers.get("retry-after"), this.now()));
      if (!response.ok)
        throw new UpstreamError(`upstream returned ${response.status}`, response.status);
      try {
        return await response.json();
      } catch {
        if (controller.signal.aborted) throw new UpstreamError("upstream timed out", null);
        throw new UpstreamError("upstream returned invalid JSON", response.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The catalog's first product; null when it lists none (an unknown GUID) or the shape is odd. */
function parseProduct(body: unknown): XboxProduct | null {
  if (!isRec(body)) return null;
  const first = arr(body.Products)[0];
  if (!isRec(first)) return null;
  const localized = arr(first.LocalizedProperties)[0];
  return {
    kind: str(first.ProductKind),
    title: isRec(localized) ? str(localized.ProductTitle) : null,
  };
}

function parsePresence(body: Rec): XboxPresence {
  // "Away" (idle at the console, a game still running) is online too; only "Offline" is not.
  const online = str(body.state) !== null && body.state !== "Offline";
  if (!online) return { online: false, device: null, title: null };
  let best: { device: string | null; title: Rec; at: number } | null = null;
  let firstDevice: string | null = null;
  for (const d of arr(body.devices)) {
    if (!isRec(d)) continue;
    const device = str(d.type);
    firstDevice ??= device;
    for (const t of arr(d.titles)) {
      if (!isRec(t) || t.placement !== "Full" || str(t.id) === null) continue;
      const parsed = typeof t.lastModified === "string" ? Date.parse(t.lastModified) : NaN;
      const at = Number.isNaN(parsed) ? 0 : parsed;
      // Two devices can both report a Full title; the newer report wins.
      if (!best || at > best.at) best = { device, title: t, at };
    }
  }
  if (!best) return { online: true, device: firstDevice, title: null };
  return {
    online: true,
    device: best.device,
    title: {
      id: String(best.title.id),
      name: str(best.title.name) ?? "",
      richPresence: cleanPresence(
        isRec(best.title.activity) ? best.title.activity.richPresence : null,
      ),
    },
  };
}

function parseTitle(v: unknown): XboxTitleInfo | null {
  if (!isRec(v)) return null;
  const id = str(v.titleId);
  if (id === null) return null;
  const achievement = isRec(v.achievement) ? v.achievement : {};
  const totalGamerscore = num(achievement.totalGamerscore) ?? 0;
  const current = num(achievement.currentAchievements) ?? 0;
  const onXboxDevice = arr(v.devices).some(
    (d) => typeof d === "string" && XBOX_DEVICES.includes(d),
  );
  // Titlehub says what a title is in `type` ("Game", "App", ...); apps such as media players run
  // on an Xbox too. `mediaItemType` is no help: games report "Application" there as well.
  const type = str(v.type);
  const isGame = type === null || type === "Game";
  const lastPlayed = unlockTime(isRec(v.titleHistory) ? v.titleHistory.lastTimePlayed : null);
  return {
    id,
    name: str(v.name) ?? "",
    isXboxLive: isGame && (totalGamerscore > 0 || current > 0 || onXboxDevice),
    image: safeIcon(str(v.displayImage)),
    totalGamerscore,
    currentGamerscore: num(achievement.currentGamerscore) ?? 0,
    devices: arr(v.devices).filter((d): d is string => typeof d === "string"),
    ...(lastPlayed === null ? {} : { lastPlayed }),
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Xbox sends year 1 as "never": a locked achievement's unlock time. */
function unlockTime(v: unknown): string | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) || t <= 0 ? null : new Date(t).toISOString();
}

function gamerscoreOf(a: Rec): number {
  for (const r of arr(a.rewards)) {
    if (isRec(r) && r.type === "Gamerscore") return num(r.value) ?? 0;
  }
  return 0;
}

function progressOf(a: Rec): { current: number; target: number } | null {
  const first = isRec(a.progression) ? arr(a.progression.requirements)[0] : undefined;
  if (!isRec(first)) return null;
  const current = num(first.current);
  const target = num(first.target);
  return current !== null && target !== null && target > 1 ? { current, target } : null;
}

function iconOf(a: Rec): string | null {
  const assets = arr(a.mediaAssets).filter(isRec);
  const asset =
    assets.find((m) => m.type === "Icon" && str(m.url)) ?? assets.find((m) => str(m.url));
  return asset ? safeIcon(str(asset.url)) : null;
}

/** An achievement record's id; null for a record `normaliseXbox` skips. */
function achievementId(raw: Rec): string | null {
  return typeof raw.id === "number" ? String(raw.id) : str(raw.id);
}

/** The products the listed achievements came with, each once, in order of first appearance. */
export function xboxProductIds(list: XboxAchievementList): string[] {
  const ids = new Set<string>();
  for (const raw of list.achievements) {
    if (!isRec(raw) || achievementId(raw) === null) continue;
    const productId = str(raw.productId);
    if (productId !== null) ids.add(productId);
  }
  return [...ids];
}

/**
 * The base game is the one product the catalog calls a Game; with none or several, the product
 * most achievements came with (the first to appear on a tie).
 */
function baseProduct(
  ids: string[],
  productIds: (string | null)[],
  products: ReadonlyMap<string, XboxProduct | null> | undefined,
): string {
  const games = ids.filter((id) => products?.get(id)?.kind === "Game");
  if (games.length === 1 && games[0] !== undefined) return games[0];
  const counts = new Map<string, number>();
  for (const id of productIds) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best = ids[0] ?? "";
  for (const id of ids) if ((counts.get(id) ?? 0) > (counts.get(best) ?? 0)) best = id;
  return best;
}

/**
 * Groups by the product each achievement came with, when there are at least two. DLC are named
 * from the catalog, else `Add-on <n>` by their place; an achievement with no product counts as the
 * base game's.
 */
function xboxGroupKeys(
  productIds: (string | null)[],
  products: ReadonlyMap<string, XboxProduct | null> | undefined,
): { keys: string[]; defs: GroupDef[] } | null {
  const ids = [...new Set(productIds.filter((id): id is string => id !== null))];
  if (ids.length < 2) return null;
  const keyOf = (id: string): string => `xbox:${id}`;
  const base = baseProduct(ids, productIds, products);
  const defs: GroupDef[] = [{ key: keyOf(base), name: "Base game", dlc: false }];
  for (const id of ids) {
    if (id === base) continue;
    const name = products?.get(id)?.title ?? `Add-on ${defs.length}`;
    defs.push({ key: keyOf(id), name, dlc: true });
  }
  return { keys: productIds.map((id) => keyOf(id ?? base)), defs };
}

/**
 * Xbox achievements in the shape the panel shows. Secret ones are `hidden` until unlocked.
 * `products` (from `XboxClient.products`) names a DLC game's groups.
 */
export function normaliseXbox(
  titleId: string,
  title: string,
  list: XboxAchievementList,
  info: XboxTitleInfo | null,
  products?: ReadonlyMap<string, XboxProduct | null>,
): AchievementsResponse {
  const achievements: Achievement[] = [];
  const productIds: (string | null)[] = [];
  let current = 0;
  let total = 0;
  for (const raw of list.achievements) {
    if (!isRec(raw)) continue;
    const id = achievementId(raw);
    if (id === null) continue;
    productIds.push(str(raw.productId));
    const progression = isRec(raw.progression) ? raw.progression : {};
    const unlocked = raw.progressState === "Achieved";
    const percentage = isRec(raw.rarity) ? num(raw.rarity.currentPercentage) : null;
    const gamerscore = gamerscoreOf(raw);
    total += gamerscore;
    if (unlocked) current += gamerscore;
    achievements.push({
      id,
      name: str(raw.name) ?? "",
      description: str(raw.description),
      icon: iconOf(raw),
      unlocked,
      unlockedAt: unlocked ? unlockTime(progression.timeUnlocked) : null,
      unlockPercent: percentage === null ? null : round1(percentage),
      hidden: raw.isSecret === true,
      missable: false,
      kind: null,
      gamerscore,
      progress: progressOf(raw),
    });
  }
  const grouping = xboxGroupKeys(productIds, products);
  const grouped = grouping && groupAchievements(achievements, grouping.keys, grouping.defs);
  return {
    source: "xbox",
    id: titleId,
    title,
    total: achievements.length,
    unlocked: achievements.filter((a) => a.unlocked).length,
    stale: false,
    achievements: grouped ? grouped.achievements : achievements,
    gamerscore: { current, total },
    ...(achievements.length === 0 && (info?.totalGamerscore ?? 0) > 0 ? { noList: true } : {}),
    ...(grouped ? { groups: grouped.groups } : {}),
  };
}
