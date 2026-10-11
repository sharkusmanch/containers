import { describe, expect, it } from 'vitest'
import { dataset } from '../src/data/manifest'
import { evaluateOakCheckpoint } from '../src/planner/readiness'
import { brock, mistyAdded, kogaAdded, erikaAdded, known, pokemon, snapshot, unknown } from './planner-fixtures'
import type { BranchChoices } from '../src/model'

const choices: BranchChoices = { starter: 'bulbasaur', eevee: 'vaporeon', dojo: 'hitmonlee', fossil: 'helix', moonstones: [31,34] }
const preBrock = [...brock,1,2,3]
const preMisty = [...preBrock,...mistyAdded,31,34]
const preKoga = [...preMisty,...kogaAdded,36,40,134,106]
const preErika = [...preKoga,...erikaAdded,138,139]
const preSurge = [...preErika,144]
// Breaks caught: accepting counts without exact species, wrong badge order, wrong selected line.
describe('exact Oak checkpoint preparation', () => {
  it.each([
    ['brock',preBrock,0,21], ['misty',preMisty,1,47], ['koga',preKoga,3,105], ['erika',preErika,19,121],
    ['surge',preSurge,27,122], ['sabrina',preSurge,31,122], ['blaine',preSurge,63,122], ['giovanni',preSurge,127,122],
  ] as const)('requires the complete natural collection before %s', (id, dex, badges, count) => {
    const result = evaluateOakCheckpoint(snapshot([...dex],badges),id,choices,dataset)
    expect(result.readiness).toBe('ready'); expect(result.requiredCount).toBe(count); expect(result.missingDex).toEqual([])
    for (const missing of dex) {
      const wrong = snapshot([...dex.filter(n => n !== missing),151],badges)
      expect(evaluateOakCheckpoint(wrong,id,choices,dataset).readiness,`substituting #${missing} before ${id}`).toBe('blocked')
    }
    expect(evaluateOakCheckpoint(snapshot([...dex.slice(1),151],badges),id,choices,dataset).missingDex).toContain(10)
  })
  it.each([
    [{starter:'charmander'},[4,5,6],134,106,[138,139]],
    [{starter:'squirtle',eevee:'jolteon',dojo:'hitmonchan',fossil:'dome'},[7,8,9],135,107,[140,141]],
    [{eevee:'flareon'},[1,2,3],136,106,[138,139]],
  ] as const)('honors chosen alternatives %j', (branch, starter, eevee, dojo, fossil) => {
    const ids = [...brock,...starter,...mistyAdded,...kogaAdded,31,34,36,40,eevee,dojo,...erikaAdded,...fossil,144]
    expect(evaluateOakCheckpoint(snapshot(ids,27),'surge',{...choices,...branch},dataset).readiness).toBe('ready')
    expect(evaluateOakCheckpoint(snapshot(preSurge,27),'surge',{...choices,starter:'squirtle'},dataset).readiness).toBe('blocked')
  })
  it('accepts any two distinct Misty Moon Stone entries but no duplicate substitute', () => {
    const s = snapshot([...preBrock,...mistyAdded,36,40],1)
    expect(evaluateOakCheckpoint(s,'misty',{starter:'bulbasaur'},dataset).readiness).toBe('ready')
    s.ownedDex=known([...preBrock,...mistyAdded,36,36])
    expect(evaluateOakCheckpoint(s,'misty',choices,dataset).readiness).toBe('blocked')
  })
  it('registration does not require holding every historical species', () => {
    const s=snapshot(preBrock); s.currentBox=unknown; s.archivedBoxes=unknown; s.daycare=unknown
    expect(evaluateOakCheckpoint(s,'brock',choices,dataset).readiness).toBe('ready')
  })
  it('cannot use unreadable Dex, missing choice, or null save as readiness', () => {
    const s=snapshot(preBrock); s.ownedDex=unknown
    expect(evaluateOakCheckpoint(s,'brock',choices,dataset).readiness).toBe('unknown')
    expect(evaluateOakCheckpoint(snapshot(preBrock),'brock',{},dataset).readiness).toBe('unknown')
    expect(evaluateOakCheckpoint(null,'brock',choices,dataset).readiness).toBe('unknown')
  })
  it('checks every party level before gym entry, permitting boxed grinders', () => {
    const s=snapshot(preBrock); s.currentBox=known({index:0,pokemon:[{...pokemon(3,100),location:{kind:'box',index:0,slot:1}}]})
    expect(evaluateOakCheckpoint(s,'brock',choices,dataset).readiness).toBe('ready')
    s.party=known([pokemon(1),pokemon(12,15)])
    expect(evaluateOakCheckpoint(s,'brock',choices,dataset).readiness).toBe('blocked')
    s.party=unknown
    expect(evaluateOakCheckpoint(s,'brock',choices,dataset).readiness).toBe('unknown')
  })
  it('checks Set mode, detects defeated leaders, and enforces canonical order', () => {
    const s=snapshot(preKoga,3); s.battleStyle=known('shift')
    expect(evaluateOakCheckpoint(s,'koga',choices,dataset).readiness).toBe('blocked')
    s.battleStyle=known('set'); s.badgeMask=known(7)
    expect(evaluateOakCheckpoint(s,'koga',choices,dataset).readiness).toBe('blocked')
    s.badgeMask=known(19)
    expect(evaluateOakCheckpoint(s,'koga',choices,dataset).readiness).toBe('missed')
  })
})
