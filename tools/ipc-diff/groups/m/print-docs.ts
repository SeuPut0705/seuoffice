/**
 * Group `m/print-docs`: the docs editor's printing, `docs:printers`,
 * `docs:print` and `docs:print-pdf-buffer`.
 *
 * The handlers are inline in `registerDocsIpc`, which cannot be loaded here (it
 * is the whole editor), so their bodies are copied verbatim from
 * apps/docs/src/main/docs-main.ts: `printScale` and `docs:printers` /
 * `docs:print` from lines 3516-3578, `docs:print-pdf-buffer` from 3831-3855
 * (`TWIPS_PER_INCH` is line 1696, `pdfScale` line 3513). The helpers they call
 * are the real ones: print-args.ts and electron-utils' print-job.ts and
 * print-cups.ts. The sender's own `print`/`printToPDF` are W's shared fakes;
 * `lp` is the CUPS fake of print/host.ts.
 *
 * On macOS a named printer takes the CUPS route (printToPDF, then `lp`), on
 * Linux `webContents.print`: the same cases compare whichever the machine runs.
 */
import { printPdfViaCups } from '../../../../packages/electron-utils/src/print-cups.ts'
import { printJobOptions, printOutcome } from '../../../../packages/electron-utils/src/print-job.ts'
import {
  printPaperOption,
  printScaleOption,
  validPrintGeometry,
  validPrintPaper,
} from '../../../../apps/docs/src/main/print-args.ts'
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const TWIPS_PER_INCH = 1440

const docs = [{ view: 1, window: 1, surface: 'Docs' }]
const undef = { $: 'u' }
const A4 = { widthTwips: 11906, heightTwips: 16838 }
const lp = (code: number, stdout = '', stderr = '') => ({
  commands: { '/usr/bin/lp': { code, stdout, stderr } },
})
const contents = (c: Record<string, unknown>) => ({ shared: { contents: c } })

const printers = { channel: 'docs:printers', args: [] }
const print = (...args: unknown[]) => ({ channel: 'docs:print', args })
const buffer = (...args: unknown[]) => ({ channel: 'docs:print-pdf-buffer', args })

/** a silent job to the queue `q` */
const job = (extra: Record<string, unknown> = {}) => ({ deviceName: 'q', ...extra })

const cases: Case[] = [
  {
    note: 'printers: the case names none, so the probe offers "office"',
    views: docs,
    calls: [printers],
  },
  {
    note: 'printers: an empty display name shows the name, none at all gives an empty list',
    views: docs,
    hosts: { m: { printers: [{ name: 'q', displayName: '' }, { name: 'r', displayName: 'Room R' }] } },
    calls: [printers],
  },
  {
    note: 'printers: no printer installed',
    views: docs,
    hosts: { m: { printers: [] } },
    calls: [printers],
  },
  {
    note: 'print: the system dialog, nothing asked for',
    views: docs,
    hosts: contents({ print: true }),
    calls: [print(undef, undef, undef)],
  },
  {
    note: 'print: the dialog route with a scale and the document paper (the paper wins over the job size)',
    views: docs,
    hosts: contents({ print: true }),
    calls: [print(1.5, { pageSizeIn: { width: 8.5, height: 11 } }, A4)],
  },
  {
    note: 'print: scale 1 and a scale that is no number are left out, a job that is no object is no job',
    views: docs,
    hosts: contents({ print: true }),
    calls: [print(1, 'job', { widthTwips: 143, heightTwips: 16838 }), print(-2, null, null)],
  },
  {
    note: 'print: the dialog answers a cancel, which is no error: a bare ok false',
    views: docs,
    hosts: contents({ print: false }),
    calls: [print(undef, { deviceName: null }, undef)],
  },
  {
    note: 'print: a silent job to the default queue, the document paper, a scale (CUPS on macOS)',
    views: docs,
    hosts: { ...contents({ pdf: '25504446' }), m: lp(0, 'request id is q-1') },
    calls: [print(0.8, job({ deviceName: '' }), A4)],
  },
  {
    note: 'print: a silent job with every option, lp takes it',
    views: docs,
    hosts: {
      ...contents({ pdf: '25504446', print: true }),
      m: lp(0),
    },
    calls: [
      print(
        1.25,
        job({
          copies: 3,
          collate: true,
          duplex: 'shortEdge',
          pageSizeIn: { width: 8.27, height: 11.69 },
          driverOptions: [
            { name: 'cupsPrintQuality', value: 'High' },
            { name: 'bad name', value: 'x' },
            { name: 'ColorModel', value: 'Gray' },
          ],
        }),
        undef,
      ),
    ],
  },
  {
    note: 'print: out-of-range copies and an unknown duplex are dropped, not clamped',
    views: docs,
    hosts: { ...contents({ pdf: '25504446' }), m: lp(0) },
    calls: [print(undef, job({ copies: 1000, duplex: 'diagonal', collate: 'yes', pageSizeIn: { width: 0, height: 5 } }), undef)],
  },
  {
    note: 'print: lp refuses and says why on stderr',
    views: docs,
    hosts: { ...contents({ pdf: '25504446', print: false }), m: lp(1, 'out', 'lp: Unknown printer\n') },
    calls: [print(undef, job(), A4)],
  },
  {
    note: 'print: lp says nothing on stderr, its stdout is the reason',
    views: docs,
    hosts: { ...contents({ pdf: '25504446', print: false }), m: lp(1, 'busy\n', '') },
    calls: [print(undef, job(), undef)],
  },
  {
    note: 'print: lp says nothing at all, the exit code is the reason',
    views: docs,
    hosts: { ...contents({ pdf: '25504446', print: false }), m: lp(3) },
    calls: [print(undef, job(), undef)],
  },
  {
    note: 'print: there is no lp (and a failed silent print on the other route): the failure reaches the caller',
    views: docs,
    hosts: contents({ pdf: '25504446', print: false }),
    calls: [print(undef, job(), undef)],
  },
  {
    note: 'print: printToPDF fails (CUPS route) while the print itself would work: the invoke rejects there',
    views: docs,
    hosts: { shared: { contents: { print: true } }, m: lp(0) },
    calls: [print(undef, job(), A4)],
  },
  {
    note: 'print-pdf-buffer: a valid page, no scale',
    views: docs,
    hosts: contents({ pdf: '255044462d312e34' }),
    calls: [buffer(11906, 16838, undef)],
  },
  {
    note: 'print-pdf-buffer: a scale, and the scale 1 that is left out',
    views: docs,
    hosts: contents({ pdf: '25504446' }),
    calls: [buffer(12240, 15840, 1.25), buffer(12240, 15840, 1)],
  },
  {
    note: 'print-pdf-buffer: sizes and scales that must not reach Chromium',
    views: docs,
    hosts: contents({ pdf: '25504446' }),
    calls: [
      buffer(143, 16838, undef),
      buffer(11906, 72001, undef),
      buffer(11906, 16838, 0.09),
      buffer(11906, 16838, 5.1),
      buffer('11906', 16838, undef),
      buffer(11906, 16838, null),
      buffer(undef, undef, undef),
    ],
  },
  {
    note: 'print-pdf-buffer: the bounds themselves are valid',
    views: docs,
    hosts: contents({ pdf: '25504446' }),
    calls: [buffer(144, 72000, 0.1), buffer(72000, 144, 5)],
  },
  {
    note: 'print-pdf-buffer: printToPDF rejects, the error is the answer',
    views: docs,
    calls: [buffer(11906, 16838, undef)],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const { ipcMain } = cx.electron as unknown as {
      ipcMain: { handle(channel: string, fn: (event: Event, ...args: never[]) => unknown): void }
    }
    interface Event {
      sender: {
        getPrintersAsync(): Promise<{ name: string; displayName: string }[]>
        printToPDF(options: unknown): Promise<Buffer>
        print(options: unknown, done: (success: boolean, failureReason: string) => void): void
      }
    }

    // docs-main.ts:3513-3519
    const pdfScale = (scale?: number) => printScaleOption(scale)
    const printScale = (scale?: number) =>
      typeof scale === 'number' && Number.isFinite(scale) && scale > 0 && scale !== 1
        ? { scaleFactor: Math.round(scale * 100) }
        : {}

    // docs-main.ts:3526-3529
    ipcMain.handle('docs:printers', async (event) => {
      const printers = await event.sender.getPrintersAsync()
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
      }))
    })

    // docs-main.ts:3531-3573
    ipcMain.handle('docs:print', async (event, scale?: number, job?: unknown, paper?: unknown) => {
      const printOpts = {
        margins: { marginType: 'none' as const },
        ...printScale(scale),
        ...printJobOptions(job),
        ...printPaperOption(paper),
      }
      if (process.platform === 'darwin' && printOpts.silent) {
        const geometry = validPrintPaper(paper)
        const printed = await event.sender.printToPDF({
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          ...(geometry
            ? {
                pageSize: {
                  width: geometry.widthTwips / TWIPS_PER_INCH,
                  height: geometry.heightTwips / TWIPS_PER_INCH,
                },
              }
            : {}),
          ...printScaleOption(scale),
        })
        return printPdfViaCups(printed, printOpts)
      }
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        event.sender.print(printOpts, (success, failureReason) => {
          resolve(printOutcome(success, failureReason, printOpts.silent))
        })
      })
    })

    // docs-main.ts:3831-3852
    ipcMain.handle(
      'docs:print-pdf-buffer',
      async (event, pageWidthTwips: number, pageHeightTwips: number, scale?: number) => {
        if (!validPrintGeometry(pageWidthTwips, pageHeightTwips, scale)) {
          return { ok: false, error: 'invalid page size or scale' }
        }
        try {
          const data = await event.sender.printToPDF({
            printBackground: true,
            pageSize: {
              width: pageWidthTwips / TWIPS_PER_INCH,
              height: pageHeightTwips / TWIPS_PER_INCH,
            },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            ...pdfScale(scale),
          })
          return { ok: true, base64: data.toString('base64') }
        } catch (err) {
          return { ok: false, error: String(err) }
        }
      },
    )
  },
  cases,
}
