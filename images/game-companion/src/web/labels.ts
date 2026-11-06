/**
 * Short names for the rail's page buttons, shared by the web client (`slotLabel`) and the server
 * (the label service). It lives with the web code because the browser can only load modules
 * served from the web directory; it imports nothing and touches no DOM, so the server can use it
 * too.
 */

/** Fixed short names for the guides' standard pages, by lower-cased title. */
const KNOWN_LABELS: ReadonlyMap<string, string> = new Map([
  ["achievement checklist", "Checklist"],
  ["blind playthrough essentials", "Blind"],
  ["notes", "Notes"],
  ["collectibles", "Collect"],
]);

/** A rail label longer than this many characters is cut (fallback) or refused (generated). */
export const LABEL_MAX = 8;

/** A generated label: a letter or digit, then letters, digits, spaces and & ' % . - only. */
const LABEL_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} &'%.-]*$/u;

const collapse = (title: string): string => title.trim().replace(/\s+/g, " ");

/** The common mapping's name for a standard guide page, or null for any other title. */
export function knownLabel(title: string): string | null {
  return KNOWN_LABELS.get(collapse(title).toLocaleLowerCase()) ?? null;
}

/** The common mapping's names (Checklist, Blind, ...), lower-cased. */
const KNOWN_NAMES: ReadonlySet<string> = new Set(
  [...KNOWN_LABELS.values()].map((name) => name.toLocaleLowerCase()),
);

/** Whether a label is one of the common mapping's names, in any case. */
export function isKnownName(label: string): boolean {
  return KNOWN_NAMES.has(label.trim().toLocaleLowerCase());
}

/**
 * The name a page gets without a generated label: the common mapping's; else the first word
 * (after a leading article) of the part after a colon, or of the whole title; cut to LABEL_MAX
 * characters with an ellipsis and capitalised. "?" for a title with no letters or digits.
 */
export function defaultLabel(title: string): string {
  const known = knownLabel(title);
  if (known !== null) return known;
  const clean = collapse(title);
  const colon = clean.indexOf(":");
  const head = colon >= 0 ? clean.slice(0, colon) : clean;
  const tail = colon >= 0 ? clean.slice(colon + 1).trim() : "";
  if (tail === "" && head !== clean) return defaultLabel(head);
  const words = (tail || clean).split(/[^\p{L}\p{N}%]+/u).filter((w) => w !== "");
  const word = words.length > 1 && /^(the|a|an)$/i.test(words[0] ?? "") ? words[1] : words[0];
  if (word === undefined) return "?";
  const chars = Array.from(word);
  const cut = chars.length <= LABEL_MAX ? chars : [...chars.slice(0, LABEL_MAX - 1), "…"];
  return (cut[0] ?? "").toLocaleUpperCase() + cut.slice(1).join("");
}

/**
 * A generated label, trimmed, when it is acceptable: 1 to LABEL_MAX characters (code points) of
 * the allowed set. Null for anything else.
 */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  const n = Array.from(label).length;
  return n >= 1 && n <= LABEL_MAX && LABEL_CHARS.test(label) ? label : null;
}

/** A name the person typed for a rail button is at most this many characters (code points). */
export const CUSTOM_LABEL_MAX = 12;

/** Control characters, line and paragraph separators, and lone surrogates: never printable. */
const UNPRINTABLE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * A name the person typed for a page's rail button, trimmed: 1 to CUSTOM_LABEL_MAX characters
 * (code points) of any printable text, emoji included. "" when nothing is left after trimming
 * (the page goes back to its automatic label). Null for anything else.
 */
export function cleanCustomLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label === "") return "";
  return Array.from(label).length <= CUSTOM_LABEL_MAX && !UNPRINTABLE.test(label) ? label : null;
}
