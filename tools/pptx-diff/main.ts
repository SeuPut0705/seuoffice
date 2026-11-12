// Every tracked PPTX, built decks and adversarial inputs, through the shared Word gate.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import {
  atFloor,
  Comparison,
  failGate,
  gateHasFailed,
  option,
  repoRoot,
  reportComparisons,
  useFloors,
} from '../docx-diff/harness'
import { observedDifferences } from '../docx-diff/known-differences'
import { mulberry32 } from '../docx-diff/synthetic'
import { builtContainers, builtDecks } from './built'
import { callsAfterCorpus, callsOnDocument, reportCalls } from './calls-run'
import { comparePackage } from './compare-package'
import { registerLedger, reportDivergences } from './divergences'

useFloors(fileURLToPath(new URL('floors.json', import.meta.url)))
registerLedger()
const callsOnly = process.argv.includes('--calls-only')
const corpusPackages = callsOnly
  ? null
  : new Comparison('(a) package open, tracked decks', 'packageCorpus')
const corpusBytes = callsOnly
  ? null
  : new Comparison('(a) package entry bytes, tracked decks', 'packageCorpusEntries')
const builtPackages = callsOnly
  ? null
  : new Comparison('(a) package open, built containers', 'packageBuilt')
const builtBytes = callsOnly
  ? null
  : new Comparison('(a) package entry bytes, built containers', 'packageBuiltEntries')
const corpus = execFileSync('git', ['ls-files', '-z', '*.pptx'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
let opened = 0
let slides = 0

for (const [where, bytes, tracked] of [
  ...corpus.map((path): [string, Uint8Array, boolean] => [
    path,
    readFileSync(resolve(repoRoot, path)),
    true,
  ]),
  ...(await builtDecks()).map(([name, bytes]): [string, Uint8Array, boolean] => [
    name,
    bytes,
    false,
  ]),
  ...builtContainers().map(([name, bytes]): [string, Uint8Array, boolean] => [name, bytes, false]),
]) {
  const archive = callsOnly
    ? await PackageArchive.open(bytes).catch(() => null)
    : await comparePackage(
        tracked ? corpusPackages! : builtPackages!,
        tracked ? corpusBytes! : builtBytes!,
        where,
        bytes,
      )
  if (archive === null) continue
  if (tracked) opened += 1
  const parts = new Map<string, string>()
  for (const [name, bytes] of archive.entries) {
    if (/\.(xml|rels)$/i.test(name)) parts.set(name, Buffer.from(bytes).toString('utf8'))
    if (tracked && /^ppt\/slides\/slide\d+\.xml$/.test(name)) slides += 1
  }
  await callsOnDocument(where, parts)
}
await callsAfterCorpus(mulberry32(option('--seed', 20261112)))
console.log(
  `pptx-diff: ${corpus.length} tracked .pptx (${atFloor(corpus.length, 'trackedDocuments')}); ${opened} opened (${atFloor(opened, 'openedDocuments')}); ${slides} slides (${atFloor(slides, 'corpusSlides')})`,
)
reportComparisons()
reportCalls()
if (!callsOnly) await reportDivergences()
if (process.argv.includes('--group') && !callsOnly) {
  console.error('A selected group is not the full gate. Use calls -- --group NAME for porting.')
  failGate()
}
mkdirSync(fileURLToPath(new URL('out', import.meta.url)), { recursive: true })
const fullDifferences = JSON.stringify(observedDifferences, null, 2) + '\n'
writeFileSync(fileURLToPath(new URL('out/differences.json', import.meta.url)), fullDifferences)
const firstAt = process.argv.indexOf('--record-first')
if (firstAt !== -1) {
  const unit = process.argv[firstAt + 1]
  if (!unit || !/^[a-z0-9-]+$/.test(unit)) throw new Error('invalid first-run unit name')
  const evidence = resolve(repoRoot, 'crates/pptx-engine/evidence')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, `${unit}-first.differences.json`), fullDifferences, {
    flag: 'wx',
  })
}
process.exit(gateHasFailed() ? 1 : 0)
