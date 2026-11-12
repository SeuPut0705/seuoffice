// before anything of the engine: it sets the host the engine runs on
import './host'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine'
import { reportKeyOrder } from './key-order'

export const toolDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(toolDir, '../..')
export const WASM_PATH =
  process.env.SEUOFFICE_WASM ??
  resolve(repoRoot, 'crates/target/wasm32-wasip1/release/office_wasm.wasm')

export const engine = Engine.load(WASM_PATH)

/** A numeric command line option: `--name N`. */
export function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}

/** Differences printed per comparison. */
export const SHOW = option('--show', 5)

/** Every comparison made, in the order the report prints them. */
const registered: Comparison[] = []

export class Comparison {
  compared = 0
  typescriptThrew = 0
  readonly differences: string[] = []
  listed = 0
  /** Of the differences: results equal as JSON whose keys are in another order. */
  keyOrderOnly = 0
  /**
   * `floor` is the least population the comparison must reach: a key of
   * floors.json, or the number itself where an option sets it.
   */
  constructor(
    readonly label: string,
    readonly floor: string | number,
  ) {
    registered.push(this)
  }

  record(difference: string | null, keyOrderOnly = false): void {
    this.compared += 1
    if (difference === null) return
    this.differences.push(difference)
    if (keyOrderOnly) this.keyOrderOnly += 1
  }
}

let floors = JSON.parse(readFileSync(resolve(toolDir, 'floors.json'), 'utf8')) as Record<
  string,
  number
>

/** Selects the populations of a gate that imports this harness. */
export function useFloors(path: string): void {
  floors = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
}
let gateFailed = false

/** Marks the gate as failed: the run exits with 1. */
export function failGate(): void {
  gateFailed = true
}

export function gateHasFailed(): boolean {
  return gateFailed
}

/** `count` against its floor, as report text. A count below its floor fails the gate. */
export function atFloor(count: number, floor: string | number): string {
  const least = typeof floor === 'number' ? floor : floors[floor]
  if (least !== undefined && count >= least) return `floor ${String(least).padStart(6)}`
  failGate()
  return `floor ${String(least ?? 'missing').padStart(6)}  BELOW FLOOR`
}

/**
 * Prints every comparison, grouped by its letter: a module registers its
 * lines when it is imported, which is not the order of the report. A
 * difference fails the gate, a difference of key order like any other.
 */
export function reportComparisons(): void {
  const byLetter = [...registered].sort((a, b) => a.label[1]!.localeCompare(b.label[1]!))
  for (const comparison of byLetter) {
    if (comparison.differences.length > 0) failGate()
    console.log(
      `${comparison.label.padEnd(46)} compared ${String(comparison.compared).padStart(6)}  ` +
        `${atFloor(comparison.compared, comparison.floor)}  differences ${comparison.differences.length}` +
        (comparison.keyOrderOnly > 0 ? `  (key order only: ${comparison.keyOrderOnly})` : '') +
        (comparison.listed > 0 ? `  listed ${comparison.listed}` : '') +
        (comparison.typescriptThrew > 0
          ? `  (TypeScript threw in ${comparison.typescriptThrew}: Rust must refuse those too)`
          : ''),
    )
    for (const difference of comparison.differences.slice(0, SHOW))
      console.log(`    - ${difference}`)
    if (comparison.differences.length > SHOW) {
      console.log(`    ... ${comparison.differences.length - SHOW} more (--show N)`)
    }
  }
  reportKeyOrder(option('--places', 40))
}

export function excerpt(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))
}

export function describeTextDifference(typescript: string, rust: string): string {
  const shared = Math.min(typescript.length, rust.length)
  let at = 0
  while (at < shared && typescript.charCodeAt(at) === rust.charCodeAt(at)) at += 1
  return (
    `first difference at code unit ${at} (lengths ${typescript.length} and ${rust.length})\n` +
    `      typescript ${excerpt(typescript, at)}\n      rust       ${excerpt(rust, at)}`
  )
}
