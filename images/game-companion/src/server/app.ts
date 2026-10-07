import type { AchievementService } from "./achievements.js";
import type { Detector, DetectorSnapshot } from "./detector.js";
import type { GuideIndex } from "./guide-index.js";
import type { GuidePageService } from "./guide-pages.js";
import type { RouteDeps } from "./routes.js";

/** How many games the detector has reported that stay eligible for achievement lookups. */
const DETECTED_MAX = 20;

export interface AppParts {
  staticDir: string;
  /** Page titles the web client pins by default; sent with every hub tree. */
  defaultPins: string[];
  detector: Pick<Detector, "current">;
  index: Pick<GuideIndex, "available" | "hubs" | "lookup" | "tree" | "requestRefresh">;
  achievements: Pick<AchievementService, "get">;
  pages: Pick<GuidePageService, "find" | "marks">;
}

/**
 * Adapts the detector, guide index and achievement service to the request handler.
 * Every call goes through the object (never a detached method), so classes keep `this`.
 */
export function buildDeps(parts: AppParts): RouteDeps {
  const { detector, index, achievements, pages } = parts;

  // Games the detector has reported since start, oldest first. Together with the guide index
  // this is the whole set an anonymous caller may ask the achievement service about.
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
      };
    },
    guides: () => ({ available: index.available(), hubs: index.hubs() }),
    hubTree: (hubId) => {
      const tree = index.tree(hubId);
      return tree === null ? null : { ...tree, defaultPins: parts.defaultPins };
    },
    refreshGuides: () => index.requestRefresh(),
    achievements: async (source, id) => {
      const game = snapshot().game;
      const key = `${source}:${id}`;
      // Priority is for the one game /api/now reports. A caller can request any game in the
      // detected history, so that history only makes a request allowed, never prioritised.
      const priority = game !== null && game.id !== null && `${game.source}:${game.id}` === key;
      if (!detected.has(key) && index.lookup(source, id).length === 0) return null;
      return achievements.get(source, id, { priority });
    },
    find: (hubId, query) => pages.find(hubId, query),
    marks: (hubId) => pages.marks(hubId),
  };
}
