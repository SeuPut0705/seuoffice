import { createReadStream, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ModelInput } from './model-wire'

interface Captured {
  status: 'ok' | 'rejected'
  sha256?: string
  model?: ModelInput
  test: string
  error?: string
}

/** Deduplicate identical results but report all calls, refusals and files separately. */
export async function readTestInputs(
  directory: string,
): Promise<{ inputs: ModelInput[]; calls: number; refused: Captured[]; files: number }> {
  const names = readdirSync(directory)
    .filter((name) => /^parse-\d+-\d+\.ndjson$/.test(name))
    .sort()
  const inputs: ModelInput[] = []
  const seen = new Set<string>()
  const refused: Captured[] = []
  let calls = 0
  for (const name of names) {
    for await (const line of createInterface({
      input: createReadStream(resolve(directory, name)),
      crlfDelay: Infinity,
    })) {
      if (!line) continue
      const record = JSON.parse(line) as Captured
      calls++
      if (record.status === 'rejected') {
        refused.push(record)
      } else if (record.status === 'ok' && record.model && record.sha256) {
        if (seen.has(record.sha256)) continue
        seen.add(record.sha256)
        inputs.push(record.model)
      } else {
        throw new Error(`invalid capture in ${name}: ${line.slice(0, 120)}`)
      }
    }
  }
  return { inputs, calls, refused, files: names.length }
}
