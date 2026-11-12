// Comparison (f): the functions of the modules ported after the property
// readers, each called by name on both sides: over the corpus, over built
// inputs and over seeded mutations of both.
import { isDeepStrictEqual } from 'node:util'
import { ALTCHUNK } from './calls-altchunk'
import type { ParsedDoc } from '../../packages/docx-engine/src/types'
import { GEN_RPR } from './calls-gen-rpr'
import { GEN_PROPS } from './calls-gen-props'
import { GEN_DRAWING } from './calls-gen-drawing'
import { GEN_DRAWING_BUILD } from './calls-gen-drawing-build'
import { GEN_TEXT } from './calls-gen-text'
import { GEN_TABLE } from './calls-gen-table'
import { GEN_FIELDS } from './calls-gen-fields'
import { GEN_RUNS } from './calls-gen-runs'
import { GEN_PARAGRAPH } from './calls-gen-paragraph'
import { BLANK } from './calls-blank'
import { BLOCKPASSES } from './calls-blockpasses'
import { CHART } from './calls-chart'
import { CHECKBOX } from './calls-checkbox'
import { DOCPROPS } from './calls-docprops'
import { DRAWING } from './calls-drawing'
import { FIELDDISPLAY } from './calls-fielddisplay'
import { FIELDS } from './calls-fields'
import { IMAGES } from './calls-images'
import { INK } from './calls-ink'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { RESOLVE } from './calls-resolve'
import { REVISION } from './calls-revision'
import { SECTION } from './calls-section'
import { VML } from './calls-vml'
import { ArgPool } from './calls-arg-mutation'
import type { CallSpec, Input } from './calls-spec'
import { byFunction, checkOutcome, flush, type Outcome, rustOutcome, SHOWN_CHARS } from './compare-props'
import { mutate } from './compare-xml'
import { maskNonFinite } from './listed'
import { atFloor, Comparison, failGate, option } from './harness'

const CALL_FUZZ_CASES = option('--call-fuzz', 300)
const ARG_FUZZ_CASES = option('--call-arg-fuzz', 1500)
/** `--group NAME`: that group alone, while it is being ported. */
const ONLY_GROUP = process.argv.includes('--group')
  ? process.argv[process.argv.indexOf('--group') + 1]
  : undefined
/** Corpus inputs kept per function as seeds of the mutations. */
const SEEDS_KEPT = 40
/** Corpus arguments kept per function as seeds of the argument mutations: so many of one document, so many in all. */
const ARG_SEEDS_PER_DOCUMENT = 8
const ARG_SEEDS_KEPT = 800

interface Group {
  name: string
  specs: CallSpec[]
  corpus: Comparison
  built: Comparison
  mutated: Comparison
  /** only where a spec asks for it */
  argMutated?: Comparison
  /** mutated arguments the typed reader of the Rust side refuses: not a call of the function */
  argRefused: number
}

const titled = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

const groups: Group[] = Object.entries({
  altchunk: ALTCHUNK,
  blank: BLANK,
  blockpasses: BLOCKPASSES,
  chart: CHART,
  checkbox: CHECKBOX,
  docprops: DOCPROPS,
  drawing: DRAWING,
  fielddisplay: FIELDDISPLAY,
  fields: FIELDS,
  images: IMAGES,
  ink: INK,
  markers: MARKERS,
  math: MATH,
  resolve: RESOLVE,
  revision: REVISION,
  section: SECTION,
  vml: VML,
  genRpr: GEN_RPR,
  genProps: GEN_PROPS,
  genDrawing: GEN_DRAWING,
  genDrawingBuild: GEN_DRAWING_BUILD,
  genText: GEN_TEXT,
  genTable: GEN_TABLE,
  genFields: GEN_FIELDS,
  genRuns: GEN_RUNS,
  genParagraph: GEN_PARAGRAPH,
})
  .filter(([name, specs]) => specs.length > 0 && (ONLY_GROUP ?? name) === name)
  .map(([name, specs]) => ({
    name,
    specs,
    corpus: new Comparison(`(f) ${name} on the corpus, checks`, `calls${titled(name)}Corpus`),
    built: new Comparison(`(f) ${name} on built inputs, checks`, `calls${titled(name)}Built`),
    mutated: new Comparison(`(f+) ${name} on mutated texts, checks`, `calls${titled(name)}Mutated`),
    ...(specs.some((spec) => spec.argMutation)
      ? { argMutated: new Comparison(`(f+) ${name} on mutated arguments, checks`, `calls${titled(name)}ArgMutated`) }
      : {}),
    argRefused: 0,
  }))

const seeds = new Map<string, Map<string, Input>>()
const argSeeds = new Map<string, { pool: ArgPool; kept: Input[]; from: Map<string, number> }>()

/** Every input of an `argMutation` function feeds its pool; every built one and some of the corpus stay as seeds. */
function keepArguments(spec: CallSpec, where: string, input: Input, built = false): void {
  if (!spec.argMutation || input.args === undefined) return
  const seen = argSeeds.get(spec.fn) ?? { pool: new ArgPool(), kept: [], from: new Map<string, number>() }
  argSeeds.set(spec.fn, seen)
  seen.pool.add(input.args)
  const taken = seen.from.get(where) ?? 0
  if (!built && (taken >= ARG_SEEDS_PER_DOCUMENT || seen.kept.length >= ARG_SEEDS_KEPT)) return
  seen.from.set(where, taken + 1)
  seen.kept.push(input)
}

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

/**
 * The classes compared under a mask (`CallSpec.masked`): the inputs where the
 * TypeScript wrote a non-finite number, how many of them were compared with
 * that value masked, and how many the Rust refused as its builders must.
 */
export const maskedClasses = new Map<string, { inputs: number; compared: number; refused: number }>()

/** One check whose two sides were compared here and not through the queue of compare-props. */
function recordCheck(comparison: Comparison, fn: string, outcome: string, difference: string | null): void {
  const tally = byFunction.get(fn) ?? { checks: 0, differences: 0, keyOrderOnly: 0, threw: 0, outcomes: new Set<string>() }
  byFunction.set(fn, tally)
  tally.checks += 1
  tally.outcomes.add(outcome)
  if (difference !== null) tally.differences += 1
  comparison.record(difference)
}

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
  const masked = spec.masked?.(text, args)
  if (masked !== undefined && 'value' in outcome) {
    const rust = rustOutcome(spec.fn, text, args)
    const pair = maskNonFinite(outcome.value, 'value' in rust ? rust.value : undefined)
    if (pair) {
      const count = maskedClasses.get(masked) ?? { inputs: 0, compared: 0, refused: 0 }
      maskedClasses.set(masked, count)
      count.inputs++
      const call = `${where}: ${spec.fn}(${JSON.stringify(text).slice(0, SHOWN_CHARS)}, ${JSON.stringify(args).slice(0, SHOWN_CHARS)})`
      const shown = (value: unknown): string => (JSON.stringify(value) ?? 'undefined').slice(0, SHOWN_CHARS)
      let difference: string | null = null
      if (spec.maskedRefuses) {
        count.refused++
        if (!('error' in rust)) difference = `${call}\n      the TypeScript wrote a non-finite number and Rust did not refuse: ${shown(rust)}`
      } else {
        count.compared++
        if ('error' in rust) difference = `${call}\n      the TypeScript wrote a non-finite number and Rust refused: ${shown(rust)}`
        else if (!isDeepStrictEqual(pair.typescript, pair.rust)) {
          // the two texts around the first place they differ
          const [ours, theirs] = [JSON.stringify(pair.typescript) ?? '', JSON.stringify(pair.rust) ?? '']
          let at = 0
          while (at < ours.length && ours[at] === theirs[at]) at++
          const from = Math.max(0, at - 120)
          difference = `${call}\n      under the mask, at ${at}\n      typescript ${ours.slice(from, at + 180)}\n      rust       ${theirs.slice(from, at + 180)}`
        }
      }
      recordCheck(comparison, spec.fn, JSON.stringify(outcome), difference)
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
        keepArguments(spec, where, input)
        const text = input.text ?? ''
        if (kept.size < SEEDS_KEPT && text.length > 0 && text.length < 20_000) {
          kept.set(text, input)
        }
      }
    }
  }
}
/** Save builders receive the same values parseDocx actually produced. */
export async function callsOnModel(where: string, doc: ParsedDoc): Promise<void> {
  for (const group of groups) {
    for (const spec of group.specs) {
      for (const input of spec.fromModel?.(doc) ?? []) {
        await check(group.corpus, `${where} parsed model`, spec, input)
        keepArguments(spec, where, input)
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
        keepArguments(spec, `built ${index}`, input, true)
      }
      const withArguments = argSeeds.get(spec.fn)
      if (group.argMutated && withArguments && withArguments.kept.length > 0) {
        let done = 0
        for (let tried = 0; done < ARG_FUZZ_CASES && tried < ARG_FUZZ_CASES * 4; tried++) {
          const seed = withArguments.kept[Math.floor(random() * withArguments.kept.length)]!
          const args = withArguments.pool.mutate(seed.args, random)
          if (args === undefined) continue
          const text = seed.text ?? ''
          const rust = rustOutcome(spec.fn, text, args)
          if ('error' in rust && /^the \w+ argument: /.test(rust.error)) {
            group.argRefused += 1
            continue
          }
          await check(group.argMutated, `argument mutation ${done}`, spec, { text, args })
          done += 1
        }
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
  for (const { name, specs, argMutated, argRefused } of groups) {
    if (argMutated) {
      console.log(
        `(f+) ${name}: ${argRefused} more mutated arguments were refused by the typed reader of the Rust side and compared nothing`,
      )
    }
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
  for (const [id, { inputs, compared, refused }] of maskedClasses) {
    console.log(
      `(f) masked class ${id}: in ${inputs} inputs the TypeScript wrote a non-finite number: ${compared} compared with that value masked, ${refused} where the Rust must refuse`,
    )
  }
  for (const [id, { inputs, differ }] of listedClasses) {
    console.log(
      `(f) listed class ${id}: ${inputs} inputs, ${differ} differ as listed and are not counted above`,
    )
  }
}

export function callsReport(): object {
  return {
    node: process.version,
    groups: groups.map(({ name, corpus, built, mutated, argMutated, argRefused, specs }) => ({
      name,
      argRefused,
      populations: Object.fromEntries(
        [['corpus', corpus], ['built', built], ['mutated', mutated], ...(argMutated ? [['argMutated', argMutated]] : [])].map(([name, comparison]) => {
          const value = comparison as Comparison
          return [name, { compared: value.compared, differences: value.differences, keyOrderOnly: value.keyOrderOnly }]
        }),
      ),
      functions: specs.map(({ fn }) => {
        const tally = byFunction.get(fn)
        return { fn, checks: tally?.checks ?? 0, differences: tally?.differences ?? 0,
          distinctResults: tally?.outcomes.size ?? 0, typescriptThrew: tally?.threw ?? 0 }
      }),
    })),
  }
}
