import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDocx } from './reference/parse'
import type { ParsedDocFull } from './reference/patch'
import { failGate, gateHasFailed, repoRoot, reportComparisons } from './harness'
import { buildModelBody, MODEL_BODIES } from './model-bodies'
import { corpusDocuments, requireModelNode } from './model-inputs'
import { modelAfterCorpus, modelOnDocument, reportModel } from './model-run'
import { parseOnDocument, reportParse } from './model-parse'
import { reportSave, saveAfterCorpus, saveOnDocument } from './model-save'

requireModelNode()
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const encrypted: string[] = []
const refused: Array<{ where: string; error: string }> = []
for (const path of corpusDocuments()) {
  const bytes = readFileSync(resolve(repoRoot, path))
  // an encrypted docx is an OLE compound file, not a zip: the parser has no model to give
  if (OLE_MAGIC.equals(bytes.subarray(0, 8))) {
    encrypted.push(path)
    continue
  }
  let doc: unknown
  try { doc = await parseDocx(new Uint8Array(bytes)) }
  catch (error) { refused.push({ where: path, error: String(error) }); continue }
  modelOnDocument(path, doc)
  parseOnDocument(path, new Uint8Array(bytes), doc)
  await saveOnDocument(path, new Uint8Array(bytes), doc as ParsedDocFull)
}
// the documents built to reach what the corpus does not cross the whole Rust parser as well
for (const { name, ...options } of MODEL_BODIES) {
  const bytes = await buildModelBody(options)
  parseOnDocument(`model body ${name}`, bytes, await parseDocx(bytes))
}
console.log(`Model corpus: ${corpusDocuments().length} documents, ${encrypted.length} encrypted skipped, ${refused.length} parser refusals`)
for (const refusal of refused) console.log(`  ${refusal.where}: ${refusal.error}`)
if (refused.length > 0) failGate()
await modelAfterCorpus()
await saveAfterCorpus()
reportComparisons()
reportModel()
reportParse()
reportSave()
process.exitCode = gateHasFailed() ? 1 : 0
