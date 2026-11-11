// Comparison (f) alone, for the loop of porting one group: seconds instead of
// the minute of the whole gate. It checks no floor and no other comparison,
// so it accepts nothing: the gate does.
//
//   npm --prefix tools/docx-diff run calls -- --group markers [--by-function] [--show N]
//                                             [--call-fuzz N] [--seed N]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadDocxZip } from '../../packages/docx-engine/src/zip-load'
import { callsAfterCorpus, callsOnDocument, reportCalls } from './calls-run'
import { option, repoRoot, reportComparisons } from './harness'
import { mulberry32 } from './synthetic'

const corpus = execFileSync('git', ['ls-files', '-z', '*.docx'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

for (const path of corpus) {
  const zip = await loadDocxZip(new Uint8Array(readFileSync(resolve(repoRoot, path)))).catch(
    () => null,
  )
  if (zip === null) continue
  const parts = new Map<string, string>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir && /\.(xml|rels)$/i.test(name)) parts.set(name, await file.async('string'))
  }
  await callsOnDocument(path, parts)
}
await callsAfterCorpus(mulberry32(option('--seed', 20261111)))

reportComparisons()
reportCalls()
