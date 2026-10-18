export interface Config {
  port: number;
  staticDir: string;
  steamApiKey: string;
  steamId: string;
  raApiKey: string;
  raUsername: string;
  /** Explicit additional games eligible for anonymous RA lookups; closed by default. */
  additionalRaGameIds: string[];
  outlineBaseUrl: string;
  /** Null until the read-only key is provisioned; the guide index then reports unavailable. */
  outlineApiKey: string | null;
  outlineCollectionId: string;
  outlineGuidesParentId: string;
  outlineScheduleDocId: string | null;
  /** Titles of the guide pages pinned by default, in order; empty when none are configured. */
  defaultPinnedPages: string[];
  /** Titles of pages that are for typing in; the web client never applies reader mode to them. */
  editablePages: string[];
  /** Null until the key is provisioned; the Ask assistant is then unavailable. */
  anthropicApiKey: string | null;
  assistantModel: string;
  assistantEffort: "low" | "medium" | "high";
  assistantPerMinute: number;
  assistantPerDay: number;
  /** Character budget for the guide text sent with each question. */
  assistantGuideChars: number;
  /** Bearer token for the MCP endpoint; null keeps the endpoint off (404). */
  mcpToken: string | null;
}

const REQUIRED = [
  "STEAM_API_KEY",
  "STEAM_ID",
  "RA_API_KEY",
  "RA_USERNAME",
  "OUTLINE_BASE_URL",
  "OUTLINE_COLLECTION_ID",
  "OUTLINE_GUIDES_PARENT_ID",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1-65535");
  const need = (k: (typeof REQUIRED)[number]): string => env[k] as string;
  return {
    port,
    staticDir: env.STATIC_DIR ?? "dist/web",
    steamApiKey: need("STEAM_API_KEY"),
    steamId: need("STEAM_ID"),
    raApiKey: need("RA_API_KEY"),
    raUsername: need("RA_USERNAME"),
    additionalRaGameIds: parseRaIds(env.RA_ADDITIONAL_GAME_IDS),
    outlineBaseUrl: need("OUTLINE_BASE_URL").replace(/\/+$/, ""),
    outlineApiKey: env.OUTLINE_API_KEY || null,
    outlineCollectionId: need("OUTLINE_COLLECTION_ID"),
    outlineGuidesParentId: need("OUTLINE_GUIDES_PARENT_ID"),
    outlineScheduleDocId: env.OUTLINE_SCHEDULE_DOC_ID || null,
    defaultPinnedPages: parseTitles(env.DEFAULT_PINNED_PAGES),
    editablePages: parseTitles(env.EDITABLE_PAGES),
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    assistantModel: env.ASSISTANT_MODEL || "claude-opus-5-5",
    assistantEffort: parseEffort(env.ASSISTANT_EFFORT),
    assistantPerMinute: positiveInt(env, "ASSISTANT_PER_MINUTE", 10),
    assistantPerDay: positiveInt(env, "ASSISTANT_PER_DAY", 150),
    assistantGuideChars: positiveInt(env, "ASSISTANT_GUIDE_CHARS", 120000),
    mcpToken: env.COMPANION_MCP_TOKEN || null,
  };
}

function parseEffort(raw: string | undefined): "low" | "medium" | "high" {
  if (raw === undefined || raw === "") return "low";
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error("ASSISTANT_EFFORT must be low, medium or high");
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/** Comma-separated titles: trimmed, empty entries dropped, duplicates dropped keeping the first. */
function parseTitles(raw: string | undefined): string[] {
  const titles = (raw ?? "").split(",").map((t) => t.trim());
  return [...new Set(titles.filter((t) => t !== ""))];
}

function parseRaIds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("RA_ADDITIONAL_GAME_IDS must be comma-separated positive integer game IDs");
  }
  return [...new Set(ids)];
}
