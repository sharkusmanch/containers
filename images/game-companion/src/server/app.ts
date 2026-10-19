import type {
  AchievementsResponse,
  AskRequest,
  GameRef as DetectedGame,
  GuideHub,
  Source,
} from "../shared/types.js";
import type { AchievementService } from "./achievements.js";
import type { AgentClient } from "./agent-client.js";
import { buildStatusBlock, type ContextInput, INSTRUCTIONS } from "./assistant-context.js";
import type { Detector, DetectorSnapshot } from "./detector.js";
import type { GuideIndex } from "./guide-index.js";
import { type GuidePageService, missableMarks, type PageText } from "./guide-pages.js";
import { guideOutline, readGuide, searchGuide } from "./guide-tools.js";
import type { McpTools, ToolResult } from "./mcp.js";
import type { PlatformMemory } from "./platform-memory.js";
import type { AskLimiter } from "./rate-limit.js";
import type { RouteDeps } from "./routes.js";
import type { XboxAuth } from "./xbox-auth.js";
import type { XboxClient } from "./xbox.js";
import { formatAchievements, formatTitles, NOT_CONNECTED, UNREACHABLE } from "./xbox-tools.js";

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
  /** Remembers the platform each guide was last detected on; absent or null when Xbox is off. */
  memory?: null | Pick<PlatformMemory, "record">;
  /** The Xbox sign-in; absent or null when Xbox is off (no client ID). */
  xbox?: null | {
    /** Origin of the wiki that frames the page: the one origin allowed to change the sign-in. */
    origin: string;
    auth: Pick<XboxAuth, "status" | "startConnect" | "cancelConnect" | "disconnect">;
    /** Backs the Xbox MCP tools; without it they answer as if Xbox were not connected. */
    client?: Pick<XboxClient, "titles" | "titleInfo" | "achievements">;
  };
  /** Fixed-text log lines. */
  log?: (line: string) => void;
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

  /** The guides for a detected game; an Xbox game is also matched by name. */
  const hubsFor = (game: DetectedGame): GuideHub[] =>
    game.id === null ? [] : index.lookup(game.source, game.id, game.title);

  /** Whether the hub is a guide for this game: its own game, or an Xbox title known for it. */
  const hubHasGame = (hub: GuideHub, game: DetectedGame): boolean =>
    game.id !== null &&
    ((hub.source === game.source && hub.gameId === game.id) ||
      (game.source === "xbox" && hub.xboxTitleId === game.id));

  /**
   * The Xbox game a guide is being asked about when the guide's own game is another platform's: the
   * Xbox game played now that this guide covers, or the one a request names with this guide's
   * Xbox title ID. Null otherwise, and then the guide's own game is the target.
   */
  const xboxTargetFor = (hub: GuideHub | null, requested: GameRef | null): GameRef | null => {
    if (hub === null) return null;
    const game = snapshot().game;
    if (game !== null && game.id !== null && game.source === "xbox" && hubHasGame(hub, game)) {
      return { source: "xbox", id: game.id };
    }
    if (requested?.source === "xbox" && hub.xboxTitleId === requested.id) {
      return { source: "xbox", id: requested.id };
    }
    return null;
  };

  /**
   * For a Steam or Xbox game being played, remembers the platform (and the Xbox title ID) on each
   * of its guides, then answers the guides as they are now. The file write happens in the
   * background; a failure is logged and changes nothing here.
   */
  const rememberPlatform = (game: DetectedGame, hubs: GuideHub[]): GuideHub[] => {
    const memory = parts.memory;
    if (!memory || game.id === null || hubs.length === 0) return hubs;
    if (game.source !== "steam" && game.source !== "xbox") return hubs;
    for (const hub of hubs) {
      const write =
        game.source === "xbox"
          ? memory.record(hub.hubId, "xbox", game.id)
          : memory.record(hub.hubId, "steam");
      write.catch(() => parts.log?.("platform memory write failed"));
    }
    return hubsFor(game);
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
    if (!hubHasGame(hub, game)) return { matches: [] };
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
    // The guide itself vouches for its own Xbox title ID, so that target needs no further check.
    const viaGuide = xboxTargetFor(hub, req.game);
    const target =
      viaGuide ??
      (hub?.source != null && hub.gameId != null
        ? { source: hub.source, id: hub.gameId }
        : req.game);
    if (viaGuide === null && target !== null && !lookupAllowed(target.source, target.id)) {
      return null;
    }
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
        hub?.platformLabel ??
        (target?.source === "ra"
          ? "RetroAchievements"
          : target?.source === "xbox"
            ? "Xbox"
            : "Steam"),
      ...(target?.source === "xbox" ? { xbox: { device: isDetected ? snap.device : null } } : {}),
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

  /** The current game, when the detector reports one with an id, and its first guide. */
  const current = (): { game: GameRef | null; hub: GuideHub | null } => {
    const game = snapshot().game;
    if (game === null || game.id === null) return { game: null, hub: null };
    return { game: { source: game.source, id: game.id }, hub: hubsFor(game)[0] ?? null };
  };

  /** The hub a tool names, else the current game's; a tool error when there is none. */
  const toolHub = (hubId: string | undefined): GuideHub | ToolResult => {
    if (hubId !== undefined) return index.tree(hubId)?.hub ?? unknownGuide(hubId);
    return current().hub ?? { text: NO_CURRENT_GUIDE, isError: true };
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

  /** Runs an Xbox tool against the client when the sign-in is connected. */
  const withXbox = async (
    run: (client: NonNullable<NonNullable<AppParts["xbox"]>["client"]>) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const client = parts.xbox?.client;
    if (!client || parts.xbox?.auth.status().state !== "connected") {
      return { text: NOT_CONNECTED, isError: true };
    }
    try {
      return await run(client);
    } catch {
      return { text: UNREACHABLE, isError: true };
    }
  };

  const mcpTools: McpTools = {
    status: async (hubId) => {
      const named = hubId === undefined ? null : toolHub(hubId);
      if (named !== null && "text" in named) return named;
      const { game, hub: currentHub } = current();
      const hub = named ?? currentHub;
      // The Xbox game played now when the guide covers it; else the hub's own game when it names
      // one; otherwise only the current game, without a hub.
      const target =
        hub === null
          ? game
          : (xboxTargetFor(hub, null) ??
            (hub.source !== null && hub.gameId !== null
              ? { source: hub.source, id: hub.gameId }
              : null));
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
    xboxTitles: (query) =>
      withXbox(async (client) => {
        const titles = await client.titles();
        return titles === null
          ? { text: UNREACHABLE, isError: true }
          : { text: formatTitles(titles, query) };
      }),
    xboxAchievements: (titleId) =>
      withXbox(async (client) => {
        const [list, info] = await Promise.all([
          client.achievements(titleId),
          client.titleInfo(titleId),
        ]);
        return { text: formatAchievements(titleId, list, info) };
      }),
  };

  const askParts = parts.ask;
  const xboxParts = parts.xbox ?? null;
  return {
    staticDir: parts.staticDir,
    now: () => {
      const snap = snapshot();
      const game = snap.game;
      const found = game === null ? [] : hubsFor(game);
      const hubs =
        game !== null && snap.state === "playing" ? rememberPlatform(game, found) : found;
      return {
        game,
        state: snap.state,
        stale: snap.stale,
        observedAt: snap.observedAt === null ? null : new Date(snap.observedAt).toISOString(),
        presence: snap.presence,
        device: snap.device,
        hubs,
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
    xbox:
      xboxParts === null
        ? null
        : {
            origin: xboxParts.origin,
            status: () => xboxParts.auth.status(),
            connect: () => xboxParts.auth.startConnect(),
            cancel: () => {
              xboxParts.auth.cancelConnect();
              return xboxParts.auth.status();
            },
            disconnect: async () => {
              await xboxParts.auth.disconnect();
              return xboxParts.auth.status();
            },
          },
  };
}
