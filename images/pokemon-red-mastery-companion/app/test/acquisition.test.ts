import { describe, expect, it } from 'vitest'
import { dataset } from '../src/data/manifest'
import { planAcquisitions } from '../src/planner/acquisition'
import { brock, mistyAdded, kogaAdded, erikaAdded, known, pokemon, snapshot, unknown } from './planner-fixtures'

// Breaks caught: registration used as fodder, stale archive inclusion, missing-resource readiness.
describe('observed acquisition resources', () => {
  it('keeps registered traded-away species separate from held trade fodder', () => {
    const s=snapshot([63],1); s.party=known([])
    const result=planAcquisitions(s,[63,122],dataset)
    expect(result.alreadyRegistered).toEqual([63]); expect(result.targets[0]?.heldInstances).toEqual([])
    expect(result.targets[1]?.paths[0]).toMatchObject({method:'trade',sourceDex:63,readiness:'blocked'})
    expect(result.targets[1]?.missingResources.join(' ')).toMatch(/Abra/)
    expect(result.targets[1]?.paths[0]?.instructions.join(' ')).toMatch(/Route24|Route25/)
  })
  it('uses live box and other initialized archives, excluding the superseded active archive', () => {
    const s=snapshot([],1); s.party=known([])
    s.currentBox=known({index:0,pokemon:[{...pokemon(63),location:{kind:'box',index:0,slot:1}}]})
    s.archivedBoxes=known([{index:0,pokemon:[pokemon(21)]},{index:1,pokemon:[{...pokemon(80),location:{kind:'box',index:1,slot:1}}]}])
    const result=planAcquisitions(s,[63,21,80,122],dataset)
    expect(result.targets.map(t=>t.heldInstances.length)).toEqual([1,0,1,0])
    expect(result.targets[3]?.paths[0]?.readiness).toBe('unknown') // trade flag not observed
  })
  it('does not infer absent donors from uninitialized or unreadable storage', () => {
    const s=snapshot([63],1); s.party=known([]); s.archivedBoxes={known:false,reason:'Archived boxes have not been initialized.'}
    const result=planAcquisitions(s,[122],dataset)
    expect(result.targets[0]?.paths[0]?.readiness).toBe('unknown')
    expect(result.diagnostics.join(' ')).toMatch(/not been initialized/)
  })
  it('requires an observed source instance and preserves daycare level uncertainty', () => {
    const s=snapshot([10]); s.party=known([]); s.daycare=known({...pokemon(10),location:{kind:'daycare'},level:unknown})
    const result=planAcquisitions(s,[11],dataset)
    expect(result.targets[0]?.paths[0]).toMatchObject({method:'evolve',sourceDex:10,level:7,readiness:'unknown'})
  })
  it('allocates a finite Moon Stone inventory across missing evolutions', () => {
    const s=snapshot([],1); s.party=known([pokemon(30),pokemon(33)]); s.bag=known([{position:1,rawItemId:10,quantity:1}])
    const result=planAcquisitions(s,[31,34],dataset)
    expect(result.targets[0]?.paths[0]?.readiness).toBe('ready')
    expect(result.targets[1]?.paths[0]?.readiness).toBe('blocked')
    expect(result.missingResources.join(' ')).toMatch(/Moon Stone/)
    s.pcItems=unknown
    expect(planAcquisitions(s,[31,34],dataset).targets[1]?.paths[0]?.readiness).toBe('unknown')
  })
  it('cannot promise two Eevee evolutions from one held Eevee', () => {
    const s=snapshot([],3); s.party=known([pokemon(133)]); s.bag=known([{position:1,rawItemId:34,quantity:1},{position:2,rawItemId:33,quantity:1}])
    const result=planAcquisitions(s,[134,135],dataset)
    expect(result.targets[0]?.paths[0]?.readiness).toBe('ready')
    expect(result.targets[1]?.paths[0]?.readiness).toBe('blocked')
  })
  it('requires available rods and defers Seafoam/Surf until the appropriate badge phases', () => {
    const s=snapshot([],3)
    const result=planAcquisitions(s,[54,72,116,120,144,145],dataset)
    expect(result.targets.slice(0,4).map(t=>t.paths[0]?.readiness)).toEqual(['blocked','blocked','blocked','blocked'])
    expect(result.targets[0]?.paths[0]?.area).toBe('CERULEAN_CITY')
    expect(result.targets.slice(4).map(t=>t.paths[0]?.method)).toEqual(['unavailable','unavailable'])
    s.bag=known([...s.bag.known?s.bag.value:[],{position:2,rawItemId:78,quantity:1}])
    expect(planAcquisitions(s,[54],dataset).targets[0]?.paths[0]?.readiness).toBe('ready')
  })
  it('keeps unknown Dex/phase explicit and does not invent Red-exclusive availability', () => {
    const s=snapshot(); s.ownedDex=unknown; s.badgeMask=unknown
    const result=planAcquisitions(s,[10,69],dataset)
    expect(result.targets[0]?.registered.known).toBe(false)
    expect(result.targets[0]?.paths[0]?.readiness).toBe('unknown')
    expect(planAcquisitions(snapshot([],3),[69],dataset).targets[0]?.paths[0]?.method).toBe('unavailable')
    expect(planAcquisitions(null,[10],dataset).targets[0]?.paths[0]?.readiness).toBe('unknown')
  })
  it('uses current Cave access rather than the transient Champion event cleared by Hall of Fame', () => {
    const earlier123=[...brock,1,2,3,...mistyAdded,...kogaAdded,...erikaAdded,31,34,36,40,134,106,138,139,144,146]
    const s=snapshot(earlier123,255); s.events=known({EVENT_BEAT_CHAMPION_RIVAL:false}); s.objectFlags=known({TOGGLE_CERULEAN_CAVE_GUY:true})
    expect(planAcquisitions(s,[150],dataset).targets[0]?.paths[0]?.method).toBe('static')
    s.objectFlags=unknown; s.events=known({EVENT_BEAT_CHAMPION_RIVAL:true})
    expect(planAcquisitions(s,[150],dataset).targets[0]?.paths[0]?.readiness).toBe('unknown')
  })
  it('uses current status flags for one-time starter and Lapras availability', () => {
    const s=snapshot([],3); s.statusFlags=known({'wStatusFlags4:3':true,'wStatusFlags4:0':true})
    expect(planAcquisitions(s,[7,131],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['blocked','blocked'])
  })
  it('defers Mewtwo until 123 earlier registrations rather than substituting its entry', () => {
    const s=snapshot([],255); s.objectFlags=known({TOGGLE_CERULEAN_CAVE_GUY:true})
    expect(planAcquisitions(s,[150],dataset).targets[0]?.paths[0]?.readiness).toBe('blocked')
    s.ownedDex=unknown
    expect(planAcquisitions(s,[150],dataset).targets[0]?.paths[0]?.readiness).toBe('unknown')
  })
  it('honors one-time NPC trade flags independently from registration', () => {
    const s=snapshot([63],1); s.party=known([pokemon(63)]); s.tradeFlags=known({1:false})
    expect(planAcquisitions(s,[122],dataset).targets[0]?.paths[0]?.readiness).toBe('ready')
    s.tradeFlags=known({1:true})
    expect(planAcquisitions(s,[122],dataset).targets[0]?.paths[0]?.readiness).toBe('blocked')
  })
  it('requires the Flute for Snorlax and Scope for Tower catches', () => {
    const s=snapshot([],3)
    expect(planAcquisitions(s,[92],dataset).targets[0]?.paths[0]?.readiness).toBe('blocked')
    expect(planAcquisitions(s,[143],dataset).missingResources.join(' ')).toMatch(/Flute/)
  })
  it('does not tell players to redo completed dependency catches when a donor is held', () => {
    const s=snapshot([30],1); s.party=known([pokemon(30)]); s.bag=known([{position:1,rawItemId:10,quantity:1}])
    const result=planAcquisitions(s,[31],dataset)
    expect(result.targets[0]?.paths[0]?.instructions.join(' ')).not.toMatch(/Catch Nidoran/)
  })
  it('suppresses acquisition work for a target already registered and held', () => {
    const s=snapshot([10]); s.party=known([pokemon(10)])
    expect(planAcquisitions(s,[10],dataset).targets[0]?.paths).toEqual([])
  })
  it('requires Surf travel resources for Cinnabar NPC trades even with a held donor', () => {
    const s=snapshot([77],19); s.party=known([pokemon(77)]); s.tradeFlags=known({3:false})
    const missing=planAcquisitions(s,[86],dataset).targets[0]!
    expect(missing.paths[0]).toMatchObject({method:'trade',sourceDex:77,readiness:'blocked'})
    expect(missing.missingResources.join(' ')).toMatch(/Hm03|surf/i)
    s.bag=unknown; s.archivedBoxes=unknown
    expect(planAcquisitions(s,[86],dataset).targets[0]?.paths[0]?.readiness).toBe('unknown')
    s.bag=known([{position:1,rawItemId:198,quantity:1}]); s.archivedBoxes=known([])
    s.party=known([pokemon(77),{...pokemon(61),moves:known([{id:57,pp:15,ppUps:0}])}])
    expect(planAcquisitions(s,[86],dataset).targets[0]?.paths[0]?.readiness).toBe('ready')
  })
  it('cannot reuse a traded-away Surf carrier for subsequent Power Plant travel', () => {
    const s=snapshot([61],19); s.party=known([{...pokemon(61),moves:known([{id:57,pp:15,ppUps:0}])}])
    s.tradeFlags=known({6:false}); s.bag=known([{position:1,rawItemId:198,quantity:1},{position:2,rawItemId:4,quantity:2}])
    expect(planAcquisitions(s,[124,81],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','blocked'])
    s.archivedBoxes=unknown
    expect(planAcquisitions(s,[124,81],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','unknown'])
    s.archivedBoxes=known([])
    s.currentBox=known({index:0,pokemon:[{...pokemon(131),location:{kind:'box',index:0,slot:1},moves:known([{id:57,pp:15,ppUps:0}])}]})
    expect(planAcquisitions(s,[124,81],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','ready'])
  })
  it('retains observed Surf through a planned stone evolution before Power Plant travel', () => {
    const s=snapshot([61],19); s.party=known([{...pokemon(61),moves:known([{id:57,pp:15,ppUps:0}])}])
    s.bag=known([{position:1,rawItemId:34,quantity:1},{position:2,rawItemId:198,quantity:1},{position:3,rawItemId:4,quantity:1}])
    const before=structuredClone(s)
    const result=planAcquisitions(s,[62,81],dataset)
    expect(result.targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','ready'])
    expect(result.targets[0]?.paths[0]).toMatchObject({method:'evolve',sourceDex:61,rawItemId:34})
    expect(s).toEqual(before)
    expect(result.targets[0]?.heldInstances).toEqual([]) // planned Poliwrath is not an observed instance
    s.party=known([{...pokemon(61),moves:unknown}])
    expect(planAcquisitions(s,[62,81],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','unknown'])
  })
  it.each([[115,'SafariZoneEast'],[113,'SafariZoneNorth']] as const)('uses Safari supply rather than ordinary balls for #%i at %s', (dex,area) => {
    const s=snapshot([],3); s.bag=known([{position:1,rawItemId:78,quantity:1}])
    const result=planAcquisitions(s,[dex],dataset).targets[0]!
    expect(result.paths[0]).toMatchObject({method:'catch',area,readiness:'unknown'})
    expect(result.missingResources.join(' ')).toMatch(/Safari.*(supply|hunt|entry)/i)
    expect(result.missingResources.join(' ')).not.toMatch(/Poké Balls are required/)
  })
  it('allocates at least one capture ball per missing ordinary catch in target order', () => {
    const s=snapshot(); s.bag=known([{position:1,rawItemId:4,quantity:1}])
    expect(planAcquisitions(s,[10,13],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','blocked'])
    s.pcItems=unknown
    expect(planAcquisitions(s,[10,13],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','unknown'])
    s.pcItems=known([{position:1,rawItemId:3,quantity:1}])
    expect(planAcquisitions(s,[10,13,21],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','ready','blocked'])
    s.bag=known([{position:1,rawItemId:4,quantity:2}])
    expect(planAcquisitions(s,[10,13,21],dataset).targets.map(t=>t.paths[0]?.readiness)).toEqual(['ready','ready','ready'])
  })
})
