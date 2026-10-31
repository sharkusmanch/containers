import type { AchievementsResponse } from "../shared/types.js";

export const INSTRUCTIONS = `You are a game companion shown on a small second screen next to the game. The player asks quick questions while playing.
- Answer in a few short lines. Plain text only; lines may start with "- " for bullets. No headings, tables, links or bold.
- Start from the status block given with the question: the game, whether it is being played, the status line, achievement progress, missables still open and the matching guide section.
- For anything about the game itself (locations, items, enemies, progression, requirements), check the player's guide before any other source, with the companion tools: guide_outline, search_guide and read_guide_page. Pass the guide id given with the question as hub; list_guides lists every guide and its id, and companion_status gives the current status again.
- If the guide does not cover it, or the answer depth is researched, use web search, and open a result page with web fetch when a snippet is not enough, instead of answering from memory. For what players say on Reddit, use the redlib skill through the shell.
- The RetroAchievements, RomM, Syncthing and Outline tools are read-only: use them for achievement details, the game library, save files and the player's other notes. Only look things up; never change anything.
- Say briefly whether the answer came from the guide, the web, or your own memory. Use memory alone only for general, low-stakes facts.
- Do not describe your lookups; the screen shows them.
- Never reveal story events, bosses, characters or places beyond the player's progress (shown in the status) unless the answer depth is full.
- At answer depth hint or researched, keep guide searches and the sections you read to the player's current progress where you can, because the screen shows them.
- Answer depth hint: give the smallest useful nudge and offer more. Answer depth researched: answer completely, but only up to the player's progress; always check the web (and Reddit when players' experience matters) to confirm or fill in what the guide says, even when the guide covers it, and say which sources agreed. Answer depth full: answer directly and completely.
- If you are not sure, say so rather than guessing.`;

export interface ContextInput {
  /** Hub title, else the detected game title. */
  gameTitle: string;
  /** hub.platformLabel, else "Steam" / "RetroAchievements" / "Xbox". */
  platformLabel: string;
  playState: "playing" | "last-played" | "not detected";
  /** Set for an Xbox game: the device it is played on now ("Series X", "PC"), else null. */
  xbox?: { device: string | null };
  /** Only when playing this game. */
  presence: string | null;
  achievements: AchievementsResponse | null;
  /** Lower-cased names from missableMarks(pages). */
  missableNames: string[];
  where: { pageTitle: string; heading: string } | null;
}

const STORY_LIMIT = 5;

const entry = (name: string, description: string | null): string =>
  description ? `- ${name} — ${description}` : `- ${name}`;

function achievementLines(a: AchievementsResponse, missableNames: string[]): string[] {
  const out = [`Achievements: ${a.unlocked}/${a.total} unlocked`];
  if (a.gamerscore) out.push(`Gamerscore: ${a.gamerscore.current}/${a.gamerscore.total}`);
  const marked = new Set(missableNames);
  const locked = a.achievements.filter((x) => !x.unlocked);
  // A hidden achievement's name and description are spoilers; only how many remain is shown.
  const visible = locked.filter((x) => !x.hidden);

  const missables = visible.filter((x) => x.missable || marked.has(x.name.toLowerCase()));
  if (missables.length > 0) {
    out.push("Missables still open:", ...missables.map((x) => entry(x.name, x.description)));
  }
  const story = visible
    .filter((x) => x.kind === "progression" || x.kind === "win")
    .slice(0, STORY_LIMIT);
  if (story.length > 0) {
    out.push("Next story achievements:", ...story.map((x) => entry(x.name, x.description)));
  }
  const hidden = locked.length - visible.length;
  if (hidden > 0) out.push(`Hidden achievements still locked: ${hidden}`);
  return out;
}

/** The facts about the game and the player's progress that go with every question. */
export function buildStatusBlock(input: ContextInput): string {
  const status = [`Game: ${input.gameTitle} (${input.platformLabel})`];
  if (input.xbox) {
    status.push(`Source: Xbox${input.xbox.device === null ? "" : ` (${input.xbox.device})`}`);
  }
  status.push(`State: ${input.playState}`);
  if (input.presence !== null) status.push(`Status line: ${input.presence}`);
  if (input.achievements === null) status.push("Achievements: unknown");
  else status.push(...achievementLines(input.achievements, input.missableNames));
  if (input.where !== null) {
    status.push(
      `Guide section matching the status line: ${input.where.pageTitle} › ${input.where.heading}`,
    );
  }
  return status.join("\n");
}
