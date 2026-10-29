import type { Achievement, AchievementGroup } from "../shared/types.js";

/**
 * Splits a list (already filtered and sorted) by group, in the order of `groups`, keeping each
 * group's share in list order. An achievement with no group, or one `groups` does not list,
 * counts as the first (base) group's.
 */
export function partitionByGroup(
  groups: readonly AchievementGroup[],
  list: readonly Achievement[],
): Map<string, Achievement[]> {
  const parts = new Map<string, Achievement[]>(groups.map((g) => [g.key, []]));
  const first = groups[0]?.key;
  for (const a of list) {
    const part = (a.group !== undefined ? parts.get(a.group) : undefined) ?? parts.get(first ?? "");
    part?.push(a);
  }
  return parts;
}

/**
 * A group's header: its name, a DLC tag for a DLC, and its own `unlocked/total`. A heading, so a
 * screen reader can move from group to group; not tappable.
 */
export function renderGroupHead(doc: Document, group: AchievementGroup): HTMLElement {
  const head = doc.createElement("h3");
  head.classList.add("ach-group-head");
  const part = (className: string, text: string): HTMLElement => {
    const el = doc.createElement("span");
    el.classList.add(className);
    el.textContent = text;
    return el;
  };
  head.append(part("ach-group-name", group.name));
  if (group.dlc) head.append(part("ach-group-dlc", "DLC"));
  head.append(part("ach-group-count", `${group.unlocked}/${group.total}`));
  return head;
}
