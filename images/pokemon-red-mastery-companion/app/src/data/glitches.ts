import curated from './glitches.curated.json'
import type { GlitchMethod } from '../model'
export const glitches: GlitchMethod[] = curated as GlitchMethod[]
