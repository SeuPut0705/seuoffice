// Comparison (f): the functions of the modules ported after the property
// readers, each called by name on both sides: over the corpus, over built
// inputs and over seeded mutations of both.
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
import { DOCPROPS } from './calls-docprops'
import { FIELDS } from './calls-fields'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { RESOLVE } from './calls-resolve'
import { SECTION } from './calls-section'
import { ArgPool } from './calls-arg-mutation'
import type { CallSpec, Input } from './calls-spec'
import { byFunction, checkOutcome, flush, type Outcome, rustOutcome } from './compare-props'
import { mutate } from './compare-xml'
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
  /**
   * Mutated arguments with a non-finite number that the TypeScript writes
   * into its result as NaN or Infinity and the Rust does not: the defect
   * divergences.json lists per function and argument, on another input.
   */
  argNonFinite: number
}

const titled = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

const groups: Group[] = Object.entries({
  blank: BLANK,
  docprops: DOCPROPS,
  fields: FIELDS,
  markers: MARKERS,
  math: MATH,
  resolve: RESOLVE,
  section: SECTION,
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
    argNonFinite: 0,
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

async function check(
  comparison: Comparison,
  where: string,
  spec: CallSpec,
  { text = '', args = {} }: Input,
): Promise<void> {
  const outcome = await typescriptOutcome(spec, text, args)
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
      const nonFinite = (value: unknown): boolean => /NaN|Infinity/.test(JSON.stringify(value))
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
          const typescript = await typescriptOutcome(spec, text, args)
          if (nonFinite(args) && !nonFinite(text) && nonFinite(typescript) && !nonFinite(rust)) {
            group.argNonFinite += 1
            continue
          }
          checkOutcome(group.argMutated, `argument mutation ${done}: ${spec.fn}`, spec.fn, text, args, () => typescript)
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
  for (const { name, specs, argMutated, argRefused, argNonFinite } of groups) {
    if (argMutated) {
      console.log(
        `(f+) ${name}: ${argRefused} more mutated arguments were refused by the typed reader of the Rust side, ` +
          `and in ${argNonFinite} the TypeScript wrote a non-finite number the Rust does not write (divergences.json): those compared nothing`,
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
}

export function callsReport(): object {
  return {
    node: process.version,
    groups: groups.map(({ name, corpus, built, mutated, argMutated, argRefused, argNonFinite, specs }) => ({
      name,
      argRefused,
      argNonFinite,
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
