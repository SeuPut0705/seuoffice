// Comparison (f), shared by the Word and the slides engines: the functions
// of the ported modules, each called by name on both sides: over the corpus,
// over built inputs and over seeded mutations of both.
import { isDeepStrictEqual } from 'node:util'
import type { ParsedDoc } from './reference/types'
import { ArgPool } from './calls-arg-mutation'
import type { CallSpec, Input } from './calls-spec'
import { byFunction, checkOutcome, flush, type Outcome, rustOutcome } from './compare-props'
import { mutate } from './compare-xml'
import { atFloor, Comparison, failGate, option } from './harness'
import { captureCalls, parseInternals } from './parse-internals'

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

export function createCallsRunner(all: Record<string, CallSpec[]>) {
  const groups: Group[] = Object.entries(all)
    .filter(([name, specs]) => specs.length > 0 && (ONLY_GROUP ?? name) === name)
    .map(([name, specs]) => ({
      name,
      specs,
      corpus: new Comparison(`(f) ${name} on the corpus, checks`, `calls${titled(name)}Corpus`),
      built: new Comparison(`(f) ${name} on built inputs, checks`, `calls${titled(name)}Built`),
      mutated: new Comparison(
        `(f+) ${name} on mutated texts, checks`,
        `calls${titled(name)}Mutated`,
      ),
      ...(specs.some((spec) => spec.argMutation)
        ? {
            argMutated: new Comparison(
              `(f+) ${name} on mutated arguments, checks`,
              `calls${titled(name)}ArgMutated`,
            ),
          }
        : {}),
      argRefused: 0,
    }))

  const seeds = new Map<string, Map<string, Input>>()
  const argSeeds = new Map<string, { pool: ArgPool; kept: Input[]; from: Map<string, number> }>()

  /** Every input of an `argMutation` function feeds its pool; every built one and some of the corpus stay as seeds. */
  function keepArguments(spec: CallSpec, where: string, input: Input, built = false): void {
    if (!spec.argMutation || input.args === undefined) return
    const seen = argSeeds.get(spec.fn) ?? {
      pool: new ArgPool(),
      kept: [],
      from: new Map<string, number>(),
    }
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
  async function callOutcomes(
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
  const listedClasses = new Map<string, { inputs: number; differ: number }>()

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

  /** One corpus input: compared, and kept as a seed of both mutations. */
  async function corpusInput(
    group: Group,
    where: string,
    spec: CallSpec,
    input: Input,
  ): Promise<void> {
    const kept = seeds.get(spec.fn) ?? new Map<string, Input>()
    seeds.set(spec.fn, kept)
    await check(group.corpus, where, spec, input)
    keepArguments(spec, where, input)
    const text = input.text ?? ''
    if (kept.size < SEEDS_KEPT && text.length > 0 && text.length < 20_000) {
      kept.set(text, input)
    }
  }

  /** The functions over what one corpus document holds. */
  async function callsOnDocument(where: string, parts: ReadonlyMap<string, string>): Promise<void> {
    for (const group of groups) {
      for (const spec of group.specs) {
        for (const input of spec.fromDocument?.(parts) ?? [])
          await corpusInput(group, where, spec, input)
      }
    }
  }

  /** Captured calls of one function compared per document, at most; the rest repeat. */
  const PARSE_INPUTS_PER_DOCUMENT = 300
  /** What every `fromParse` spec has compared already, by its input as JSON. */
  const parseSeen = new Map<string, Set<string>>()

  /**
   * The internal functions of parse.ts, with the arguments a parseDocx of this
   * document calls them with (parse-internals.ts). The input is taken at the
   * call, before the parser goes on to change what it passed.
   */
  async function callsOnParse(
    where: string,
    bytes: Uint8Array,
    parts: ReadonlyMap<string, string>,
  ): Promise<void> {
    const byFn = new Map<string, Array<{ group: Group; spec: CallSpec }>>()
    for (const group of groups) {
      for (const spec of group.specs) {
        if (spec.fromParse)
          byFn.set(spec.fromParse.fn, [...(byFn.get(spec.fromParse.fn) ?? []), { group, spec }])
      }
    }
    if (byFn.size === 0) return
    const internals = await parseInternals()
    const taken: Array<{ group: Group; spec: CallSpec; input: Input }> = []
    const perSpec = new Map<CallSpec, number>()
    await captureCalls(
      (fn, args) => {
        for (const { group, spec } of byFn.get(fn) ?? []) {
          if ((perSpec.get(spec) ?? 0) >= PARSE_INPUTS_PER_DOCUMENT) continue
          const input = spec.fromParse!.input(args, parts)
          if (!input) continue
          const seen = parseSeen.get(spec.fn) ?? new Set<string>()
          parseSeen.set(spec.fn, seen)
          const key = JSON.stringify(input)
          if (seen.has(key)) continue
          seen.add(key)
          perSpec.set(spec, (perSpec.get(spec) ?? 0) + 1)
          taken.push({ group, spec, input })
        }
      },
      () => Promise.resolve(internals.parseDocx!(bytes)).catch(() => null),
    )
    for (const { group, spec, input } of taken)
      await corpusInput(group, `${where} parse`, spec, input)
  }

  /** Save builders receive the same values parseDocx actually produced. */
  async function callsOnModel(where: string, doc: ParsedDoc): Promise<void> {
    for (const group of groups) {
      for (const spec of group.specs) {
        for (const input of spec.fromModel?.(doc) ?? []) {
          await check(group.corpus, `${where} parsed model`, spec, input)
          keepArguments(spec, where, input)
        }
      }
    }
  }

  /** Bytes a zip entry name holds at most: its length field is 16 bits. */
  const ZIP_NAME_LIMIT = 0xffff

  /**
   * A `parts` argument naming a part longer than any zip entry name. Swapping a
   * part's name and text makes one; JSZip then adds a folder per slash of it,
   * each a copy of the name, and a 350 KB text filled the gate's JavaScript heap.
   */
  function partNameBeyondZip(args: unknown): boolean {
    const parts = (args as { parts?: unknown } | null)?.parts
    return (
      Array.isArray(parts) &&
      parts.some(
        (part) =>
          Array.isArray(part) &&
          typeof part[0] === 'string' &&
          Buffer.byteLength(part[0]) > ZIP_NAME_LIMIT,
      )
    )
  }

  /** The built inputs and the mutations: run once the corpus has been read. */
  async function callsAfterCorpus(random: () => number): Promise<void> {
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
            if (args === undefined || partNameBeyondZip(args)) continue
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
          (input) => input.seed !== false && (input.text ?? '').length > 0,
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
  function reportCalls(): void {
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
    for (const [id, { inputs, differ }] of listedClasses) {
      console.log(
        `(f) listed class ${id}: ${inputs} inputs, ${differ} differ as listed and are not counted above`,
      )
    }
  }

  function callsReport(): object {
    return {
      node: process.version,
      groups: groups.map(({ name, corpus, built, mutated, argMutated, argRefused, specs }) => ({
        name,
        argRefused,
        populations: Object.fromEntries(
          [
            ['corpus', corpus],
            ['built', built],
            ['mutated', mutated],
            ...(argMutated ? [['argMutated', argMutated]] : []),
          ].map(([name, comparison]) => {
            const value = comparison as Comparison
            return [
              name,
              {
                compared: value.compared,
                differences: value.differences,
                keyOrderOnly: value.keyOrderOnly,
              },
            ]
          }),
        ),
        functions: specs.map(({ fn }) => {
          const tally = byFunction.get(fn)
          return {
            fn,
            checks: tally?.checks ?? 0,
            differences: tally?.differences ?? 0,
            distinctResults: tally?.outcomes.size ?? 0,
            typescriptThrew: tally?.threw ?? 0,
          }
        }),
      })),
    }
  }

  return {
    callOutcomes,
    callsOnDocument,
    callsOnParse,
    callsOnModel,
    callsAfterCorpus,
    reportCalls,
    callsReport,
    listedClasses,
  }
}
