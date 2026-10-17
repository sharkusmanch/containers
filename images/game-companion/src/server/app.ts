import type { AchievementsResponse, AskRequest, Source } from "../shared/types.js";
import type { AchievementService } from "./achievements.js";
import type { Assistant } from "./assistant.js";
import { buildContext } from "./assistant-context.js";
import type { Detector, DetectorSnapshot } from "./detector.js";
import type { GuideIndex } from "./guide-index.js";
import { type GuidePageService, missableMarks } from "./guide-pages.js";
import { readGuide, searchGuide } from "./guide-tools.js";
import type { AskLimiter } from "./rate-limit.js";
import type { RouteDeps } from "./routes.js";

/** How many games the detector has reported that stay eligible for achievement lookups. */
const DETECTED_MAX = 20;

export interface AppParts {
  staticDir: string;
  /** Page titles the web client pins by default; sent with every hub tree. */
  defaultPins: string[];
  /** Titles of pages for typing in; sent with every hub tree. */
  editablePages: string[];
  /** Explicit RA lookup allowlist; these games use the general fetch budget. */
  additionalRaGameIds: string[];
  detector: Pick<Detector, "current">;
  index: Pick<GuideIndex, "available" | "hubs" | "lookup" | "tree" | "requestRefresh">;
  achievements: Pick<AchievementService, "get">;
  pages: Pick<GuidePageService, "find" | "marks" | "where" | "progress" | "texts">;
  /** Null when no API key is configured. */
  ask: null | {
    /** Origin of the wiki that frames the page: the one origin allowed to post questions. */
    origin: string;
    limiter: Pick<AskLimiter, "admit">;
    assistant: Pick<Assistant, "ask">;
    /** Character budget for the guide text sent with each question. */
    guideChars: number;
  };
}

/**
 * Adapts the detector, guide index and achievement service to the request handler.
 * Every call goes through the object (never a detached method), so classes keep `this`.
 */
export function buildDeps(parts: AppParts): RouteDeps {
  const { detector, index, achievements, pages } = parts;

  // Games the detector has reported since start, oldest first. Along with the guide index
  // and explicit RA allowlist, these bound anonymous achievement lookups.
  const additionalRaIds = new Set(parts.additionalRaGameIds);
  const detected = new Set<string>();
  const snapshot = (): DetectorSnapshot => {
    const snap = detector.current();
    const game = snap.game;
    if (game && game.id !== null) {
      const key = `${game.source}:${game.id}`;
      detected.delete(key);
      detected.add(key);
      while (detected.size > DETECTED_MAX) {
        const oldest = detected.values().next().value;
        if (oldest === undefined) break;
        detected.delete(oldest);
      }
    }
    return snap;
  };

  /** Whether anonymous lookups may name this game: detected lately, in a guide, or allowlisted. */
  const lookupAllowed = (source: Source, id: string): boolean =>
    detected.has(`${source}:${id}`) ||
    index.lookup(source, id).length > 0 ||
    (source === "ra" && additionalRaIds.has(id));

  // Guide sections matching the status line. The status text is the detector's own and is
  // offered only for the game being played, so a guide for any other game never sees it.
  const whereFor = async (hubId: string) => {
    const hub = index.tree(hubId)?.hub;
    if (!hub) return null;
    const snap = snapshot();
    const game = snap.game;
    const status = snap.presence;
    if (snap.state !== "playing" || status === null || game === null) return { matches: [] };
    if (hub.source === null || hub.gameId === null) return { matches: [] };
    if (game.source !== hub.source || game.id !== hub.gameId) return { matches: [] };
    return pages.where(hubId, status);
  };

  /**
   * The hub and the game a question is about, or null when either is not allowed. The target is
   * the hub's own game when it has one (a `game` sent with it is ignored), else the request's.
   * Synchronous, so the route can refuse before the rate limiter counts the question.
   */
  const resolveAsk = (req: AskRequest) => {
    snapshot();
    const hub = req.hubId === null ? null : (index.tree(req.hubId)?.hub ?? null);
    if (req.hubId !== null && hub === null) return null;
    const target =
      hub?.source != null && hub.gameId != null ? { source: hub.source, id: hub.gameId } : req.game;
    if (target !== null && !lookupAllowed(target.source, target.id)) return null;
    return { hub, target };
  };

  const askParts = parts.ask;
  return {
    staticDir: parts.staticDir,
    now: () => {
      const snap = snapshot();
      const game = snap.game;
      return {
        game,
        state: snap.state,
        stale: snap.stale,
        observedAt: snap.observedAt === null ? null : new Date(snap.observedAt).toISOString(),
        presence: snap.presence,
        hubs: game && game.id !== null ? index.lookup(game.source, game.id) : [],
        assistant: askParts !== null,
      };
    },
    guides: () => ({ available: index.available(), hubs: index.hubs() }),
    hubTree: (hubId) => {
      const tree = index.tree(hubId);
      return tree === null
        ? null
        : { ...tree, defaultPins: parts.defaultPins, editablePages: parts.editablePages };
    },
    refreshGuides: () => index.requestRefresh(),
    achievements: async (source, id) => {
      const game = snapshot().game;
      const key = `${source}:${id}`;
      // Priority is for the one game /api/now reports. A caller can request any game in the
      // detected history, so that history only makes a request allowed, never prioritised.
      const priority = game !== null && game.id !== null && `${game.source}:${game.id}` === key;
      if (!lookupAllowed(source, id)) return null;
      return achievements.get(source, id, { priority });
    },
    find: (hubId, query) => pages.find(hubId, query),
    marks: (hubId) => pages.marks(hubId),
    where: whereFor,
    progress: (hubId, opts) => pages.progress(hubId, opts),
    ask:
      askParts === null
        ? null
        : {
            origin: askParts.origin,
            admit: () => askParts.limiter.admit(),
            allowed: (req) => resolveAsk(req) !== null,
            start: async (req, signal) => {
              const snap = snapshot();
              const resolved = resolveAsk(req);
              if (resolved === null) return null;
              const { hub, target } = resolved;
              const detectedGame = snap.game;
              const isDetected =
                target !== null &&
                detectedGame !== null &&
                detectedGame.source === target.source &&
                detectedGame.id === target.id;
              const playing = isDetected && snap.state === "playing";

              let ach: AchievementsResponse | null = null;
              if (target !== null) {
                ach = await achievements
                  .get(target.source, target.id, { priority: isDetected })
                  .catch(() => null);
              }

              const texts = req.hubId === null ? [] : ((await pages.texts(req.hubId)) ?? []);
              const match =
                playing && req.hubId !== null ? (await whereFor(req.hubId))?.matches[0] : undefined;
              const ctx = buildContext({
                gameTitle:
                  hub?.title ?? ach?.title ?? (isDetected ? detectedGame.title : "Unknown game"),
                platformLabel:
                  hub?.platformLabel ?? (target?.source === "ra" ? "RetroAchievements" : "Steam"),
                playState: !isDetected
                  ? "not detected"
                  : snap.state === "playing"
                    ? "playing"
                    : snap.state === "last-played"
                      ? "last-played"
                      : "not detected",
                presence: playing ? snap.presence : null,
                achievements: ach,
                missableNames: missableMarks(texts).map((n) => n.toLowerCase()),
                where: match ? { pageTitle: match.pageTitle, heading: match.heading } : null,
                pages: texts,
                pinnedTitles: parts.defaultPins,
                guideChars: askParts.guideChars,
              });
              return askParts.assistant.ask(ctx, req.history, req.question, req.depth, signal, {
                search: (query) => searchGuide(texts, query),
                read: (page, section) => readGuide(texts, page, section),
              });
            },
          },
  };
}
