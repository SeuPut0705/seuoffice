import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { threadId } from 'node:worker_threads'
import { expect, vi } from 'vitest'
import type * as ParseModule from './reference/parse'
import type { ParseExtras, ParseOptions } from './reference/parse'
import type { ParsedDoc } from './reference/types'
import { modelDigest, modelJson } from './model-wire'

vi.mock('./reference/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseModule>()
  return {
    ...actual,
    parseDocx: async (bytes: Uint8Array, options?: ParseOptions) => {
      const dir = process.env.DOCX_MODEL_CAPTURE_DIR
      if (!dir) throw new Error('DOCX_MODEL_CAPTURE_DIR must name the capture directory')
      if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Node 22 required')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `parse-${process.pid}-${threadId}.ndjson`)
      const input = { bytes: { $bytes: Buffer.from(bytes).toString('base64') }, options }
      const test = expect.getState().currentTestName ?? ''
      let result: ParsedDoc & { extras: ParseExtras }
      try {
        result = await actual.parseDocx(bytes, options)
      } catch (error) {
        appendFileSync(
          file,
          JSON.stringify({ status: 'rejected', test, input, error: String(error) }) + '\n',
        )
        throw error
      }
      const json = modelJson(result)
      appendFileSync(
        file,
        JSON.stringify({
          status: 'ok',
          test,
          input,
          sha256: modelDigest(json),
          model: { where: test, population: 'tests', type: 'ParsedDocFull', json },
        }) + '\n',
      )
      return result
    },
  }
})
