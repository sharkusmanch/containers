import type { PokemonObservation, SaveSnapshot } from '../src/model'
export const unknown = { known: false as const, reason: 'Unreadable test section' }
export const known = <T>(value: T) => ({ known: true as const, value })
export function pokemon(dexNumber: number, level = 5): PokemonObservation {
  return { internalSpeciesId: dexNumber, dexNumber, location: { kind: 'party', slot: 1 }, level: known(level), moves: known([]), special: known(10) }
}
export function snapshot(owned: number[] = [], badges = 0): SaveSnapshot {
  return { profileId: 'red-en', hash: 'test', importedAt: '2026-10-11', trainer: unknown,
    battleStyle: known('set'), badgeMask: known(badges), ownedDex: known(owned), seenDex: unknown,
    party: known([pokemon(1)]), currentBox: known({ index: 0, pokemon: [] }), archivedBoxes: known([]), daycare: known(null),
    bag: known([{ position: 1, rawItemId: 4, quantity: 10 }]), pcItems: known([]), events: known({}), location: unknown, playTime: unknown, hallOfFame: unknown }
}
// Hand-transcribed domain audit at source af519899719f0754965776faac0e836a3b906e6d.
// Independent of the dataset, so a missing/wrong phase species cannot validate itself.
export const brock = [10,11,12,13,14,15,16,17,18,19,20,21,22,25,29,30,32,33]
export const mistyAdded = [35,39,41,42,46,47,50,51,63,64,74,75,83,96,97,122,129,130,23,24,43,44,56,57]
export const kogaAdded = [26,48,49,54,55,60,61,62,66,67,72,73,79,80,84,85,90,91,92,93,95,98,99,100,101,102,103,104,105,108,111,112,113,115,128,116,117,118,119,120,121,124,131,132,133,137,143,147,148,149,45,58,59,123]
export const erikaAdded = [77,78,81,82,86,87,88,89,109,110,114,145,125,142]
