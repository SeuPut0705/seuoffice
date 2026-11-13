/**
 * Group `d2/pdf-tools-convert`: the shell side of the pdf editor's Markdown /
 * EPUB conversion screen (`apps/shell/src/main/pdf-convert-ui.ts`), registered
 * with the tab manager hooks the shell entry passes (logged by the fakes). A
 * request names the view's own PDF, given by the `d2/pdf-tools:open-view`
 * trigger; the dialog request is the shell's `requestPdfConvertDialog`.
 */
import type { Case, Group, View } from '../../types.ts'
import { loadPdfTools, trigger, triggers } from './pdf-tools-fakes/load.ts'

const PDF: View = { view: 5, window: 1, surface: 'Pdf' }
const views = [PDF]
const A = '$DIR/documents/a.pdf'
const MD = '$DIR/out/a.md'
const files = {
  'documents/a.pdf': '%PDF-a',
  'out/a.md': '# a',
  'out/a.epub': 'epub',
  'out/a.txt': 'text',
}
const call = (channel: string, ...args: unknown[]) => ({ channel, view: 5, args })
const release = (path: unknown, source: unknown = A) =>
  call('pdf:convert-release-target', { source, path })
const openResult = (path: unknown) => call('pdf:convert-open-result', { source: A, path })
const reveal = (path: unknown) => call('pdf:convert-reveal-result', { source: A, path })
const grant = trigger('open-view', 5, [A])
const hosts = (tools: unknown) => ({ d2: { pdf: { tools } } })

const cases: Case[] = [
  {
    note: 'a view that was not given the PDF gets nothing',
    views,
    files,
    calls: [release(MD), openResult(MD), reveal(MD)],
  },
  {
    note: 'freeing the target: no tab shows it, a tab closes, a tab stays, a close that fails',
    views,
    files,
    hosts: hosts({
      find_tab: [null, 'tab-1', null, 'tab-2', 'tab-2', 'tab-3'],
      close_tab: [null, null, 'the tab would not close'],
    }),
    calls: [
      grant,
      release(MD),
      release(MD),
      release(MD),
      release(MD),
      release('$DIR/out/a.epub'),
      release(''),
      release(MD, '$DIR/documents/b.pdf'),
      call('pdf:convert-release-target', null),
    ],
  },
  {
    note: 'only an existing Markdown result opens; results of the kinds written are shown',
    views,
    files,
    hosts: hosts({ open_document_path: [false] }),
    calls: [
      grant,
      openResult(MD),
      openResult(MD),
      openResult('$DIR/out/b.md'),
      openResult('$DIR/out/a.epub'),
      reveal('$DIR/out/a.epub'),
      reveal(MD),
      reveal('$DIR/out/a.txt'),
      reveal('$DIR/out/gone.pdf'),
      call('pdf:convert-reveal-result', 'x'),
    ],
  },
  {
    note: 'File > Markdown / EPUB and Save As ask the pdf view to open its conversion dialog',
    views,
    files,
    calls: [
      trigger('request-convert-dialog', 5, ['md']),
      trigger('request-convert-dialog', 5, ['epub', '$DIR/out/b.epub']),
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  load: loadPdfTools,
  cases,
  triggers,
}
