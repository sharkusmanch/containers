/** Game checksum: complement of the unsigned byte sum over [start,end). */
export function checksum(bytes: Uint8Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i++) sum = (sum + bytes[i]!) & 255
  return sum ^ 255
}
/** FNV-1a-64 over all original bytes, for unchanged-file detection only. */
export function fingerprint(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}
