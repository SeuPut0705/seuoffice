import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusDocuments, parsedModels, type ModelRefusal } from './model-inputs'
import { modelDigest } from './model-wire'

const here = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] ?? resolve(here, 'out/model-inputs.ndjson'))
mkdirSync(dirname(output), { recursive: true })
const fd = openSync(output, 'w')
const refused: ModelRefusal[] = []
const counts: Record<string, number> = {}
const hashes: string[] = []
try {
  for await (const input of parsedModels(refused)) {
    writeSync(fd, JSON.stringify(input) + '\n')
    counts[input.population] = (counts[input.population] ?? 0) + 1
    hashes.push(modelDigest(input.json))
  }
} finally {
  closeSync(fd)
}
const summary = {
  node: process.version,
  tracked: corpusDocuments().length,
  counts,
  refused,
  hashes,
}
writeFileSync(output + '.summary.json', JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, hashes: `${hashes.length} hashes saved` }, null, 2))
