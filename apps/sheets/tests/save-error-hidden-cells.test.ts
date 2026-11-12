import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { applyCellEditsToXlsx } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { REDACTION_PART_PATH } from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'
import { localizeSaveError } from '../src/renderer/save-actions'
import { buildEditFixture } from './fixture-builder'

/**
 * A save that moves rows while the record of the cells hidden from AI cannot
 * be read is refused by the gateway. The person who hits it is told what to
 * do in their own language: the refusal's wording and the renderer's table of
 * known save errors have to keep meeting.
 */
describe('a save refused over unreadable hidden-cell marks', () => {
  it('reaches the person as a localized message', async () => {
    const zip = await JSZip.loadAsync(await buildEditFixture())
    zip.file(REDACTION_PART_PATH, '{"version":1,"sheets":[')
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const refusal = await applyCellEditsToXlsx(
      source,
      [],
      [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }],
    ).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refusal, 'the save went through').not.toBeNull()
    const shown = localizeSaveError(refusal!)
    expect(shown, refusal!).not.toBeNull()
    expect(shown).not.toBe(refusal)
  })
})
