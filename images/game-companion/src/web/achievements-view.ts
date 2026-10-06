import type { Achievement, AchievementsResponse } from "../shared/types.js";
import type { StorageLike } from "./state.js";

export type SortKey = "rarity" | "name" | "order";
export type SortDir = "asc" | "desc";
export interface SortPref {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortPref = { key: "rarity", dir: "desc" };
export const SORT_STORAGE_KEY = "game-companion:v1:sort";
export const HIDE_UNLOCKED_STORAGE_KEY = "game-companion:v1:hide-unlocked";

const SORT_KEYS: readonly SortKey[] = ["rarity", "name", "order"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];
const NATURAL_DIR: Record<SortKey, SortDir> = { rarity: "desc", name: "asc", order: "asc" };
const KEY_LABEL: Record<SortKey, string> = {
  rarity: "Unlock percentage",
  name: "Name",
  order: "Game order",
};

/** Sorts without filtering or mutating. `masked` marks rows whose name must not influence order. */
export function sortAchievements(
  list: Achievement[],
  pref: SortPref,
  masked?: (a: Achievement) => boolean,
): Achievement[] {
  const sign = pref.dir === "asc" ? 1 : -1;
  const compare = (x: { a: Achievement; i: number }, y: { a: Achievement; i: number }): number => {
    if (pref.key === "order") return sign * (x.i - y.i);
    if (pref.key === "rarity") {
      const px = x.a.unlockPercent;
      const py = y.a.unlockPercent;
      if (px === py) return 0;
      if (px === null) return 1;
      if (py === null) return -1;
      return sign * (px - py);
    }
    const mx = masked?.(x.a) ?? false;
    const my = masked?.(y.a) ?? false;
    if (mx || my) return mx === my ? 0 : mx ? 1 : -1;
    return (
      sign * x.a.name.localeCompare(y.a.name, undefined, { sensitivity: "base", numeric: true })
    );
  };
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => compare(x, y) || x.i - y.i)
    .map(({ a }) => a);
}

export function sortLocked(list: Achievement[]): Achievement[] {
  return sortAchievements(
    list.filter((a) => !a.unlocked),
    DEFAULT_SORT,
  );
}

export function loadSortPref(storage: StorageLike | null | undefined): SortPref {
  try {
    const raw = storage?.getItem(SORT_STORAGE_KEY);
    if (raw === null || raw === undefined) return { ...DEFAULT_SORT };
    const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown } | null;
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_SORT };
    const key = SORT_KEYS.find((k) => k === parsed.key);
    const dir = SORT_DIRS.find((d) => d === parsed.dir);
    return key !== undefined && dir !== undefined ? { key, dir } : { ...DEFAULT_SORT };
  } catch {
    return { ...DEFAULT_SORT };
  }
}

export function saveSortPref(storage: StorageLike | null | undefined, pref: SortPref): void {
  try {
    storage?.setItem(SORT_STORAGE_KEY, JSON.stringify({ key: pref.key, dir: pref.dir }));
  } catch {
    // Storage may be blocked or full; the preference just will not persist.
  }
}

export function loadHideUnlocked(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(HIDE_UNLOCKED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHideUnlocked(storage: StorageLike | null | undefined, hide: boolean): void {
  try {
    storage?.setItem(HIDE_UNLOCKED_STORAGE_KEY, hide ? "1" : "0");
  } catch {
    // Storage may be blocked or full; the choice just will not persist.
  }
}

export function recentUnlocks(list: Achievement[], count = 3): Achievement[] {
  return list
    .filter((a) => a.unlocked && a.unlockedAt !== null)
    .sort((x, y) => (y.unlockedAt as string).localeCompare(x.unlockedAt as string))
    .slice(0, count);
}

export function summaryLine(data: Pick<AchievementsResponse, "total" | "unlocked">): string {
  if (data.total === 0) return "0 / 0";
  return `${data.unlocked} / ${data.total} · ${Math.round((data.unlocked / data.total) * 100)}%`;
}

export function isMasked(a: Achievement, revealed: ReadonlySet<string>): boolean {
  return a.hidden && !a.unlocked && !revealed.has(a.id);
}

/** True when `a` should be listed under `filter`. `masked` is the view's spoiler rule for `a`. */
export function matchesFilter(a: Achievement, filter: string, masked: boolean): boolean {
  const needle = filter.trim().toLocaleLowerCase();
  if (needle === "") return true;
  if (masked) return false;
  return (
    a.name.toLocaleLowerCase().includes(needle) ||
    (a.description?.toLocaleLowerCase().includes(needle) ?? false)
  );
}

export interface AchievementsView {
  element: HTMLElement;
  update(data: AchievementsResponse | null, message?: string): void;
  /** Enables or disables the "Find in guide" action (it needs a loaded guide). Default: disabled. */
  setFindEnabled(enabled: boolean): void;
}

export function createAchievementsView(
  doc: Document,
  options: {
    storage?: StorageLike;
    /** Called when the user asks to find an achievement in the guide. */
    onFind?: (achievement: Achievement) => void;
  } = {},
): AchievementsView {
  const storage = options.storage;
  const onFind = options.onFind;
  const element = doc.createElement("section");
  element.classList.add("ach");

  const revealed = new Set<string>();
  const expanded = new Set<string>();
  let lastData: AchievementsResponse | null = null;
  let lastMessage = "";
  let lastGame: string | null = null;
  let unlockedSection: HTMLDetailsElement | null = null;
  let unlockedOpen = false;
  // The user's own choices: unlike the per-game state above, a change of game does not reset them.
  let sortPref = loadSortPref(storage);
  let hideUnlocked = loadHideUnlocked(storage);
  // Per-game, like revealed and expanded; never stored.
  let filter = "";
  let missableOnly = false;
  // Set by the page once a guide is loaded; the action needs one.
  let findEnabled = false;

  const textEl = (tag: string, className: string, text: string): HTMLElement => {
    const el = doc.createElement(tag);
    el.classList.add(className);
    el.textContent = text;
    return el;
  };

  const renderRow = (a: Achievement): HTMLElement => {
    const masked = isMasked(a, revealed);
    const row = doc.createElement("button");
    row.setAttribute("type", "button");
    row.classList.add("ach-row");
    if (expanded.has(a.id)) row.classList.add("expanded");
    row.dataset["id"] = a.id;
    if (!masked && a.icon !== null && a.icon.startsWith("https://")) {
      const img = doc.createElement("img");
      img.setAttribute("src", a.icon);
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
      row.append(img);
    }
    row.append(textEl("span", "ach-name", masked ? "Hidden achievement" : a.name));
    row.append(textEl("span", "ach-desc", masked ? "Tap to reveal" : (a.description ?? "")));
    if (a.missable) row.append(textEl("span", "ach-missable", "Missable"));
    row.append(textEl("span", "ach-pct", a.unlockPercent === null ? "" : `${a.unlockPercent}%`));
    return row;
  };

  const renderFindBar = (a: Achievement): HTMLElement => {
    const bar = doc.createElement("div");
    bar.classList.add("ach-actions");
    const find = doc.createElement("button");
    find.setAttribute("type", "button");
    find.classList.add("ach-find");
    find.textContent = "Find in guide";
    find.addEventListener("click", () => onFind?.(a));
    bar.append(find);
    return bar;
  };

  /** A row, followed by its action bar (a sibling: a button cannot contain a button) when expanded. */
  const renderRows = (list: Achievement[]): HTMLElement[] =>
    list.flatMap((a) => {
      const row = renderRow(a);
      const showBar =
        findEnabled && onFind !== undefined && expanded.has(a.id) && !isMasked(a, revealed);
      return showBar ? [row, renderFindBar(a)] : [row];
    });

  const renderList = (className: string, list: Achievement[]): HTMLElement => {
    const container = doc.createElement("div");
    container.classList.add(className);
    container.append(...renderRows(list));
    return container;
  };

  // The control rows are created once and updated in place by syncControls(): only the lists are
  // rebuilt, so typing keeps its focus, caret and on-screen keyboard through every render.
  const control = (className: string, onClick: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.classList.add(className);
    button.setAttribute("type", "button");
    button.addEventListener("click", onClick);
    return button;
  };

  const keyButton = control("ach-sort-key", () => {
    const next =
      SORT_KEYS[(SORT_KEYS.indexOf(sortPref.key) + 1) % SORT_KEYS.length] ?? DEFAULT_SORT.key;
    sortPref = { key: next, dir: NATURAL_DIR[next] };
    saveSortPref(storage, sortPref);
    render();
  });
  const dirButton = control("ach-sort-dir", () => {
    sortPref = { key: sortPref.key, dir: sortPref.dir === "desc" ? "asc" : "desc" };
    saveSortPref(storage, sortPref);
    render();
  });
  const hideButton = control("ach-hide-unlocked", () => {
    hideUnlocked = !hideUnlocked;
    saveHideUnlocked(storage, hideUnlocked);
    render();
  });
  const missableButton = control("ach-missable-only", () => {
    missableOnly = !missableOnly;
    render();
  });
  missableButton.textContent = "Missable";
  const sortRow = doc.createElement("div");
  sortRow.classList.add("ach-sort");
  sortRow.append(keyButton, dirButton, hideButton);

  const filterInput = doc.createElement("input");
  filterInput.classList.add("ach-filter-input");
  filterInput.setAttribute("type", "search");
  filterInput.setAttribute("placeholder", "Filter achievements");
  filterInput.setAttribute("aria-label", "Filter achievements");
  filterInput.setAttribute("autocomplete", "off");
  filterInput.setAttribute("autocapitalize", "off");
  filterInput.setAttribute("spellcheck", "false");
  filterInput.setAttribute("enterkeyhint", "search");
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    render();
  });
  const clearButton = control("ach-filter-clear", () => {
    filter = "";
    filterInput.value = "";
    render();
    filterInput.focus();
  });
  clearButton.setAttribute("aria-label", "Clear filter");
  clearButton.textContent = "✕";
  clearButton.hidden = true;
  const filterRow = doc.createElement("div");
  filterRow.classList.add("ach-filter");
  filterRow.append(filterInput, clearButton, missableButton);

  const summaryEl = textEl("div", "ach-summary", "");
  const staleEl = textEl("div", "ach-stale", "Showing older data");
  let listNodes: HTMLElement[] = [];

  const syncControls = (hasMissable: boolean, missableActive: boolean): void => {
    const keyLabel = KEY_LABEL[sortPref.key];
    keyButton.textContent = keyLabel;
    keyButton.setAttribute("aria-label", `Sort by: ${keyLabel}`);
    const descending = sortPref.dir === "desc";
    dirButton.textContent = descending ? "↓" : "↑";
    dirButton.setAttribute("aria-label", descending ? "Descending" : "Ascending");
    hideButton.textContent = hideUnlocked ? "Unlocked: hidden" : "Unlocked: shown";
    hideButton.setAttribute("aria-pressed", hideUnlocked ? "true" : "false");
    if (filterInput.value !== filter) filterInput.value = filter;
    clearButton.hidden = filter === "";
    missableButton.hidden = !hasMissable;
    missableButton.setAttribute("aria-pressed", missableActive ? "true" : "false");
  };

  const render = (): void => {
    // Read the section's state before it is replaced. While unlocked achievements are hidden there is
    // no section, so the last remembered state is kept and applies when it comes back.
    if (unlockedSection !== null) unlockedOpen = unlockedSection.open;
    unlockedSection = null;
    for (const node of listNodes) node.remove();
    listNodes = [];
    if (lastData === null) {
      element.replaceChildren(textEl("p", "ach-message", lastMessage));
      return;
    }
    const data = lastData;
    if (sortRow.parentNode !== element) element.replaceChildren(summaryEl, sortRow, filterRow);
    summaryEl.textContent = summaryLine(data);
    if (!data.stale) staleEl.remove();
    else if (staleEl.parentNode !== element) element.insertBefore(staleEl, sortRow);
    // The option applies only while the data has a missable achievement; the choice itself is kept.
    const hasMissable = data.achievements.some((a) => a.missable);
    const missableActive = missableOnly && hasMissable;
    syncControls(hasMissable, missableActive);

    const masked = (a: Achievement): boolean => isMasked(a, revealed);
    const listed = (unlocked: boolean): Achievement[] =>
      sortAchievements(
        data.achievements.filter(
          (a) =>
            a.unlocked === unlocked &&
            (!missableActive || a.missable) &&
            matchesFilter(a, filter, masked(a)),
        ),
        sortPref,
        masked,
      );
    const filtering = filter.trim() !== "";
    const locked = listed(false);
    const showUnlocked = !hideUnlocked && !missableActive;
    const unlocked = showUnlocked ? listed(true) : [];

    if ((filtering || missableActive) && locked.length === 0 && unlocked.length === 0) {
      listNodes.push(
        textEl(
          "p",
          "ach-empty",
          filtering ? "No matching achievements" : "No missable achievements left",
        ),
      );
    } else {
      if (showUnlocked && !filtering) {
        listNodes.push(renderList("ach-recent", recentUnlocks(data.achievements)));
      }
      listNodes.push(renderList("ach-locked", locked));
      if (showUnlocked) {
        const details = doc.createElement("details");
        details.classList.add("ach-unlocked");
        details.open = unlockedOpen;
        unlockedSection = details;
        const summary = doc.createElement("summary");
        summary.textContent = `Unlocked (${unlocked.length})`;
        details.append(summary, ...renderRows(unlocked));
        listNodes.push(details);
      }
    }
    element.append(...listNodes);
  };

  element.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest(".ach-actions") !== null) return;
    const row = target.closest<HTMLElement>(".ach-row");
    const id = row?.dataset["id"];
    if (row === null || id === undefined || lastData === null) return;
    const achievement = lastData.achievements.find((a) => a.id === id);
    if (achievement !== undefined && isMasked(achievement, revealed)) {
      revealed.add(id);
    } else if (!expanded.delete(id)) {
      expanded.add(id);
    }
    render();
  });

  return {
    element,
    update(data, message = "") {
      if (data !== null) {
        const game = `${data.source}:${data.id}`;
        if (game !== lastGame) {
          revealed.clear();
          expanded.clear();
          unlockedOpen = false;
          unlockedSection = null;
          filter = "";
          missableOnly = false;
          lastGame = game;
        }
      }
      lastData = data;
      lastMessage = message;
      render();
    },
    setFindEnabled(enabled) {
      findEnabled = enabled;
      if (lastData !== null) render();
    },
  };
}
