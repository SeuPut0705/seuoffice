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
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { parseDocx } from '../../packages/docx-engine/src/index'
import { resolveMainDocumentPath } from '../../packages/docx-engine/src/parse-package'
import { fieldInstructions } from '../../packages/docx-engine/src/parse-props'
import { DEFAULT_THEME_COLORS } from '../../packages/docx-engine/src/theme'
import type { Run } from '../../packages/docx-engine/src/types'
import { loadDocxZip } from '../../packages/docx-engine/src/zip-load'
import { bench } from './bench'
import {
  brokenAtTheRoot,
  byFunction,
  compareModelDomains,
  compareModelValues,
  compareReaders,
  flush,
  type Group,
  inputsOf,
  inputsOfWhole,
  modelValuesOf,
  mutateProps,
  ODD_FONT_THEMES,
  ODD_VALUES,
  READER_ELEMENTS,
} from './compare-props'
import { compareScan } from './compare-scan'
import { compareRoundTrips, mutate } from './compare-xml'
import { compareZipText, textWithoutBuffer } from './compare-zip'
import { staleDivergences } from './divergences'
import { elementFragments } from './fragments'
import { Comparison, repoRoot, toolDir } from './harness'
import { READERS, type Themes } from './props-registry'
import { numberTexts, PROPS_INSTRUCTIONS, PROPS_RUN_LISTS, PROPS_TEXTS } from './props-synthetic'
import { mulberry32, SCAN_CASES, XML_CASES, zipTextCases } from './synthetic'

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const SHOW = option('--show', 5)
const FUZZ_CASES = option('--fuzz', 20_000)
const PROPS_FUZZ_CASES = option('--props-fuzz', 4_000)
const NUMBER_TEXTS = option('--numbers', 20_000)

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
  propsSynthetic: new Comparison('(d) readers on synthetic texts, checks', 'propsSyntheticChecks'),
  propsBroken: new Comparison('(d) readers on elements broken at the root', 'propsBrokenChecks'),
  propsModel: new Comparison('(d) model functions, checks', 'propsModelChecks'),
  propsMutated: new Comparison('(d+) readers on mutated fragments, checks', 'propsMutatedChecks'),
}
const readers: Record<Group, Comparison> = {
  pPr: new Comparison('(d) w:pPr readers, checks', 'propsPPrChecks'),
  rPr: new Comparison('(d) w:rPr readers, checks', 'propsRPrChecks'),
  paragraph: new Comparison('(d) paragraph and run readers, checks', 'propsParagraphChecks'),
  table: new Comparison('(d) table readers, checks', 'propsTableChecks'),
  values: new Comparison('(d) helpers on attribute values, checks', 'propsValueChecks'),
}
/** Fragments of each element the readers were called on, and what feeds the mutations. */
const fragmentCounts = new Map<string, number>()
const distinctFragments = new Map<string, Set<string>>()
const themesSeen: Themes[] = []
const runLists: Run[][] = []

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
  const parsed = await parseDocx(bytes).catch(() => null)
  const themes: Themes = {
    colors: parsed?.themeColors ?? undefined,
    fonts: parsed?.themeFonts ?? undefined,
  }
  themesSeen.push(themes)
  for (const block of parsed?.blocks ?? []) {
    const runs = (block as { runs?: Run[] }).runs
    if (runs && runs.length > 0 && JSON.stringify(runs).length < 20_000) runLists.push(runs)
  }
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.xml$/i.test(name)) continue
    const partXml = await file.async('string')
    const fragments = elementFragments(partXml, 'w:rPr')
    compareRoundTrips(comparisons.rPr, `${path}: ${name}`, fragments)
    for (const fragment of fragments) mutationSeeds.add(fragment)

    const inputs = inputsOf(partXml)
    for (const [element, list] of inputs.elements) {
      fragmentCounts.set(element, (fragmentCounts.get(element) ?? 0) + list.length)
      const distinct = distinctFragments.get(element) ?? new Set()
      for (const fragment of list) distinct.add(fragment)
      distinctFragments.set(element, distinct)
    }
    const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
    compareReaders(readers, `${path}: ${name}`, inputs, themes, partXml, instructions)
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

/** Every reader group recorded under one comparison. */
const allGroups = (comparison: Comparison): Record<Group, Comparison> =>
  Object.fromEntries(Object.keys(readers).map((group) => [group, comparison])) as Record<
    Group,
    Comparison
  >
const noteFragments = (elements: Map<string, string[]>): void => {
  for (const [element, list] of elements) {
    const distinct = distinctFragments.get(element) ?? new Set()
    for (const fragment of list) distinct.add(fragment)
    distinctFragments.set(element, distinct)
  }
}
const oddThemes = (index: number): Themes => ({
  colors: index % 3 === 0 ? { dk1: ' 1f2e3d ', accent1: 'abcdef', lt1: '' } : DEFAULT_THEME_COLORS,
  fonts: ODD_FONT_THEMES[index % ODD_FONT_THEMES.length],
})

const syntheticTexts = Object.entries(PROPS_TEXTS).flatMap(([group, texts]) =>
  texts.map((text, index) => ({ where: `synthetic "${group}" ${index}`, text })),
)
syntheticTexts.forEach(({ where, text }, index) => {
  const inputs = inputsOf(text)
  noteFragments(inputs.elements)
  const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
  if (index === 0) {
    for (const instruction of PROPS_INSTRUCTIONS) instructions.add(instruction)
    for (const value of ODD_VALUES) inputs.attributeValues.add(value)
    for (const value of numberTexts(random, NUMBER_TEXTS)) inputs.attributeValues.add(value)
  }
  for (const themes of [{}, oddThemes(index)]) {
    compareReaders(allGroups(comparisons.propsSynthetic), where, inputs, themes, text, instructions)
  }
})

const propsSeeds = [
  ...syntheticTexts.map(({ text }) => text),
  ...['w:pPr', 'w:rPr', 'w:tblPr', 'w:tcPr'].flatMap((name) => [
    ...(distinctFragments.get(name) ?? []),
  ]),
  ...[...(distinctFragments.get('w:p') ?? [])].filter((fragment) => fragment.length < 3000),
]

// inputsOf yields balanced elements only, so the texts the parser refuses are passed as they are
for (const name of [...READER_ELEMENTS, 'w:p']) {
  const fragments = [...(distinctFragments.get(name) ?? [])]
  const shape = fragments.find((fragment) => fragment.includes('<wps:wsp'))
  for (const fragment of [...fragments.slice(0, 3), ...(shape ? [shape] : [])]) {
    brokenAtTheRoot(fragment).forEach((text, index) => {
      compareReaders(
        allGroups(comparisons.propsBroken),
        `${name} broken at the root, way ${index}`,
        inputsOfWhole(text),
        oddThemes(index),
        text,
        [],
      )
    })
  }
}

for (let index = 0; index < PROPS_FUZZ_CASES; index++) {
  // half of the mutations start from a synthetic text: the tracked documents hold few constructs
  const seed =
    index % 2 === 0
      ? syntheticTexts[Math.floor(random() * syntheticTexts.length)]!.text
      : propsSeeds[Math.floor(random() * propsSeeds.length)]!
  // one in ten is broken as XML too, and goes to the readers whole as well
  const edited = mutateProps(seed, random)
  const broken = index % 10 === 9
  const fragment = broken ? mutate(edited, random) : edited
  const inputs = inputsOf(fragment)
  noteFragments(inputs.elements)
  const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
  compareReaders(
    allGroups(comparisons.propsMutated),
    `mutation ${index}`,
    inputs,
    oddThemes(index),
    fragment,
    instructions,
  )
  if (broken) {
    compareReaders(
      allGroups(comparisons.propsMutated),
      `mutation ${index}, whole`,
      inputsOfWhole(fragment),
      oddThemes(index),
      fragment,
      [],
    )
  }
}

const modelValues = modelValuesOf(
  distinctFragments.get('w:pPr') ?? [],
  distinctFragments.get('w:ind') ?? [],
)
compareModelDomains(comparisons.propsModel, themesSeen)
compareModelValues(
  comparisons.propsModel,
  { ...modelValues, runs: [...PROPS_RUN_LISTS, ...runLists] },
  random,
)
flush()

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
for (const comparison of [...Object.values(comparisons), ...Object.values(readers)]) {
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

for (const [element, key] of [
  ['w:pPr', 'pPrFragments'],
  ['w:rPr', 'rPrFragments'],
] as const) {
  const count = fragmentCounts.get(element) ?? 0
  console.log(
    `(d) ${element} fragments the readers were called on: ${count} (${atFloor(count, key)})`,
  )
}
console.log(
  `(d+) mutated fragments: ${PROPS_FUZZ_CASES} (${atFloor(PROPS_FUZZ_CASES, 'propsMutatedFragments')})`,
)
const oneResult = [...byFunction].filter(([, tally]) => tally.outcomes.size < 2).map(([fn]) => fn)
console.log(
  `(d) functions compared: ${byFunction.size} (${atFloor(byFunction.size, 'propsFunctions')}); ` +
    `with a single distinct result, so not really compared: ` +
    `${oneResult.length}${oneResult.length > 0 ? ` (${oneResult.join(', ')})` : ''}`,
)
if (oneResult.length > 0) failedGate = true
const overAnElement = new Set(
  READERS.filter((reader) => reader.on.some((on) => typeof on === 'object')).map(({ fn }) => fn),
)
const neverRefused = [...overAnElement].filter((fn) => (byFunction.get(fn)?.threw ?? 0) === 0)
console.log(
  `(d) readers over a parsed element: ${overAnElement.size}; never called on a text the TypeScript ` +
    `parser refuses: ${neverRefused.length}${neverRefused.length > 0 ? ` (${neverRefused.join(', ')})` : ''}`,
)
if (neverRefused.length > 0) failedGate = true
if (process.argv.includes('--by-function')) {
  for (const [fn, { checks, differences, threw, outcomes }] of [...byFunction].sort(
    (a, b) => b[1].differences - a[1].differences || a[0].localeCompare(b[0]),
  )) {
    console.log(
      `    ${fn.padEnd(26)} checks ${String(checks).padStart(8)}  differences ${String(differences).padStart(7)}  ` +
        `equal ${(100 * (1 - differences / checks)).toFixed(3)}%  distinct results ${outcomes.size}  ` +
        `TypeScript threw ${threw}`,
    )
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
