/**
 * The attachment parsers hand a compound file (.doc, .ppt, .hwp) to their readers only after
 * the compound-file gate: a file whose sector tables loop or point outside it is refused, not
 * followed, and the refusal reads as a damaged document of that type, in one short sentence
 * a person can be shown.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DamagedFileError, docToText, parseFileToText, pptToText } from '../src/index'
import { checkedHwpBytes, hwpMemosOf, hwpToText } from '../src/hwp'
import { HOSTILE_FILES, REFUSAL_MS } from '../../compound-file/tests/helpers/raw-compound'
import { writeFixture } from './helpers/fixtures'

/** What a refusal says of the kind of document the reader was asked for. */
const READERS: Array<[string, (bytes: Uint8Array) => Promise<unknown>, string]> = [
  ['docToText', docToText, 'Word 97-2003'],
  ['pptToText', pptToText, 'PowerPoint 97-2003'],
  ['hwpToText', hwpToText, 'HWP'],
  ['hwpMemosOf', hwpMemosOf, 'HWP'],
  ['checkedHwpBytes', (bytes) => checkedHwpBytes(bytes, 'hwp'), 'HWP'],
]

/** Words of the gate's own finding, which name parts of the container and not the document. */
const CONTAINER_WORDS = /compound file|sector|FAT|directory|chain/i

describe('a hostile compound file', () => {
  for (const { what, build } of HOSTILE_FILES) {
    for (const [name, read, type] of READERS) {
      it(`${what}: ${name} refuses it as a damaged document, quickly`, async () => {
        const bytes = build()
        const started = performance.now()
        const thrown = await read(bytes).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
        expect(thrown).toBeInstanceOf(DamagedFileError)
        const refusal = thrown as DamagedFileError
        expect(refusal.message).toBe(`The file is damaged or is not a valid ${type} document`)
      })
    }

    for (const ext of ['doc', 'ppt', 'hwp']) {
      it(`${what}: an .${ext} of it is a failed read of a damaged file, quickly`, async () => {
        const bytes = build()
        const path = writeFixture(
          `hostile-${HOSTILE_FILES.findIndex((file) => file.what === what)}.${ext}`,
          bytes,
        )
        const started = performance.now()
        const result = await parseFileToText(path)
        expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
        expect(result.ok).toBe(false)
        expect(result.damaged).toBe(true)
        expect(result.error).toMatch(/^The file is damaged or is not a valid .+ document$/)
        expect(result.error).not.toMatch(CONTAINER_WORDS)
      })
    }
  }
})

describe('a real document whose container the gate refuses', () => {
  it('is a failed read of a damaged file, not the gate reading of its header', async () => {
    const memo = await readFile(
      fileURLToPath(new URL('../../../apps/hwp/tests/fixtures/memo.hwp', import.meta.url)),
    )
    // the header counts one FAT sector more than the file lists
    const view = new DataView(memo.buffer, memo.byteOffset)
    view.setUint32(44, view.getUint32(44, true) + 1, true)
    const result = await parseFileToText(writeFixture('fat-count.hwp', memo))
    expect(result).toEqual({
      ok: false,
      kind: 'text',
      damaged: true,
      error: 'The file is damaged or is not a valid HWP document',
    })
  })
})

describe('a file that fails for another reason', () => {
  it('is not called damaged', async () => {
    const result = await parseFileToText(writeFixture('text.hwp', Buffer.from('not a document')))
    expect(result.ok).toBe(false)
    expect(result.damaged).toBeUndefined()
  })
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
