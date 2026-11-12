/**
 * The attachment parsers hand a compound file (.doc, .ppt, .hwp) to their readers only after
 * the compound-file gate: a file whose sector tables loop or point outside it is refused
 * with the gate's error, not followed.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CompoundFileError } from '@genoffice/compound-file'
import { docToText, parseFileToText, pptToText } from '../src/index'
import { checkedHwpBytes, hwpMemosOf, hwpToText } from '../src/hwp'
import { HOSTILE_FILES, REFUSAL_MS } from '../../compound-file/tests/helpers/raw-compound'
import { writeFixture } from './helpers/fixtures'

const READERS: Array<[string, (bytes: Uint8Array) => Promise<unknown>]> = [
  ['docToText', docToText],
  ['pptToText', pptToText],
  ['hwpToText', hwpToText],
  ['hwpMemosOf', hwpMemosOf],
  ['checkedHwpBytes', (bytes) => checkedHwpBytes(bytes, 'hwp')],
]

describe('a hostile compound file', () => {
  for (const { what, build, code } of HOSTILE_FILES) {
    for (const [name, read] of READERS) {
      it(`${what}: ${name} refuses it, quickly`, async () => {
        const bytes = build()
        const started = performance.now()
        const thrown = await read(bytes).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
        expect(thrown).toBeInstanceOf(CompoundFileError)
        expect((thrown as CompoundFileError).code).toBe(code)
      })
    }

    for (const ext of ['doc', 'ppt', 'hwp']) {
      it(`${what}: an .${ext} of it is a failed read with the gate's reason, quickly`, async () => {
        const bytes = build()
        const path = writeFixture(
          `hostile-${HOSTILE_FILES.findIndex((file) => file.what === what)}.${ext}`,
          bytes,
        )
        const refusal = (await docToText(bytes).catch((error: unknown) => error)) as Error
        const started = performance.now()
        const result = await parseFileToText(path)
        expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
        expect(result.ok).toBe(false)
        expect(result.error).toBe(refusal.message)
      })
    }
  }
})

describe('a sound compound file', () => {
  it('written by Hangul is still read', async () => {
    const path = fileURLToPath(
      new URL('../../../apps/hwp/tests/fixtures/memo.hwp', import.meta.url),
    )
    const result = await parseFileToText(path)
    expect(result.ok).toBe(true)
    expect(result.text?.trim().length).toBeGreaterThan(0)
    const bytes = await readFile(path)
    expect(await checkedHwpBytes(bytes, 'hwp')).toBe(bytes)
  })
})
