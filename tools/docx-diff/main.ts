// Parity gate of the Rust docx engine (crates/) against the TypeScript engine of
// this checkout, over every .docx tracked in the repository. Exit code 1 on any
// difference, any population below floors.json, or a stale divergences.json.
//
//   npm --prefix tools/docx-diff run gate     builds the wasm first
//   npx tsx tools/docx-diff/main.ts [--show N] [--seed N] [--fuzz N] [--props-fuzz N]
//                                   [--numbers N] [--by-function] [--bench]
//
// floors.json holds the populations of a run with the default options. The
// counts that follow the corpus are exact; the ones that follow the seeded
// generators (synthetic, model and mutated checks) are rounded down, so adding
// an input does not move them.
//
// This file reads the corpus and hands each document and part to the
// comparisons. A comparison lives in one module (compare-*.ts, with a
// *-run.ts where it has populations of its own to build) and registers the
// lines it reports by constructing a Comparison.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { parseDocx } from './reference/index'
import { resolveMainDocumentPath } from './reference/parse-package'
import { loadDocxZip } from './reference/zip-load'
import { bench } from './bench'
import { callsAfterCorpus, callsOnDocument, callsOnModel, callsOnParse, reportCalls } from './calls-run'
import { compareBlankBytes } from './compare-blank'
import { compareScan } from './compare-scan'
import { compareRoundTrips, mutate } from './compare-xml'
import { compareZipText, textWithoutBuffer } from './compare-zip'
import { staleDivergences } from './divergences'
import { elementFragments } from './fragments'
import {
  atFloor,
  Comparison,
  failGate,
  gateHasFailed,
  option,
  repoRoot,
  reportComparisons,
  SHOW,
} from './harness'
import type { Themes } from './props-registry'
import { packageAfterCorpus, packageOnDocument, reportPackage } from './package-run'
import { propsAfterCorpus, propsOnDocument, propsOnPart, reportProps } from './props-run'
import { mulberry32, SCAN_CASES, XML_CASES, zipTextCases } from './synthetic'
import { modelAfterCorpus, modelOnDocument, reportModel } from './model-run'

const FUZZ_CASES = option('--fuzz', 20_000)

const comparisons = {
  scan: new Comparison('(a) scanBody, corpus documents', 'scanBodyDocuments'),
  scanSynthetic: new Comparison('(a) scanBody, synthetic', 'scanBodySynthetic'),
  rPr: new Comparison('(b) w:rPr round trip, corpus fragments', 'rPrFragments'),
  xmlSynthetic: new Comparison('(b) round trip, synthetic fragments', 'roundTripSynthetic'),
  bodyElements: new Comparison('(b+) body element round trip, corpus', 'bodyElements'),
  fuzz: new Comparison('(b+) round trip, seeded mutations', FUZZ_CASES),
  zipText: new Comparison('(c) zip entry text, corpus entries', 'zipEntries'),
  zipXmlText: new Comparison('(c) of which .xml and .rels entries', 'zipXmlEntries'),
  zipSynthetic: new Comparison('(c) zip entry text, synthetic entries', 'zipSyntheticEntries'),
  writtenZips: new Comparison('(g) zips written: blank documents and packages', 'writtenZips'),
}

const corpus = execFileSync('git', ['ls-files', '-z', '*.docx'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const skipped = { encrypted: [] as string[], refused: [] as string[], noMainPart: [] as string[] }
const mainParts: string[] = []
const loadable: Uint8Array[] = []
const mutationSeeds = new Set<string>()
// The baseline is JSZip's decoder in Node. Hosts without a global Buffer get
// another one: these are the corpus entries it would read differently.
const withoutBuffer = { entries: 0, differing: [] as string[] }

for (const path of corpus) {
  const bytes = new Uint8Array(readFileSync(resolve(repoRoot, path)))
  // an encrypted docx is an OLE compound file, not a zip: neither engine reads it here
  if (OLE_MAGIC.equals(bytes.subarray(0, 8))) {
    skipped.encrypted.push(path)
    continue
  }

  for (const { name, difference, read } of await compareZipText(path, bytes)) {
    comparisons.zipText.record(difference)
    if (/\.(xml|rels)$/i.test(name)) comparisons.zipXmlText.record(difference)
    if (read) {
      withoutBuffer.entries += 1
      if ((await textWithoutBuffer(read.file)) !== read.text) {
        withoutBuffer.differing.push(`${path}: ${name}`)
      }
    }
  }

  let zip: JSZip
  try {
    zip = await loadDocxZip(bytes)
  } catch (error) {
    skipped.refused.push(`${path}: ${String(error)}`)
    continue
  }
  loadable.push(bytes)
  await packageOnDocument(path, bytes, zip)
  const parsed = await parseDocx(bytes).catch(() => null)
  if (parsed) await callsOnModel(path, parsed)
  if (parsed) modelOnDocument(path, parsed)
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
  const parts = new Map<string, string>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir && /\.(xml|rels)$/i.test(name)) parts.set(name, await file.async('string'))
  }
  await callsOnDocument(path, parts)
  await callsOnParse(path, bytes, parts)
  for (const [name, partXml] of parts) {
    if (!/\.xml$/i.test(name)) continue
    const fragments = elementFragments(partXml, 'w:rPr')
    compareRoundTrips(comparisons.rPr, `${path}: ${name}`, fragments)
    for (const fragment of fragments) mutationSeeds.add(fragment)
    propsOnPart(`${path}: ${name}`, partXml, themes)
  }

  const mainPath = await resolveMainDocumentPath(zip)
  const documentXml = mainPath === null ? undefined : await zip.file(mainPath)?.async('string')
  if (documentXml === undefined) {
    skipped.noMainPart.push(path)
    continue
  }
  mainParts.push(documentXml)
  const { typescript, difference, keyOrderOnly } = compareScan(path, documentXml)
  comparisons.scan.record(difference, keyOrderOnly)
  if ('scan' in typescript) {
    const elements = typescript.scan.elements.map((e) => documentXml.slice(e.start, e.end))
    compareRoundTrips(comparisons.bodyElements, `${path}: ${mainPath}`, elements)
    for (const element of elements) if (element.length < 4000) mutationSeeds.add(element)
  }
}

for (const [name, xml] of Object.entries(SCAN_CASES)) {
  const synthetic = compareScan(`synthetic "${name}"`, xml)
  comparisons.scanSynthetic.record(synthetic.difference, synthetic.keyOrderOnly)
}
for (const [group, fragments] of Object.entries(XML_CASES)) {
  compareRoundTrips(comparisons.xmlSynthetic, `synthetic "${group}"`, fragments)
}

const random = mulberry32(option('--seed', 20261111))
const seeds = [...mutationSeeds]
for (let done = 0; done < FUZZ_CASES; done += 500) {
  const batch = Array.from({ length: Math.min(500, FUZZ_CASES - done) }, () =>
    mutate(seeds[Math.floor(random() * seeds.length)]!, random),
  )
  compareRoundTrips(comparisons.fuzz, `mutations from ${done}`, batch)
}

propsAfterCorpus(random)
await packageAfterCorpus(random)
await callsAfterCorpus(random)
await modelAfterCorpus()
const written = await compareBlankBytes()
comparisons.writtenZips.compared = written.compared
comparisons.writtenZips.differences.push(...written.differences)

const CHECKSUM_MARKER = 'content whose checksum goes stale'
for (const compression of ['STORE', 'DEFLATE'] as const) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(zipTextCases())) zip.file(name, content)
  zip.file('stale-checksum.xml', CHECKSUM_MARKER, { compression: 'STORE' })
  const container = await zip.generateAsync({ type: 'uint8array', compression })
  container[Buffer.from(container.buffer).indexOf(CHECKSUM_MARKER)] = 0x43
  for (const { difference } of await compareZipText(`synthetic ${compression}`, container)) {
    comparisons.zipSynthetic.record(difference)
  }
}

const ledger = await staleDivergences()

console.log(
  `docx-diff: ${corpus.length} tracked .docx (${atFloor(corpus.length, 'trackedDocuments')}); ` +
    `skipped ${skipped.encrypted.length} encrypted, ${skipped.refused.length} refused by loadDocxZip, ` +
    `${skipped.noMainPart.length} without a main part`,
)
for (const line of [
  ...skipped.encrypted.map((path) => `encrypted: ${path}`),
  ...skipped.refused,
  ...skipped.noMainPart,
]) {
  console.log(`  skipped ${line}`)
}
reportComparisons()
reportProps()
reportPackage()
reportCalls()
reportModel()
console.log(
  `(g) raw zip fields that differ between the two writers, each following from the deflate stream: ` +
    [...written.rawFields].map(([field, count]) => `${field} ${count}`).join(', '),
)
const nonAscii = mainParts.filter((xml) => /[^\0-\x7f]/.test(xml)).length
console.log(
  `offsets: ${nonAscii} of ${mainParts.length} main parts hold non-ASCII text, where a byte offset ` +
    `is not a string index (${atFloor(nonAscii, 'nonAsciiMainParts')})`,
)
const xmlWithoutBuffer = withoutBuffer.differing.filter((name) => /\.(xml|rels)$/i.test(name))
console.log(
  `hosts without Buffer: JSZip would decode ${withoutBuffer.differing.length} of ${withoutBuffer.entries} ` +
    `corpus entries differently; ${xmlWithoutBuffer.length} of them are .xml or .rels`,
)
for (const name of xmlWithoutBuffer.slice(0, SHOW)) console.log(`    - ${name}`)
console.log(`divergences.json: ${ledger.listed} listed, ${ledger.stale.length} no longer reproduce`)
for (const line of ledger.stale) console.log(`    - ${line}`)
if (ledger.stale.length > 0 || xmlWithoutBuffer.length > 0) failGate()

if (process.argv.includes('--bench')) await bench(mainParts, loadable)

process.exit(gateHasFailed() ? 1 : 0)
