import facts from './pokered.generated.json'
import type { GameData } from '../model'
// Oak-used methods independently matched to pinned raw ASM; scope/evidence: docs/oak-validation.md.
export const game: GameData = facts as GameData
