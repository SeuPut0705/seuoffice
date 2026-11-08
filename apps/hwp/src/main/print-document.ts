import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { MAX_PRINT_CHARS, MAX_PRINT_PAGES } from '../shared/ipc'
import type { PrintJob, PrintPage } from '../shared/ipc'

/**
 * Printing a document: the pages as the editor draws them for print (SVG), one after
 * another in one HTML page sized page by page, which a hidden window with scripts off
 * turns into a PDF or hands to the system print dialog.
 */

/** Paper sides in mm: ISO A3–A5, JIS B4–B5, US Letter, Legal and Tabloid. */
const PAPER_SIDES_MM = [148, 182, 210, 215.9, 257, 279.4, 297, 355.6, 364, 420, 431.8]
/**
 * A side within this of a paper side is that side. The file keeps lengths in whole
 * HWPUNIT and the editor gives pages to a tenth of a pixel, so an A4 page comes out
 * 296.99 mm; printed so, a printer takes it for a paper it does not have.
 */
const PAPER_SNAP_MM = 0.05

/** A page side in CSS pixels as mm, on the paper side it is meant to be when it is one. */
export function sideMm(px: number): number {
  const mm = (px * 25.4) / 96
  const paper = PAPER_SIDES_MM.find((side) => Math.abs(side - mm) <= PAPER_SNAP_MM)
  return paper ?? Math.round(mm * 1000) / 1000
}

/**
 * The page's ids made its own: every page names its clip paths from the same counter, so
 * pages put in one HTML would clip with each other's. References go with them.
 */
export function ownIds(svg: string, prefix: string): string {
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)\s]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/\bhref="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`)
}

/** The picture types written out as files; any other picture stays in the page. */
const IMAGE_FILE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/

/** The file a picture of the job is written to, or null when it stays a data URL. */
export function imageFile(dataUrl: string, index: number): { name: string; bytes: Buffer } | null {
  const match = DATA_URL.exec(dataUrl)
  const ext = match ? IMAGE_FILE_EXT[match[1]] : undefined
  if (!match || !ext) return null
  return { name: `image-${index}.${ext}`, bytes: Buffer.from(match[2], 'base64') }
}

/** Why a job from the renderer is not printed, or null when it may be. */
export function badJob(job: unknown): string | null {
  if (!job || typeof job !== 'object') return 'not a print job'
  const { mode, pages, images } = job as Partial<PrintJob>
  if (mode !== 'pdf' && mode !== 'print') return 'unknown print mode'
  if (!Array.isArray(pages) || pages.length === 0) return 'no pages'
  if (pages.length > MAX_PRINT_PAGES) return 'too many pages'
  if (!Array.isArray(images) || images.some((image) => typeof image !== 'string')) {
    return 'bad pictures'
  }
  let chars = images.reduce((sum, image) => sum + image.length, 0)
  for (const page of pages as unknown[]) {
    const { svg, width, height } = (page ?? {}) as Partial<PrintPage>
    if (typeof svg !== 'string' || !svg.trimStart().startsWith('<svg')) return 'bad page'
    if (!isSide(width) || !isSide(height)) return 'bad page size'
    chars += svg.length
  }
  if (chars > MAX_PRINT_CHARS) return 'too large'
  return null
}

const isSide = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000

/** Pages and pictures load from the job's own folder; nothing else is fetched or run. */
const PRINT_CSP =
  "default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; font-src file: data:; " +
  "base-uri 'none'; form-action 'none'"

const mm = (value: number) => `${value}mm`

/**
 * The HTML of the pages: each page on a paper of its own size with no margin, the page's
 * pictures pointing at `picture(i)` (a file name next to the HTML, or the data URL).
 */
export function printableHtml(pages: PrintPage[], picture: (index: number) => string): string {
  const rules: string[] = []
  const body: string[] = []
  pages.forEach((page, index) => {
    const width = mm(sideMm(page.width))
    const height = mm(sideMm(page.height))
    rules.push(`@page p${index} { size: ${width} ${height}; margin: 0; }`)
    rules.push(`.p${index} { page: p${index}; width: ${width}; height: ${height}; }`)
    const svg = ownIds(page.svg, `p${index}-`).replace(
      /\bhref="ieum-image:(\d+)"/g,
      (_, n: string) => `href="${picture(Number(n))}"`,
    )
    body.push(`<div class="page p${index}">${svg}</div>`)
  })
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    // what is printed is the document: the same in either app theme
    '<style>',
    '* { margin: 0; padding: 0; }',
    'body { background: #fff; }',
    '.page { overflow: hidden; break-after: page; }',
    '.page:last-child { break-after: auto; }',
    '.page > svg { display: block; width: 100%; height: 100%; }',
    ...rules,
    '</style>',
    '</head>',
    `<body>${body.join('')}</body>`,
    '</html>',
  ].join('\n')
}

export type PrintWindow = Pick<BrowserWindow, 'loadFile' | 'destroy'> & {
  webContents: Pick<BrowserWindow['webContents'], 'printToPDF' | 'print'>
}

/**
 * Put the job in a folder of its own (the HTML and its pictures), load it in the window
 * `createWindow` makes (hidden, scripts off) and run `use` on it. The window and the
 * folder are gone afterwards, whatever happened.
 */
async function withPrintWindow<T>(
  job: PrintJob,
  createWindow: () => PrintWindow,
  use: (win: PrintWindow) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ieum-hwp-print-'))
  let win: PrintWindow | undefined
  try {
    const names = await Promise.all(
      job.images.map(async (dataUrl, index) => {
        const file = imageFile(dataUrl, index)
        if (!file) return dataUrl
        await writeFile(join(dir, file.name), file.bytes)
        return file.name
      }),
    )
    const htmlPath = join(dir, 'print.html')
    await writeFile(
      htmlPath,
      printableHtml(job.pages, (index) => names[index] ?? ''),
      'utf8',
    )
    win = createWindow()
    await win.loadFile(htmlPath)
    return await use(win)
  } finally {
    win?.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}

/** The pages as PDF bytes, each page on its own paper. */
export function printJobToPdf(job: PrintJob, createWindow: () => PrintWindow): Promise<Buffer> {
  return withPrintWindow(job, createWindow, (win) =>
    win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }),
  )
}

/**
 * The pages to the system print dialog. Resolves when the dialog is done: true when they
 * were sent to a printer, false when the user canceled.
 */
export function printJobToPrinter(
  job: PrintJob,
  createWindow: () => PrintWindow,
): Promise<boolean> {
  return withPrintWindow(
    job,
    createWindow,
    (win) =>
      new Promise<boolean>((resolve, reject) => {
        win.webContents.print(
          { silent: false, printBackground: true, margins: { marginType: 'none' } },
          (sent, reason) => {
            if (sent || /cancel/i.test(reason)) resolve(sent)
            else reject(new Error(reason || 'print failed'))
          },
        )
      }),
  )
}
