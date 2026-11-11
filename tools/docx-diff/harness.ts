import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine'

export const toolDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(toolDir, '../..')
export const WASM_PATH = resolve(repoRoot, 'crates/target/wasm32-wasip1/release/office_wasm.wasm')

export const engine = Engine.load(WASM_PATH)

export class Comparison {
  compared = 0
  typescriptThrew = 0
  readonly differences: string[] = []
  constructor(
    readonly label: string,
    readonly floorKey: string,
  ) {}

  record(difference: string | null): void {
    this.compared += 1
    if (difference !== null) this.differences.push(difference)
  }
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
