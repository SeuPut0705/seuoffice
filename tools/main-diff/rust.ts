import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const addonPath = join(fileURLToPath(new URL('.', import.meta.url)), 'out', 'main_node.node')
const addon = require(addonPath) as { call(name: string, request: string): string }

/** The Rust answer of `name` in the wire form of `main_core::calls`. */
export function rustCall(name: string, args: unknown[], now: number): string {
  return addon.call(name, JSON.stringify({ args, now }))
}
