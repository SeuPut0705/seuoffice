import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const addonPath =
  process.env.MAIN_DIFF_ADDON ??
  join(fileURLToPath(new URL('.', import.meta.url)), 'out', 'main_node.node')
type Addon = { call(name: string, request: string): string }
/** loaded on the first call, so listing the functions (`main.ts --list`) needs no addon */
let addon: Addon | undefined

/** The Rust answer of `name` in the wire form of `main_core::calls`. */
export function rustCall(name: string, args: unknown[], now: number): string {
  // JSON writes an undefined argument as null, which the specs before it read
  // as left out; one at the end is dropped, which is how Rust reads `undefined`
  const given = [...args]
  while (given.length > 0 && given[given.length - 1] === undefined) given.pop()
  addon ??= require(addonPath) as Addon
  return addon.call(name, JSON.stringify({ args: given, now }))
}
