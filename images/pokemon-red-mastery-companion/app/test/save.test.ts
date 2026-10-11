import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { Fact, ParseResult } from '../src/model'
import { parseRedSave } from '../src/save/parse'

function known<T>(fact: Fact<T>): T {
  if (!fact.known) throw new Error(fact.reason)
  return fact.value
}
function snapshot(result: ParseResult) {
  expect(result.status).not.toBe('rejected')
  if (result.status === 'rejected') throw new Error('Rejected fixture')
  return result.snapshot
}
function fixture(name: string) { return new Uint8Array(readFileSync(`test/fixtures/private/${name}`)) }
// Defensive-test SRAM, not an emulator capture. Independent test checksum algorithm.
function seal(b: Uint8Array, start = 0x2598, end = 0x3523) {
  let sum = 0
  for (let i = start; i < end; i++) sum += b[i]!
  b[end] = 255 - sum % 256
  return b
}
function defensive() {
  const b = new Uint8Array(32768)
  b.set([0x80, 0x50], 0x2598)
  b[0x25ca] = b[0x27e7] = b[0x2f2d] = b[0x30c1] = 255
  return seal(b)
}
function archives(b: Uint8Array) {
  b[0x284c] = 128
  for (const bank of [0x4000, 0x6000]) {
    for (let i = 0; i < 6; i++) {
      b[bank + i * 0x462 + 1] = 255
      let sum = 0
      for (let j = 0; j < 0x462; j++) sum += b[bank + i * 0x462 + j]!
      b[bank + 0x1a4d + i] = 255 - sum % 256
    }
    seal(b, bank, bank + 0x1a4c)
  }
  return seal(b)
}

describe('bounded read-only defensive-test saves', () => {
  it('reads empty main observations without inventing archived ownership', () => {
    const s = snapshot(parseRedSave(defensive()))
    expect(known(s.party)).toEqual([])
    expect(known(s.ownedDex)).toEqual([])
    expect(s.archivedBoxes.known).toBe(false)
    expect(known(s.hallOfFame)).toBe(false)
  })
  it.each([0, 100, 32767, 32769])('rejects unsupported byte length %i', length => {
    expect(parseRedSave(new Uint8Array(length))).toMatchObject({ status: 'rejected', issues: [{ code: 'unsupported-size' }] })
  })
  it('rejects checksum failure with no replacement snapshot', () => {
    const b = defensive(); b[0x2602] = 1
    expect(parseRedSave(b)).toMatchObject({ status: 'rejected', issues: [{ code: 'main-checksum' }] })
    expect(parseRedSave(b)).not.toHaveProperty('snapshot')
  })
  it.each(['aggregate', 'individual'])('rejects applicable initialized archive %s failure', kind => {
    const b = archives(defensive())
    b[kind === 'aggregate' ? 0x5a4c : 0x7a50] ^= 1
    expect(parseRedSave(b)).toMatchObject({ status: 'rejected', issues: [{ code: 'archive-checksum' }] })
    expect(parseRedSave(b)).not.toHaveProperty('snapshot')
  })
  it('ignores archive failures when archives have never been initialized', () => {
    const b = archives(defensive()); b[0x284c] = 0; b[0x5a4c] ^= 1; seal(b)
    expect(snapshot(parseRedSave(b)).archivedBoxes.known).toBe(false)
  })
  it.each([[0x2f2c, 'party', 7], [0x30c0, 'currentBox', 21], [0x25c9, 'bag', 21], [0x27e6, 'pcItems', 51]])('bounds count at %i for %s', (offset, section, count) => {
    const b = defensive(); b[offset as number] = count as number; seal(b)
    const result = parseRedSave(b), s = snapshot(result)
    expect(result.status).toBe('partial')
    expect(s[section as 'party'].known).toBe(false)
    expect(s.rawCounts?.[section as 'party']).toBe(count)
    expect(known(s.ownedDex)).toEqual([])
  })
  it('retains bag order, duplicates, unknown item IDs and quantity 255', () => {
    const b = defensive(); b[0x25c9] = 6
    b.set([40, 1, 40, 2, 41, 3, 42, 4, 43, 5, 254, 255, 255], 0x25ca); seal(b)
    expect(known(snapshot(parseRedSave(b)).bag)).toEqual([
      { position: 1, rawItemId: 40, quantity: 1 }, { position: 2, rawItemId: 40, quantity: 2 },
      { position: 3, rawItemId: 41, quantity: 3 }, { position: 4, rawItemId: 42, quantity: 4 },
      { position: 5, rawItemId: 43, quantity: 5 }, { position: 6, rawItemId: 254, quantity: 255 },
    ])
  })
  it('retains unmapped internal species without inventing owned flags', () => {
    const b = defensive(); b[0x2f2c] = 1; b.set([31, 255], 0x2f2d); b[0x2f34] = 31; b[0x2f55] = 5; seal(b)
    const result = parseRedSave(b), s = snapshot(result)
    expect(result.status).toBe('partial')
    expect(known(s.party)[0]).toMatchObject({ internalSpeciesId: 31, dexNumber: null })
    expect(known(s.ownedDex)).toEqual([])
  })
  it('diagnoses species-array disagreement while retaining both raw IDs', () => {
    const b = defensive(); b[0x2f2c] = 1; b.set([153, 255], 0x2f2d); b[0x2f34] = 176; seal(b)
    const result = parseRedSave(b)
    expect(result.status).toBe('partial')
    expect(known(snapshot(result).party)[0]).toMatchObject({ internalSpeciesId: 176, listedSpeciesId: 153 })
    expect(result.issues.some(i => i.code === 'species-mismatch')).toBe(true)
  })
  it.each([[0x2f2d, 'party'], [0x30c1, 'currentBox'], [0x25ca, 'bag'], [0x27e7, 'pcItems']])('unavailable list on missing terminator %i', (offset, section) => {
    const b = defensive(); b[offset as number] = 0; seal(b)
    expect(snapshot(parseRedSave(b))[section as 'party'].known).toBe(false)
  })
  it('does not give an invalid box index a valid identity', () => {
    const b = defensive(); b[0x284c] = 12; seal(b)
    const s = snapshot(parseRedSave(b))
    expect(s.currentBox.known).toBe(false)
    expect(s.rawCounts?.currentBoxByte).toBe(12)
  })
  it('reads occupied daycare without calculating absent Special; empty ignores stale record', () => {
    const b = defensive(); b[0x2cf4] = 1; b[0x2d0b] = 176; b[0x2d0e] = 8; seal(b)
    expect(known(snapshot(parseRedSave(b)).daycare)).toMatchObject({ dexNumber: 4, level: { known: false }, special: { known: false } })
    b[0x2cf4] = 0; seal(b)
    expect(known(snapshot(parseRedSave(b)).daycare)).toBeNull()
    b[0x2cf4] = 2; seal(b)
    expect(snapshot(parseRedSave(b)).daycare.known).toBe(false)
  })
  it('does not expose deposited daycare level as current after experience gain', () => {
    // Defensive-test state: deposited level 8 stays cached while EXP has advanced to 8000.
    // Walking increments EXP alone; current daycare level needs an audited growth calculation.
    const b = defensive()
    b[0x2cf4] = 1; b[0x2d0b] = 176; b[0x2d0e] = 8
    b.set([0, 0x1f, 0x40], 0x2d19)
    b[0x2f2c] = 1; b.set([176, 255], 0x2f2d); b[0x2f34] = 176
    b[0x2f37] = 8; b[0x2f55] = 11
    b[0x30c0] = 1; b.set([176, 255], 0x30c1); b[0x30d6] = 176; b[0x30d9] = 8
    seal(b)
    const s = snapshot(parseRedSave(b)), daycare = known(s.daycare)
    expect(daycare).toMatchObject({ dexNumber: 4, location: { kind: 'daycare' }, level: { known: false } })
    expect(daycare!.level).not.toHaveProperty('value')
    expect(known(known(s.party)[0]!.level)).toBe(11)
    expect(known(known(s.currentBox).pokemon[0]!.level)).toBe(8)
  })
  it('uses distinct event, object, hidden, trade, status and script namespaces', () => {
    const b = defensive()
    b[0x29f3] = b[0x2852] = b[0x299c] = b[0x29aa] = b[0x29e3] = b[0x29d4] = 1
    b[0x289c] = 7; seal(b)
    const s = snapshot(parseRedSave(b))
    expect(known(s.events).EVENT_FOLLOWED_OAK_INTO_LAB).toBe(true)
    expect(known(s.objectFlags!).TOGGLE_PALLET_TOWN_OAK).toBe(true)
    expect(known(s.hiddenItemFlags!)[0]).toBe(true)
    expect(known(s.hiddenCoinFlags!)[0]).toBe(true)
    expect(known(s.tradeFlags!)[0]).toBe(true)
    expect(known(s.statusFlags!)['wStatusFlags1:0']).toBe(true)
    expect(known(s.mapScriptStates!)[0]).toBe(7)
  })
  it('keeps invalid clock and unchecked Hall of Fame unknown', () => {
    const b = defensive(); b[0x284e] = 255; b.set([1, 0, 60, 0, 0], 0x2ced); seal(b)
    const s = snapshot(parseRedSave(b))
    expect(s.playTime.known).toBe(false)
    expect(s.playTimeRaw).toEqual([1, 0, 60, 0, 0])
    expect(s.hallOfFame.known).toBe(false)
    expect(s.rawCounts?.hallOfFame).toBe(255)
  })
  it('does not decode control bytes into a plausible trainer identity', () => {
    const b = defensive(); b[0x2598] = 0; seal(b)
    expect(snapshot(parseRedSave(b)).trainer.known).toBe(false)
  })
  it('ignores the unused Dex bit and never infers held species as registered', () => {
    const b = defensive(); b[0x25a3] = 1; b[0x25b5] = 192; b[0x25b6] = 2
    b[0x2f2c] = 1; b.set([176, 255], 0x2f2d); b[0x2f34] = 176; seal(b)
    const s = snapshot(parseRedSave(b))
    expect(known(s.ownedDex)).toEqual([1, 151])
    expect(known(s.seenDex)).toEqual([2])
    expect(known(s.party)[0]?.dexNumber).toBe(4)
  })
  it('decodes trainer Gen1 characters and big-endian ID without ASCII assumptions', () => {
    const b = defensive(); b.set([0x80, 0xa1, 0xf8, 0x50], 0x2598); b.set([0x12, 0x34], 0x2605); seal(b)
    expect(known(snapshot(parseRedSave(b)).trainer)).toEqual({ name: 'Ab2', id: 4660 })
  })
  it('treats the overwritten active archive record as superseded even if its count is invalid', () => {
    const b = archives(defensive()); b[0x4000] = 255
    seal(b, 0x4000, 0x5a4c)
    let sum = 0; for (let i = 0x4000; i < 0x4462; i++) sum += b[i]!
    b[0x5a4d] = 255 - sum % 256
    const s = snapshot(parseRedSave(b))
    expect(known(s.currentBox).pokemon).toEqual([])
    expect(known(s.archivedBoxes)).toHaveLength(11)
    expect(s.rawCounts?.archivedBoxes[0]).toBe(255)
  })
  it('makes the archived section unknown on overflow in an inactive box', () => {
    const b = archives(defensive()); b[0x6000] = 21
    seal(b, 0x6000, 0x7a4c)
    let sum = 0; for (let i = 0x6000; i < 0x6462; i++) sum += b[i]!
    b[0x7a4d] = 255 - sum % 256
    const result = parseRedSave(b), s = snapshot(result)
    expect(result.status).toBe('partial')
    expect(s.archivedBoxes.known).toBe(false)
    expect(s.rawCounts?.archivedBoxes[6]).toBe(21)
    expect(known(s.currentBox).pokemon).toEqual([])
  })
  it('rejects even a superseded active archive checksum failure when initialized', () => {
    const b = archives(defensive()); b[0x5a4d] ^= 1
    expect(parseRedSave(b)).toMatchObject({ status: 'rejected', issues: [{ code: 'archive-checksum' }] })
  })
  it('never uses unchecked bank zero when no Hall of Fame team is recorded', () => {
    const b = defensive(); b.fill(255, 0x0598, 0x1858)
    expect(known(snapshot(parseRedSave(b)).hallOfFame)).toBe(false)
  })
  it('preserves bytes and fingerprints the complete original input deterministically', () => {
    const b = defensive(), before = b.slice()
    const s = snapshot(parseRedSave(b))
    expect(b).toEqual(before)
    expect(snapshot(parseRedSave(b)).hash).toBe(s.hash)
    b[0] = 1
    expect(snapshot(parseRedSave(b)).hash).not.toBe(s.hash)
  })
})

describe.skipIf(!existsSync('test/fixtures/private/emulator-starter-red.srm'))('independently recorded ordinary gameplay fixtures', () => {
  it('initial save has no party or registration and ignores uninitialized storage', () => {
    const s = snapshot(parseRedSave(fixture('emulator-initial-red.srm')))
    expect(known(s.party)).toEqual([]); expect(known(s.ownedDex)).toEqual([])
    expect(known(s.location)).toEqual({ mapId: 38, x: 3, y: 6 })
    expect(s.archivedBoxes.known).toBe(false)
    expect(known(s.playTime)).toEqual({ hours: 0, minutes: 0, seconds: 10 })
  })
  it.each([['emulator-starter-red.srm', 'shift'], ['emulator-starter-set-red.srm', 'set']])('reads actual party fields and option polarity in %s', (name, style) => {
    const s = snapshot(parseRedSave(fixture(name)))
    expect(known(s.battleStyle)).toBe(style)
    expect(known(s.ownedDex)).toEqual([4]); expect(known(s.badgeMask)).toBe(0)
    expect(known(s.party)).toHaveLength(1)
    expect(known(s.party)[0]).toMatchObject({ internalSpeciesId: 176, dexNumber: 4, level: { known: true, value: 5 }, special: { known: true, value: 11 }, moves: { known: true, value: [{ id: 10, pp: 35, ppUps: 0 }, { id: 45, pp: 40, ppUps: 0 }, { id: 0, pp: 0, ppUps: 0 }, { id: 0, pp: 0, ppUps: 0 }] } })
  })
})
describe.skipIf(!existsSync('test/fixtures/private/BaseSAV.sav'))('independent public fixtures with unverified emulator provenance', () => {
  it('live box supersedes the intentionally empty archived active box', () => {
    const s = snapshot(parseRedSave(fixture('BaseSAV.sav')))
    expect(known(s.currentBox).index).toBe(11)
    expect(known(s.currentBox).pokemon.map(p => p.internalSpeciesId)).toEqual([113, 185, 169, 157])
    expect(known(s.archivedBoxes).map(b => b.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(known(s.archivedBoxes).map(b => b.pokemon.length)).toEqual([2, 6, 6, 2, 1, 1, 2, 8, 2, 2, 2])
    expect(known(s.party).map(p => known(p.special))).toEqual([195, 7])
    expect(known(known(s.party)[0]!.moves)[0]).toEqual({ id: 52, pp: 30, ppUps: 2 })
    expect(known(s.currentBox).pokemon.every(p => !p.special.known)).toBe(true)
    expect(known(s.playTime)).toEqual({ hours: 15, minutes: 39, seconds: 4 })
    expect(s.hallOfFame.known).toBe(false)
  })
  it('stale valid archives and HoF data do not create current-save ownership/history', () => {
    const s = snapshot(parseRedSave(fixture('BaseSAV.new.sav')))
    expect(s.archivedBoxes.known).toBe(false)
    expect(known(s.hallOfFame)).toBe(false)
    expect(known(s.currentBox).pokemon).toEqual([])
  })
})
describe.skipIf(!existsSync('test/fixtures/private/private-current-red.srm'))('private erased battery fixture', () => {
  it('rejects the erased main image without replacement', () => {
    expect(parseRedSave(fixture('private-current-red.srm')).status).toBe('rejected')
  })
})
