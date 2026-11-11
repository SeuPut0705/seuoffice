// Comparison (f): the functions of the modules ported after the property
// readers, each called by name on both sides: over the corpus, over built
// inputs and over seeded mutations of both.
import { BLANK } from './calls-blank'
import { DOCPROPS } from './calls-docprops'
import { FIELDS } from './calls-fields'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { SECTION } from './calls-section'
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
  /** Made at the first case that needs it: most groups have none. */
  lossy?: Comparison
}

const titled = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

const groups: Group[] = Object.entries({
  blank: BLANK,
  docprops: DOCPROPS,
  fields: FIELDS,
  markers: MARKERS,
  math: MATH,
  section: SECTION,
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

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * `value` with every lone surrogate as U+FFFD, in strings and in keys: what a
 * Rust string holds of it (`String::from_utf16_lossy`). A TypeScript result
 * with a lone surrogate can equal no Rust result, and divergences.json lists
 * one such case per cause; the rest of the result is still the port's to get
 * right, so those cases are compared in this form, on a line of their own.
 */
function lossy(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '\uFFFD')
  if (Array.isArray(value)) return value.map(lossy)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [lossy(key) as string, lossy(inner)]),
  )
}
/** Per group, the cases a spec names as a listed divergence. */
const listedCases = new Map<string, number>()

/**
 * What the TypeScript side gives, in the form the Rust reply has: a Map as
 * its entries, a Set as its values, a function made visible.
 */
async function typescriptOutcome(
  spec: CallSpec,
  text: string,
  args: Record<string, unknown>,
): Promise<{ outcome: Outcome; unpaired: boolean }> {
  let unpaired = false
  const wireForm = (key: string, value: unknown): unknown => {
    // not `test`: the pattern is global for `lossy`, and `test` would keep its place
    if (key.search(LONE_SURROGATE) !== -1) unpaired = true
    if (typeof value === 'string' && value.search(LONE_SURROGATE) !== -1) unpaired = true
    if (value instanceof Map) return [...(value as Map<unknown, unknown>)]
    if (value instanceof Set) return [...(value as Set<unknown>)]
    return typeof value === 'function' ? '[function]' : value
  }
  // the TypeScript logs what it degrades, with a stack: on mutated input that is thousands of lines
  const { warn, error: logError } = console
  console.warn = console.error = () => {}
  try {
    const value: unknown = await spec.call(text, args)
    return { outcome: JSON.parse(JSON.stringify({ value }, wireForm)) as Outcome, unpaired }
  } catch (error) {
    return { outcome: { error: String(error) }, unpaired }
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
  const { outcome } = await typescriptOutcome(spec, text, args)
  return { typescript: outcome, rust: rustOutcome(fn, text, args) }
}

async function check(
  group: Group,
  comparison: Comparison,
  where: string,
  spec: CallSpec,
  { text = '', args = {} }: Input,
): Promise<void> {
  if (spec.listed?.(text, args)) {
    listedCases.set(group.name, (listedCases.get(group.name) ?? 0) + 1)
    return
  }
  const { outcome, unpaired } = await typescriptOutcome(spec, text, args)
  if (unpaired) {
    group.lossy ??= new Comparison(
      `(f) ${group.name}, lone surrogates as U+FFFD, checks`,
      `calls${titled(group.name)}Lossy`,
    )
    const expected = lossy(outcome) as Outcome
    checkOutcome(group.lossy, `${where}: ${spec.fn}`, spec.fn, text, args, () => expected)
    return
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
        await check(group, group.corpus, where, spec, input)
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
        await check(group, group.built, `built ${index}`, spec, input)
      }
      if (spec.mutation === 'none') continue
      const from = [...spec.built, ...(seeds.get(spec.fn)?.values() ?? [])].filter(
        (input) => (input.text ?? '').length > 0,
      )
      if (from.length === 0) continue
      for (let done = 0; done < CALL_FUZZ_CASES; done++) {
        const seed = from[Math.floor(random() * from.length)]!
        const text = mutate(seed.text!, random)
        await check(group, group.mutated, `mutation ${done}`, spec, { text, args: seed.args })
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
        `; never threw in TypeScript: ${neverThrew.length} of ${specs.length}` +
        `; cases left out as listed divergences: ${listedCases.get(name) ?? 0}`,
    )
    if (oneResult.length > 0) failGate()
    if (!process.argv.includes('--by-function')) continue
    for (const { fn, tally } of tallies) {
      console.log(
        `    ${fn.padEnd(40)} checks ${String(tally?.checks ?? 0).padStart(7)}  ` +
          `differences ${String(tally?.differences ?? 0).padStart(6)}  ` +
          `distinct results ${String(tally?.outcomes.size ?? 0).padStart(5)}  ` +
          `TypeScript threw ${tally?.threw ?? 0}`,
      )
    }
  }
}
