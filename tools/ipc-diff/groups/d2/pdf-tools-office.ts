/**
 * Group `d2/pdf-tools-office`: `pdf:convert-office`, registered by the shell
 * entry itself (`apps/shell/src/main/index.ts`, loaded with W's
 * `loadShellIndex`). The case's active pdf tab
 * (`hosts.d2.pdf.tools.active_pdf_tab`) is a focused detached window on the
 * TypeScript side (pdf-tools-fakes/detached-windows.cts), where
 * `activePdfTarget()` looks first; the conversion answers from the case
 * (pdf-tools-fakes/pdf2docx-local.cts).
 *
 * The entry builds its tab manager when the app is ready, which it never is
 * here; the Rust fakes run with `tabManager: false` to match. So the Word,
 * Excel and PowerPoint flows run up to the written file and do not open it,
 * and the Hangul flow (`openPdfAsHwp` returns while there is no tab manager)
 * answers without an effect on both sides.
 */
import type { Case, Group, View } from '../../types.ts'
import { loadShellIndex } from '../w/shell-index.ts'
import { startToolsCase } from './pdf-tools-fakes/load.ts'

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const PDF: View = { view: 5, window: 7, surface: 'Pdf' }
const OTHER: View = { view: 6, window: 7, surface: 'Pdf' }
const views = [SHELL, PDF, OTHER]
const A = '$DIR/documents/a.pdf'
const files = { 'documents/a.pdf': '%PDF-a', out: { dir: true as const } }
const convert = (format: unknown, view = 5) => ({
  channel: 'pdf:convert-office',
  view,
  args: [format],
})
/** the entry's strings in its start-up language (Korean: no settings file) */
const strings = {
  filterWord: 'Word 문서',
  pdfDocxFailedMsg: 'Word로 내보내기 실패',
  pdfDocxLocalCorruptDetail: '파일이 손상되었거나 유효한 PDF가 아니어서 변환할 수 없습니다.',
}
const hosts = (tools: Record<string, unknown>, save: unknown[] = []) => ({
  shared: { dialogs: { save } },
  d2: {
    pdf: {
      tools: {
        tabManager: false,
        strings,
        active_pdf_tab: { id: 'tab-5', view: 5, filePath: A, window: 7 },
        ...tools,
      },
    },
  },
})

const cases: Case[] = [
  {
    note: 'no active pdf tab: no format converts',
    views,
    files,
    calls: [convert('docx'), convert('xlsx'), convert('pptx'), convert('hwp'), convert(3)],
  },
  {
    note: 'only a pdf view may ask',
    views,
    calls: [{ channel: 'pdf:convert-office', view: 1, args: ['docx'] }],
  },
  {
    note: 'Word: pick the file, convert, write it; another pdf view and an unknown format do nothing',
    views,
    files,
    hosts: hosts({ convert_to_office: [{ bytes: { $u8: [80, 75] }, pageResults: [[1, 'ok']] }] }, [
      '$DIR/out/a.docx',
    ]),
    calls: [convert('docx', 6), convert('odt'), convert('docx')],
  },
  {
    note: 'Word: a cancelled save dialog converts nothing',
    views,
    files,
    hosts: hosts({}, [null]),
    calls: [convert('docx')],
  },
  {
    note: 'Word: a damaged PDF is explained',
    views,
    files,
    hosts: hosts({ convert_to_office: [{ load: 'corrupt' }] }, ['$DIR/out/a.docx']),
    calls: [convert('docx')],
  },
  {
    note: 'Hangul: without the tab manager the copy is not made',
    views,
    files,
    hosts: hosts({}),
    calls: [convert('hwp')],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    startToolsCase(cx)
    await loadShellIndex(cx)
  },
  cases,
}
