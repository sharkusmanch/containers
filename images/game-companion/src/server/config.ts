export interface Config {
  port: number;
  staticDir: string;
  steamApiKey: string;
  steamId: string;
  raApiKey: string;
  raUsername: string;
  outlineBaseUrl: string;
  /** Null until the read-only key is provisioned; the guide index then reports unavailable. */
  outlineApiKey: string | null;
  outlineCollectionId: string;
  outlineGuidesParentId: string;
  outlineScheduleDocId: string | null;
  /** Titles of the guide pages pinned by default, in order; empty when none are configured. */
  defaultPinnedPages: string[];
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
    outlineBaseUrl: need("OUTLINE_BASE_URL").replace(/\/+$/, ""),
    outlineApiKey: env.OUTLINE_API_KEY || null,
    outlineCollectionId: need("OUTLINE_COLLECTION_ID"),
    outlineGuidesParentId: need("OUTLINE_GUIDES_PARENT_ID"),
    outlineScheduleDocId: env.OUTLINE_SCHEDULE_DOC_ID || null,
    defaultPinnedPages: parseTitles(env.DEFAULT_PINNED_PAGES),
  };
}

/** Comma-separated titles: trimmed, empty entries dropped, duplicates dropped keeping the first. */
function parseTitles(raw: string | undefined): string[] {
  const titles = (raw ?? "").split(",").map((t) => t.trim());
  return [...new Set(titles.filter((t) => t !== ""))];
}
