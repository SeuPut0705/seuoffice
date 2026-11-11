// Opens one container with the TypeScript loader and prints what happened.
// Run as a child process for a container the loader may never return from:
//   node --import tsx load-once.ts < container.bin
import { readFileSync } from 'node:fs'
import { loadDocxZip } from '../../packages/docx-engine/src/zip-load'

const docx = new Uint8Array(readFileSync(0))
try {
  await loadDocxZip(docx)
  console.log(JSON.stringify('opens'))
} catch (error) {
  console.log(JSON.stringify({ refused: error instanceof Error ? error.message : String(error) }))
}
