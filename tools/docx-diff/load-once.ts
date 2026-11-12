// Opens one container with one of the two loaders and prints what happened.
// Run as a child process for a container a loader may never return from:
//   node --import tsx load-once.ts typescript|rust < container.bin
import { readFileSync } from 'node:fs'
import { loadDocxZip } from './reference/zip-load'
import { rustOpen } from './compare-package'

const docx = new Uint8Array(readFileSync(0))
let outcome: unknown = 'opens'
if (process.argv[2] === 'rust') {
  const opened = rustOpen(docx)
  if ('refused' in opened) outcome = { refused: opened.refused }
} else {
  try {
    await loadDocxZip(docx)
  } catch (error) {
    outcome = { refused: error instanceof Error ? error.message : String(error) }
  }
}
console.log(JSON.stringify(outcome))
