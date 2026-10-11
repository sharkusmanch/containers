import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
// Partition one immutable source file at build time: the curated data/API stays intact.
// Rolldown splits modules, not the contents of a single 513kB JSON module.
const rules = JSON.parse(
  readFileSync(
    new URL('./src/data/rules.curated.json', import.meta.url),
    'utf8',
  ),
) as { setKey: string }[]
const prefix = 'virtual:mastery-rules'
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'mastery-rules-by-set',
      enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('/rules.curated.json')) return '\0' + prefix
        if (id.startsWith(prefix)) return '\0' + id
      },
      load(id) {
        if (id === '\0' + prefix)
          return `import main from '${prefix}-main';import oak from '${prefix}-oak';import glitch from '${prefix}-glitch';export default [...main,...oak,...glitch]`
        if (id.startsWith('\0' + prefix + '-'))
          return `export default ${JSON.stringify(rules.filter((r) => r.setKey === id.slice(('\0' + prefix + '-').length)))}`
      },
    },
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'game-facts', test: /pokered\.generated\.json/ },
            { name: 'rules-main', test: /virtual:mastery-rules-main/ },
            { name: 'rules-oak', test: /virtual:mastery-rules-oak/ },
            { name: 'rules-glitch', test: /virtual:mastery-rules-glitch/ },
            { name: 'area-checklists', test: /areas\.curated\.json/ },
          ],
        },
      },
    },
  },
})
