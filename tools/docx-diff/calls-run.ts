// Comparison (f): the functions of the modules ported after the property
// readers, each called by name on both sides: over the corpus, over built
// inputs and over seeded mutations of both.
import { isDeepStrictEqual } from 'node:util'
import { ALTCHUNK } from './calls-altchunk'
import { BLANK } from './calls-blank'
import { CHECKBOX } from './calls-checkbox'
import { DOCPROPS } from './calls-docprops'
import { DRAWING } from './calls-drawing'
import { FIELDDISPLAY } from './calls-fielddisplay'
import { FIELDS } from './calls-fields'
import { IMAGES } from './calls-images'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { RESOLVE } from './calls-resolve'
import { REVISION } from './calls-revision'
import { SECTION } from './calls-section'
import { VML } from './calls-vml'
import type { CallSpec, Input } from './calls-spec'
import { byFunction, checkOutcome, flush, type Outcome, rustOutcome } from './compare-props'
import { mutate } from './compare-xml'
import { atFloor, Comparison, failGate, option } from './harness'

const CALL_FUZZ_CASES = option('--call-fuzz', 300)
/** `--group NAME`: that group alone, while it is being ported. */
const ONLY_GROUP = process.argv.includes('--group')
  ? process.argv[process.argv.indexOf('--group') + 1]
  : undefined
/** Corpus inputs kept per function as seeds of the mutations. */
const SEEDS_KEPT = 40

interface Group {
  name: string
  specs: CallSpec[]
  corpus: Comparison
  built: Comparison
  mutated: Comparison
}

const titled = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

const groups: Group[] = Object.entries({
  altchunk: ALTCHUNK,
  blank: BLANK,
  checkbox: CHECKBOX,
  docprops: DOCPROPS,
  drawing: DRAWING,
  fielddisplay: FIELDDISPLAY,
  fields: FIELDS,
  images: IMAGES,
  markers: MARKERS,
  math: MATH,
  resolve: RESOLVE,
  revision: REVISION,
  section: SECTION,
  vml: VML,
})
  .filter(([name, specs]) => specs.length > 0 && (ONLY_GROUP ?? name) === name)
  .map(([name, specs]) => ({
    name,
    specs,
    corpus: new Comparison(`(f) ${name} on the corpus, checks`, `calls${titled(name)}Corpus`),
    built: new Comparison(`(f) ${name} on built inputs, checks`, `calls${titled(name)}Built`),
    mutated: new Comparison(`(f+) ${name} on mutated texts, checks`, `calls${titled(name)}Mutated`),
  }))

const seeds = new Map<string, Map<string, Input>>()

/**
 * What the TypeScript side gives, in the form the Rust reply has: a Map as
 * its entries, a Set as its values, a function made visible. A lone surrogate
 * in it shows as a difference: a Rust string cannot hold one.
 */
async function typescriptOutcome(
  spec: CallSpec,
  text: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const wireForm = (_key: string, value: unknown): unknown => {
    if (value instanceof Map) return [...(value as Map<unknown, unknown>)]
    if (value instanceof Set) return [...(value as Set<unknown>)]
    return typeof value === 'function' ? '[function]' : value
  }
  // the TypeScript logs what it degrades, with a stack: on mutated input that is thousands of lines
  const { warn, error: logError } = console
  console.warn = console.error = () => {}
  try {
    const value: unknown = await spec.call(text, args)
    return JSON.parse(JSON.stringify({ value }, wireForm)) as Outcome
  } catch (error) {
    return { error: String(error) }
  } finally {
    console.warn = warn
    console.error = logError
  }
}

/** Both sides of one call, for the ledger of divergences. */
export async function callOutcomes(
  fn: string,
  text: string,
  args: Record<string, unknown>,
): Promise<{ typescript: unknown; rust: unknown }> {
  const spec = groups.flatMap(({ specs }) => specs).find((candidate) => candidate.fn === fn)
  if (!spec) return { typescript: 'no such function', rust: 'no such function' }
  return {
    typescript: await typescriptOutcome(spec, text, args),
    rust: rustOutcome(fn, text, args),
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** No string in `value`, key or value, holds half a surrogate pair. */
function wellFormed(value: unknown): boolean {
  if (typeof value === 'string') return !LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.every(wellFormed)
  if (typeof value !== 'object' || value === null) return true
  return Object.entries(value).every(([key, item]) => wellFormed(key) && wellFormed(item))
}

/**
 * The classes of divergences.json the specs name (`CallSpec.listed`): how many
 * inputs fell in each and how many of those differed.
 */
export const listedClasses = new Map<string, { inputs: number; differ: number }>()

async function check(
  comparison: Comparison,
  where: string,
  spec: CallSpec,
  { text = '', args = {} }: Input,
): Promise<void> {
  // JSON cannot carry half a surrogate pair to Rust: the whole batch would be
  // refused, so the input that holds one is named here instead
  if (!wellFormed(text) || !wellFormed(args)) {
    throw new Error(`${where}: ${spec.fn}: the input holds a lone surrogate`)
  }
  const outcome = await typescriptOutcome(spec, text, args)
  const id = spec.listed?.(text, args)
  if (id !== undefined) {
    const rust = rustOutcome(spec.fn, text, args)
    const same = 'error' in outcome ? 'error' in rust : isDeepStrictEqual(outcome, rust)
    const count = listedClasses.get(id) ?? { inputs: 0, differ: 0 }
    listedClasses.set(id, count)
    count.inputs++
    if (!same) {
      count.differ++
      return
    }
  }
  checkOutcome(comparison, `${where}: ${spec.fn}`, spec.fn, text, args, () => outcome)
}

/** The functions over what one corpus document holds. */
export async function callsOnDocument(
  where: string,
  parts: ReadonlyMap<string, string>,
): Promise<void> {
  for (const group of groups) {
    for (const spec of group.specs) {
      const kept = seeds.get(spec.fn) ?? new Map<string, Input>()
      seeds.set(spec.fn, kept)
      for (const input of spec.fromDocument?.(parts) ?? []) {
        await check(group.corpus, where, spec, input)
        const text = input.text ?? ''
        if (kept.size < SEEDS_KEPT && text.length > 0 && text.length < 20_000) {
          kept.set(text, input)
        }
      }
    }
  }
}

/** The built inputs and the mutations: run once the corpus has been read. */
export async function callsAfterCorpus(random: () => number): Promise<void> {
  for (const group of groups) {
    for (const spec of group.specs) {
      for (const [index, input] of spec.built.entries()) {
        await check(group.built, `built ${index}`, spec, input)
      }
      if (spec.mutation === 'none') continue
      const from = [...spec.built, ...(seeds.get(spec.fn)?.values() ?? [])].filter(
        (input) => (input.text ?? '').length > 0,
      )
      if (from.length === 0) continue
      for (let done = 0; done < CALL_FUZZ_CASES; done++) {
        const seed = from[Math.floor(random() * from.length)]!
        const text = mutate(seed.text!, random)
        await check(group.mutated, `mutation ${done}`, spec, { text, args: seed.args })
      }
    }
  }
  flush()
}

/** The coverage of (f), after the comparison lines. */
export function reportCalls(): void {
  for (const { name, specs } of groups) {
    const tallies = specs.map(({ fn }) => ({ fn, tally: byFunction.get(fn) }))
    const oneResult = tallies.filter(({ tally }) => (tally?.outcomes.size ?? 0) < 2)
    // told, not required: a function may have no input it refuses
    const neverThrew = specs
      .filter((spec) => spec.mutation !== 'none')
      .filter(({ fn }) => (byFunction.get(fn)?.threw ?? 0) === 0)
    console.log(
      `(f) ${name}: ${specs.length} functions (${atFloor(specs.length, `calls${titled(name)}Functions`)}); ` +
        `with a single distinct result, so not really compared: ${oneResult.length}` +
        (oneResult.length > 0 ? ` (${oneResult.map(({ fn }) => fn).join(', ')})` : '') +
        `; never threw in TypeScript: ${neverThrew.length} of ${specs.length}`,
    )
    if (oneResult.length > 0) failGate()
    if (!process.argv.includes('--by-function')) continue
    for (const { fn, tally } of tallies) {
      console.log(
        `    ${fn.padEnd(40)} checks ${String(tally?.checks ?? 0).padStart(7)}  ` +
          `differences ${String(tally?.differences ?? 0).padStart(6)}  ` +
          `key order only ${String(tally?.keyOrderOnly ?? 0).padStart(6)}  ` +
          `distinct results ${String(tally?.outcomes.size ?? 0).padStart(5)}  ` +
          `TypeScript threw ${tally?.threw ?? 0}`,
      )
    }
  }
  for (const [id, { inputs, differ }] of listedClasses) {
    console.log(
      `(f) listed class ${id}: ${inputs} inputs, ${differ} differ as listed and are not counted above`,
    )
  }
}
