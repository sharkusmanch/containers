/** Reproducible map-ID → display-name table from the pinned pokered map constants. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const PIN = 'af519899719f0754965776faac0e836a3b906e6d'
const root = resolve(process.argv[2] ?? '/tmp/pokemon-red-source')
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (commit !== PIN) throw new Error(`Expected pinned pokered ${PIN}; got ${commit}`)
if (execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Dirty source tree')
const special: Record<string, string> = { MT: 'Mt.', SS: 'S.S.', POKECENTER: 'Pokémon Center', MART: 'Poké Mart', REDS: "Red's", BLUES: "Blue's", OAKS: "Oak's", BILLS: "Bill's", HQ: 'HQ', CO: 'Co.', SAFARI: 'Safari', PP: 'PP' }
const names: Record<number, string> = {}
for (const line of readFileSync(join(root, 'constants/map_constants.asm'), 'utf8').split('\n')) {
  const m = /^\s*map_const\s+([A-Z0-9_]+),.*;\s*\$([0-9A-F]{2})\s*$/.exec(line)
  if (!m || m[1]!.startsWith('UNUSED_MAP')) continue
  names[parseInt(m[2]!, 16)] = m[1]!.split('_').map(w => special[w] ?? (/^\d|^B?\d+F$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ').replace(/ Copy$/, '')
}
writeFileSync(new URL('../src/data/map-names.generated.json', import.meta.url), JSON.stringify({ sourceCommit: PIN, sourceUrl: `https://github.com/pret/pokered/blob/${PIN}/constants/map_constants.asm`, names }, null, 1) + '\n')
console.log(Object.keys(names).length, 'maps')
