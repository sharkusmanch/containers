// Regressions against independently decoded public bytes, not runtime/session proof.
// Catches accepting corrupt archives, trusting stale storage, losing live boxes,
// inventing story/HoF from Dex/badges, partial-as-empty, and modifying source bytes.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRedSave } from '../src/save/parse'
import type { Fact } from '../src/model'
import catalogue from './fixtures/online-save-catalogue.json'

function value<T>(fact: Fact<T>): T {
  if (!fact.known) throw new Error(fact.reason)
  return fact.value
}

for (const fixture of catalogue.fixtures) {
  const path = `test/fixtures/private/${fixture.file}`
  describe.skipIf(!existsSync(path))(`optional independent public fixture: ${fixture.file}`, () => {
    it('preserves the original SHA256 and applies independent integrity/field expectations', () => {
      const bytes = new Uint8Array(readFileSync(path)), before = bytes.slice()
      const sha = () => createHash('sha256').update(bytes).digest('hex')
      expect(bytes.length).toBe(fixture.sizeBytes)
      expect(sha()).toBe(fixture.sha256)
      const result = parseRedSave(bytes)
      expect(bytes).toEqual(before)
      expect(sha()).toBe(fixture.sha256)

      if (fixture.sizeBytes !== 32768) {
        expect(result).toMatchObject({ status: 'rejected', issues: [{ code: 'unsupported-size' }] })
        expect(result).not.toHaveProperty('snapshot')
        return
      }
      const facts = fixture.independentFacts!
      if (facts.archivesInitialized && facts.archiveBoxes.some(box => !box.checksumValid)) {
        expect(result).toMatchObject({ status: 'rejected', issues: [{ code: 'archive-checksum' }] })
        expect(result).not.toHaveProperty('snapshot')
        return
      }
      expect(result.status).toBe('partial') // A HoF count never proves unchecked bank-zero history.
      if (result.status === 'rejected') throw new Error('Expected independently valid main/archive integrity')
      const s = result.snapshot
      expect(value(s.badgeMask)).toBe(facts.badgeMask)
      expect(value(s.battleStyle)).toBe(facts.battleStyle)
      expect(value(s.ownedDex)).toHaveLength(facts.ownedDexCount)
      expect(value(s.seenDex)).toHaveLength(facts.seenDexCount)
      expect(value(s.location).mapId).toBe(facts.mapId)
      expect(s.playTimeRaw).toEqual(facts.playtimeRaw)
      expect(s.rawCounts?.hallOfFame).toBe(facts.hallOfFameCount)
      expect(s.hallOfFame.known).toBe(false)
      expect(value(s.daycare)).toBeNull()
      expect(s.rawCounts?.daycare).toBe(facts.daycareOccupancy)
      expect(value(s.party)).toHaveLength(facts.partyCount)
      expect(value(s.party).map(p => ({ rawSpecies: p.internalSpeciesId, dexNumber: p.dexNumber,
        level: value(p.level), actualSpecial: value(p.special) }))).toEqual(facts.party)
      expect(value(s.currentBox).index).toBe(facts.currentBoxIndex)
      expect(value(s.currentBox).pokemon).toHaveLength(facts.liveBoxCount)
      if (facts.archivesInitialized) {
        expect(value(s.archivedBoxes).map(box => ({ index: box.index, count: box.pokemon.length })))
          .toEqual(facts.archiveBoxes.filter(box => !box.activeArchive).map(box => ({ index: box.index, count: box.count })))
        expect(value(s.archivedBoxes).some(box => box.index === facts.currentBoxIndex)).toBe(false)
      } else expect(s.archivedBoxes.known).toBe(false)
      expect(value(s.events)).toMatchObject(facts.selectedEvents)
      expect(s.pcItems.known).toBe(facts.pcItemCountValid)
      if (!facts.pcItemCountValid) expect(result.issues).toContainEqual(expect.objectContaining({ code: 'list-count', section: 'pcItems' }))
    })
  })
}
