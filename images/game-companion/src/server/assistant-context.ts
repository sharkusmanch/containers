import type { AchievementsResponse, AskHistoryEntry } from "../shared/types.js";
import type { PageText } from "./guide-pages.js";
import { guideOutline } from "./guide-tools.js";

export const INSTRUCTIONS = `You are a game companion shown on a small second screen next to the game. The player asks quick questions while playing.
- Answer in a few short lines. Plain text only; lines may start with "- " for bullets. No headings, tables, links or bold.
- For anything about the game itself (locations, items, enemies, progression, requirements), check the player's guide first: the outline and pinned pages below, then the search_guide and read_guide_page tools.
- If the guide does not cover it, use web search, and open a result page when a snippet is not enough, instead of answering from memory.
- Say briefly whether the answer came from the guide, the web, or your own memory. Use memory alone only for general, low-stakes facts.
- Do not describe your lookups; the screen shows them.
- Never reveal story events, bosses, characters or places beyond the player's progress (shown in the status) unless the answer depth is full.
- At answer depth hint, keep guide searches and the sections you read to the player's current progress where you can, because the screen shows them.
- Answer depth hint: give the smallest useful nudge and offer more. Answer depth full: answer directly and completely.
- If you are not sure, say so rather than guessing.`;

export interface ContextInput {
  /** Hub title, else the detected game title. */
  gameTitle: string;
  /** hub.platformLabel, else "Steam" / "RetroAchievements". */
  platformLabel: string;
  playState: "playing" | "last-played" | "not detected";
  /** Only when playing this game. */
  presence: string | null;
  achievements: AchievementsResponse | null;
  /** Lower-cased names from missableMarks(pages). */
  missableNames: string[];
  where: { pageTitle: string; heading: string } | null;
  /** Hub pages in tree order. */
  pages: PageText[];
  /** Default pinned page titles, in order. */
  pinnedTitles: string[];
  /** Budget for the rendered pinned pages, in characters. */
  guideChars: number;
}

export interface BuiltContext {
  /** Instructions, guide outline and pinned pages; byte-stable for equal inputs. */
  system: string;
  /** Goes into the last user turn. */
  statusBlock: string;
  /** True only when pinned pages were cut to fit the budget. */
  truncatedGuide: boolean;
}

const CUT_MARKER = "\n[guide cut here]\n";
const STORY_LIMIT = 5;

/** The pinned pages, in pinned order (the first page of each title not already taken). */
function pinnedPages(pages: PageText[], pinnedTitles: string[]): PageText[] {
  const pinned: PageText[] = [];
  for (const title of pinnedTitles) {
    const found = pages.find((p) => p.title === title && !pinned.includes(p));
    if (found) pinned.push(found);
  }
  return pinned;
}

function renderGuide(pages: PageText[], budget: number): { guide: string; truncated: boolean } {
  let guide = "";
  for (const p of pages) {
    const rendered = `## ${p.title}\n\n${p.text}\n\n`;
    const room = budget - guide.length;
    if (rendered.length <= room) {
      guide += rendered;
      continue;
    }
    const cut = rendered.slice(0, Math.max(room, 0)).lastIndexOf("\n");
    return {
      guide: guide + (cut === -1 ? "" : rendered.slice(0, cut)) + CUT_MARKER,
      truncated: true,
    };
  }
  return { guide, truncated: false };
}

const entry = (name: string, description: string | null): string =>
  description ? `- ${name} — ${description}` : `- ${name}`;

function achievementLines(a: AchievementsResponse, missableNames: string[]): string[] {
  const out = [`Achievements: ${a.unlocked}/${a.total} unlocked`];
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

export function buildContext(input: ContextInput): BuiltContext {
  const pinned = pinnedPages(input.pages, input.pinnedTitles);
  const { guide, truncated } = renderGuide(pinned, input.guideChars);
  const outline = input.pages.length === 0 ? "This game has no guide." : guideOutline(input.pages);
  const system =
    INSTRUCTIONS +
    (truncated ? "\nThe pinned pages below are incomplete." : "") +
    `\n\n# Guide outline\n\n${outline}` +
    (pinned.length === 0 ? "" : `\n\n# Pinned pages\n\n${guide}`);

  const status = [`Game: ${input.gameTitle} (${input.platformLabel})`, `State: ${input.playState}`];
  if (input.presence !== null) status.push(`Status line: ${input.presence}`);
  if (input.achievements === null) status.push("Achievements: unknown");
  else status.push(...achievementLines(input.achievements, input.missableNames));
  if (input.where !== null) {
    status.push(
      `Guide section matching the status line: ${input.where.pageTitle} › ${input.where.heading}`,
    );
  }
  return { system, statusBlock: status.join("\n"), truncatedGuide: truncated };
}

export function buildMessages(
  ctx: BuiltContext,
  history: AskHistoryEntry[],
  question: string,
  depth: "hint" | "full",
): { role: "user" | "assistant"; content: string }[] {
  const turns = history.flatMap((h) => [
    { role: "user" as const, content: h.question },
    { role: "assistant" as const, content: h.answer },
  ]);
  return [
    ...turns,
    {
      role: "user",
      content: `${ctx.statusBlock}\n\nAnswer depth: ${depth}\n\nQuestion: ${question}`,
    },
  ];
}
