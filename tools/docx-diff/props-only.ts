// Comparison (d) alone, for the loop of porting a property reader: the corpus
// and the generators of props-run.ts, without the other comparisons. It checks
// no floor of the gate, so it accepts nothing: the gate does.
//
//   npx tsx tools/docx-diff/props-only.ts [--by-function] [--show N] [--seed N]
//                                         [--props-fuzz N] [--numbers N]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDocx } from './reference/index'
import { loadDocxZip } from './reference/zip-load'
import { gateHasFailed, option, repoRoot, reportComparisons } from './harness'
import type { Themes } from './props-registry'
import { propsAfterCorpus, propsOnDocument, propsOnPart, reportProps } from './props-run'
import { mulberry32 } from './synthetic'

const corpus = execFileSync('git', ['ls-files', '-z', '*.docx'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

for (const path of corpus) {
  const bytes = new Uint8Array(readFileSync(resolve(repoRoot, path)))
  const zip = await loadDocxZip(bytes).catch(() => null)
  if (zip === null) continue
  const parsed = await parseDocx(bytes).catch(() => null)
  const themes: Themes = {
    colors: parsed?.themeColors ?? undefined,
    fonts: parsed?.themeFonts ?? undefined,
  }
  propsOnDocument(
    themes,
    (parsed?.blocks ?? []).flatMap((block) => {
      const runs = 'runs' in block ? block.runs : undefined
      return runs && runs.length > 0 && JSON.stringify(runs).length < 20_000 ? [runs] : []
    }),
  )
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.xml$/i.test(name)) continue
    propsOnPart(`${path}: ${name}`, await file.async('string'), themes)
  }
}
propsAfterCorpus(mulberry32(option('--seed', 20261111)))

reportComparisons()
reportProps()
process.exitCode = gateHasFailed() ? 1 : 0
