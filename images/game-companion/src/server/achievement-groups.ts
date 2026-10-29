import type { Achievement, AchievementGroup } from "../shared/types.js";

/** A group as a platform names it, before its achievements are counted. */
export interface GroupDef {
  key: string;
  name: string;
  dlc: boolean;
}

export interface Grouped {
  achievements: Achievement[];
  groups: AchievementGroup[];
}

/**
 * Tags each achievement with its group (`keys[i]` for `achievements[i]`; a key `defs` does not
 * list counts as the first, base, group) and counts every group, in the order of `defs`. Null
 * unless at least two groups have an achievement: a game without DLC achievements keeps the
 * ungrouped shape. Empty groups are dropped, and a key listed twice keeps its first place.
 */
export function groupAchievements(
  achievements: Achievement[],
  keys: readonly string[],
  defs: readonly GroupDef[],
): Grouped | null {
  const base = defs[0];
  if (base === undefined) return null;
  const counts = new Map(defs.map((d) => [d.key, { total: 0, unlocked: 0 }]));
  const tagged = achievements.map((a, i) => {
    const wanted = keys[i];
    const key = wanted !== undefined && counts.has(wanted) ? wanted : base.key;
    const count = counts.get(key);
    if (count) {
      count.total += 1;
      if (a.unlocked) count.unlocked += 1;
    }
    return { ...a, group: key };
  });
  const groups: AchievementGroup[] = [];
  for (const d of defs) {
    const count = counts.get(d.key);
    if (count && count.total > 0 && !groups.some((g) => g.key === d.key))
      groups.push({ ...d, ...count });
  }
  return groups.length >= 2 ? { achievements: tagged, groups } : null;
}
