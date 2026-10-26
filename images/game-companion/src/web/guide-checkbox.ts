/**
 * Locating a checkbox in Outline's Markdown and building the `documents.update` patch for it.
 *
 * Adapted from Inkharbor's `src/lib/outline/edits.ts` (MIT; see THIRD-PARTY-NOTICES.md). Outline's
 * patch mode replaces the first occurrence of `findText`, so a repeated line like "- [ ] Potion"
 * has to be widened until it is unique. Inkharbor widens backwards across anything, blank lines
 * included; this version widens only across non-blank lines (the following line first, then the
 * preceding one) so the patch stays inside one Markdown block, and refuses when no such window
 * is unique.
 */

/** A ProseMirror node as Outline's `documents.info` (API version 3) returns it. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** Every `checkbox_item` in the document, in document order (a parent before its children). */
export function checkboxItems(node: PMNode): PMNode[] {
  const found: PMNode[] = [];
  const visit = (current: PMNode): void => {
    if (current.type === "checkbox_item") found.push(current);
    for (const child of current.content ?? []) visit(child);
  };
  visit(node);
  return found;
}

/** The lines that start a checkbox item in Outline's Markdown, outside code fences. */
export function checkboxLines(markdown: string): { line: number; checked: boolean }[] {
  const found: { line: number; checked: boolean }[] = [];
  let fence: string | null = null;
  markdown.split("\n").forEach((text, line) => {
    const opening = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (opening && (!fence || opening.startsWith(fence))) {
      fence = fence ? null : opening;
      return;
    }
    if (fence) return;
    const match = /^(?:\s*>\s?)*\s*- \[([ xX])\] /.exec(text);
    if (match) found.push({ line, checked: match[1] !== " " });
  });
  return found;
}

export type PatchPlan =
  | { ok: true; findText: string; text: string }
  | { ok: false; reason: "count" | "state" | "ambiguous" };

/** How many times `part` appears in `text`, overlapping matches included. */
function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) count += 1;
  return count;
}

/**
 * The `findText` / `text` pair that sets the `index`th checkbox of `markdown` to `checked`.
 * Refuses with `count` when the Markdown has a different number of boxes than the structured
 * document (`structuredCount`), `state` when the box is not as it was shown (`shownChecked`),
 * and `ambiguous` when no run of non-blank lines around it appears exactly once.
 */
export function planCheckboxPatch(
  markdown: string,
  structuredCount: number,
  index: number,
  shownChecked: boolean,
  checked: boolean,
): PatchPlan {
  const found = checkboxLines(markdown);
  const target = found[index];
  if (found.length !== structuredCount || !target) return { ok: false, reason: "count" };
  if (target.checked !== shownChecked) return { ok: false, reason: "state" };

  const lines = markdown.split("\n");
  const k = target.line;
  const edited = (lines[k] ?? "").replace(/- \[[ xX]\] /, checked ? "- [x] " : "- [ ] ");
  const piece = (lo: number, hi: number, replaced?: string): string =>
    lines
      .slice(lo, hi + 1)
      .map((text, offset) => (lo + offset === k && replaced !== undefined ? replaced : text))
      .join("\n") + (hi < lines.length - 1 ? "\n" : "");

  let lo = k;
  let hi = k;
  for (;;) {
    if (occurrences(markdown, piece(lo, hi)) === 1) {
      return { ok: true, findText: piece(lo, hi), text: piece(lo, hi, edited) };
    }
    if (hi + 1 < lines.length && (lines[hi + 1] ?? "").trim() !== "") hi += 1;
    else if (lo > 0 && (lines[lo - 1] ?? "").trim() !== "") lo -= 1;
    else return { ok: false, reason: "ambiguous" };
  }
}
