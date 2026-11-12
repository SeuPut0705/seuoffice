// Every tracked PPTX, built decks and adversarial inputs, through the shared Word gate.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import { observeDifferences, observedDifferences } from '../docx-diff/known-differences'
import { mutateContainer } from '../docx-diff/package-zips'
import { mulberry32 } from '../docx-diff/synthetic'
import { builtContainers, builtDecks } from './built'
import { callsAfterCorpus, callsOnDocument, reportCalls } from './calls-run'
import { comparePackage } from './compare-package'
import { registerLedger, reportDivergences } from './divergences'

useFloors(fileURLToPath(new URL('floors.json', import.meta.url)))
registerLedger()
observeDifferences(option('--keep', 40))
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
const CONTAINER_FUZZ_CASES = option('--container-fuzz', 300)
const mutatedPackages = callsOnly
  ? null
  : new Comparison('(a+) package open, mutated containers', CONTAINER_FUZZ_CASES)
const mutatedBytes = callsOnly
  ? null
  : new Comparison('(a+) package entry bytes, mutated containers', 'packageMutatedEntries')
const containerSeeds: Array<[string, Uint8Array]> = []
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
  containerSeeds.push([where, bytes])
  const parts = new Map<string, string>()
  for (const [name, bytes] of archive.entries) {
    if (/\.(xml|rels)$/i.test(name)) parts.set(name, Buffer.from(bytes).toString('utf8'))
    if (tracked && /^ppt\/slides\/slide\d+\.xml$/.test(name)) slides += 1
  }
  await callsOnDocument(where, parts)
}
if (!callsOnly) {
  // its own generator: the mutations of the calls keep their sequence
  const random = mulberry32(option('--seed', 20261112) + 1)
  for (let done = 0; done < CONTAINER_FUZZ_CASES; done++) {
    const [where, deck] = containerSeeds[Math.floor(random() * containerSeeds.length)]!
    await comparePackage(
      mutatedPackages!,
      mutatedBytes!,
      `mutation ${done} of ${where}`,
      mutateContainer(deck, random),
    )
  }
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
const outputDir = process.env.PPTX_DIFF_OUT ?? fileURLToPath(new URL('out', import.meta.url))
mkdirSync(outputDir, { recursive: true })
// One difference per line: a run with whole decks in its differences passes
// the longest string V8 can build as one JSON text.
const lines = (): string[] => observedDifferences.map((difference) => JSON.stringify(difference))
const writeLines = (path: string, flag: string): void => {
  writeFileSync(path, '', { flag })
  for (const line of lines()) appendFileSync(path, line + '\n')
}
writeLines(resolve(outputDir, callsOnly ? 'calls-differences.jsonl' : 'differences.jsonl'), 'w')
const firstAt = process.argv.indexOf('--record-first')
if (firstAt !== -1) {
  const unit = process.argv[firstAt + 1]
  if (!unit || !/^[a-z0-9-]+$/.test(unit)) throw new Error('invalid first-run unit name')
  const evidence = resolve(repoRoot, 'crates/pptx-engine/evidence')
  mkdirSync(evidence, { recursive: true })
  writeLines(resolve(evidence, `${unit}-first.differences.jsonl`), 'wx')
}
process.exit(gateHasFailed() ? 1 : 0)
