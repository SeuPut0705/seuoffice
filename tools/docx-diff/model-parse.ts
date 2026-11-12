// Comparison (h) parseDocx: the typed Rust parser against the TypeScript one,
// over the corpus. Blob 0 of the `parseDocx` command is the docx; reply blob 0
// is the `ParsedDocFull` the Rust parser returns, as the model comparison's
// JSON. Each block of the two models is compared on its own and counted under
// its block type, the rest of the model (everything but `blocks`) as one entry.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { failed } from './engine'
import { Comparison, describeTextDifference, engine } from './harness'
import { keyOrderDifferences, parseKeepingOrder } from './key-order'
import { modelJson } from './model-wire'

const encode = new TextEncoder()
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Documents the comparison must reach: the corpus is 185 files, some of them encrypted. */
const DOCUMENT_FLOOR = 100

const documents = new Comparison('(h) parseDocx, corpus documents (all but blocks)', DOCUMENT_FLOOR)
const blocks = new Map<string, Comparison>()
const refusals: string[] = []

interface RustParse {
  json?: string
  error?: string
}

/** The Rust parser's model of a docx, as the JSON it wrote. */
export function rustParse(bytes: Uint8Array): RustParse {
  const reply = engine.call<{ model: boolean }>({ cmd: 'parseDocx' }, [bytes])
  if (failed(reply.header)) return { error: `${reply.header.error.code}: ${reply.header.error.message}` }
  if (!reply.header.model || reply.blobs.length !== 1) throw new Error('invalid parseDocx reply')
  return { json: decode.decode(reply.blobs[0]!) }
}

function population(type: string): Comparison {
  let known = blocks.get(type)
  if (!known) {
    known = new Comparison(`(h) parseDocx, ${type} blocks`, 1)
    blocks.set(type, known)
  }
  return known
}

/** One value of each side: equal as text, equal as JSON with another key order, or different. */
function compareJson(comparison: Comparison, where: string, typescript: string, rust: string): void {
  if (typescript === rust) {
    comparison.record(null)
    return
  }
  const equal = isDeepStrictEqual(JSON.parse(typescript), JSON.parse(rust))
  comparison.record(
    `${where}: ${describeTextDifference(typescript, rust)}`,
    equal && keyOrderDifferences(JSON.parse(typescript), parseKeepingOrder(rust)).length > 0,
  )
}

interface Model {
  blocks: Array<{ type: string }>
  [key: string]: unknown
}

/** `doc` is what the TypeScript parseDocx returned for `bytes`. */
export function parseOnDocument(where: string, bytes: Uint8Array, doc: unknown): void {
  const typescript = modelJson(doc)
  const rust = rustParse(bytes)
  if (rust.error !== undefined) {
    refusals.push(`${where}: ${rust.error}`)
    documents.record(`${where}: Rust refused ${rust.error}`)
    return
  }
  const ts = JSON.parse(typescript) as Model
  const rs = JSON.parse(rust.json!) as Model
  const { blocks: tsBlocks, ...tsRest } = ts
  const { blocks: rsBlocks, ...rsRest } = rs
  // JSON.stringify of the rest keeps each side's key order
  compareJson(documents, where, JSON.stringify(tsRest), JSON.stringify(rsRest))
  const count = Math.max(tsBlocks.length, rsBlocks.length)
  for (let index = 0; index < count; index++) {
    const own = tsBlocks[index]
    const theirs = rsBlocks[index]
    const comparison = population(own?.type ?? theirs?.type ?? 'missing')
    if (own === undefined || theirs === undefined) {
      comparison.record(`${where} block ${index}: ${own === undefined ? 'only Rust has' : 'only TypeScript has'} it`)
      continue
    }
    compareJson(comparison, `${where} block ${index}`, JSON.stringify(own), JSON.stringify(theirs))
  }
}

/** `--report FILE`: what each population compared and where the two differ. */
export function reportParse(): void {
  const at = process.argv.indexOf('--report')
  if (at === -1) return
  const path = resolve(process.argv[at + 1]!)
  const line = (comparison: Comparison) => ({
    label: comparison.label,
    compared: comparison.compared,
    differences: comparison.differences.length,
    keyOrderOnly: comparison.keyOrderOnly,
    first: comparison.differences.slice(0, 20),
  })
  const report = { documents: line(documents), blocks: [...blocks.values()].map(line), refusals }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: process.argv.includes('--first') ? 'wx' : 'w' })
}
