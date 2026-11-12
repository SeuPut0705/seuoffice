// Shared function comparisons: corpus inputs, built inputs and seeded mutations.
import type { CallSpec, Input } from './calls-spec'
import { byFunction, checkOutcome, flush, type Outcome, rustOutcome } from './compare-props'
import { mutate } from './compare-xml'
import { atFloor, Comparison, failGate, option } from './harness'

const CALL_FUZZ_CASES = option('--call-fuzz', 300)
const ONLY_GROUP = process.argv.includes('--group')
  ? process.argv[process.argv.indexOf('--group') + 1]
  : undefined
const SEEDS_KEPT = 40

interface Group {
  name: string
  specs: CallSpec[]
  corpus: Comparison
  built: Comparison
  mutated: Comparison
}

const titled = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

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
    }))
  const seeds = new Map<string, Map<string, Input>>()

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

  async function check(
    comparison: Comparison,
    where: string,
    spec: CallSpec,
    { text = '', args = {} }: Input,
  ): Promise<void> {
    const outcome = await typescriptOutcome(spec, text, args)
    checkOutcome(comparison, `${where}: ${spec.fn}`, spec.fn, text, args, () => outcome)
  }

  async function callsOnDocument(where: string, parts: ReadonlyMap<string, string>): Promise<void> {
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

  async function callsAfterCorpus(random: () => number): Promise<void> {
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

  function reportCalls(): void {
    for (const { name, specs } of groups) {
      const tallies = specs.map(({ fn }) => ({ fn, tally: byFunction.get(fn) }))
      const oneResult = tallies.filter(({ tally }) => (tally?.outcomes.size ?? 0) < 2)
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

  return { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls }
}
