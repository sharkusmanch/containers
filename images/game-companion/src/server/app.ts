import type { AchievementsResponse, AskRequest, GuideHub, Source } from "../shared/types.js";
import type { AchievementService } from "./achievements.js";
import type { AgentClient } from "./agent-client.js";
import { buildStatusBlock, type ContextInput, INSTRUCTIONS } from "./assistant-context.js";
import type { Detector, DetectorSnapshot } from "./detector.js";
import type { GuideIndex } from "./guide-index.js";
import { type GuidePageService, missableMarks, type PageText } from "./guide-pages.js";
import { guideOutline, readGuide, searchGuide } from "./guide-tools.js";
import type { McpTools, ToolResult } from "./mcp.js";
import type { AskLimiter } from "./rate-limit.js";
import type { RouteDeps } from "./routes.js";

type GameRef = NonNullable<AskRequest["game"]>;

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
  /** Null when no agent is configured. */
  ask: null | {
    /** Origin of the wiki that frames the page: the one origin allowed to post questions. */
    origin: string;
    limiter: Pick<AskLimiter, "admit">;
    agent: Pick<AgentClient, "ask">;
  };
  /** Absent or null when no MCP token is configured; the MCP endpoint is then off. */
  mcp?: null | { token: string; version: string };
}

const UNLOADED = "The guide could not be loaded right now.";

const NO_CURRENT_GUIDE = "No guide for the current game. Call list_guides and pass hub.";
const NO_GAME = "No game is detected right now. Call list_guides and pass hub.";
const unknownGuide = (hubId: string): ToolResult => ({
  text: `Unknown guide "${hubId}". Call list_guides for the guide ids.`,
  isError: true,
});

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

  /**
   * What a status block is built from, for a hub (or none) and the game it is about (or none).
   * The target must already be allowed. Rejects when the hub's pages fail to load.
   */
  const gatherContext = async (
    hub: GuideHub | null,
    target: GameRef | null,
  ): Promise<ContextInput> => {
    const snap = snapshot();
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

    const texts = hub === null ? [] : ((await pages.texts(hub.hubId)) ?? []);
    const match = playing && hub !== null ? (await whereFor(hub.hubId))?.matches[0] : undefined;
    return {
      gameTitle: hub?.title ?? ach?.title ?? (isDetected ? detectedGame.title : "Unknown game"),
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
    };
  };

  /** The current game, when the detector reports one with an id. */
  const currentGame = (): GameRef | null => {
    const game = snapshot().game;
    return game !== null && game.id !== null ? { source: game.source, id: game.id } : null;
  };

  /** The hub a tool names, else the current game's; a tool error when there is none. */
  const toolHub = (hubId: string | undefined): GuideHub | ToolResult => {
    if (hubId !== undefined) return index.tree(hubId)?.hub ?? unknownGuide(hubId);
    const game = currentGame();
    const hub = game === null ? undefined : index.lookup(game.source, game.id)[0];
    return hub ?? { text: NO_CURRENT_GUIDE, isError: true };
  };

  /** Runs `fn` over the pages of the hub a guide tool names (or the current game's). */
  const withGuide = async (
    hubId: string | undefined,
    fn: (texts: PageText[]) => ToolResult,
  ): Promise<ToolResult> => {
    const hub = toolHub(hubId);
    if ("text" in hub) return hub;
    const texts = await pages.texts(hub.hubId).catch(() => null);
    if (texts === null || texts.length === 0) return { text: UNLOADED, isError: true };
    return fn(texts);
  };

  const mcpTools: McpTools = {
    status: async (hubId) => {
      const named = hubId === undefined ? null : toolHub(hubId);
      if (named !== null && "text" in named) return named;
      const game = currentGame();
      const hub = named ?? (game === null ? null : (index.lookup(game.source, game.id)[0] ?? null));
      // A hub's own game when it names one; otherwise only the current game, without a hub.
      const target =
        hub === null
          ? game
          : hub.source !== null && hub.gameId !== null
            ? { source: hub.source, id: hub.gameId }
            : null;
      if (hub === null && target === null) return { text: NO_GAME, isError: true };
      return { text: buildStatusBlock(await gatherContext(hub, target)) };
    },
    listGuides: async () => {
      if (!index.available()) {
        return { text: "The guide list is not available right now.", isError: true };
      }
      const hubs = index.hubs();
      if (hubs.length === 0) return { text: "There are no guides." };
      return { text: hubs.map((h) => `- ${h.title} (${h.platformLabel}): ${h.hubId}`).join("\n") };
    },
    outline: (hubId) => withGuide(hubId, (texts) => ({ text: guideOutline(texts) })),
    search: (query, hubId) => withGuide(hubId, (texts) => ({ text: searchGuide(texts, query) })),
    read: (page, section, hubId) =>
      withGuide(hubId, (texts) => {
        const read = readGuide(texts, page, section);
        return read.ok ? { text: read.text } : { text: read.text, isError: true };
      }),
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
              const resolved = resolveAsk(req);
              if (resolved === null) return null;
              const statusBlock = buildStatusBlock(
                await gatherContext(resolved.hub, resolved.target),
              );
              return askParts.agent.ask(
                {
                  instructions: INSTRUCTIONS,
                  statusBlock,
                  history: req.history,
                  question: req.question,
                  depth: req.depth,
                  hub: resolved.hub?.hubId ?? null,
                },
                signal,
              );
            },
          },
    mcp: parts.mcp ? { ...parts.mcp, tools: mcpTools } : null,
  };
}
