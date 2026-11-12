import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '../../packages/zip-gate/src/index'
import { Engine, failed } from '../docx-diff/engine'
import {
  atFloor, Comparison, failGate, gateHasFailed, option, repoRoot, reportComparisons, WASM_PATH,
} from '../docx-diff/harness'
import { keyOrderDifference, keyOrderDifferences, keysAsWritten } from '../docx-diff/key-order'
import { mutate } from '../docx-diff/compare-xml'
import { mutateContainer } from '../docx-diff/package-zips'
import { mulberry32 } from '../docx-diff/synthetic'
import type { Input, Spec } from './spec'
import { isolatedOutcomes } from './isolated'
import { type Outcome, typescriptOutcome, withoutHostText } from './outcome'
import { fixtureBytes } from './zip-fixture'
import { HOST_STEPS } from './host-steps'

export type { Input, Spec } from './spec'

interface WireInput { label: string; text?: string; bytesBase64?: string; args?: Record<string, unknown>; isolate?: true }
/** Every object of a value, where it is and its keys in the order they were written. */
type KeyOrders = Array<{ path: string; keys: string[] }>
interface Divergence {
  id: string
  fn: string
  input: WireInput
  typescript: Outcome
  rust: Outcome
  /** The order Rust wrote its keys in: `rust` read back from JSON has lost it. */
  rustKeyOrders: KeyOrders
  reason: string
}
interface RuntimeFailure { fn: string; label: string; kind: 'trap' | 'host' | 'isolated'; message: string }
interface Tally { compared: number; differences: number; listed: number; errors: number; outcomes: Set<string> }

export interface SuiteConfig {
  /** Holds floors.json and divergences.json; `--save` paths resolve against it. */
  directory: string
  /** Each group's specs; `--group` runs one of them. */
  groups: Record<string, Spec[]>
  /** The engine command every spec's `fn` is called through. */
  command?: string
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
/** Every file under the crates the WASM was built from, `target` left out, as one hash. */
function sourceTree(root: string): { root: string; sha256: string; files: number } {
  const hash = createHash('sha256')
  let files = 0
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`
      if (path === 'target') continue
      if (entry.isDirectory()) walk(resolve(dir, entry.name), `${path}/`)
      else if (entry.isFile()) {
        hash.update(`${path}\0${sha256(readFileSync(resolve(dir, entry.name)))}\n`)
        files++
      }
    }
  }
  walk(root, '')
  return { root, sha256: hash.digest('hex'), files }
}
function provenance(wasmPath: string) {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const status = git('status', '--porcelain=v1', '-z')
  return {
    wasm: { path: wasmPath, sha256: sha256(readFileSync(wasmPath)) },
    crates: sourceTree(resolve(dirname(wasmPath), '../../..')),
    git: { head: git('rev-parse', 'HEAD').trim(), dirty: status.length > 0, statusSha256: sha256(status) },
  }
}
function wire(input: Input): WireInput {
  return { label: input.label, ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.bytes === undefined ? {} : { bytesBase64: Buffer.from(input.bytes).toString('base64') }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.isolate ? { isolate: true as const } : {}) }
}
function unwire(input: WireInput): Input {
  return { label: input.label, text: input.text, args: input.args, isolate: input.isolate === true,
    ...(input.bytesBase64 === undefined ? {} : { bytes: Buffer.from(input.bytesBase64, 'base64') }) }
}
/** The input as the spec runs it: every input of an isolated spec is isolated. */
function asRun(spec: Spec, input: Input): Input {
  return spec.isolate && !input.isolate ? { ...input, isolate: true } : input
}
function keyOrdersOf(value: unknown, path = '', found: KeyOrders = []): KeyOrders {
  if (value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => keyOrdersOf(item, `${path}/${index}`, found))
    return found
  }
  const keys = keysAsWritten(value)
  found.push({ path: path || '/', keys })
  for (const key of keys) keyOrdersOf((value as Record<string, unknown>)[key], `${path}/${key}`, found)
  return found
}
/** The answers of a ledger entry, values and the order of every key. */
function recorded(entry: Divergence, ts: Outcome, rs: Outcome): boolean {
  return isDeepStrictEqual(entry.typescript, ts) && isDeepStrictEqual(keyOrdersOf(entry.typescript), keyOrdersOf(ts)) &&
    isDeepStrictEqual(entry.rust, rs) && isDeepStrictEqual(entry.rustKeyOrders, keyOrdersOf(rs))
}
function flipped(bytes: Uint8Array, random: () => number): Uint8Array {
  if (bytes.length === 0) return new Uint8Array([1])
  const copy = bytes.slice()
  copy[Math.floor(random() * copy.length)]! ^= 1 << Math.floor(random() * 8)
  return copy
}
/** One XML part of the ZIP mutated and the ZIP written again; undefined where the seed has no such part or does not open. */
async function zipXmlMutant(bytes: Uint8Array, random: () => number): Promise<Uint8Array | undefined> {
  try {
    await assertZipInflatesWithinLimits(bytes)
    const zip = await JSZip.loadAsync(bytes)
    const files = Object.keys(zip.files).filter(name => !zip.files[name]!.dir && /\.(xml|rels)$/i.test(name))
    const name = files[Math.floor(random() * files.length)]
    if (name === undefined) return undefined
    zip.file(name, mutate(await zip.file(name)!.async('string'), random))
    return await fixtureBytes(zip)
  } catch {
    return undefined
  }
}
async function mutant(spec: Spec, from: Input, label: string, random: () => number): Promise<Input> {
  const mode = spec.mutation ?? (from.text === undefined ? 'zip-xml' : 'text')
  if (mode === 'text') {
    if (from.text === undefined) throw new Error(`${spec.fn}: text mutation of ${from.label}, which has no text`)
    return { ...from, label, text: mutate(from.text, random) }
  }
  if (from.bytes === undefined) throw new Error(`${spec.fn}: ${mode} mutation of ${from.label}, which has no bytes`)
  // an isolated seed may hang JSZip, so it is never opened in this process
  const bytes = mode === 'container' ? mutateContainer(from.bytes, random)
    : from.isolate || spec.isolate ? undefined : await zipXmlMutant(from.bytes, random)
  return { ...from, label, bytes: bytes === undefined || Buffer.compare(bytes, from.bytes) === 0 ? flipped(from.bytes, random) : bytes }
}

/**
 * Compares every spec's TypeScript with the Rust engine over its corpus, built
 * and mutated populations, replays the ledger, and reports. Reads `--group`,
 * `--seed`, `--fuzz` and `--save` from the command line. The gate's failed flag
 * and the comparisons live in docx-diff's harness, so one process runs one suite.
 * Returns whether the gate passed.
 */
export async function runSuite(config: SuiteConfig): Promise<boolean> {
  const { directory, groups, command = 'fileParse' } = config
  const wasmPath = process.env.FILEPARSE_WASM_PATH ?? WASM_PATH
  let gateEngine = Engine.load(wasmPath, HOST_STEPS)
  const floors = JSON.parse(readFileSync(resolve(directory, 'floors.json'), 'utf8')) as Record<string, unknown>
  const ledger = JSON.parse(readFileSync(resolve(directory, 'divergences.json'), 'utf8')) as Divergence[]
  const groupArg = process.argv.indexOf('--group')
  const onlyGroup = groupArg < 0 ? undefined : process.argv[groupArg + 1]
  if (onlyGroup !== undefined && !(onlyGroup in groups)) throw new Error(`Unknown group ${onlyGroup}`)
  const selectedGroups = Object.keys(groups).filter(name => onlyGroup === undefined || name === onlyGroup)
  const specs = selectedGroups.flatMap(name => groups[name]!)
  const allSpecs = Object.values(groups).flat()
  const seed = option('--seed', 20261112)
  const fuzz = option('--fuzz', 100)
  const populations: Record<string, number> = {}
  const tallies = new Map<string, Tally>(specs.map(spec => [spec.fn, { compared: 0, differences: 0, listed: 0, errors: 0, outcomes: new Set<string>() }]))
  const differences: Array<{ fn: string; input: WireInput; typescript: Outcome; rust: Outcome; rustKeyOrders: KeyOrders; order: string | null }> = []
  const runtimeFailures: RuntimeFailure[] = []
  const matchedPopulation = new Set<string>()
  const reproduced: string[] = []
  const stale: string[] = []
  const staleReasons: Record<string, string> = {}
  const expectedFloors = new Set<string>()
  const missingFloors: string[] = []

  /** The floor of `key` in floors.json, or a key the report prints as missing. */
  const floorOf = (key: string): number | string => {
    expectedFloors.add(key)
    const floor = floors[key]
    if (typeof floor === 'number') return floor
    missingFloors.push(key)
    // not a key of docx-diff's floors.json, which atFloor reads: the report shows "missing" and fails
    return `fileparse-diff ${key}`
  }
  const comparison = (fn: string, population: string): Comparison =>
    new Comparison(`(p) ${fn}.${population}`, floorOf(`${fn}.${population}`))
  const runtimeFailure = (spec: Spec, input: Input, kind: RuntimeFailure['kind'], message: string): void => {
    runtimeFailures.push({ fn: spec.fn, label: input.label, kind, message })
    console.error(`${spec.fn} ${input.label}: ${kind} ${message}`)
    failGate()
  }
  /** Both answers. `broke`: a reader did not answer (a trap, a host error, a child that failed), which is never parity. */
  const answers = async (spec: Spec, input: Input): Promise<{ ts: Outcome; rs: Outcome; broke: boolean }> => {
    if (input.isolate) {
      if (command !== 'fileParse') throw new Error(`${spec.fn} ${input.label}: isolated inputs run only through fileParse`)
      const { typescript: ts, rust: rs, failures } = isolatedOutcomes(spec, input, wasmPath)
      for (const message of failures) runtimeFailure(spec, input, 'isolated', message)
      return { ts: ts as Outcome, rs: rs as Outcome, broke: failures.length > 0 }
    }
    const ts = await typescriptOutcome(spec, input)
    try {
      const { header } = gateEngine.call<Outcome>({ cmd: command, function: spec.engineFn ?? spec.fn, text: input.text ?? '', args: input.args ?? {} }, input.bytes === undefined ? [] : [input.bytes])
      if (!(failed(header) && 'code' in header.error)) return { ts, rs: header as Outcome, broke: false }
      const message = `WASM command failed: ${header.error.message}`
      runtimeFailure(spec, input, 'host', message)
      return { ts, rs: { error: { name: 'HostError', message } }, broke: true }
    } catch (error) {
      gateEngine = Engine.load(wasmPath, HOST_STEPS)
      const trap = error instanceof WebAssembly.RuntimeError
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      runtimeFailure(spec, input, trap ? 'trap' : 'host', message)
      return { ts, rs: { error: { name: trap ? 'WasmTrap' : 'HostError', message } }, broke: true }
    }
  }
  /** Compares one input; answers whether the difference found is one the ledger lists. */
  const check = async (spec: Spec, given: Input, comp: Comparison): Promise<boolean> => {
    const input = asRun(spec, given)
    const { ts, rs, broke } = await answers(spec, input)
    const equal = !broke && isDeepStrictEqual(withoutHostText(ts), withoutHostText(rs))
    const order = equal ? keyOrderDifference(spec.fn, ts, rs) : null
    const same = equal && order === null
    const tally = tallies.get(spec.fn)!
    tally.compared++
    tally.outcomes.add('error' in ts ? 'error' : JSON.stringify(ts))
    if ('error' in ts) { tally.errors++; comp.typescriptThrew++ }
    let listed = false
    if (!same) {
      const found = broke ? undefined : ledger.find(entry => entry.fn === spec.fn && entry.reason.trim().length > 0 &&
        isDeepStrictEqual({ ...entry.input, label: '' }, { ...wire(input), label: '' }) && recorded(entry, ts, rs))
      if (found) { listed = true; matchedPopulation.add(found.id); tally.listed++ }
      else { tally.differences++; differences.push({ fn: spec.fn, input: wire(input), typescript: ts, rust: rs, rustKeyOrders: keyOrdersOf(rs), order }) }
    }
    comp.record(same || listed ? null : `${input.label}: TS ${JSON.stringify(ts).slice(0, 350)}; Rust ${JSON.stringify(rs).slice(0, 350)}${order ? `; ${order}` : ''}`, order !== null)
    return listed
  }

  const stamp = provenance(wasmPath)
  console.log(`WASM ${stamp.wasm.sha256} at ${stamp.wasm.path}; crates source ${stamp.crates.sha256} (${stamp.crates.files} files); ` +
    `git ${stamp.git.head}${stamp.git.dirty ? ' with uncommitted changes' : ''}. Whether this WASM was built from this source is not checked.`)
  const duplicateFunctions = [...new Set(allSpecs.map(spec => spec.fn).filter((fn, index, all) => all.indexOf(fn) !== index))]
  if (duplicateFunctions.length > 0) {
    console.error(`Functions with more than one spec: ${duplicateFunctions.join(', ')}`)
    failGate()
  }
  const activeCorpora: Array<{ fn: string; count: number }> = []
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).split('\0').filter(Boolean)
  for (const spec of specs) {
    let functionSeed = seed
    for (const char of spec.fn) functionSeed = Math.imul(functionSeed ^ char.charCodeAt(0), 16777619)
    const random = mulberry32(functionSeed >>> 0)
    const seeds: Input[] = []
    const corpus = comparison(spec.fn, 'corpus')
    let activeCorpus = 0
    for (const path of tracked) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      if (!spec.extensions.includes(ext)) continue
      const bytes = new Uint8Array(readFileSync(resolve(repoRoot, path)))
      const input: Input = spec.mutateText ? { label: path, text: Buffer.from(bytes).toString('utf8') } : { label: path, bytes }
      await check(spec, input, corpus)
      if (spec.isActive?.(input)) activeCorpus++
      if (spec.seedCorpus !== false && seeds.length < 40 && bytes.length < 1_000_000) seeds.push(input)
    }
    populations[`${spec.fn}.corpus`] = corpus.compared
    if (spec.isActive) {
      activeCorpora.push({ fn: spec.fn, count: activeCorpus })
      populations[`${spec.fn}.activeCorpus`] = activeCorpus
    }
    const built = comparison(spec.fn, 'built')
    const builtInputs = await spec.built()
    // a listed input seeds no mutations: nearly all of them are the same known difference again
    const listedInputs = new Set<Input>()
    for (const input of builtInputs) if (await check(spec, input, built)) listedInputs.add(input)
    populations[`${spec.fn}.built`] = built.compared
    if (spec.mutation === 'none') continue
    seeds.push(...builtInputs.filter(input => input.mutate !== false && !listedInputs.has(input)))
    const mutated = comparison(spec.fn, 'mutated')
    for (let n = 0; n < fuzz && seeds.length > 0; n++) {
      const from = seeds[Math.floor(random() * seeds.length)]!
      await check(spec, await mutant(spec, from, `mutation ${n} of ${from.label}`, random), mutated)
    }
    populations[`${spec.fn}.mutated`] = mutated.compared
  }

  const knownFunctions = new Set(allSpecs.map(spec => spec.fn))
  const ledgerIds = new Set<string>()
  for (const entry of ledger) {
    const markStale = (reason: string): void => {
      stale.push(entry.id)
      staleReasons[entry.id] = reason
      console.error(`Stale divergence ${entry.id}: ${reason}`)
      failGate()
    }
    if (ledgerIds.has(entry.id)) { markStale('its id is listed twice'); continue }
    ledgerIds.add(entry.id)
    if (!knownFunctions.has(entry.fn)) { markStale(`no spec has the function ${entry.fn}`); continue }
    const spec = specs.find(spec => spec.fn === entry.fn)
    if (!spec) continue
    if (entry.reason.trim().length === 0) { markStale('it gives no reason'); continue }
    if (!Array.isArray(entry.rustKeyOrders)) { markStale('it records no rustKeyOrders'); continue }
    const { ts, rs, broke } = await answers(spec, asRun(spec, unwire(entry.input)))
    if (broke) markStale('a reader failed instead of answering')
    else if (isDeepStrictEqual(ts, rs) && keyOrderDifferences(ts, rs).length === 0) markStale('Rust and TypeScript now agree')
    else if (!recorded(entry, ts, rs)) markStale('the answers are no longer the recorded ones')
    else reproduced.push(entry.id)
  }
  const ledgerOnly = reproduced.filter(id => !matchedPopulation.has(id))

  reportComparisons()
  for (const { fn, count } of activeCorpora) {
    console.log(`${`(p) ${fn}.activeCorpus`.padEnd(46)} active   ${String(count).padStart(6)}  ${atFloor(count, floorOf(`${fn}.activeCorpus`))}`)
  }
  const functionCounts: Record<string, number> = {}
  for (const group of selectedGroups) {
    const count = groups[group]!.length
    functionCounts[group] = count
    console.log(`${`functions.${group}`.padEnd(46)} specs    ${String(count).padStart(6)}  ${atFloor(count, floorOf(`functions.${group}`))}`)
  }
  if (missingFloors.length > 0) console.error(`Missing from floors.json: ${missingFloors.join(', ')}`)
  const unknownFloors = onlyGroup === undefined ? Object.keys(floors).filter(key => !expectedFloors.has(key)) : []
  if (unknownFloors.length > 0) {
    console.error(`Floors no group or function of this gate has: ${unknownFloors.join(', ')}`)
    failGate()
  }
  for (const spec of specs) {
    const tally = tallies.get(spec.fn)!
    console.log(`${spec.fn}: ${tally.compared} checks, ${tally.differences} differences, ${tally.listed} listed, ${tally.outcomes.size} distinct results, ${tally.errors} errors`)
    if (tally.outcomes.size < 2 && !spec.constant) {
      console.error(`${spec.fn} gave fewer than two distinct TypeScript results`)
      failGate()
    }
  }
  console.log(`Ledger: ${matchedPopulation.size} matched in the populations, ${reproduced.length} reproduced, ` +
    `${ledgerOnly.length} reproduced only from the ledger${ledgerOnly.length > 0 ? ` (${ledgerOnly.join(', ')})` : ''}, ${stale.length} stale`)
  if (runtimeFailures.length > 0) console.error(`${runtimeFailures.length} inputs where a reader failed instead of answering`)
  const saveAt = process.argv.indexOf('--save')
  if (saveAt >= 0) {
    const path = resolve(directory, process.argv[saveAt + 1]!)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      node: process.version, command, seed, fuzz, group: onlyGroup ?? null, provenance: stamp,
      functions: functionCounts, populations,
      tallies: Object.fromEntries([...tallies].map(([fn, tally]) => [fn, { ...tally, outcomes: tally.outcomes.size }])),
      differences, runtimeFailures,
      matchedPopulation: [...matchedPopulation], reproduced, ledgerOnly, stale, staleReasons,
      missingFloors, unknownFloors, duplicateFunctions, passed: !gateHasFailed(),
    }, null, 2) + '\n', { flag: 'wx' })
    console.log(`Saved untouched results to ${path}`)
  }
  console.log(`Populations: ${JSON.stringify(populations)}`)
  return !gateHasFailed()
}
