import { game } from '../data/game'
import type { BagSlot, BoxObservation, Fact, ParseIssue, ParseResult, PokemonObservation, SaveSnapshot, TrainerObservation } from '../model'
import { checksum, fingerprint } from './checksum'
import { boxOffset, layout as l } from './layout'
import { known, readPokemon, unknown, word } from './pokemon'

/** Synchronous, bounded, read-only English Red 32KiB battery-save reader. */
export function parseRedSave(bytes: Uint8Array): ParseResult {
  const issues: ParseIssue[] = []
  const fail = (code: string, message: string, offset?: number): ParseResult => ({ status: 'rejected', issues: [{ code, message, ...(offset === undefined ? {} : { offset }) }] })
  if (bytes.length !== l.size) return fail('unsupported-size', 'Expected an English Red 32768-byte battery save.')
  if (checksum(bytes, l.mainStart, l.mainEnd) !== bytes[l.mainEnd]) return fail('main-checksum', 'Main save checksum failed.', l.mainEnd)
  const currentBoxByte = bytes[l.currentBoxByte]!, currentIndex = currentBoxByte & 127
  const initialized = (currentBoxByte & 128) !== 0
  if (initialized) {
    for (const bank of [0x4000, 0x6000]) {
      if (checksum(bytes, bank, bank + 6 * l.boxSize) !== bytes[bank + 6 * l.boxSize]) return fail('archive-checksum', 'Initialized archived bank checksum failed.', bank + 6 * l.boxSize)
      for (let i = 0; i < 6; i++) {
        const start = bank + i * l.boxSize, check = bank + 6 * l.boxSize + 1 + i
        if (checksum(bytes, start, start + l.boxSize) !== bytes[check]) return fail('archive-checksum', 'Initialized archived box checksum failed.', check)
      }
    }
  }
  const unavailable = <T>(section: keyof SaveSnapshot, code: string, message: string, offset: number): Fact<T> => {
    issues.push({ code, message, section, offset })
    return unknown(message)
  }
  function pokemonList(offset: number, party: boolean, boxIndex: number): Fact<PokemonObservation[]> {
    const section = party ? 'party' : offset === l.currentBox ? 'currentBox' : 'archivedBoxes'
    const count = bytes[offset]!, capacity = party ? 6 : 20
    if (count > capacity) return unavailable(section, 'list-count', 'Pokémon list count exceeds its fixed capacity.', offset)
    if (bytes[offset + 1 + count] !== 255) return unavailable(section, 'list-terminator', 'Pokémon list terminator is missing.', offset + 1 + count)
    return known(Array.from({ length: count }, (_, slot) => readPokemon(bytes, offset + (party ? 8 : 0x16) + slot * (party ? 44 : 33),
      party ? { kind: 'party', slot: slot + 1 } : { kind: 'box', index: boxIndex, slot: slot + 1 }, section, issues, bytes[offset + 1 + slot]!)))
  }
  function box(offset: number, index: number): Fact<BoxObservation> {
    const pokemon = pokemonList(offset, false, index)
    return pokemon.known ? known({ index, pokemon: pokemon.value }) : pokemon
  }
  function items(offset: number, capacity: number, section: 'bag' | 'pcItems'): Fact<BagSlot[]> {
    const count = bytes[offset]!
    if (count > capacity) return unavailable(section, 'list-count', 'Item list count exceeds its fixed capacity.', offset)
    if (bytes[offset + 1 + count * 2] !== 255) return unavailable(section, 'list-terminator', 'Item list terminator is missing.', offset + 1 + count * 2)
    return known(Array.from({ length: count }, (_, i) => ({ position: i + 1, rawItemId: bytes[offset + 1 + i * 2]!, quantity: bytes[offset + 2 + i * 2]! })))
  }
  function flags(offset: number, symbols: Record<string, number>): Fact<Record<string, boolean>> {
    return known(Object.fromEntries(Object.entries(symbols).map(([name, bit]) => [name, (bytes[offset + (bit >> 3)]! & (1 << (bit & 7))) !== 0])))
  }
  function indexedFlags(offset: number, count: number): Fact<Record<number, boolean>> {
    return flags(offset, Object.fromEntries(Array.from({ length: count }, (_, bit) => [bit.toString(), bit])))
  }
  const trainer = readTrainer(bytes) ?? unavailable<TrainerObservation>('trainer', 'trainer-encoding', 'Trainer name has unsupported bytes, length, or no terminator.', l.name)
  const currentBox: Fact<BoxObservation> = currentIndex < 12 ? box(l.currentBox, currentIndex) : unavailable('currentBox', 'box-index', 'Current box index is outside 0–11.', l.currentBoxByte)
  let archivedBoxes: Fact<BoxObservation[]> = unknown('Archived boxes have not been initialized.')
  if (initialized) {
    if (currentIndex >= 12) archivedBoxes = unknown('Current box index is invalid; active archive cannot be identified.')
    else {
      const boxes: BoxObservation[] = []
      let readable = true
      for (let i = 0; i < 12; i++) {
        if (i === currentIndex) continue
        const observation = box(boxOffset(i), i)
        if (observation.known) boxes.push(observation.value)
        else readable = false
      }
      archivedBoxes = readable ? known(boxes) : unknown('One or more initialized archived lists are unavailable.')
    }
  }
  const occupancy = bytes[l.daycare]!
  const daycare = occupancy === 0 ? known(null) : occupancy === 1 ? known(readPokemon(bytes, l.daycarePokemon, { kind: 'daycare' }, 'daycare', issues)) : unavailable<PokemonObservation | null>('daycare', 'daycare-occupancy', 'Daycare occupancy must be 0 or 1.', l.daycare)
  const time = Array.from(bytes.subarray(l.playTime, l.playTime + 5))
  const playTime = time[1]! <= 1 && time[2]! < 60 && time[3]! < 60 && time[4]! < 60 && (time[1] === 0 || time[0] === 255)
    ? known({ hours: time[0]!, minutes: time[2]!, seconds: time[3]! })
    : unavailable<SaveSnapshot['playTime'] extends Fact<infer T> ? T : never>('playTime', 'play-time', 'Saved clock components are incoherent.', l.playTime)
  const hofCount = bytes[l.hallOfFameCount]!
  const hallOfFame = hofCount === 0 ? known(false) : unavailable<boolean>('hallOfFame', 'hall-of-fame-unchecked', 'Hall of Fame bank has no checksum; saved count cannot establish a verified clear or its history.', l.hallOfFameCount)
  const snapshot: SaveSnapshot = {
    profileId: game.profileId, hash: fingerprint(bytes), importedAt: new Date().toISOString(),
    trainer, battleStyle: known((bytes[l.options]! & 64) !== 0 ? 'set' : 'shift'), badgeMask: known(bytes[l.badges]!),
    ownedDex: dexFlags(bytes, l.owned), seenDex: dexFlags(bytes, l.seen),
    party: pokemonList(l.party, true, 0), currentBox, archivedBoxes, daycare,
    bag: items(l.bag, 20, 'bag'), pcItems: items(l.pcItems, 50, 'pcItems'),
    events: flags(l.events, game.eventFlags), objectFlags: flags(l.objects, game.objectFlags),
    hiddenItemFlags: indexedFlags(l.hiddenItems, 112), hiddenCoinFlags: indexedFlags(l.hiddenCoins, 16), tradeFlags: indexedFlags(l.trades, 16),
    statusFlags: known(Object.fromEntries(l.status.flatMap((offset, i) => Array.from({ length: 8 }, (_, bit) => [`wStatusFlags${i + 1}:${bit}`, (bytes[offset]! & (1 << bit)) !== 0])))),
    mapScriptStates: known(Array.from(bytes.subarray(l.scripts, l.scripts + 200))),
    location: known({ mapId: bytes[l.map]!, x: bytes[l.x]!, y: bytes[l.y]! }), playTime, playTimeRaw: time, hallOfFame,
    rawCounts: { party: bytes[l.party]!, currentBox: bytes[l.currentBox]!, currentBoxByte, archivedBoxes: initialized ? Array.from({ length: 12 }, (_, i) => bytes[boxOffset(i)]!) : [], bag: bytes[l.bag]!, pcItems: bytes[l.pcItems]!, daycare: occupancy, hallOfFame: hofCount },
  }
  return { status: issues.length === 0 ? 'readable' : 'partial', snapshot, issues }
}

function dexFlags(bytes: Uint8Array, offset: number): Fact<number[]> {
  return known(Array.from({ length: 151 }, (_, i) => i + 1).filter(n => (bytes[offset + ((n - 1) >> 3)]! & (1 << ((n - 1) & 7))) !== 0))
}
/** Conservative player-name display subset of constants/charmap.asm; control codes unavailable. */
function readTrainer(bytes: Uint8Array): Fact<TrainerObservation> | null {
  const characters: Record<number, string> = { 0x7f: ' ', 0x9a: '(', 0x9b: ')', 0x9c: ':', 0x9d: ';', 0x9e: '[', 0x9f: ']', 0xba: 'é', 0xe0: "'", 0xe3: '-', 0xe6: '?', 0xe7: '!', 0xe8: '.', 0xef: '♂', 0xf3: '/', 0xf4: ',', 0xf5: '♀' }
  let name = ''
  for (let i = 0; i < 11; i++) {
    const byte = bytes[l.name + i]!
    if (byte === 0x50) return i > 0 && i <= 7 ? known({ name, id: word(bytes, l.trainerId) }) : null
    if (i >= 7) return null
    const character = byte >= 0x80 && byte <= 0x99 ? String.fromCharCode(65 + byte - 0x80) : byte >= 0xa0 && byte <= 0xb9 ? String.fromCharCode(97 + byte - 0xa0) : byte >= 0xf6 ? String(byte - 0xf6) : characters[byte]
    if (character === undefined) return null
    name += character
  }
  return null
}
