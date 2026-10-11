import { game } from '../data/game'
import type { Fact, ParseIssue, PokemonLocation, PokemonObservation, SaveSnapshot } from '../model'
const dexByInternal = new Map(game.species.map(p => [p.internalSpeciesId, p.dexNumber]))
export const known = <T>(value: T): Fact<T> => ({ known: true, value })
export const unknown = <T>(reason: string): Fact<T> => ({ known: false, reason })
export const word = (bytes: Uint8Array, offset: number): number => bytes[offset]! * 256 + bytes[offset + 1]!

/** Called only with validated fixed-stride offsets within the supported SRAM layout. */
export function readPokemon(bytes: Uint8Array, offset: number, location: PokemonLocation,
  section: keyof SaveSnapshot, issues: ParseIssue[], listedSpeciesId?: number): PokemonObservation {
  const internalSpeciesId = bytes[offset]!
  const mismatch = listedSpeciesId !== undefined && listedSpeciesId !== internalSpeciesId
  const mappedDex = dexByInternal.get(internalSpeciesId) ?? null
  if (mappedDex === null) issues.push({ code: 'unknown-species', message: 'Unmapped internal species retained as raw data.', section, offset })
  if (mismatch) issues.push({ code: 'species-mismatch', message: 'Species list and record disagree; identity and dependent stats are unavailable.', section, offset })
  const party = location.kind === 'party'
  return {
    internalSpeciesId, ...(listedSpeciesId === undefined ? {} : { listedSpeciesId }),
    dexNumber: mismatch ? null : mappedDex, location,
    level: mismatch ? unknown('Species list and record disagree.') : location.kind === 'daycare' ? unknown('Daycare stores deposited level; current level requires an audited experience growth calculation.') : known(bytes[offset + (party ? 0x21 : 3)]!),
    moves: mismatch ? unknown('Species list and record disagree.') : known(Array.from({ length: 4 }, (_, i) => ({
      id: bytes[offset + 8 + i]!, pp: bytes[offset + 0x1d + i]! & 63, ppUps: bytes[offset + 0x1d + i]! >> 6,
    }))),
    special: mismatch ? unknown('Species list and record disagree.') : party ? known(word(bytes, offset + 0x2a)) : unknown('Stored record has no measured Special stat.'),
  }
}
