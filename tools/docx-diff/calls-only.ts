// Comparison (f) alone, for the loop of porting one group: seconds instead of
// the minute of the whole gate. It checks no floor and no other comparison,
// so it accepts nothing: the gate does.
//
//   npm --prefix tools/docx-diff run calls -- --group markers [--by-function] [--show N]
//                                             [--call-fuzz N] [--seed N]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseDocx } from './reference/parse'
import { loadDocxZip } from './reference/zip-load'
import {
  callsAfterCorpus,
  callsOnDocument,
  callsOnModel,
  callsOnParse,
  callsReport,
  reportCalls,
} from './calls-run'
import { gateHasFailed, option, repoRoot, reportComparisons } from './harness'
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
  const bytes = new Uint8Array(readFileSync(resolve(repoRoot, path)))
  await callsOnParse(path, bytes, parts)
  const doc = await parseDocx(bytes).catch(() => null)
  if (doc) await callsOnModel(path, doc)
}
await callsAfterCorpus(mulberry32(option('--seed', 20261111)))

reportComparisons()
reportCalls()
const reportAt = process.argv.indexOf('--report')
if (reportAt >= 0) {
  const path = resolve(process.argv[reportAt + 1]!)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(callsReport(), null, 2) + '\n', {
    flag: process.argv.includes('--first') ? 'wx' : 'w',
  })
}
process.exitCode = gateHasFailed() ? 1 : 0
