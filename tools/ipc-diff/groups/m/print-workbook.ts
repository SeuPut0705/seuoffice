/**
 * Group `m/print-workbook`: the sheets editor's `workbook:print` and
 * `workbook:list-printers`.
 *
 * The handlers are inline in `registerSheetsIpc`, so their bodies are copied
 * verbatim from apps/sheets/src/main/sheets-main.ts:3256-3271, with `sessionFor`
 * (773-777) over the module's `sheetsTabs` map. What they call is the real
 * code: pdf-export.ts (`printWorkbook`) and the zod schemas of
 * shared/desktop-api.ts.
 *
 * Every call here stops at `sessionFor`: the probe has no sheets editor (no
 * document batch provides `DocumentEditors`), so `sheetsTabs` is empty and
 * no view is a trusted sheets tab, on both sides. That is also why the zod
 * rejection order cannot be observed: `sessionFor` runs before the request is
 * parsed, so an invalid request, a valid one and an oversized printer name
 * all answer 'Untrusted IPC sender.'. The flow behind it (the window, the
 * template fonts, CUPS) is not reachable until a sheets batch provides its
 * editor; the Rust unit tests of print.rs cover it.
 */
import type { IpcMainInvokeEvent } from 'electron'
import { printWorkbook } from '../../../../apps/sheets/src/main/pdf-export.ts'
import {
  printerInfoSchema,
  workbookExportPdfRequestSchema,
} from '../../../../apps/sheets/src/shared/desktop-api.ts'
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const sheets = [{ view: 1, window: 1, surface: 'Sheets' }]
const request = {
  fileName: 'book.pdf',
  html: '<html><body>x</body></html>',
  landscape: false,
  pageSize: 'A4',
  margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
  scale: 1,
}
const print = (...args: unknown[]) => ({ channel: 'workbook:print', args })
const list = { channel: 'workbook:list-printers', args: [] }

const cases: Case[] = [
  {
    note: 'list-printers: no sheets tab is registered, so the sender is untrusted',
    views: sheets,
    calls: [list],
  },
  {
    note: 'list-printers: a printer name over the schema limit is never parsed: the sender is checked first',
    views: sheets,
    hosts: { m: { printers: [{ name: 'q'.repeat(256), displayName: 'Q' }] } },
    calls: [list],
  },
  {
    note: 'list-printers: from a docs view the shell refuses the channel itself',
    views: [{ view: 1, window: 1, surface: 'Docs' }],
    calls: [list],
  },
  {
    note: 'print: a valid request from an untrusted sender, and with a named printer',
    views: sheets,
    files: { temp: { dir: true as const } },
    calls: [print(request), print({ ...request, deviceName: 'q', copies: 2, collate: true })],
  },
  {
    note: 'print: requests the schema would reject answer the same: the sender is checked first',
    views: sheets,
    files: { temp: { dir: true as const } },
    calls: [print({ $: 'u' }), print(null), print({}), print({ ...request, scale: 9 }), print({ ...request, extra: 1 })],
  },
  {
    note: 'print: from a docs view the shell refuses the channel itself',
    views: [{ view: 1, window: 1, surface: 'Docs' }],
    calls: [print(request)],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const { ipcMain } = cx.electron as unknown as {
      ipcMain: {
        handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
      }
    }

    // sheets-main.ts:763, 773-777
    const sheetsTabs = new Map<number, unknown>()
    function sessionFor(event: IpcMainInvokeEvent): unknown {
      const entry = sheetsTabs.get(event.sender.id)
      if (!entry) throw new Error('Untrusted IPC sender.')
      return entry
    }

    // sheets-main.ts:3256-3259
    ipcMain.handle('workbook:print', async (event, input: unknown) => {
      sessionFor(event)
      return printWorkbook(event, workbookExportPdfRequestSchema.parse(input))
    })

    // sheets-main.ts:3261-3271
    ipcMain.handle('workbook:list-printers', async (event) => {
      sessionFor(event)
      const printers = await event.sender.getPrintersAsync()
      return printers.map((printer) =>
        printerInfoSchema.parse({
          name: printer.name,
          displayName: printer.displayName || printer.name,
        }),
      )
    })
  },
  cases,
}
