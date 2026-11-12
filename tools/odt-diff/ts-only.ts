// The TypeScript-only dry run (`run.mjs --ts-only`): builds the whole corpus and
// runs only the TypeScript side, with no wasm, and prints the populations. It
// proves that the corpus builds, that the edits apply, and what each function
// of comparison (f) gives on its inputs (the distinct results; a function with
// fewer than two is named).
import '../docx-diff/host'
import { isDeepStrictEqual } from 'node:util'
import { parseDocx } from '@seuoffice/docx-engine'
import { mulberry32 } from '../docx-diff/synthetic'
import {
  type OdtCase,
  builtOdts,
  docxCases,
  mutatedContainers,
  mutatedDocx,
  mutatedDocxContainers,
  mutatedOdts,
  partText,
} from './corpus'
import { editsFor } from './edits'
import { CALL_GROUPS } from './calls-groups'
import { isFailure, tsDocxToOdt, tsOdtToDocx, tsOdtToText, tsSaveOdt } from './ts-side'
import { withClock } from './clock'
import JSZip from 'jszip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

const option = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const seed = option('--seed', 20261112)
const print = (line: string): void => console.log(line)
const started = Date.now()

/** The text of every .xml and .rels entry of a docx. */
async function xmlParts(bytes: Uint8Array): Promise<Map<string, string>> {
  const parts = new Map<string, string>()
  try {
    const zip = await JSZip.loadAsync(bytes)
    for (const [name, file] of Object.entries(zip.files)) {
      if (!file.dir && /\.(xml|rels)$/i.test(name)) parts.set(name, await file.async('string'))
    }
  } catch {
    // not a zip
  }
  return parts
}

const odts: OdtCase[] = await builtOdts(mulberry32(seed + 10))
const docxes = await docxCases()
print(
  `corpus: ${odts.length} built ODTs (${odts.filter((o) => o.kind === 'sample').length} sample), ${docxes.filter((d) => d.tracked).length} tracked .docx, ${docxes.filter((d) => !d.tracked).length} built .docx`,
)

// (d) and (a): open every ODT; the exported ones of the docx corpus join them
let exportedOk = 0
let exportedFailed = 0
const exportedOdts: OdtCase[] = []
for (const docx of docxes) {
  const plain = await tsDocxToOdt(docx.bytes)
  if (isFailure(plain)) exportedFailed += 1
  else {
    exportedOk += 1
    exportedOdts.push({ name: `exported ${docx.name}`, bytes: plain.value.odt, kind: 'exported' })
  }
  if (docx.rendered) await tsDocxToOdt(docx.bytes, docx.rendered)
}
print(
  `(c) docxToOdt: ${exportedOk} converted, ${exportedFailed} refused (${docxes.filter((d) => d.rendered).length} also with rendered objects)`,
)

const random = mulberry32(seed + 20)
const seedsForMutation = [...odts, ...exportedOdts.slice(0, 20)]
const mutations = [
  ...(await mutatedOdts(seedsForMutation, random, option('--mutations', 150))),
  ...mutatedContainers(seedsForMutation, random, option('--container-mutations', 60)),
]
const docxMutations = [
  ...(await mutatedDocx(docxes, random, option('--docx-mutations', 60))),
  ...mutatedDocxContainers(docxes, random, option('--docx-container-mutations', 30)),
]
let mutatedConverted = 0
for (const docx of docxMutations)
  if (!isFailure(await tsDocxToOdt(docx.bytes))) mutatedConverted += 1
print(
  `mutations: ${mutations.length} ODT (${mutations.filter((m) => m.name.startsWith('container')).length} container), ${docxMutations.length} docx (${mutatedConverted} still convert)`,
)

const all = [...odts, ...exportedOdts, ...mutations]
let opened = 0
const refused = new Map<string, number>()
let textOk = 0
let edits = 0
let editsFailed = 0
let unchanged = 0
let saved = 0
let saveFailed = 0
const editRandom = mulberry32(seed + 30)
const bridges: Array<{ name: string; odt: OdtCase; bridgeJson: string }> = []
const documents: Array<[string, Map<string, string>]> = []
for (const odt of all) {
  const outcome = await tsOdtToDocx(odt.bytes)
  if (isFailure(outcome)) {
    refused.set(outcome.error.code, (refused.get(outcome.error.code) ?? 0) + 1)
  } else {
    opened += 1
    if (!isFailure(await tsOdtToText(odt.bytes))) textOk += 1
    const styles = outcome.value.bridge.styles
    const limit = odt.kind === 'exported' ? 2 : odt.kind === 'mutation' ? 2 : 8
    const made = await editsFor(outcome.value.docx, styles, editRandom, limit)
    editsFailed += made.failed
    for (const edit of made.edits) {
      edits += 1
      const result = await tsSaveOdt(odt.bytes, outcome.value.bridgeJson, edit.docx)
      if (isFailure(result)) saveFailed += 1
      else if (result.value.unchanged) unchanged += 1
      else saved += 1
    }
    bridges.push({ name: odt.name, odt, bridgeJson: outcome.value.bridgeJson })
  }
  if (odt.kind !== 'mutation' || true) {
    const parts = new Map<string, string>()
    for (const name of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) {
      const text = await partText(odt.bytes, name)
      if (text !== null) parts.set(name, text)
    }
    documents.push([odt.name, parts])
  }
}
print(
  `(a) odtToDocx: ${all.length} ODTs, ${opened} open, refused ${JSON.stringify(Object.fromEntries(refused))}`,
)
print(`(d) odtToText: ${textOk} read`)
print(
  `(b) saveOdt: ${edits} edits (${editsFailed} refused by the editor helpers), ${unchanged} unchanged, ${saved} saved, ${saveFailed} refused by saveOdt`,
)

// (f): every spec on the corpus documents and its built inputs, the distinct results
const tallies = new Map<string, { checks: number; results: Set<string>; threw: number }>()
async function call(spec: CallSpec, input: Input): Promise<void> {
  const { warn, error: logError } = console
  console.warn = console.error = () => {}
  let outcome: unknown
  try {
    const value: unknown = await spec.call(input.text ?? '', input.args ?? {})
    outcome = JSON.parse(
      JSON.stringify({ value }, (_k, v: unknown) =>
        v instanceof Map
          ? [...v]
          : v instanceof Set
            ? [...v]
            : typeof v === 'function'
              ? '[function]'
              : v,
      ),
    )
  } catch (error) {
    outcome = { error: String(error) }
  } finally {
    console.warn = warn
    console.error = logError
  }
  const tally = tallies.get(spec.fn) ?? { checks: 0, results: new Set<string>(), threw: 0 }
  tallies.set(spec.fn, tally)
  tally.checks += 1
  if (outcome && typeof outcome === 'object' && 'error' in outcome) tally.threw += 1
  tally.results.add(JSON.stringify(outcome))
}
const inputCounts = new Map<string, { corpus: number; built: number; model: number }>()
const count = (group: string, kind: 'corpus' | 'built' | 'model', n: number): void => {
  const c = inputCounts.get(group) ?? { corpus: 0, built: 0, model: 0 }
  c[kind] += n
  inputCounts.set(group, c)
}
const modelSeeds = docxes.filter((d) => d.bytes.length < 600_000).slice(0, 80)
const modelDocs = await Promise.all(
  modelSeeds.map(async (d) => withClock(() => parseDocx(d.bytes)).catch(() => null)),
)
for (const d of modelSeeds) documents.push([d.name, await xmlParts(d.bytes)])
for (const [group, specs] of Object.entries(CALL_GROUPS)) {
  for (const spec of specs) {
    for (const [, parts] of documents) {
      for (const input of spec.fromDocument?.(parts) ?? []) {
        await call(spec, input)
        count(group, 'corpus', 1)
      }
    }
    for (const doc of modelDocs) {
      if (!doc) continue
      for (const input of spec.fromModel?.(doc) ?? []) {
        await call(spec, input)
        count(group, 'model', 1)
      }
    }
    for (const input of spec.built) {
      await call(spec, input)
      count(group, 'built', 1)
    }
  }
}
for (const [group, specs] of Object.entries(CALL_GROUPS)) {
  const c = inputCounts.get(group) ?? { corpus: 0, built: 0, model: 0 }
  const few = specs.filter((s) => (tallies.get(s.fn)?.results.size ?? 0) < 2)
  print(
    `(f) ${group}: ${specs.length} functions; inputs: ${c.corpus} from the corpus, ${c.model} from models, ${c.built} built; with fewer than two distinct results: ${few.length}${few.length ? ` (${few.map((s) => s.fn).join(', ')})` : ''}`,
  )
  if (process.argv.includes('--by-function')) {
    for (const spec of specs) {
      const t = tallies.get(spec.fn)
      print(
        `    ${spec.fn.padEnd(40)} checks ${String(t?.checks ?? 0).padStart(6)}  distinct ${String(t?.results.size ?? 0).padStart(5)}  threw ${t?.threw ?? 0}`,
      )
    }
  }
}
void isDeepStrictEqual
void withClock
print(`ts-only: done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
