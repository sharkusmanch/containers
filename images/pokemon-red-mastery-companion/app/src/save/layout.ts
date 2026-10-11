/** Flat 32KiB English Red SRAM offsets. Source: pret/pokered af5198997, ram/sram.asm.
 * WRAM conversion: 0x25A3 + (symbol - 0xD2F7). See docs/save-reader.md. */
export const layout = {
  size: 0x8000, mainStart: 0x2598, mainEnd: 0x3523,
  name: 0x2598, trainerId: 0x2605, options: 0x2601, badges: 0x2602,
  owned: 0x25a3, seen: 0x25b6, map: 0x260a, y: 0x260d, x: 0x260e,
  party: 0x2f2c, currentBox: 0x30c0, currentBoxByte: 0x284c, boxSize: 0x462,
  bag: 0x25c9, pcItems: 0x27e6, daycare: 0x2cf4, daycarePokemon: 0x2d0b,
  events: 0x29f3, objects: 0x2852, hiddenItems: 0x299c, hiddenCoins: 0x29aa,
  trades: 0x29e3, scripts: 0x289c, playTime: 0x2ced, hallOfFameCount: 0x284e,
  status: [0x29d4, 0x29d8, 0x29d9, 0x29da, 0x29dc, 0x29de, 0x29df],
} as const
export function boxOffset(index: number): number {
  return index < 6 ? 0x4000 + index * layout.boxSize : 0x6000 + (index - 6) * layout.boxSize
}
