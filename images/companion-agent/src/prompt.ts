export interface AskRequest {
  /** House rules, used only when the project folder has no CLAUDE.md. */
  instructions: string;
  statusBlock: string;
  history: { question: string; answer: string }[];
  question: string;
  depth: "hint" | "full";
  /** The guide the companion tools default to; null for a game with no guide. */
  hub: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A NUL byte cannot be passed in a process argument.
const hasNul = (s: string): boolean => s.includes("\u0000");

/** The companion's `/ask` body with only its known fields, or null when it is not one. */
export function parseAskRequest(body: unknown): AskRequest | null {
  if (!isRecord(body)) return null;
  const { instructions, statusBlock, history, question, depth, hub } = body;
  if (typeof instructions !== "string" || typeof statusBlock !== "string") return null;
  if (typeof question !== "string" || question.trim() === "") return null;
  if (depth !== "hint" && depth !== "full") return null;
  if (hub !== null && typeof hub !== "string") return null;
  if (!Array.isArray(history)) return null;
  const pairs: AskRequest["history"] = [];
  for (const entry of history) {
    if (
      !isRecord(entry) ||
      typeof entry.question !== "string" ||
      typeof entry.answer !== "string"
    ) {
      return null;
    }
    pairs.push({ question: entry.question, answer: entry.answer });
  }
  const texts = [
    instructions,
    statusBlock,
    question,
    hub ?? "",
    ...pairs.flatMap((p) => [p.question, p.answer]),
  ];
  if (texts.some(hasNul)) return null;
  return { instructions, statusBlock, history: pairs, question, depth, hub };
}

/** The `-p` prompt: status, earlier turns, depth, guide hub id, then the question. */
export function buildPrompt(req: AskRequest): string {
  const parts = [
    req.statusBlock,
    ...req.history.map((h) => `Earlier question: ${h.question}\nEarlier answer: ${h.answer}`),
    `Answer depth: ${req.depth}`,
    `Guide hub id: ${req.hub ?? "none"}`,
    `Question: ${req.question}`,
  ];
  return parts.filter((p) => p !== "").join("\n\n");
}
