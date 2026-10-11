import curated from './rules.curated.json'
import type { AchievementRule } from '../model'
// Oak species/group validation is knowledge-only. Badge/Champion execution gates remain sourced.
export const rules: AchievementRule[] = curated as AchievementRule[]
