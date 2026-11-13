/**
 * Group `d1/sheets-save`: saving, the chunked edit transfer, the recovery copy,
 * the template bytes, the exports (CSV, ODS, PDF) and AI-created documents
 * (`apps/sheets/src/main/sheets-main.ts`, `ods-export.ts`, `pdf-export.ts`),
 * loaded as the shell loads it (`d1/sheets-host.ts`).
 *
 * Not reachable by a call, so not compared here: a save whose output does not
 * reopen (it appends the clock and the app version to the save-failure log: the
 * clock is fixed, but the engine would have to fail only the reopen) and the
 * PDF header and footer variants (`firstPage`, `evenPages`), which the engine's
 * `render_pdf` stands for as one call.
 */
import { loadSheets } from '../../d1/sheets-host.ts'
import { NOBODY, S1, S2, T1, T2, T3, SELECT, call, cellEdit, pdfRequest, queued, saveRequest, send, sheetsCase, tab } from '../../d1/sheets-cases.ts'
import type { Case, Group } from '../../types.ts'

const A = queued([1, 'a.xlsx'])
const save = (session: string, mode: string, extra: Record<string, unknown> = {}) =>
  call('workbook:save', [saveRequest(session, mode, extra)])
const begin = (session: string, transfer: string, total: number) =>
  call('workbook:save-edits-begin', [{ sessionId: session, transferId: transfer, total }])
const chunk = (session: string, transfer: string, seq: number, edits: unknown[]) =>
  call('workbook:save-edits-chunk', [{ sessionId: session, transferId: transfer, seq, editsJson: JSON.stringify(edits) }])
const abort = (session: string, transfer: string) =>
  call('workbook:save-edits-abort', [{ sessionId: session, transferId: transfer }])
const csvExport = (extra: Record<string, unknown> = {}) =>
  call('workbook:export-csv', [{ fileName: 'sheet.csv', content: 'a,b\n1,2', hasFormulas: false, ...extra }])
const exportOds = (extra: Record<string, unknown>) => call('workbook:export-ods', [{ sessionId: S1, ...extra }])
const createDoc = (type: string, extra: Record<string, unknown> = {}) =>
  call('workbook:create-document', [{ type, title: 'My Doc', content: 'a,b\n1,2', ...extra }])

/** two tabs on the same file, then a save from each */
const TWO = queued([1, 'a.xlsx'], [2, 'a.xlsx'])

const cases: Case[] = [
  // ---- save ----
  sheetsCase('a plain save writes the file back and swaps the session', { d1: A }, [
    SELECT,
    save(S1, 'save'),
    save(S2, 'save'),
    save(S1, 'save'),
  ]),
  sheetsCase('a file changed by another program is not overwritten', { d1: TWO }, [
    call('workbook:select', [], { view: 1 }),
    call('workbook:select', [], { view: 2 }),
    save(S1, 'save'),
    save(S2, 'save'),
  ], { views: [tab(1), tab(2)] }),
  sheetsCase(
    'Save As: cancel, a CSV, an ODS and a PDF pick are handed back, a bare name is refused, an .xlsx saves',
    { d1: A, saves: [null, '$DIR/o.csv', '$DIR/o.ods', '$DIR/o.pdf', '$DIR/bare', '$DIR/copy.xlsx'] },
    [SELECT, save(S1, 'save-as'), save(S1, 'save-as'), save(S1, 'save-as'), save(S1, 'save-as'), save(S1, 'save-as'), save(S1, 'save-as', { defaultName: 'Quarterly: Plan' })],
  ),
  sheetsCase('a macro workbook keeps .xlsm', { d1: queued([1, 'macro.xlsm']), saves: ['$DIR/m2'] }, [
    SELECT,
    save(S1, 'save-as'),
  ]),
  sheetsCase(
    'an explicit path needs a target the MCP layer resolved, Save As, an absolute path and no clobber',
    {
      d1: {
        startup: {
          queued: [{ view: 1, path: '$DIR/a.xlsx' }],
          mcpWritable: [
            { view: 1, path: '$DIR/mcp.xlsx' },
            { view: 1, path: '$DIR/a.xlsx' },
          ],
        },
      },
    },
    [
      SELECT,
      save(S1, 'save', { targetPath: '$DIR/mcp.xlsx' }),
      save(S1, 'save-as', { targetPath: 'rel.xlsx' }),
      save(S1, 'save-as', { targetPath: '$DIR/other.xlsx' }),
      save(S1, 'save-as', { targetPath: '$DIR/a.xlsx' }),
      save(S1, 'save-as', { targetPath: '$DIR/a.xlsx', overwrite: true }),
      save(S2, 'save-as', { targetPath: '$DIR/mcp' }),
    ],
  ),
  sheetsCase('a converted .xls asks where to save the first time', { d1: queued([1, 'old.xls']), saves: [null, '$DIR/old-copy.xlsx'] }, [
    SELECT,
    save(S1, 'save'),
    save(S1, 'save'),
  ]),
  sheetsCase('a CSV saves back to its file with the serialized content, and explains Save As', { d1: queued([1, 't.csv']), saves: ['$DIR/t2.xlsx'] }, [
    SELECT,
    save(S1, 'save', { csvContent: 'a,b\n9,9\n' }),
    save(S2, 'save-as'),
  ]),
  sheetsCase('an encrypted workbook is saved encrypted', { d1: { ...queued([1, 'enc.xlsx']), password: 'secret' } }, [
    SELECT,
    save(S1, 'save'),
    save(S2, 'save'),
  ]),
  sheetsCase('a save of a session that is not open, and one the schema refuses', { d1: A }, [
    SELECT,
    save(NOBODY, 'save'),
    call('workbook:save', [null]),
  ]),
  sheetsCase('a save that the engine fails leaves the file and the session', { d1: { ...A, writeWorkbook: { error: 'disk full' } } }, [
    SELECT,
    save(S1, 'save'),
    save(S1, 'save'),
  ]),

  // ---- the chunked edit transfer ----
  sheetsCase('a transfer feeds one save and is spent', { d1: A }, [
    SELECT,
    begin(S1, T1, 2),
    chunk(S1, T1, 0, [cellEdit(0), cellEdit(1)]),
    save(S1, 'save', { editsTransferId: T1 }),
    save(S2, 'save', { editsTransferId: T1 }),
  ]),
  sheetsCase('uploads that break the rules are dropped, and abort is a no-op the second time', { d1: A }, [
    SELECT,
    begin(S1, T1, 3),
    begin(S1, T1, 3),
    chunk(S1, T1, 0, [cellEdit(0)]),
    chunk(S1, T1, 5, [cellEdit(1)]),
    chunk(S1, T1, 1, [cellEdit(1)]),
    begin(S1, T2, 1),
    chunk(S1, T2, 0, [cellEdit(0), cellEdit(1)]),
    begin(S1, T3, 2),
    chunk(S1, T3, 0, [cellEdit(0)]),
    abort(S1, T3),
    abort(S1, T3),
    save(S1, 'save', { editsTransferId: T3 }),
  ]),
  sheetsCase('an incomplete transfer, a mixed request and a request the schema refuses', { d1: A }, [
    SELECT,
    begin(S1, T1, 2),
    chunk(S1, T1, 0, [cellEdit(0)]),
    save(S1, 'save', { editsTransferId: T1 }),
    begin(S1, T2, 1),
    chunk(S1, T2, 0, [cellEdit(0)]),
    save(S1, 'save', { editsTransferId: T2, edits: [cellEdit(5)] }),
    begin(NOBODY, T3, 1),
    begin(S1, T3, 0),
    call('workbook:save-edits-chunk', [{ sessionId: S1, transferId: T3, seq: 0, editsJson: '[]' }]),
    call('workbook:save-edits-chunk', [{ sessionId: S1, transferId: T3, seq: 0, editsJson: 'not json' }]),
    call('workbook:save-edits-abort', [{ sessionId: S1 }]),
  ]),

  // ---- recovery copy and template bytes ----
  sheetsCase('a dirty tab writes its copy through the store', { d1: A }, [
    SELECT,
    call('workbook:write-recovery', [saveRequest(S1, 'save')]),
    call('workbook:write-recovery', [saveRequest(NOBODY, 'save')]),
    call('workbook:write-recovery', [null]),
    // the copy's name is a hash of the real path, which differs per side: a
    // successful save drops the copy so the folders compare
    save(S1, 'save'),
  ]),
  sheetsCase('a headless run keeps no copy', { d1: { ...A, headless: true } }, [
    SELECT,
    call('workbook:write-recovery', [saveRequest(S1, 'save')]),
  ]),
  sheetsCase('an encrypted workbook keeps no copy', { d1: { ...queued([1, 'enc.xlsx']), password: 'secret' } }, [
    SELECT,
    call('workbook:write-recovery', [saveRequest(S1, 'save')]),
  ]),
  sheetsCase('the workbook as edited, for a skill template', { d1: A }, [
    SELECT,
    call('workbook:template-bytes', [saveRequest(S1, 'save')]),
    call('workbook:template-bytes', [saveRequest(NOBODY, 'save')]),
    call('workbook:template-bytes', [null]),
  ]),
  sheetsCase('the template copy fails quietly', { d1: { ...A, writeWorkbook: { error: 'no space' } } }, [
    SELECT,
    call('workbook:template-bytes', [saveRequest(S1, 'save')]),
  ]),

  // ---- the close guard and the recovery flush: sends, answered by nothing ----
  sheetsCase('the renderer reports its pending edits, a close answer and a flush answer', { d1: A }, [
    SELECT,
    send('workbook:pending-edits', [3]),
    send('workbook:pending-edits', [-1]),
    send('workbook:pending-edits', ['x']),
    send('workbook:close-save-result', [true]),
    send('workbook:close-save-result', [false]),
    send('workbook:recovery-write-now-done', ['nonce']),
    send('workbook:recovery-write-now-done', [3]),
    call('workbook:close', [S1]),
  ]),

  // ---- CSV ----
  sheetsCase('the CSV questions', { messages: [0, 1, 2, 1, 0, 2] }, [
    call('workbook:csv-save-confirm'),
    call('workbook:csv-save-confirm'),
    call('workbook:csv-save-confirm'),
    call('workbook:withheld-export-choice', ['CSV']),
    call('workbook:withheld-export-choice', ['PDF']),
    call('workbook:withheld-export-choice', ['CSV']),
    call('workbook:withheld-export-choice', ['ODS']),
    call('workbook:withheld-export-choice', []),
  ]),
  sheetsCase(
    'a CSV export: the formula warning, the dialog, a given path, a bad request',
    { saves: ['$DIR/out', null, '$DIR/note.csv'], messages: [0, 2, 1] },
    [
      csvExport({ hasFormulas: true }),
      csvExport({ hasFormulas: true }),
      csvExport({ hasFormulas: true, activeSheetName: 'Data' }),
      csvExport(),
      csvExport({ activeSheetName: 'Data' }),
      csvExport({ targetPath: '$DIR/given' }),
      call('workbook:export-csv', [{ fileName: '', content: 3 }]),
    ],
  ),
  sheetsCase('an export onto the CSV a session was opened from keeps its next save valid', { d1: queued([1, 't.csv']) }, [
    SELECT,
    csvExport({ targetPath: '$DIR/t.csv', content: 'x,y' }),
    save(S1, 'save', { csvContent: 'x,y\n' }),
  ]),

  // ---- ODS ----
  sheetsCase(
    'Save As > ODS: the picked path is accepted once',
    { d1: A, saves: ['$DIR/x.ods'] },
    [SELECT, save(S1, 'save-as'), exportOds({ targetPath: '$DIR/x.ods' }), exportOds({ targetPath: '$DIR/x.ods' }), exportOds({ targetPath: '$DIR/other.ods' })],
  ),
  sheetsCase('the export asks where, adds .ods, and offers the workbook name', { d1: A, saves: ['$DIR/y', null] }, [
    SELECT,
    exportOds({}),
    exportOds({}),
  ]),
  sheetsCase(
    'what ODS cannot hold is listed and asked about once',
    { d1: { ...A, convertToOds: { formulasDropped: 3, dropped: { charts: 2, macros: 1 } } }, saves: ['$DIR/z.ods', '$DIR/z.ods'], messages: [1, 0] },
    [SELECT, exportOds({}), exportOds({})],
  ),
  sheetsCase(
    'cells hidden from the AI cannot go into an ODS copy',
    {
      d1: { ...A, readRedactions: { status: 'ok', source: 'part', states: [{ sheetId: 's1', marks: [{}] }] } },
      saves: ['$DIR/r.ods', '$DIR/r.ods', '$DIR/r.ods'],
      messages: [0, 2, 1],
    },
    [SELECT, exportOds({}), exportOds({}), exportOds({})],
  ),
  sheetsCase('an unreadable redaction record counts as hidden cells', { d1: { ...A, readRedactions: { status: 'unreadable', error: 'bad' } }, saves: ['$DIR/u.ods'], messages: [2] }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('an encrypted workbook is not exported', { d1: { ...queued([1, 'enc.xlsx']), password: 'secret' } }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('the original .ods is never the target', { d1: queued([1, 'sheet.ods']), saves: ['$DIR/sheet.ods', '$DIR/sheet2.ods'] }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('the engine fails the conversion, and the file it wrote cannot be read back', { d1: A, saves: ['$DIR/f.ods', '$DIR/g.ods'] }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('a failed conversion', { d1: { ...A, convertToOds: { error: 'no ods writer' } }, saves: ['$DIR/f.ods'] }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('a file that cannot be opened again is removed', { d1: { ...A, convertWorkbook: { error: 'cannot read' } }, saves: ['$DIR/v.ods'] }, [
    SELECT,
    exportOds({}),
  ]),
  sheetsCase('pending edits are exported from a private copy', { d1: A, saves: ['$DIR/e.ods'] }, [
    SELECT,
    exportOds({ workbook: saveRequest(S1, 'save', { edits: [cellEdit(0)] }) }),
    exportOds({ workbook: saveRequest(S2, 'save') }),
  ]),
  sheetsCase('a request the schema refuses, a session that is not there', { d1: A }, [
    SELECT,
    call('workbook:export-ods', [{ sessionId: 'x' }]),
    exportOds({ targetPath: '' }),
    call('workbook:export-ods', [{ sessionId: NOBODY }]),
  ]),

  // ---- PDF ----
  sheetsCase('an export asks where, and a cancelled dialog writes nothing', { saves: ['$DIR/o.pdf', null] }, [
    call('workbook:export-pdf', [pdfRequest()]),
    call('workbook:export-pdf', [pdfRequest()]),
    call('workbook:export-pdf', [null]),
  ]),
  sheetsCase('Save As > PDF is accepted once and skips the dialog', { d1: A, saves: ['$DIR/p.pdf'] }, [
    SELECT,
    save(S1, 'save-as'),
    call('workbook:export-pdf', [pdfRequest({ saveAsPath: '$DIR/p.pdf' })]),
    call('workbook:export-pdf', [pdfRequest({ saveAsPath: '$DIR/p.pdf' })]),
  ]),
  sheetsCase('a headless run writes where the command line said', { d1: { headless: true } }, [
    call('workbook:export-pdf', [pdfRequest({ outPath: '$DIR/h.pdf' })]),
    call('workbook:export-pdf', [pdfRequest()]),
  ]),

  // ---- AI-created documents ----
  sheetsCase('a CSV and a workbook land in the default folder, numbered when taken', {}, [
    createDoc('csv'),
    createDoc('csv'),
    createDoc('xlsx', { sheetName: 'Data' }),
    createDoc('xlsx', { title: 'a/b:c' }),
  ]),
  sheetsCase('the project folder of the panel decides where a document goes', { d1: { writeNewDocument: { path: '$DIR/proj/My Doc.csv' } } }, [
    createDoc('csv'),
    createDoc('xlsx'),
  ]),
  sheetsCase('the shell has no folder for it', { d1: { writeNewDocument: { error: 'no folder' } } }, [createDoc('csv')]),
  sheetsCase('other formats go to the shell', { d1: { createDocument: { ok: true, path: '$DIR/doc.docx' } } }, [
    createDoc('docx'),
    createDoc('md'),
  ]),
  sheetsCase('the shell has no creator for them, and a request the schema refuses', {}, [
    createDoc('docx'),
    call('workbook:create-document', [{ type: 'exe', title: '', content: '' }]),
    call('workbook:create-document', []),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: loadSheets,
  cases,
  single: {
    'workbook:pending-edits': 'a send answers nothing; it only feeds the close guard, which no call asks',
    'workbook:close-save-result': 'a send answers nothing; it settles a close guard no probe call starts',
    'workbook:recovery-write-now-done': 'a send answers nothing; it settles a flush the shell starts, which no call does',
  },
}

