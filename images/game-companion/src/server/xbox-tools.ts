import { normaliseTitle } from "./guide-index.js";
import { normaliseXbox, type XboxAchievementList, type XboxTitleInfo } from "./xbox.js";

/** What both Xbox tools answer when the sign-in is not working. */
export const NOT_CONNECTED = "Xbox is not connected.";
export const UNREACHABLE = "Xbox could not be reached right now. Try again shortly.";

/** Longest title list returned. */
export const TITLES_MAX = 50;

/** Text for one line: runs of whitespace (newlines included) become single spaces. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const byNewest = (a: XboxTitleInfo, b: XboxTitleInfo): number =>
  (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? "");

/**
 * The games of the title history as one line each, newest played first, at most `TITLES_MAX`:
 * `<titleId> | <name> | <devices> | last played <ISO> | <current>/<total> G`. A query keeps the
 * titles whose normalised name contains the normalised query. Apps and non-Xbox-Live programs
 * are left out. Nothing here identifies the account.
 */
export function formatTitles(infos: readonly XboxTitleInfo[], query: string | undefined): string {
  const wanted = query === undefined ? null : normaliseTitle(query);
  const games = infos
    .filter((t) => t.isXboxLive)
    .filter((t) => wanted === null || (wanted !== "" && normaliseTitle(t.name).includes(wanted)))
    .sort(byNewest);
  if (games.length === 0) {
    return query === undefined ? "No Xbox titles found." : "No Xbox titles match that query.";
  }
  const lines = games.slice(0, TITLES_MAX).map((t) => {
    const devices = t.devices && t.devices.length > 0 ? t.devices.join(", ") : "unknown devices";
    const played = t.lastPlayed ?? "unknown";
    const score = `${t.currentGamerscore ?? 0}/${t.totalGamerscore ?? 0} G`;
    return `${t.id} | ${oneLine(t.name)} | ${devices} | last played ${played} | ${score}`;
  });
  if (games.length > TITLES_MAX) {
    lines.push(`(showing ${TITLES_MAX} of ${games.length}; pass a query to narrow)`);
  }
  return lines.join("\n");
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The locked description Xbox sends for each achievement id (normaliseXbox does not keep it). */
function lockedDescriptions(list: XboxAchievementList): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of list.achievements) {
    const a = rec(raw);
    if (a === null) continue;
    const id = typeof a.id === "number" ? String(a.id) : a.id;
    if (typeof id === "string" && typeof a.lockedDescription === "string") {
      found.set(id, a.lockedDescription);
    }
  }
  return found;
}

/**
 * A header line (`<title> | <current>/<total> G`) then one line per achievement:
 * `<id> | <name> | <unlocked ISO or "locked"> | <rarity>% | <G> G | secret or not secret |
 * progress <c>/<t> or no progress | <description> | locked: <locked description>`.
 * Secret achievements are included in full: the skills that read this decide how to show them.
 */
export function formatAchievements(
  titleId: string,
  list: XboxAchievementList,
  info: XboxTitleInfo | null,
): string {
  const title = oneLine(info?.name ?? "") || `Xbox title ${titleId}`;
  const shown = normaliseXbox(titleId, title, list, info);
  if (shown.achievements.length === 0) {
    return `${title}: no achievements listed. If the game has never been launched on this account, launch it once and try again.`;
  }
  const locked = lockedDescriptions(list);
  const gs = shown.gamerscore;
  const lines = [`${title} | ${gs?.current ?? 0}/${gs?.total ?? 0} G`];
  for (const a of shown.achievements) {
    lines.push(
      [
        a.id,
        oneLine(a.name),
        a.unlocked ? (a.unlockedAt ?? "unlocked") : "locked",
        `${a.unlockPercent ?? "?"}%`,
        `${a.gamerscore ?? 0} G`,
        a.hidden ? "secret" : "not secret",
        a.progress ? `progress ${a.progress.current}/${a.progress.target}` : "no progress",
        oneLine(a.description ?? "") || "-",
        `locked: ${oneLine(locked.get(a.id) ?? "") || "-"}`,
      ].join(" | "),
    );
  }
  return lines.join("\n");
}
