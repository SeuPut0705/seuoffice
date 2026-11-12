// The differences the ledger lists for decodeCsvBuffer are Node's TextDecoder,
// not the port: with the WHATWG decoder of @exodus/bytes in its place, the
// TypeScript gives the answer the ledger records for Rust. Run with
// `npx tsx csv-decoders.ts`; exits 1 when an entry does not hold.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder as Whatwg } from '@exodus/bytes/encoding.js'
import { decodeCsvBuffer } from '../../packages/xlsx-gateway/src/gateway/csv-import'

interface Entry { id: string; fn: string; input: { bytesBase64?: string; args?: { preferred?: string } }; rust: { value?: string } }

const directory = dirname(fileURLToPath(import.meta.url))
const ledger = JSON.parse(readFileSync(resolve(directory, 'divergences.json'), 'utf8')) as Entry[]
const NodeDecoder = globalThis.TextDecoder
let held = 0
const failed: string[] = []
for (const entry of ledger.filter(entry => entry.fn === 'decodeCsvBuffer')) {
  const bytes = Buffer.from(entry.input.bytesBase64 ?? '', 'base64')
  globalThis.TextDecoder = Whatwg as unknown as typeof TextDecoder
  try {
    if (decodeCsvBuffer(bytes, entry.input.args?.preferred) === entry.rust.value) held++
    else failed.push(entry.id)
  } finally {
    globalThis.TextDecoder = NodeDecoder
  }
}
console.log(`${held} decodeCsvBuffer entries give the Rust answer with the WHATWG decoder${failed.length ? `; not: ${failed.join(', ')}` : ''}`)
process.exitCode = failed.length === 0 && held > 0 ? 0 : 1
