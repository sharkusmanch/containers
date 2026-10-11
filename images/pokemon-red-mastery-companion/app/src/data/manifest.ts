import type { AchievementSet, Dataset } from '../model'
import setMembership from './sets.json'
import { game } from './game'
import { rules } from './rules'
import { route } from './route'
import { glitches } from './glitches'
import { areas } from './areas'
export const dataset: Dataset = {
  manifest: {
    version: '2026-10-11.1', publishedCheckedAt: '2026-10-11', sourceCommit: game.sourceCommit,
    sources: [
      { url: 'https://github.com/pret/pokered/tree/' + game.sourceCommit, purpose: 'Pinned factual disassembly; reproducible extraction.' },
      { url: 'https://github.com/RetroAchievements/guides/wiki/Pokemon-Red-Version-%28Game-Boy%29', purpose: 'Original RA main-set guide; rewritten instruction summaries.' },
      { url: 'https://retroachievements.org/game/724', purpose: 'Published membership checked against all three authenticated API game feeds.' },
    ],
    runtimePrerequisites: [
      { id: 'target-core', status: 'pending', description: 'Record emulator version, core name/version, hardcore configuration and exact supported Red ROM hash.' },
      { id: 'supported-rom', status: 'pending', description: 'Public supported MD5 3d45c1ee9abd5738df46d2bdda8b57dc; compare the actual target ROM before runtime validation.' },
      { id: 'hardcore-subsets', status: 'pending', description: 'Demonstrate main, Oak and Glitch sets actually loaded in hardcore on the target emulator; authenticated IDs/counts alone do not prove loaded sets.' },
      { id: 'safari-trigger', status: 'pending', description: 'Audit current decoded 108045 trigger enumeration and reset boundaries or perform a controlled test; physical source has eleven optional objects.' },
      { id: 'reader-fixtures', status: 'pending', description: 'Obtain independently checked real battery-save fixtures for initial, Brock, initialized/live box, Safari/Koga, Silph, postgame and glitch states.' },
      { id: 'glitch-runtime', status: 'pending', description: 'Validate each sourced candidate procedure, recovery boundary and hardcore award on the target emulator/core.' },
    ],
  },
  sets: setMembership as AchievementSet[], game, rules, route, glitches, areas,
}
