import type { GameRef, GuidePage } from "../shared/types.js";

export const SLOT_COUNT = 4;
export const ACHIEVEMENTS = -1;

export interface Slot {
  title: string;
  url: string;
}

/** A web page the person added for a game; the address always passes `isSafeLinkUrl`. */
export interface GameLink {
  title: string;
  url: string;
}

/** The most links one game can have. */
export const LINKS_MAX = 12;
const LINK_URL_MAX = 2000;
const LINK_TITLE_MAX = 40;

/** `active` is ACHIEVEMENTS or an index 0..SLOT_COUNT-1 of a non-null slot. */
export interface Layout {
  slots: (Slot | null)[];
  active: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isSafeDocUrl(url: string): boolean {
  return /^\/doc\/[A-Za-z0-9_-]+$/.test(url);
}

/** An https address with a host and no credentials; the only kind a link frame may show. Never throws. */
export function isSafeLinkUrl(url: string): boolean {
  if (typeof url !== "string" || url.length > LINK_URL_MAX) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function isSafeSlotUrl(url: string): boolean {
  return isSafeDocUrl(url) || isSafeLinkUrl(url);
}

/** Trims, checks and normalises what the person typed; null when the address is not acceptable. */
export function normaliseLink(title: string, url: string): GameLink | null {
  const address = url.trim();
  if (!isSafeLinkUrl(address)) return null;
  const parsed = new URL(address);
  const name = title.trim();
  return {
    title: name === "" ? parsed.hostname : Array.from(name).slice(0, LINK_TITLE_MAX).join(""),
    url: parsed.href,
  };
}

export function flattenPages(pages: GuidePage[]): GuidePage[] {
  return pages.flatMap((p) => [p, ...flattenPages(p.children)]);
}

function emptySlots(): (Slot | null)[] {
  return Array.from({ length: SLOT_COUNT }, () => null);
}

/** Pins the first page (at any depth) titled exactly like each of `titles`, in that order. */
export function defaultLayout(pages: GuidePage[], titles: string[]): Layout {
  const flat = flattenPages(pages);
  const slots = emptySlots();
  let next = 0;
  for (const title of titles) {
    if (next === SLOT_COUNT) break;
    const found = flat.find(
      (p) => p.title === title && isSafeDocUrl(p.url) && !slots.some((s) => s?.url === p.url),
    );
    if (found) slots[next++] = { title: found.title, url: found.url };
  }
  return { slots, active: ACHIEVEMENTS };
}

export function assignSlot(layout: Layout, page: Slot): Layout {
  if (!isSafeSlotUrl(page.url)) return layout;
  const slots = [...layout.slots];
  const existing = slots.findIndex((s) => s?.url === page.url);
  if (existing !== -1) return { slots, active: existing };
  const empty = slots.indexOf(null);
  const target =
    empty !== -1 ? empty : layout.active === ACHIEVEMENTS ? SLOT_COUNT - 1 : layout.active;
  slots[target] = { title: page.title, url: page.url };
  return { slots, active: target };
}

/** Moves pinned pages to the front, keeping their order; `active` follows its page. Returns the input itself when already compact. */
export function compactLayout(layout: Layout): Layout {
  const pinned = layout.slots.filter((s): s is Slot => s !== null);
  if (layout.slots.slice(0, pinned.length).every((s) => s !== null)) return layout;
  const slots: (Slot | null)[] = layout.slots.map((_, i) => pinned[i] ?? null);
  const kept = layout.active === ACHIEVEMENTS ? null : layout.slots[layout.active];
  const active =
    kept === null || kept === undefined
      ? ACHIEVEMENTS
      : layout.slots.slice(0, layout.active).filter((s) => s !== null).length;
  return { slots, active };
}

/**
 * The id of a guide page: the part after the last "-" in the final path segment of its URL
 * (the whole segment when it has none). The wiki derives the slug from the title, so the id is
 * what stays the same when a page is retitled.
 */
export function docId(url: string): string {
  const segment = url.slice(url.lastIndexOf("/") + 1);
  return segment.slice(segment.lastIndexOf("-") + 1);
}

/**
 * Matches pinned slots to the current page tree by `docId`: a slot takes its page's current
 * title and url, a slot whose page is gone is emptied. A slot holding a link is kept while the
 * same address is in `links`, taking that link's title. Then compacts.
 */
export function reconcileLayout(
  layout: Layout,
  pages: GuidePage[],
  links: GameLink[] = [],
): Layout {
  const flat = flattenPages(pages).filter((p) => isSafeDocUrl(p.url));
  const slots = layout.slots.map((s) => {
    if (s === null) return null;
    if (isSafeLinkUrl(s.url)) {
      const link = links.find((l) => l.url === s.url);
      return link === undefined ? null : { title: link.title, url: link.url };
    }
    const id = docId(s.url);
    const found = flat.find((p) => docId(p.url) === id);
    return found === undefined ? null : { title: found.title, url: found.url };
  });
  const active =
    layout.active !== ACHIEVEMENTS && slots[layout.active] === null ? ACHIEVEMENTS : layout.active;
  return compactLayout({ slots, active });
}

/** Empties every slot holding `url` and closes the gap. Returns the input itself when no slot holds it. */
export function removeSlot(layout: Layout, url: string): Layout {
  if (!layout.slots.some((s) => s?.url === url)) return layout;
  const slots = layout.slots.map((s) => (s?.url === url ? null : s));
  const active =
    layout.active !== ACHIEVEMENTS && slots[layout.active] === null ? ACHIEVEMENTS : layout.active;
  return compactLayout({ slots, active });
}

export function activate(layout: Layout, index: number): Layout {
  if (index === ACHIEVEMENTS || (layout.slots[index] ?? null) !== null) {
    return { slots: [...layout.slots], active: index };
  }
  return layout;
}

export function slotLabel(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  const [first, second] = words.map((w) => Array.from(w));
  if (!first) return "?";
  const label = second ? (first[0] ?? "") + (second[0] ?? "") : first.slice(0, 2).join("");
  return label.toLocaleUpperCase();
}

export function layoutKey(hubId: string): string {
  return `game-companion:v1:layout:${hubId}`;
}

function parseSlot(value: unknown): Slot | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { title, url } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof url !== "string" || !isSafeSlotUrl(url)) return undefined;
  return { title, url };
}

export function loadLayout(storage: StorageLike, hubId: string): Layout | null {
  try {
    const raw = storage.getItem(layoutKey(hubId));
    if (raw === null) return null;
    const data = JSON.parse(raw) as { slots?: unknown; active?: unknown } | null;
    if (!data || !Array.isArray(data.slots) || data.slots.length !== SLOT_COUNT) return null;
    const slots: (Slot | null)[] = [];
    for (const entry of data.slots as unknown[]) {
      const slot = parseSlot(entry);
      if (slot === undefined) return null;
      slots.push(slot);
    }
    const { active } = data;
    if (typeof active !== "number" || !Number.isInteger(active)) return null;
    if (active !== ACHIEVEMENTS && slots[active] == null) return null;
    return compactLayout({ slots, active });
  } catch {
    return null;
  }
}

export function saveLayout(storage: StorageLike, hubId: string, layout: Layout): void {
  try {
    storage.setItem(layoutKey(hubId), JSON.stringify(layout));
  } catch {
    // Storage may be blocked or full; the layout just will not persist.
  }
}

export function linksKey(scope: string): string {
  return `game-companion:v1:links:${scope}`;
}

export function loadLinks(storage: StorageLike, scope: string): GameLink[] {
  try {
    const raw = storage.getItem(linksKey(scope));
    if (raw === null) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const links: GameLink[] = [];
    for (const entry of data as unknown[]) {
      if (links.length === LINKS_MAX) break;
      if (typeof entry !== "object" || entry === null) continue;
      const { title, url } = entry as Record<string, unknown>;
      if (typeof title !== "string" || typeof url !== "string" || !isSafeLinkUrl(url)) continue;
      if (links.some((l) => l.url === url)) continue;
      links.push({ title, url });
    }
    return links;
  } catch {
    return [];
  }
}

export function saveLinks(storage: StorageLike, scope: string, links: GameLink[]): void {
  try {
    storage.setItem(linksKey(scope), JSON.stringify(links));
  } catch {
    // Storage may be blocked or full; the links just will not persist.
  }
}

/** Appends `link`; returns the list itself when the address is already there or the list is full. */
export function addLink(links: GameLink[], link: GameLink): GameLink[] {
  if (links.length >= LINKS_MAX || links.some((l) => l.url === link.url)) return links;
  return [...links, { title: link.title, url: link.url }];
}

export function removeLink(links: GameLink[], url: string): GameLink[] {
  return links.filter((l) => l.url !== url);
}

export function gameKey(game: GameRef | null): string {
  if (!game) return "";
  return game.id === null ? `${game.source}:?${game.title}` : `${game.source}:${game.id}`;
}
