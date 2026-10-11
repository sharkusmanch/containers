import curated from './areas.curated.json'
import type { AreaChecklist } from '../model'
/** Pinned physical source checklists; docs/route-evidence.md explains semantic exclusions. */
export const areas = curated as AreaChecklist[]
