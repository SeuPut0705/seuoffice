/**
 * `CHANNELS` of crates/shell-contract/src/channels.rs, read from the file the
 * inventory generates, so the harness checks surfaces and coverage against
 * the table the shell itself uses.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface Spec {
  name: string
  kinds: string[]
  batch: string
  surfaces: string[]
}

const file = fileURLToPath(new URL('../../crates/shell-contract/src/channels.rs', import.meta.url))
const source = readFileSync(file, 'utf8')
const table = source.slice(
  source.indexOf('pub const CHANNELS'),
  source.indexOf('pub struct PreloadSpec'),
)
const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export const CHANNELS: Spec[] = [
  ...table.matchAll(/spec\(\s*"([^"]+)",\s*&\[([^\]]*)\],\s*(\w+),\s*&\[([^\]]*)\],?\s*\)/g),
].map((m) => ({
  name: m[1],
  // Rust's variant names, as the harness writes kinds: invoke, send, sendSync, event, port
  kinds: list(m[2]).map((k) => k[0].toLowerCase() + k.slice(1)),
  batch: m[3],
  surfaces: list(m[4]),
}))

export const SPECS = new Map(CHANNELS.map((s) => [s.name, s]))

if (CHANNELS.length === 0) throw new Error(`no channel read from ${file}`)
