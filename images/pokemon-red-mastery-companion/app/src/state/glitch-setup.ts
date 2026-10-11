import type { Attempt, Fact, GlitchSetupIdentity, ManualEvidence, PokemonObservation, SaveSnapshot } from '../model'

export const glitchSetupKey = 'glitch:encounter-setup'
export type GlitchSetupDescriptor = Omit<GlitchSetupIdentity, 'setupId' | 'generation'>
const integer = (value: unknown, low: number, high: number): value is number =>
 typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high

/** Pure shared decoder; manual strings do not become bindings without valid typed metadata. */
export function parseGlitchSetup(value: boolean | number | string): GlitchSetupDescriptor | null {
 if (typeof value !== 'string') return null
 try {
  const data = JSON.parse(value) as Partial<GlitchSetupDescriptor> | null
  if (!data || typeof data !== 'object') return null
  const donor = data.donor
  if (typeof data.methodId !== 'string' || !['ordinary-trainer-fly', 'pc-underflow'].includes(data.transport ?? '') ||
      !integer(data.sourceRevision, 0, Number.MAX_SAFE_INTEGER - 2) || !integer(data.successfulGrowls, 0, 6) ||
      !['ready', 'blocked', 'unknown'].includes(data.preflightReadiness ?? '') || !donor ||
      !integer(donor.slot, 1, 6) || !integer(donor.internalSpeciesId, 1, 255) || !integer(donor.special, 0, 65535)) return null
  return { methodId: data.methodId, transport: data.transport!, sourceRevision: data.sourceRevision,
   successfulGrowls: data.successfulGrowls, preflightReadiness: data.preflightReadiness!,
   donor: { slot: donor.slot, internalSpeciesId: donor.internalSpeciesId, special: donor.special } }
 } catch { return null }
}

/** Signature excludes PP, trainer flags and the snapshot hash, which legitimately change during setup. */
export function glitchDonorMatches(snapshot: SaveSnapshot | null, donor: GlitchSetupDescriptor['donor']): boolean {
 return !!snapshot?.party.known && snapshot.party.value.some(p => p.location.kind === 'party' &&
  p.location.slot === donor.slot && p.internalSpeciesId === donor.internalSpeciesId &&
  p.special.known && p.special.value === donor.special)
}

/** Backups/context changes retain history but cannot restore a live pending battle. */
export function reviewGlitchSetup(attempt: Attempt): Attempt {
 const latest = attempt.manualEvidence.filter(record => record.key === glitchSetupKey).at(-1)
 if (!latest || latest.status !== 'active') return attempt
 return { ...attempt, manualEvidence: attempt.manualEvidence.map(record =>
  record.id === latest.id ? { ...record, status: 'needs-review' } : record) }
}

/** Current first-slot Mew is a save observation, never proof of a catch or level transition. */
export function firstSlotMew(snapshot: SaveSnapshot | null): Fact<PokemonObservation | null> {
 if (!snapshot?.party.known) return {known:false,reason:'Observe the current first party slot for the Mew EXP step.'}
 const first=snapshot.party.value.find(p=>p.location.kind==='party'&&p.location.slot===1)
 if(first?.dexNumber===null)return {known:false,reason:'First-slot species is unreadable.'}
 return {known:true,value:first?.internalSpeciesId===21&&first.dexNumber===151?first:null}
}

/** Preserve a completed encounter's attributed continuation, or only the controls for a compatible catch. */
export function mewContinuation(attempt: Attempt, start: ManualEvidence, snapshot: SaveSnapshot | null): 'none' | 'catch-compatible' | 'attributed-catch' {
 const setup=parseGlitchSetup(start.value)
 const eligible=(record:ManualEvidence)=>record.status==='active'&&record.attemptId===attempt.id&&record.continuityRevision===attempt.continuityRevision
 if(!eligible(start)||!setup||setup.methodId!=='candidate-57642'||setup.donor.special!==21||setup.successfulGrowls!==6||
    setup.preflightReadiness!=='ready'||setup.sourceRevision!==attempt.source.revision)return 'none'
 const scope=`glitch:encounter:${start.id}`
 const records=attempt.manualEvidence.slice(attempt.manualEvidence.indexOf(start)+1).filter(eligible)
 const value=(key:string)=>records.filter(r=>r.key===`${scope}:${key}`).at(-1)?.value
 const pending=records.some(r=>r.key===`${scope}:phase`&&r.value==='pending')
 if(!pending||value('transform-confirmed')!==true||value('neutral-attack-stage')!==true||
    value('successful-growls')!==6||value('no-intervening-encounter')!==true)return 'none'
 if(setup.transport==='ordinary-trainer-fly'&&(value('trainer-escaped')!==true||value('menus-restored')!==true))return 'none'
 if(setup.transport==='pc-underflow'&&value('pc-underflow-setup')!==true)return 'none'
 if(value('phase')==='exp'&&value('mew-caught-level-one')===true)return 'attributed-catch'
 const mew=firstSlotMew(snapshot)
 const donorElsewhere=snapshot?.party.known&&snapshot.party.value.some(p=>p.location.kind==='party'&&p.location.slot!==setup.donor.slot&&
  p.internalSpeciesId===setup.donor.internalSpeciesId&&p.special.known&&p.special.value===setup.donor.special)
 // This compatibility preserves history/control only. It does not establish the catch or advance the phase.
 return mew.known&&mew.value?.level.known&&mew.value.level.value===1&&donorElsewhere?'catch-compatible':'none'
}
