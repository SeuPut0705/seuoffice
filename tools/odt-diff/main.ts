// Every ODT the corpus builds, the docx files tracked in the repository and
// their conversions, seeded mutations of both, and the edits of comparison (b),
// through the four wire commands of the odt engine; then the pure functions
// of every layer (f). See corpus.ts, edits.ts and compare-odt.ts.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { parseDocx } from '../docx-diff/reference/index'
import {
  atFloor,
  engine,
  Comparison,
  failGate,
  gateHasFailed,
  option,
  repoRoot,
  reportComparisons,
  useFloors,
} from '../docx-diff/harness'
import { observeDifferences, observedDifferences } from '../docx-diff/known-differences'
import { mulberry32 } from '../docx-diff/synthetic'
import { withClock } from './clock'
import { panics } from './panic-guard'
import { CONTROL, compareExport, compareOpen, compareSave, makeComparisons } from './compare-odt'
import {
  builtOdts,
  docxCases,
  mutatedContainers,
  mutatedDocx,
  mutatedDocxContainers,
  mutatedOdts,
  partText,
  type OdtCase,
} from './corpus'
import { callsAfterCorpus, callsOnDocument, callsOnModel, reportCalls } from './calls-run'
import { registerLedger, reportDivergences } from './divergences'
import { editRandomFor, editsFor } from './edits'
import { isFailure, tsDocxToOdt } from './ts-side'

// The positive control (see compare-odt.ts): the lines of the report are kept to
// check that every comparison with a population shows differences, and the
// outcomes of (f) are altered here: the `props` command answers one value that
// no function gives.
const reportLines: string[] = []
if (CONTROL) {
  const log = console.log
  console.log = (...parts: unknown[]) => {
    reportLines.push(parts.map(String).join(' '))
    log(...parts)
  }
  const call = engine.call.bind(engine)
  engine.call = ((command: { cmd?: string }, blobs?: Uint8Array[]) => {
    const reply = call(command, blobs)
    const header = reply.header as { results?: unknown[][] }
    if (command.cmd === 'props' && Array.isArray(header.results)) {
      header.results = header.results.map((list) => list.map(() => ({ value: '__control__' })))
    }
    return reply
  }) as typeof engine.call
}

useFloors(fileURLToPath(new URL('floors.json', import.meta.url)))
registerLedger()
observeDifferences(option('--keep', 40))
const callsOnly = process.argv.includes('--calls-only')
const seed = option('--seed', 20261112)
const editsPerOdt = option('--edits', 8)
const editsPerDerived = option('--edits-derived', 2)

const c = makeComparisons()
const exportTracked = new Comparison('(c) docxToOdt: tracked docx', 'exportTracked')
const exportBuilt = new Comparison('(c) docxToOdt: built docx', 'exportBuilt')
const exportMutated = new Comparison('(c+) docxToOdt: mutated docx', 'exportMutated')

/** The four parts of an ODT (or the xml and rels of a docx) as text, for the functions of (f). */
async function partsOf(bytes: Uint8Array, names?: string[]): Promise<Map<string, string>> {
  const parts = new Map<string, string>()
  if (names) {
    for (const name of names) {
      const text = await partText(bytes, name)
      if (text !== null) parts.set(name, text)
    }
    return parts
  }
  try {
    const zip = await JSZip.loadAsync(bytes)
    for (const [name, file] of Object.entries(zip.files)) {
      if (!file.dir && /\.(xml|rels)$/i.test(name)) parts.set(name, await file.async('string'))
    }
  } catch {
    // not a zip: no parts
  }
  return parts
}

const populations: Record<string, number> = {}
const bump = (key: string, by = 1): void => {
  populations[key] = (populations[key] ?? 0) + by
}

const seedOdts = await builtOdts(mulberry32(seed + 10))
const docxes = await docxCases()
const exportedOdts: OdtCase[] = []

if (!callsOnly) {
  for (const docx of docxes) {
    const comparison = docx.tracked ? exportTracked : exportBuilt
    const odt = await compareExport(comparison, `docxToOdt ${docx.name}`, docx.bytes)
    if (odt) exportedOdts.push({ name: `exported ${docx.name}`, bytes: odt, kind: 'exported' })
    bump(docx.tracked ? 'docxTracked' : 'docxBuilt')
    if (docx.rendered) {
      await compareExport(
        c.exportRendered,
        `docxToOdt with rendered objects ${docx.name}`,
        docx.bytes,
        docx.rendered,
      )
      bump('docxRendered')
    }
  }
  const random = mulberry32(seed + 20)
  const base = [...seedOdts, ...exportedOdts.slice(0, 20)]
  const mutatedOdtCases = [
    ...(await mutatedOdts(base, random, option('--mutations', 150))),
    ...mutatedContainers(base, random, option('--container-mutations', 60)),
  ]
  for (const docx of [
    ...(await mutatedDocx(docxes, random, option('--docx-mutations', 60))),
    ...mutatedDocxContainers(docxes, random, option('--docx-container-mutations', 30)),
  ]) {
    await compareExport(exportMutated, `docxToOdt ${docx.name}`, docx.bytes)
    bump('docxMutated')
  }

  for (const odt of [...seedOdts, ...exportedOdts, ...mutatedOdtCases]) {
    const opened = await compareOpen(c, odt.name, odt.bytes, odt.kind === 'mutation')
    bump(`odt-${odt.kind}`)
    if (!opened) continue
    bump(`odt-${odt.kind}-opened`)
    const styles = opened.bridge.styles
    const { edits } = await editsFor(
      opened.docx,
      styles,
      editRandomFor(seed, odt.name),
      odt.kind === 'built' || odt.kind === 'sample' ? editsPerOdt : editsPerDerived,
    )
    for (const edit of edits) {
      await compareSave(
        c,
        `${odt.name}, edit: ${edit.name}`,
        odt.bytes,
        opened.bridgeJson,
        edit.docx,
      )
      bump('edits')
    }
  }
}

// (f): the corpus documents, then the built inputs and the mutations
for (const odt of [...seedOdts, ...exportedOdts]) {
  await callsOnDocument(
    odt.name,
    await partsOf(odt.bytes, ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']),
  )
}
{
  const modelSeeds = docxes.filter((d) => d.bytes.length < 600_000).slice(0, 80)
  for (const docx of modelSeeds) {
    await callsOnDocument(docx.name, await partsOf(docx.bytes))
    const doc = await withClock(() => parseDocx(docx.bytes)).catch(() => null)
    if (doc) await callsOnModel(docx.name, doc)
  }
}
await callsAfterCorpus(mulberry32(seed))

console.log(
  `odt-diff: ${seedOdts.length} built ODTs, ${exportedOdts.length} exported from docx, ${docxes.length} docx (${docxes.filter((d) => d.tracked).length} tracked); populations ${JSON.stringify(populations)}`,
)
reportComparisons()
console.log(`rust panics (each one a difference above): ${panics}`)
if (panics > 0) failGate()
reportCalls()
if (!callsOnly) await reportDivergences()
if (process.argv.includes('--group') && !callsOnly) {
  console.error('A selected group is not the full gate. Use calls -- --group NAME for porting.')
  failGate()
}
void atFloor
void repoRoot
void isFailure
void tsDocxToOdt

const outputDir = process.env.ODT_DIFF_OUT ?? fileURLToPath(new URL('out', import.meta.url))
mkdirSync(outputDir, { recursive: true })
// One difference per line: the differences hold whole documents' texts.
const lines = (): string[] => observedDifferences.map((difference) => JSON.stringify(difference))
const writeLines = (path: string, flag: string): void => {
  writeFileSync(path, '', { flag })
  for (const line of lines()) appendFileSync(path, line + '\n')
}
writeLines(resolve(outputDir, callsOnly ? 'calls-differences.jsonl' : 'differences.jsonl'), 'w')
// what the floors of floors.json are to be set to, for the integrator to commit after the first run
writeFileSync(resolve(outputDir, 'populations.json'), JSON.stringify(populations, null, 2) + '\n')
const firstAt = process.argv.indexOf('--record-first')
if (firstAt !== -1) {
  const unit = process.argv[firstAt + 1]
  if (!unit || !/^[a-z0-9-]+$/.test(unit)) throw new Error('invalid first-run unit name')
  const evidence = resolve(repoRoot, 'crates/odt-engine/evidence')
  mkdirSync(evidence, { recursive: true })
  writeLines(resolve(evidence, `${unit}-first.differences.jsonl`), 'wx')
}
if (CONTROL) {
  // every line that compared something in the normal run (the populations are the same) must show differences
  const blind = reportLines.filter((line) => {
    const tally = /compared\s+(\d+)\s.*differences\s+(\d+)/.exec(line)
    return tally !== null && Number(tally[1]) > 0 && Number(tally[2]) === 0
  })
  for (const line of blind) console.error(`CONTROL BLIND: ${line.trim()}`)
  console.log(`positive control: ${blind.length} comparison lines saw no difference`)
  process.exit(blind.length > 0 ? 2 : 0)
}
process.exit(gateHasFailed() ? 1 : 0)
