/**
 * Group `m/print-slides`: the slides editor's `slides:printers`,
 * `slides:printer-options` and `slides:print`.
 *
 * The handlers are inline in `registerSlidesIpc`, so their bodies are copied
 * verbatim from apps/slides/src/main/slides-main.ts:5296-5388. What they call is
 * the real code: shared/print-html.ts (the page assembly), print-window.ts
 * (`printSlidesHtml`), electron-utils' print-job.ts, print-cups.ts,
 * print-window.ts and printer-options.ts. The hidden windows, the temp
 * folder, `lp` and `lpoptions` are print/host.ts's. The window's `parent`
 * (`hostWindowFor(sender) ?? dialogParent()`) is not logged by either side
 * and stays the sender's window.
 *
 * On macOS a silent job takes the CUPS route (printToPDF at the layout's
 * paper, then `lp`), on Linux `webContents.print`: the same cases compare
 * whichever the machine runs.
 */
import { BrowserWindow } from 'electron'
import { rm } from 'node:fs/promises'
import {
  printPdfViaCups,
  printToPdfOptionsFor,
} from '../../../../packages/electron-utils/src/print-cups.ts'
import { printJobOptions, printOutcome } from '../../../../packages/electron-utils/src/print-job.ts'
import { loadPrintHtml } from '../../../../packages/electron-utils/src/print-window.ts'
import {
  DRIVER_OPTION_NAMES,
  queryPrinterOptions,
} from '../../../../packages/electron-utils/src/printer-options.ts'
import { printSlidesHtml } from '../../../../apps/slides/src/main/print-window.ts'
import {
  buildPrintDocumentHtml,
  printPageSizeIn,
} from '../../../../apps/slides/src/shared/print-html.ts'
import type { PrintSlidesOp } from '../../../../apps/slides/src/shared/ipc.ts'
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const slides = [{ view: 1, window: 1, surface: 'Slides' }]
const files = { temp: { dir: true as const } }
const undef = { $: 'u' }
const deck = { pngsBase64: ['AAAA', 'BBBB', 'CCCC'], widthPx: 1280, heightPx: 720 }
const lp = (code: number, stdout = '', stderr = '') => ({
  commands: { '/usr/bin/lp': { code, stdout, stderr } },
})
const lpoptions = (stdout: string, code = 0) => ({
  commands: { '/usr/bin/lpoptions': { code, stdout, stderr: '' } },
})
const printers = { channel: 'slides:printers', args: [] }
const options = (...args: unknown[]) => ({ channel: 'slides:printer-options', args })
const print = (...args: unknown[]) => ({ channel: 'slides:print', args })
const refused = (reason: string) => ({ m: { print: { success: false, failureReason: reason } } })

const QUALITY = 'cupsPrintQuality/Print Quality: Draft *Normal High'
const advertised = [
  QUALITY,
  'ColorModel/Color Model: *Gray RGB CMYK',
  'MediaType/Media Type: *Plain Glossy bad;value Plain',
  'PageSize/Page Size: *A4 Letter',
  'Duplex/2-Sided Printing: None *DuplexNoTumble',
  'Resolution/Resolution: 300dpi *600dpi',
  'bad name/Bad: a b',
  'cupsPrintQuality/Again: x',
  'ColorModel/Empty: ;;;',
  'not a line',
  '  MediaType/Indented: *Plain   Photo  ',
].join('\n')

const cases: Case[] = [
  {
    note: 'printers: the case names none, so the probe offers "office"',
    views: slides,
    calls: [printers],
  },
  {
    note: 'printers: an empty display name shows the name',
    views: slides,
    hosts: {
      m: {
        printers: [
          { name: 'q', displayName: '' },
          { name: 'r', displayName: 'Room R' },
        ],
      },
    },
    calls: [printers],
  },
  {
    note: 'printers: none installed',
    views: slides,
    hosts: { m: { printers: [] } },
    calls: [printers],
  },
  {
    note: 'printer-options: the groups the dialog presents, in the order the driver lists them',
    views: slides,
    hosts: { m: lpoptions(advertised) },
    calls: [options('q'), options('Room.R+1-a_b')],
  },
  {
    note: 'printer-options: a queue lpoptions does not know, one it fails on, and one with nothing to show',
    views: slides,
    hosts: { m: lpoptions('unknown option\n', 1) },
    calls: [options('q')],
  },
  {
    note: 'printer-options: there is no lpoptions',
    views: slides,
    calls: [options('q')],
  },
  {
    note: 'printer-options: output that is no option list',
    views: slides,
    hosts: { m: lpoptions('') },
    calls: [options('q')],
  },
  {
    note: 'printer-options: names that are no queue are refused before lpoptions runs (128 characters are the limit)',
    views: slides,
    hosts: { m: lpoptions(QUALITY) },
    calls: [
      options(undef),
      options(null),
      options(5),
      options(''),
      options('a b'),
      options('a/b'),
      options('-l'),
      options('q;rm'),
      options('é'),
      options('a'.repeat(129)),
      options('a'.repeat(128)),
      options(['q']),
    ],
  },
  {
    note: 'print: the system dialog takes the slides (full pages)',
    views: slides,
    files,
    calls: [print(deck)],
  },
  {
    note: 'print: the user closes the dialog, a bare ok false (the renderer keeps its dialog)',
    views: slides,
    files,
    hosts: refused('Print job canceled'),
    calls: [print(deck)],
  },
  {
    note: 'print: a failure with a reason, and without',
    views: slides,
    files,
    hosts: refused('no printer'),
    calls: [print(deck)],
  },
  {
    note: 'print: a failure without a reason is "the print job failed"',
    views: slides,
    files,
    hosts: refused(''),
    calls: [print(deck)],
  },
  {
    note: 'print: the page does not load',
    views: slides,
    files,
    hosts: { m: { loadError: 'ERR_FILE_NOT_FOUND' } },
    calls: [print(deck)],
  },
  {
    note: 'print: the readiness probe rejects: printing goes on',
    views: slides,
    files,
    hosts: { m: { exec: 'rejected' } },
    calls: [print(deck)],
  },
  {
    note: 'print: a probe that never settles is cut off by its timer',
    views: slides,
    files,
    hosts: { m: { exec: 'pending' } },
    calls: [print(deck)],
  },
  {
    note: 'print: every layout through the dialog (the page assembly is read by its window)',
    views: slides,
    files,
    calls: [
      print({ ...deck, layout: 'handout2', orientation: 'portrait' }),
      print({ ...deck, layout: 'handout3', orientation: 'landscape', order: 'vertical' }),
      print({ ...deck, layout: 'handout4', order: 'horizontal', frame: true }),
      print({ ...deck, layout: 'handout6' }),
      print({ ...deck, layout: 'handout9', orientation: 'landscape' }),
      print({ ...deck, layout: 'notes', notes: ['one', 'two <b>', '3'] }),
      print({ ...deck, layout: 'full', frame: true }),
      print({ ...deck, layout: 'sideways' }),
    ],
  },
  {
    note: 'print: the page assembly: notes and sources to escape, thumbnails across and down, ratios far from a slide',
    views: slides,
    files,
    calls: [
      print({
        ...deck,
        layout: 'notes',
        notes: ['<script>x</script> & "q"', 'two\nlines', ''],
        frame: true,
      }),
      print({
        pngsBase64: ['a"b', '<x>', 'a b'],
        widthPx: 100,
        heightPx: 1000,
        layout: 'handout6',
        order: 'vertical',
        orientation: 'landscape',
      }),
      print({
        pngsBase64: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        widthPx: 10000,
        heightPx: 100,
        layout: 'handout4',
        order: 'vertical',
      }),
      print({
        pngsBase64: ['A', 'B'],
        widthPx: 1024,
        heightPx: 768,
        layout: 'handout9',
        notes: ['n'],
      }),
      print({
        pngsBase64: ['A'],
        widthPx: 800,
        heightPx: 600,
        layout: 'full',
        orientation: 'portrait',
        order: 'vertical',
        frame: false,
      }),
      print({ pngsBase64: ['A'], widthPx: 1280, heightPx: 720, layout: 'handout3', notes: [] }),
      print({ pngsBase64: ['A'], widthPx: 1, heightPx: 3 }),
    ],
  },
  {
    note: 'print: a silent job to a queue, full pages (printToPDF at 7.5 in tall and lp on macOS)',
    views: slides,
    files,
    hosts: { m: lp(0, 'request id is q-1') },
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: silent jobs on every layout and orientation, with every option',
    views: slides,
    files,
    hosts: { m: lp(0) },
    calls: [
      print({
        ...deck,
        layout: 'handout6',
        orientation: 'landscape',
        job: {
          deviceName: 'office',
          copies: 2,
          collate: true,
          duplex: 'longEdge',
          pageSizeIn: { width: 11.69, height: 8.27 },
          driverOptions: [
            { name: 'cupsPrintQuality', value: 'High' },
            { name: 'MediaType', value: 'bad value' },
          ],
        },
      }),
      print({
        ...deck,
        layout: 'notes',
        notes: ['a'],
        orientation: 'portrait',
        job: { deviceName: '' },
      }),
      print({
        ...deck,
        widthPx: 1000,
        heightPx: 1000,
        job: { deviceName: 'q', copies: 0, duplex: 'x' },
      }),
      print({
        ...deck,
        widthPx: 100,
        heightPx: 1000,
        layout: 'handout2',
        job: { deviceName: 'q' },
      }),
    ],
  },
  {
    note: 'print: lp refuses and says why, says it on stdout, or only exits',
    views: slides,
    files,
    hosts: { m: lp(1, '', 'lp: Unknown printer\n') },
    calls: [print({ ...deck, job: { deviceName: 'nope' } })],
  },
  {
    note: 'print: lp says nothing on stderr, its stdout is the reason',
    views: slides,
    files,
    hosts: { m: lp(1, 'busy\n') },
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: lp says nothing at all (and a silent print that is refused on the other route)',
    views: slides,
    files,
    hosts: { m: { ...lp(2), print: { success: false, failureReason: 'Print job canceled' } } },
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: there is no lp (the other route: the print goes out)',
    views: slides,
    files,
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: a silent job whose page does not load (the temp folder is still removed)',
    views: slides,
    files,
    hosts: { m: { loadError: 'ERR_ABORTED', ...lp(0) } },
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: a silent job whose printToPDF rejects (macOS) or whose print fails with a reason (elsewhere)',
    views: slides,
    files,
    hosts: {
      m: {
        pdfError: 'Printing failed',
        print: { success: false, failureReason: 'no paper' },
        ...lp(0),
      },
    },
    calls: [print({ ...deck, job: { deviceName: 'q' } })],
  },
  {
    note: 'print: a job that is no job (no deviceName) stays on the dialog',
    views: slides,
    files,
    calls: [
      print({ ...deck, job: { deviceName: null, copies: 3 } }),
      print({ ...deck, job: 'q' }),
      print({ ...deck, job: null }),
    ],
  },
  {
    note: 'print: an op the page assembly cannot read rejects the invoke with its TypeError',
    views: slides,
    files,
    calls: [
      print(undef),
      print(null),
      print({}),
      print({ pngsBase64: 'x', widthPx: 1, heightPx: 1 }),
      print({ pngsBase64: [], widthPx: 1280, heightPx: 720 }),
      print({ pngsBase64: [1, null, 'x'], widthPx: 1280, heightPx: 720 }),
      print({ pngsBase64: ['A'], widthPx: 0, heightPx: 0 }),
      print({ pngsBase64: ['A'], widthPx: 'x', heightPx: 720 }),
      print({ pngsBase64: ['A'], widthPx: 1280 }),
      print({ ...deck, layout: 'notes', notes: 'abc' }),
      print({ ...deck, layout: 'notes', notes: [1, null] }),
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
          fn: (
            event: {
              sender: Parameters<typeof BrowserWindow.fromWebContents>[0] & {
                getPrintersAsync(): Promise<{ name: string; displayName: string }[]>
              }
            },
            ...args: never[]
          ) => unknown,
        ): void
      }
    }
    const hostWindowFor = (wc: Parameters<typeof BrowserWindow.fromWebContents>[0]) =>
      BrowserWindow.fromWebContents(wc)

    // slides-main.ts:5296-5300
    ipcMain.handle('slides:printer-options', async (_e, queue: unknown) => {
      if (typeof queue !== 'string' || !/^[A-Za-z0-9_.+-]{1,128}$/.test(queue)) return []
      const groups = await queryPrinterOptions(queue)
      return groups.filter((g) => DRIVER_OPTION_NAMES.includes(g.name))
    })

    // slides-main.ts:5302-5305
    ipcMain.handle('slides:printers', async (e) => {
      const printers = await e.sender.getPrintersAsync()
      return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }))
    })

    // slides-main.ts:5307-5388
    ipcMain.handle(
      'slides:print',
      async (e, op: PrintSlidesOp): Promise<{ ok: boolean; error?: string }> => {
        const html = buildPrintDocumentHtml({
          srcs: op.pngsBase64.map((b64) => `data:image/png;base64,${b64}`),
          ratio: op.widthPx / op.heightPx,
          layout: op.layout ?? 'full',
          ...(op.notes ? { notes: op.notes } : {}),
          ...(op.orientation ? { orientation: op.orientation } : {}),
          ...(op.order ? { order: op.order } : {}),
          ...(op.frame ? { frame: true } : {}),
        })
        const owner = hostWindowFor(e.sender)
        const buildWindow = (visibleDialog: boolean) =>
          new BrowserWindow({
            show: false,
            ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
            ...(process.platform === 'win32' && visibleDialog
              ? {
                  width: 900,
                  height: 700,
                  autoHideMenuBar: true,
                  closable: false,
                  skipTaskbar: true,
                }
              : {}),
            webPreferences: { sandbox: true },
          })
        const opts = printJobOptions(op.job)
        if (opts.silent) {
          const win = buildWindow(false)
          let tempDir: string | null = null
          try {
            tempDir = (await loadPrintHtml(win, html, 'slides.html', 'seuoffice-slides-print-'))
              .tempDir
            if (process.platform === 'darwin') {
              const size = printPageSizeIn(
                op.layout ?? 'full',
                op.orientation,
                op.widthPx / op.heightPx,
              )
              const printed = await win.webContents.printToPDF(
                printToPdfOptionsFor({
                  marginsIn: { top: 0, bottom: 0, left: 0, right: 0 },
                  widthIn: size.width,
                  heightIn: size.height,
                }),
              )
              return printPdfViaCups(printed, opts)
            }
            const result = await new Promise<{ success: boolean; failureReason: string }>(
              (resolve) => {
                win.webContents.print(
                  { ...opts, printBackground: true },
                  (success, failureReason) => resolve({ success, failureReason }),
                )
              },
            )
            return printOutcome(result.success, result.failureReason, true)
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true })
            if (!win.isDestroyed()) win.destroy()
          }
        }
        const win = buildWindow(true)
        return printSlidesHtml(html, win)
      },
    )
  },
  cases,
}
