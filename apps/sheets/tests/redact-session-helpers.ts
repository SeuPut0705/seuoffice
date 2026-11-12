/**
 * A session with privacy marks, seen from the two places a hidden value could
 * get out: what the in-app AI's read tool answers, and what a file reader
 * prints from the saved workbook.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { vi } from 'vitest'

import { parseFileToText } from '@genoffice/file-parse'
import { applyCellEditsToXlsx } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import {
  REDACTION_PART_PATH,
  serializeRedactionPart,
  type SheetRedactionState,
} from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'

import { resolveWorkbookSave } from '../src/main/workbook-save-resolve'
import type { RedactionIndex } from '../src/renderer/ai/redact'
import { loadedRedactions } from '../src/renderer/ai/redact-load'
import { readCells, type WorkbookReadContext } from '../src/renderer/ai/workbook-readers'
import type { EditJournal } from '../src/renderer/edit-journal'
import { handleSave } from '../src/renderer/save-actions'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import { workbookSaveRequestSchema } from '../src/shared/desktop-api'
import { buildEditFixture } from './fixture-builder'

export const SECRET = '13800138000'

/** The value in `address` of `sheetId`, as the in-app AI's read tool hands it over. */
export function aiReads(
  index: RedactionIndex,
  grid: Readonly<Record<string, Readonly<Record<string, string>>>>,
  sheetId: string,
  address: string,
): unknown {
  const ctx: WorkbookReadContext = {
    univerRef: { current: null },
    lazyWorkbookRef: { current: null },
    adapterRef: {
      current: {
        getSnapshot: () => ({
          revision: 1,
          sheets: Object.entries(grid).map(([id, cells]) => ({
            id,
            name: id,
            cells: Object.fromEntries(
              Object.entries(cells).map(([cell, value]) => [cell, { value }]),
            ),
          })),
        }),
      },
    } as never,
    redactionLoadRef: { current: loadedRedactions(index) },
  }
  return readCells(ctx, [address], sheetId)[address]?.value
}

/** A one-sheet workbook ("Data", id `s1`) holding the secret in B2, with `marks` in its part. */
export async function workbookWithSecret(marks: readonly SheetRedactionState[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildEditFixture())
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>${SECRET}</t></is></c></row></sheetData></worksheet>`,
  )
  if (marks.length > 0) zip.file(REDACTION_PART_PATH, serializeRedactionPart(marks))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Save the session over `source` the way the app does — the request the
 * renderer builds, resolved by the main process, written by the real gateway —
 * and return what the attachment reader (`xlsxToText`) prints from the result.
 */
export async function savedText(
  source: Buffer,
  journal: EditJournal,
  states: readonly SheetRedactionState[],
  sheetOrder: readonly string[],
): Promise<string> {
  vi.stubGlobal('window', { desktopApi: {} })
  const state = {
    formulaMode: true,
    flags: { preloadComplete: true },
    editJournal: journal,
    recalc: {
      timer: null,
      generation: 0,
      failures: 0,
      formulaCells: new Map(),
      overlay: new Map(),
    },
    file: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sheets: [{ id: 's1', name: 'Data' }],
    },
  } as unknown as LazyWorkbookState
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => ({
        getId: () => 'wb',
        getActiveSheet: () => null,
        getSheets: () => sheetOrder.map((id) => ({ getSheetId: () => id })),
      }),
    },
  } as unknown as UniverRuntime
  const outcome = await handleSave(
    {
      univerRef: { current: runtime },
      lazyWorkbookRef: { current: state },
      setMessage: () => {},
      openLazyWorkbook: () => {},
      stashViewRestore: () => {},
      redactionStates: () => states,
    } as never,
    'ods',
    true,
  )
  if (!outcome.request) throw new Error('the session built no save request')
  const request = workbookSaveRequestSchema.parse(outcome.request)
  const save = resolveWorkbookSave(new Map([['s1', 'Data']]), request)
  const saved = await applyCellEditsToXlsx(
    source,
    save.edits,
    save.structuralOps,
    save.chartEdits,
    save.sheetPlan,
    save.filterStates,
    save.hyperlinkEdits,
    save.cfStates,
    save.dvStates,
    save.sheetProtections,
    save.definedNamesState,
    save.pageSetupStates,
    save.noteStates,
    save.formulaValues,
    save.redactionStates,
  )
  const directory = await mkdtemp(join(tmpdir(), 'redact-session-'))
  try {
    const path = join(directory, 'saved.xlsx')
    await writeFile(path, saved.buffer)
    const parsed = await parseFileToText(path)
    if (!parsed.ok || parsed.text === undefined) {
      throw new Error(`the saved workbook could not be read: ${parsed.error ?? parsed.kind}`)
    }
    return parsed.text
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
