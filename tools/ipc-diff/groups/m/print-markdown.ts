/**
 * Group `m/print-markdown`: the Markdown editor's `markdown:print-preview` and
 * `markdown:print-document`.
 *
 * The handlers are inline in `registerMarkdownIpc`, so their bodies are copied
 * verbatim from apps/markdown/src/main/markdown-main.ts:1326-1380 (the
 * `printingDocuments` set is line 1348). What they call is the real code:
 * print-pdf.ts (`printMarkdownPdf`), print-document.ts
 * (`printMarkdownDocument`) and shared/print-options.ts. The hidden windows
 * and the temp folder are print/host.ts's.
 *
 * Not covered: a request whose html is longer than MAX_PRINT_HTML_CHARS (50
 * million characters, a 50 MB case line; the Rust limit is unit-tested), and
 * a second print of one view while another is in flight (the calls run one
 * after another).
 */
import {
  MAX_PRINT_HTML_CHARS,
  normalizeMarkdownPrintOptions,
} from '../../../../apps/markdown/src/shared/print-options.ts'
import { printMarkdownDocument } from '../../../../apps/markdown/src/main/print-document.ts'
import { printMarkdownPdf } from '../../../../apps/markdown/src/main/print-pdf.ts'
import type {
  MarkdownPrintDocumentRequest,
  MarkdownPrintDocumentResult,
  MarkdownPrintPreviewRequest,
  MarkdownPrintPreviewResult,
} from '../../../../apps/markdown/src/shared/ipc.ts'
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const md = [{ view: 1, window: 1, surface: 'Markdown' }]
const files = { temp: { dir: true as const } }
const html = '<!doctype html><html><body><h1>Title</h1></body></html>'
const preview = (...args: unknown[]) => ({ channel: 'markdown:print-preview', args })
const document = (...args: unknown[]) => ({ channel: 'markdown:print-document', args })
const m = (config: Record<string, unknown>) => ({ m: config })
const refused = (reason: string) => m({ print: { success: false, failureReason: reason } })

const cases: Case[] = [
  {
    note: 'preview: the default options (A4, 0.6 in, portrait, backgrounds)',
    views: md,
    files,
    calls: [preview({ html })],
  },
  {
    note: "preview: Letter and landscape are taken, the margin is always the preview's",
    views: md,
    files,
    hosts: m({ pdf: '%PDF-1.4 md' }),
    calls: [preview({ html, options: { pageSize: 'Letter', landscape: true, marginIn: 3 } })],
  },
  {
    note: 'preview: options the renderer may not choose fall to the defaults',
    views: md,
    files,
    calls: [
      preview({ html, options: { pageSize: 'A3', landscape: 'yes', printBackground: false } }),
      preview({ html, options: 'Letter' }),
      preview({ html, options: null }),
    ],
  },
  {
    note: 'preview: requests that are no print requests, before any window is made',
    views: md,
    files,
    calls: [
      preview({ $: 'u' }),
      preview(null),
      preview({}),
      preview({ html: '' }),
      preview({ html: 5 }),
    ],
  },
  {
    note: 'preview: the page does not load, the error is the answer',
    views: md,
    files,
    hosts: m({ loadError: 'ERR_FILE_NOT_FOUND' }),
    calls: [preview({ html })],
  },
  {
    note: 'preview: printToPDF rejects',
    views: md,
    files,
    hosts: m({ pdfError: 'Printing failed' }),
    calls: [preview({ html })],
  },
  {
    note: 'document: the dialog takes the whole document',
    views: md,
    files,
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: one range, Letter, landscape',
    views: md,
    files,
    calls: [
      document({
        html,
        pages: { from: 2, to: 4 },
        options: { pageSize: 'Letter', landscape: true },
      }),
      document({ html, pages: { from: 3, to: 3 }, options: { landscape: false } }),
    ],
  },
  {
    note: 'document: the user closes the dialog (any reason that says cancel)',
    views: md,
    files,
    hosts: refused('Print job canceled'),
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: "cancel" is matched in any case, anywhere in the reason',
    views: md,
    files,
    hosts: refused('The user CANCELLED it'),
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: a failure with a reason',
    views: md,
    files,
    hosts: refused('no printer'),
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: a failure without a reason is "print failed"',
    views: md,
    files,
    hosts: refused(''),
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: the page does not load',
    views: md,
    files,
    hosts: m({ loadError: 'ERR_ABORTED' }),
    calls: [document({ html, pages: null })],
  },
  {
    note: 'document: ranges the printer may not be given (no pages at all is not "all pages")',
    views: md,
    files,
    calls: [
      document({ html }),
      document({ html, pages: { from: 0, to: 1 } }),
      document({ html, pages: { from: 2, to: 1 } }),
      document({ html, pages: { from: 1.5, to: 2 } }),
      document({ html, pages: { from: '1', to: 2 } }),
      document({ html, pages: { from: 1 } }),
      document({ html, pages: 'all' }),
      document({ html, pages: 3 }),
    ],
  },
  {
    note: 'document: requests that are no print requests (the html is checked before the range)',
    views: md,
    files,
    calls: [
      document({ $: 'u' }),
      document(null),
      document({ pages: null }),
      document({ html: '', pages: { from: 0, to: 0 } }),
      document({ html: 7, pages: null }),
    ],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const { ipcMain } = cx.electron as unknown as {
      ipcMain: {
        handle(
          channel: string,
          fn: (event: { sender: { id: number } }, ...args: never[]) => unknown,
        ): void
      }
    }

    // markdown-main.ts:1326-1347
    ipcMain.handle(
      'markdown:print-preview',
      async (_e, request: MarkdownPrintPreviewRequest): Promise<MarkdownPrintPreviewResult> => {
        if (
          typeof request?.html !== 'string' ||
          !request.html ||
          request.html.length > MAX_PRINT_HTML_CHARS
        ) {
          return { ok: false, error: 'markdown: bad print preview request' }
        }
        try {
          const pdf = await printMarkdownPdf(
            request.html,
            normalizeMarkdownPrintOptions(request.options),
          )
          return { ok: true, pdf: new Uint8Array(pdf) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    // markdown-main.ts:1348-1380
    const printingDocuments = new Set<number>()
    ipcMain.handle(
      'markdown:print-document',
      async (e, request: MarkdownPrintDocumentRequest): Promise<MarkdownPrintDocumentResult> => {
        if (
          typeof request?.html !== 'string' ||
          !request.html ||
          request.html.length > MAX_PRINT_HTML_CHARS
        ) {
          return { ok: false, error: 'markdown: bad print request' }
        }
        const pages = request.pages
        if (
          pages !== null &&
          (!Number.isInteger(pages?.from) ||
            !Number.isInteger(pages?.to) ||
            pages.from < 1 ||
            pages.to < pages.from)
        ) {
          return { ok: false, error: 'markdown: bad print range' }
        }
        const wcId = e.sender.id
        if (printingDocuments.has(wcId)) return { ok: false, error: 'markdown: already printing' }
        printingDocuments.add(wcId)
        try {
          return await printMarkdownDocument(
            request.html,
            pages,
            normalizeMarkdownPrintOptions(request.options),
          )
        } finally {
          printingDocuments.delete(wcId)
        }
      },
    )
  },
  cases,
}
