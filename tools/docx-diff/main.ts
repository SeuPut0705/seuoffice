// Parity gate of the Rust docx engine (crates/) against the TypeScript engine of
// this checkout, over every .docx tracked in the repository. Exit code 1 on any
// difference, any population below floors.json, or a stale divergences.json.
//
//   npm --prefix tools/docx-diff run gate     builds the wasm first
//   npx tsx tools/docx-diff/main.ts [--show N] [--fuzz N] [--seed N] [--bench]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { resolveMainDocumentPath } from '../../packages/docx-engine/src/parse-package'
import { loadDocxZip } from '../../packages/docx-engine/src/zip-load'
import { bench } from './bench'
import { compareScan } from './compare-scan'
import { compareRoundTrips, mutate, rPrFragments } from './compare-xml'
import { compareZipText, textWithoutBuffer } from './compare-zip'
import { staleDivergences } from './divergences'
import { Comparison, repoRoot, toolDir } from './harness'
import { mulberry32, SCAN_CASES, XML_CASES, zipTextCases } from './synthetic'

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const SHOW = option('--show', 5)
const FUZZ_CASES = option('--fuzz', 20_000)

const comparisons = {
  scan: new Comparison('(a) scanBody, corpus documents', 'scanBodyDocuments'),
  scanSynthetic: new Comparison('(a) scanBody, synthetic', 'scanBodySynthetic'),
  rPr: new Comparison('(b) w:rPr round trip, corpus fragments', 'rPrFragments'),
  xmlSynthetic: new Comparison('(b) round trip, synthetic fragments', 'roundTripSynthetic'),
  bodyElements: new Comparison('(b+) body element round trip, corpus', 'bodyElements'),
  fuzz: new Comparison('(b+) round trip, seeded mutations', 'roundTripMutations'),
  zipText: new Comparison('(c) zip entry text, corpus entries', 'zipEntries'),
  zipXmlText: new Comparison('(c) of which .xml and .rels entries', 'zipXmlEntries'),
  zipSynthetic: new Comparison('(c) zip entry text, synthetic entries', 'zipSyntheticEntries'),
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
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.xml$/i.test(name)) continue
    const fragments = rPrFragments(await file.async('string'))
    compareRoundTrips(comparisons.rPr, `${path}: ${name}`, fragments)
    for (const fragment of fragments) mutationSeeds.add(fragment)
  }

  const mainPath = await resolveMainDocumentPath(zip)
  const documentXml = mainPath === null ? undefined : await zip.file(mainPath)?.async('string')
  if (documentXml === undefined) {
    skipped.noMainPart.push(path)
    continue
  }
  mainParts.push(documentXml)
  const { typescript, difference } = compareScan(path, documentXml)
  comparisons.scan.record(difference)
  if ('scan' in typescript) {
    const elements = typescript.scan.elements.map((e) => documentXml.slice(e.start, e.end))
    compareRoundTrips(comparisons.bodyElements, `${path}: ${mainPath}`, elements)
    for (const element of elements) if (element.length < 4000) mutationSeeds.add(element)
  }
}

for (const [name, xml] of Object.entries(SCAN_CASES)) {
  comparisons.scanSynthetic.record(compareScan(`synthetic "${name}"`, xml).difference)
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

const floors = JSON.parse(readFileSync(resolve(toolDir, 'floors.json'), 'utf8')) as Record<
  string,
  number
>
let failedGate = false
const atFloor = (count: number, key: string): string => {
  const floor = key === 'roundTripMutations' ? FUZZ_CASES : floors[key]
  if (floor !== undefined && count >= floor) return `floor ${String(floor).padStart(6)}`
  failedGate = true
  return `floor ${String(floor ?? 'missing').padStart(6)}  BELOW FLOOR`
}

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
for (const comparison of Object.values(comparisons)) {
  if (comparison.differences.length > 0) failedGate = true
  console.log(
    `${comparison.label.padEnd(46)} compared ${String(comparison.compared).padStart(6)}  ` +
      `${atFloor(comparison.compared, comparison.floorKey)}  differences ${comparison.differences.length}` +
      (comparison.typescriptThrew > 0
        ? `  (TypeScript threw in ${comparison.typescriptThrew}: Rust must refuse those too)`
        : ''),
  )
  for (const difference of comparison.differences.slice(0, SHOW)) console.log(`    - ${difference}`)
  if (comparison.differences.length > SHOW) {
    console.log(`    ... ${comparison.differences.length - SHOW} more (--show N)`)
  }
}

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
if (ledger.stale.length > 0 || xmlWithoutBuffer.length > 0) failedGate = true

if (process.argv.includes('--bench')) await bench(mainParts, loadable)

process.exit(failedGate ? 1 : 0)
