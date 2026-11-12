/**
 * The HWP 5 readers take a file through the compound-file gate before the container library
 * gets it: a file whose sector tables loop or point outside it is refused, not followed.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CompoundFileError } from '@genoffice/compound-file'
import { DOC_INFO, openHwp, sectionCount, streamOf } from '../src/main/hwp5-file'
import { hasTrackedChanges, withoutTrackedChanges } from '../src/main/tracked-changes'
import {
  HOSTILE_FILES,
  REFUSAL_MS,
} from '../../../packages/compound-file/tests/helpers/raw-compound'

describe('a hostile compound file under an .hwp name', () => {
  for (const { what, build, code } of HOSTILE_FILES) {
    it(`${what}: the HWP 5 reader refuses it, quickly`, () => {
      const bytes = build()
      const started = performance.now()
      let thrown: unknown
      try {
        openHwp(bytes)
      } catch (error) {
        thrown = error
      }
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
      expect(thrown).toBeInstanceOf(CompoundFileError)
      expect((thrown as CompoundFileError).code).toBe(code)
    })

    it(`${what}: it is taken to have no tracked changes, quickly`, () => {
      const bytes = build()
      const started = performance.now()
      expect(hasTrackedChanges(bytes)).toBe(false)
      expect(withoutTrackedChanges(bytes)).toBeNull()
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    })
  }
})

describe('a sound file', () => {
  it('written by Hangul still opens as an HWP 5 container', () => {
    const file = readFileSync(fileURLToPath(new URL('fixtures/memo.hwp', import.meta.url)))
    const opened = openHwp(file)
    expect(opened).not.toBeNull()
    expect(sectionCount(opened!)).toBeGreaterThan(0)
    expect(streamOf(opened!, DOC_INFO)?.length).toBeGreaterThan(0)
    expect(hasTrackedChanges(file)).toBe(false)
  })

  it('that is a zip (an HWPX) is not an HWP 5 container', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/hwp+zip')
    expect(openHwp(await zip.generateAsync({ type: 'uint8array' }))).toBeNull()
  })
})
