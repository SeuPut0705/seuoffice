/**
 * Group `b4-pdf`: the Electron-free modules of apps/pdf/src/main.
 *
 * Three things the TypeScript takes from outside are replaced the same way on
 * both sides:
 *
 * - the PDFium wasm instance (`loadPdfium` of text-edit.ts) by a scripted
 *   world, `FakePdfium` of b4-pdf-fakes.ts and `FakePdfium` of
 *   crates/main-core/src/calls/b4_pdf/fake.rs; every call is a log line;
 * - the hb-subset wasm instance by `FakeHb`, the same way;
 * - the system's certificate tools by a scripted command runner; the
 *   certificates are real (generated with openssl), and the Rust side reads
 *   them through a table of what each one describes as.
 *
 * Disk watching and the note service are driven by steps: a timer fires, a
 * `stat` answers, an event arrives, in the order the case lists them.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyAnnotDeletes, removeMatchingAnnots } from '../../../apps/pdf/src/main/annot-delete.ts'
import { flattenAnnotsBytes } from '../../../apps/pdf/src/main/annot-flatten.ts'
import { writePdfAtomically } from '../../../apps/pdf/src/main/atomic-write.ts'
import {
  MAX_THUMBS,
  RENDER_LONG_SIDE,
  THUMB_LONG_SIDE,
  findBlankPages,
  isNearlyWhite,
  shrinkBitmap,
} from '../../../apps/pdf/src/main/blank-pages.ts'
import type { BlankPagesPdfium } from '../../../apps/pdf/src/main/blank-pages.ts'
import {
  DISK_WATCH_MAX_WAITS,
  DISK_WATCH_MISSING_CONFIRMATIONS,
  endsLikeWholePdf,
  watchDiskFile,
} from '../../../apps/pdf/src/main/disk-watch.ts'
import type { DiskBaseline, DiskWatchDeps } from '../../../apps/pdf/src/main/disk-watch.ts'
import {
  buildExportImagePaths,
  buildSaveAsImagePaths,
  hasValidExportPageNumbers,
  isValidExportPageNumber,
} from '../../../apps/pdf/src/main/export-images.ts'
import { fontCoversText } from '../../../apps/pdf/src/main/font-cmap.ts'
import {
  findFontCovering,
  findSystemFont,
  isTruetype,
} from '../../../apps/pdf/src/main/font-locate.ts'
import { os2Traits, similarFontFor, sourceTraits } from '../../../apps/pdf/src/main/font-similar.ts'
import { identityCffCharset, subsetTtf } from '../../../apps/pdf/src/main/font-subset.ts'
import { uniqueGeneratedPdfPath } from '../../../apps/pdf/src/main/generated-output.ts'
import {
  NOTE_DIALOG_TEXT,
  createNoteLinkService,
  defaultNotePath,
  noteDialogText,
  noteInsertText,
  parseNoteInsertRequest,
  parseNoteOpenRequest,
  pdfLinkFromNote,
} from '../../../apps/pdf/src/main/note-link.ts'
import type { NoteLinkDeps } from '../../../apps/pdf/src/main/note-link.ts'
import { readPdfText } from '../../../apps/pdf/src/main/read-text.ts'
import {
  MAX_REDACTION_REGIONS,
  redactPdf,
  validateRedactionRegions,
} from '../../../apps/pdf/src/main/redaction.ts'
import {
  MAX_SAVED_SIGNATURES,
  addSignature,
  isSignatureData,
  loadSignatures,
  removeSignature,
  sanitizeSignatures,
  saveSignatures,
} from '../../../apps/pdf/src/main/signature-store.ts'
import {
  SystemStoreError,
  WINDOWS_CHAIN_SCRIPT,
  WINDOWS_LIST_SCRIPT,
  WINDOWS_SIGN_SCRIPT,
  listSystemCertificates,
  nssDatabaseDirs,
  openSystemSigner,
  parseNssKeyList,
  parseWindowsCertificates,
  parseWindowsChain,
  runCommand,
} from '../../../apps/pdf/src/main/system-certificates.ts'
import type { Runner, SystemStoreEnv } from '../../../apps/pdf/src/main/system-certificates.ts'
import type { Pdfium } from '../../../apps/pdf/src/main/text-edit.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'
import { CERTS } from './b4-pdf-certs.ts'
import {
  FakeHb,
  FakePdfium,
  cffFont,
  cmap12,
  cmap4,
  cmapTable,
  fontHex,
  os2Table,
  sfnt,
} from './b4-pdf-fakes.ts'
import type { HbWorld, World } from './b4-pdf-fakes.ts'

const mainDir = fileURLToPath(new URL('../../../apps/pdf/src/main/', import.meta.url)).replace(
  /\/$/,
  '',
)
const g = globalThis as unknown as Record<string, unknown>
const proc = process as unknown as { resourcesPath?: string }

// ---- the scripted PDFium behind loadPdfium ------------------------------------------

let current: FakePdfium | null = null

/** one stable module object for the memo of `loadPdfium`; it forwards to the world of the running case */
g.__b4Pdfium = new Proxy(
  {},
  {
    get(_target, prop) {
      const target = current
      if (!target) return undefined
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  },
)

interface ResolveHooks {
  resolve(
    specifier: string,
    context: unknown,
    next: (specifier: string, context: unknown) => unknown,
  ): unknown
}

/** `module.registerHooks` is Node 22.15 and later; its types may be older than the runtime */
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: ResolveHooks): unknown }

const FAKE_PDFIUM_MODULE =
  'data:text/javascript,export async function init() { return { pdfium: globalThis.__b4Pdfium } }'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@embedpdf/pdfium' && g.__b4PdfiumActive === true) {
      return { url: FAKE_PDFIUM_MODULE, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

/** Electron sets process.resourcesPath, Node does not: the wasm paths fall back to this folder */
const fallbackResources = mkdtempSync(join(tmpdir(), 'main-diff-pdf-res-'))
mkdirSync(join(fallbackResources, 'wasm'), { recursive: true })
for (const name of ['pdfium.wasm', 'hb-subset.wasm', 'qpdf.wasm']) {
  writeFileSync(join(fallbackResources, 'wasm', name), '')
}
proc.resourcesPath = fallbackResources

async function withPdfium<T>(
  world: World,
  cx: TsContext,
  run: (m: FakePdfium) => Promise<T> | T,
): Promise<T> {
  const fake = new FakePdfium(world)
  current = fake
  g.__b4PdfiumActive = true
  try {
    return await run(fake)
  } finally {
    g.__b4PdfiumActive = false
    current = null
    for (const line of fake.log) cx.log(line)
  }
}

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8')
const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex')
const bytesOf = (text: unknown): Uint8Array => new Uint8Array(Buffer.from(text as string, 'utf8'))

/** `Date`-free constant: its second case adds a file, so the two answers differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

// ---- annot-delete, annot-flatten -----------------------------------------------------

const SUBTYPE = {
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  note: 1,
  polygon: 7,
  widget: 20,
}

const annot = (
  objNum: number,
  subtype: number,
  rect: number[] | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ objNum, subtype, rect, ...extra })

const del = (
  pageIndex: number,
  objNum: number,
  subtype: string,
  rect: number[],
  contents?: string,
): Record<string, unknown> => ({
  pageIndex,
  objNum,
  subtype,
  rect,
  ...(contents === undefined ? {} : { contents }),
})

const HL = annot(5, SUBTYPE.highlight, [10, 20, 110, 40])
const NOTE = annot(6, SUBTYPE.note, [200, 300, 224, 324], { contents: 'hello' })

const deleteCases: Case[] = [
  {
    args: [{ pages: [{ annots: [HL] }] }, 'PDFDATA', [del(0, 5, 'highlight', [10, 20, 110, 40])]],
    note: 'removed by object number, then saved',
  },
  {
    args: [
      { pages: [{ annots: [HL] }] },
      'PDFDATA',
      [del(0, 99, 'highlight', [11.5, 21.5, 111.5, 41.5])],
    ],
    note: 'object number unknown: the scan matches within the tolerance',
  },
  {
    args: [{ pages: [{ annots: [HL] }] }, 'PDFDATA', [del(0, 5, 'highlight', [10, 20, 115, 40])]],
    note: 'rect off by 5: nothing matches, the bytes come back',
  },
  {
    args: [{ pages: [{ annots: [HL] }] }, 'PDFDATA', [del(0, 5, 'underline', [10, 20, 110, 40])]],
    note: 'object number found but the subtype differs',
  },
  {
    args: [
      { pages: [{ annots: [NOTE] }] },
      'PDFDATA',
      [del(0, 6, 'note', [200, 310, 260, 325], 'hello')],
    ],
    note: 'a note matches by its top-left corner, not its size',
  },
  {
    args: [
      { pages: [{ annots: [NOTE] }] },
      'PDFDATA',
      [del(0, 6, 'note', [200, 300, 224, 324], 'other')],
    ],
    note: 'contents differ',
  },
  {
    args: [
      { pages: [{ annots: [annot(7, SUBTYPE.note, [1, 2, 3, 4])] }] },
      'PDFDATA',
      [del(0, 7, 'note', [1, 2, 3, 4], '')],
    ],
    note: 'an annotation without /Contents reads as the empty string',
  },
  {
    args: [
      {
        pages: [
          {
            annots: [
              annot(8, SUBTYPE.note, [1, 2, 3, 4], {
                contents: 'h\u00e9llo \u{1F600} \u017f \u0131 \u212a',
              }),
            ],
          },
        ],
      },
      'PDFDATA',
      [del(0, 8, 'note', [1, 2, 3, 4], 'h\u00e9llo \u{1F600} \u017f \u0131 \u212a')],
    ],
    note: 'astral and case-folding characters compared as UTF-16',
  },
  {
    args: [
      { pages: [{ annots: [HL] }] },
      'PDFDATA',
      [del(-1, 5, 'highlight', [10, 20, 110, 40]), del(3, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'page indexes out of range are skipped',
  },
  {
    args: [
      { pages: [{ annots: [HL, annot(9, SUBTYPE.underline, [10, 20, 110, 40])] }] },
      'PDFDATA',
      [del(0.5, 5, 'highlight', [10, 20, 110, 40]), del(0, 9, 'underline', [10, 20, 110, 40])],
    ],
    note: 'a fractional page index is its own key and loads page 0',
  },
  {
    args: [
      { pages: [{ loadFail: true, annots: [HL] }] },
      'PDFDATA',
      [del(0, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'a page that does not load is skipped',
  },
  { args: [{ loadFail: true, pages: [{}] }, 'PDFDATA', []], note: 'the document does not load' },
  {
    args: [
      { saveFail: true, pages: [{ annots: [HL] }] },
      'PDFDATA',
      [del(0, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'the save fails',
  },
  {
    args: [
      { pages: [{ annots: [annot(5, SUBTYPE.highlight, null)] }] },
      'PDFDATA',
      [del(0, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'an annotation whose rect cannot be read never matches',
  },
  {
    args: [
      {
        pages: [{ annots: [annot(5, SUBTYPE.highlight, [10, 20, 110, 40], { annotNull: true })] }],
      },
      'PDFDATA',
      [del(0, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'the scan skips an annotation that does not open (the lookup by number still finds it)',
  },
  {
    args: [
      {
        pages: [{ annots: [annot(5, SUBTYPE.highlight, [10, 20, 110, 40], { removeFail: true })] }],
      },
      'PDFDATA',
      [del(0, 5, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'matched but the removal fails',
  },
  {
    args: [{ pages: [{ annots: [HL] }] }, 'PDFDATA', [del(0, 5, 'bogus', [10, 20, 110, 40])]],
    note: 'a subtype without a code matches nothing',
  },
  {
    args: [
      {
        pages: [
          {
            annots: [
              annot(1, SUBTYPE.underline, [0, 0, 5, 5]),
              annot(2, SUBTYPE.squiggly, [6, 6, 9, 9]),
            ],
          },
          {
            annots: [
              annot(3, SUBTYPE.strikeout, [1, 1, 2, 2]),
              annot(4, SUBTYPE.polygon, [3, 3, 8, 8]),
            ],
          },
        ],
      },
      'PDFDATA',
      [
        del(0, 1, 'underline', [0, 0, 5, 5]),
        del(1, 4, 'polygon', [3, 3, 8, 8]),
        del(0, 2, 'squiggly', [6, 6, 9, 9]),
        del(1, 3, 'strikeout', [1, 1, 2, 2]),
      ],
    ],
    note: 'four subtypes over two pages, grouped by page',
  },
  {
    args: [
      { pages: [{ annots: [HL, annot(11, SUBTYPE.highlight, [10, 20, 110, 40])] }] },
      'PDFDATA',
      [del(0, 12, 'highlight', [10, 20, 110, 40]), del(0, 12, 'highlight', [10, 20, 110, 40])],
    ],
    note: 'two deletes of the same look: the second finds the next',
  },
]

// ---- blank-pages ------------------------------------------------------------------------

/** a white BGRA bitmap with ink rectangles `[x0, y0, x1, y1, gray]`; every row `stride` bytes */
function bitmapHex(
  w: number,
  h: number,
  ink: number[][] = [],
  stride = w * 4,
  padByte = 255,
): string {
  const out = Buffer.alloc(stride * h, padByte)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out.set([255, 255, 255, 255], y * stride + x * 4)
  for (const [x0, y0, x1, y1, gray] of ink as [number, number, number, number, number][]) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) out.set([gray, gray, gray, 255], y * stride + x * 4)
  }
  return out.toString('hex')
}

/** a bitmap whose bytes are a fixed pattern, for the shrink filter */
function patternHex(w: number, h: number, stride = w * 4): string {
  const out = Buffer.alloc(stride * h)
  for (let i = 0; i < out.length; i++) out[i] = (i * 37 + 11) & 0xff
  return out.toString('hex')
}

const specks = (n: number, spread: number): number[][] =>
  Array.from({ length: n }, (_, i) => [
    (i * 17) % 60,
    3 + ((i * spread) % 70),
    ((i * 17) % 60) + 1,
    3 + ((i * spread) % 70) + 1,
    0,
  ])

const NARROW = { w: 12, h: 600 }
const textPage = (unicodes: number[]) => ({ ...NARROW, text: { unicodes } })
const objectsPage = (ink: number[][] = []) => ({ ...NARROW, objects: [{ type: 1 }], ink })

const blankCases: Case[] = [
  {
    args: [
      {
        pages: [
          textPage([72, 105]),
          { ...NARROW, noText: true },
          { ...NARROW, text: { unicodes: [32, 0xa0, 0xfeff, 0xfffe, 9] } },
          { ...NARROW, text: { unicodes: [] } },
          { ...NARROW, text: { unicodes: [0x20, 0x21] } },
        ],
      },
      false,
    ],
    note: 'visible text keeps a page out; spaces, NBSP, BOM and pdfium markers do not',
  },
  {
    args: [
      {
        pages: [
          objectsPage(),
          objectsPage([[2, 100, 3, 101, 0]]),
          objectsPage([[0, 100, 6, 104, 0]]),
          objectsPage(
            Array.from({ length: 40 }, (_, i) => [
              i % 12,
              24 + i * 13,
              (i % 12) + 1,
              25 + i * 13,
              0,
            ]),
          ),
        ],
      },
      true,
    ],
    note: 'nearly white (few specks), a dense stroke, too much ink; progress reported',
  },
  {
    args: [
      {
        pages: [
          { ...NARROW, loadFail: true },
          { w: 0.01, h: 0.01 },
          { ...NARROW, objects: [{ type: 1 }], ink: [[3, 30, 4, 31, 200]] },
        ],
      },
      true,
    ],
    note: 'a page that does not load, an empty page with a tiny thumbnail, a light speck',
  },
  {
    args: [{ bitmapFail: true, pages: [objectsPage()] }, false],
    note: 'the bitmap cannot be made',
  },
  {
    args: [{ stridePad: 8, pages: [objectsPage([[1, 30, 2, 31, 0]])] }, false],
    note: 'a padded stride',
  },
  {
    args: [{ pages: Array.from({ length: 125 }, () => ({ w: 0.01, h: 0.01 })) }, false],
    note: 'past 120 candidates the thumbnails stop',
  },
  { args: [{ pages: [] }, false], note: 'no pages' },
]

// ---- helpers for the cases that follow ----------------------------------------------------------

const pdfBytes = (text: string): string => Buffer.from(text, 'utf8').toString('hex')

// ---- disk-watch ----------------------------------------------------------------------------------

const sum = (hex: string): string => {
  const b = Buffer.from(hex, 'hex')
  let total = 0
  for (const x of b) total += x
  return `${b.length}:${total % 251}`
}

const PDF_OK = pdfBytes('%PDF-1.7\nbody\n%%EOF\n')
const PDF_OTHER = pdfBytes('%PDF-1.7\nanother body\n%%EOF\n')
const PDF_PART = pdfBytes('%PDF-1.7\nhalf written')
const SHOWN = { mtimeMs: 1000, size: 100, hash: sum(PDF_OK) }

type Step =
  | { event: string | null }
  | { timer: 1 }
  | { stat: { mtimeMs: number; size: number } | null }
  | { read: string | null }
  | { rebase: DiskBaseline | null }
  | { close: 1 }

interface WatchSpec {
  path: string
  baseline?: DiskBaseline | null
  settleMs?: number
  caseInsensitive?: boolean
  watchNull?: boolean
  own?: boolean[]
  steps: Step[]
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function watchSteps(spec: WatchSpec, cx: TsContext): Promise<undefined> {
  const q = (text: string): string => JSON.stringify(text)
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const waiting: {
    onEvent: ((filename: string | null) => void) | null
    stat: ((value: { mtimeMs: number; size: number } | null) => void) | null
    read: ((value: Uint8Array | null) => void) | null
  } = { onEvent: null, stat: null, read: null }
  let ownAt = 0
  const deps: DiskWatchDeps = {
    watchDir(dir, callback) {
      cx.log(`watchDir(${q(dir)})`)
      waiting.onEvent = callback
      return spec.watchNull
        ? null
        : {
            close() {
              cx.log('handle.close()')
            },
          }
    },
    stat(path) {
      cx.log(`stat(${q(path)})`)
      return new Promise((resolve) => {
        waiting.stat = resolve
      })
    },
    read(path) {
      cx.log(`read(${q(path)})`)
      return new Promise((resolve) => {
        waiting.read = resolve
      })
    },
    hash(bytes) {
      let total = 0
      for (const x of bytes) total += x
      const h = `${bytes.length}:${total % 251}`
      cx.log(`hash=${h}`)
      return h
    },
    setTimer(fn, ms) {
      const handle = ++nextTimer
      timers.set(handle, fn)
      cx.log(`setTimer(${ms})=${handle}`)
      return handle
    },
    clearTimer(handle) {
      timers.delete(handle as number)
      cx.log(`clearTimer(${handle})`)
    },
    ownWriteInFlight() {
      const answer = spec.own?.[ownAt] ?? false
      ownAt++
      cx.log(`ownWriteInFlight=${answer}`)
      return answer
    },
    settleMs: spec.settleMs ?? 250,
    caseInsensitive: spec.caseInsensitive ?? false,
  }
  const watch = watchDiskFile(
    spec.path,
    spec.baseline ?? null,
    (kind) => cx.log(`onChange(${kind})`),
    deps,
  )
  for (const step of spec.steps) {
    if ('event' in step) {
      waiting.onEvent?.(step.event)
    } else if ('timer' in step) {
      const live = [...timers.keys()]
      const last = live[live.length - 1]
      if (last === undefined) cx.log('no timer')
      else {
        const fn = timers.get(last)!
        timers.delete(last)
        fn()
      }
    } else if ('stat' in step) {
      const resolve = waiting.stat
      if (!resolve) cx.log('no stat pending')
      else {
        waiting.stat = null
        resolve(step.stat)
      }
    } else if ('read' in step) {
      const resolve = waiting.read
      if (!resolve) cx.log('no read pending')
      else {
        waiting.read = null
        resolve(step.read === null ? null : new Uint8Array(Buffer.from(step.read, 'hex')))
      }
    } else if ('rebase' in step) {
      watch.rebase(step.rebase)
    } else {
      watch.close()
    }
    await flush()
  }
  return undefined
}

const E = (event: string | null): Step => ({ event })
const T: Step = { timer: 1 }
const S = (mtimeMs: number, size: number): Step => ({ stat: { mtimeMs, size } })
const R = (read: string | null): Step => ({ read })

/** `n` timer-and-stat rounds that each see another mtime, so the writer never looks done */
const unsteady = (n: number, from = 5000): Step[] =>
  Array.from({ length: n }, (_, i) => [T, S(from + i, 300)]).flat()

const watchCases: Case[] = [
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [E('doc.pdf'), T, S(2000, 200), T, S(2000, 200), R(PDF_OTHER)],
      },
    ],
    note: 'a change: unsteady, steady, read, a notice',
  },
  {
    args: [{ path: '/w/doc.pdf', baseline: SHOWN, steps: [E('doc.pdf'), T, S(1000, 100)] }],
    note: 'time and size as shown: nothing',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [
          E(null),
          T,
          S(2000, 200),
          T,
          S(2000, 200),
          R(PDF_OK),
          E('doc.pdf'),
          T,
          S(3000, 200),
          T,
          S(3000, 200),
          R(PDF_OK),
        ],
      },
    ],
    note: 'same bytes under a new time: the baseline moves, no notice',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [
          E('doc.pdf'),
          T,
          { stat: null },
          T,
          { stat: null },
          E('doc.pdf'),
          T,
          { stat: null },
          E('doc.pdf'),
          T,
          S(1000, 100),
        ],
      },
    ],
    note: 'missing after two looks, said once; back as shown: unchanged',
  },
  {
    args: [
      { path: '/w/doc.pdf', baseline: SHOWN, steps: [E('doc.pdf'), ...unsteady(21), R(PDF_PART)] },
    ],
    note: 'a writer that never settles: after the waits the change is reported as it is',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [
          E('doc.pdf'),
          T,
          S(2000, 50),
          T,
          S(2000, 50),
          R(PDF_PART),
          T,
          S(2000, 50),
          R(PDF_OK),
        ],
      },
    ],
    note: 'a half written file waits for its end',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [E('doc.pdf'), ...unsteady(21), R(null), E('doc.pdf'), T, S(9000, 1)],
      },
    ],
    note: 'unreadable for good: noticed once',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: null,
        steps: [E('doc.pdf'), T, S(7, 70), T, S(7, 70), R(PDF_OK)],
      },
    ],
    note: 'no baseline: any file is a change',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [
          E('doc.pdf'),
          T,
          S(2000, 200),
          T,
          S(2000, 200),
          R(PDF_OTHER),
          { rebase: { mtimeMs: 2000, size: 200, hash: sum(PDF_OTHER) } },
          E('doc.pdf'),
          T,
          S(2000, 200),
        ],
      },
    ],
    note: 'rebase after a notice: the file is what the view shows',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [
          E('doc.pdf'),
          T,
          S(2000, 200),
          T,
          S(2000, 200),
          R(PDF_OTHER),
          E('doc.pdf'),
          T,
          S(1000, 100),
          E('doc.pdf'),
          T,
          S(2000, 200),
          T,
          S(2000, 200),
          R(PDF_OTHER),
          E('doc.pdf'),
          T,
          S(2000, 200),
          T,
          S(2000, 200),
          R(PDF_OTHER),
        ],
      },
    ],
    note: 'the same new content is reported once; going back says unchanged',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [E('doc.pdf'), T, { close: 1 }, S(2000, 200), E('doc.pdf'), T],
      },
    ],
    note: 'closed while the stat waits',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        steps: [E('doc.pdf'), T, E('doc.pdf'), T, { stat: null }, T, { stat: null }],
      },
    ],
    note: 'a timer fires while a check waits: it runs again after',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        own: [true, false],
        steps: [E('doc.pdf'), T, T, S(1000, 100)],
      },
    ],
    note: 'the app writes the file now: look again later',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        caseInsensitive: true,
        steps: [E('DOC.PDF'), T, S(1000, 100), E('other.pdf'), E('\u0130.pdf'), T],
      },
    ],
    note: 'names compare case-insensitively where asked; other names are ignored',
  },
  {
    args: [
      {
        path: '/w/doc.pdf',
        baseline: SHOWN,
        caseInsensitive: false,
        steps: [E('DOC.PDF'), E('doc.pdf'), T, S(1000, 100)],
      },
    ],
    note: 'names compare exactly otherwise',
  },
  {
    args: [
      { path: '/w/doc.pdf', baseline: SHOWN, watchNull: true, steps: [{ close: 1 }, E('doc.pdf')] },
    ],
    note: 'the platform gave no watcher',
  },
  { args: [{ path: 'doc.pdf', steps: [E(null)] }], note: 'a bare name watches the working folder' },
  { args: [{ path: '/doc.pdf', steps: [E(null)] }], note: 'a file in the root' },
  { args: [{ path: 'C:\\x\\y\\doc.pdf', steps: [E(null)] }], note: 'a Windows path' },
  {
    args: [
      { path: '/w/doc.pdf', baseline: SHOWN, steps: [T, S(1, 1), R(PDF_OK), { rebase: null }] },
    ],
    note: 'steps with nothing waiting',
  },
]

const eofBytes = (before: number, after = 0, mark = '%%EOF'): string =>
  Buffer.concat([Buffer.alloc(before, 'a'), Buffer.from(mark), Buffer.alloc(after, 'b')]).toString(
    'hex',
  )

const endsCases: Case[] = [
  { args: [eofBytes(0)], note: 'just the mark' },
  { args: [''], note: 'nothing' },
  { args: [Buffer.from('%%EO').toString('hex')], note: 'shorter than the mark' },
  { args: [eofBytes(10, 3)], note: 'the mark with a tail' },
  { args: [eofBytes(0, 1019)], note: 'the mark at the edge of the window' },
  { args: [eofBytes(0, 1020)], note: 'one byte outside the window' },
  { args: [eofBytes(5, 0, '%%EOE')], note: 'a near miss' },
  { args: [eofBytes(3000, 0)], note: 'a large file ending in the mark' },
]

// ---- export-images ---------------------------------------------------------------------------

const exportCases: Case[] = [
  { args: ['$DIR/out', 'page', [1, 2, 10], 'png'] },
  {
    args: ['$DIR/out', 'my:file*name?', [3], 'jpg'],
    note: 'characters a name cannot hold become _',
  },
  { args: ['$DIR/out', '', [4], 'png'], note: 'an empty name is "page"' },
  { args: ['$DIR/out', 0, [4], 'png'], note: 'zero is falsy' },
  { args: ['$DIR/out', null, [4], 'png'], note: 'null is falsy' },
  { args: ['$DIR/out', 5, [4], 'png'], note: 'a number is printed' },
  { args: ['$DIR/out', ['a', 'b'], [4], 'png'], note: 'an array is joined' },
  { args: ['$DIR/out', { a: 1 }, [4], 'png'], note: 'an object prints as such' },
  {
    args: ['$DIR/out', { toString: 1 }, [4], 'png'],
    note: 'an object that cannot become a string',
  },
  { args: ['$DIR/out', '../up/..', [1], 'png'], note: 'dots stay in the name' },
  { args: ['$DIR/a/../b/./c', 'x', [1], 'png'], note: 'the folder is resolved' },
  { args: ['$DIR/out', 'x', [1, 0], 'png'], note: 'a page number of 0' },
  { args: ['$DIR/out', 'x', [1.5], 'png'], note: 'a fractional page number' },
  { args: ['$DIR/out', 'x', ['1'], 'png'], note: 'a page number as text' },
  { args: ['$DIR/out', 'x', [], 'png'], note: 'no pages' },
  {
    args: ['$DIR/out', '\u0131\u017f\u212a \u{1F600}', [9007199254740991], 'png'],
    note: 'astral and folding characters; the largest safe page',
  },
  { args: ['$DIR/out', 'x', [9007199254740992], 'png'], note: 'past the safe integers' },
]

const pagesCases = (cases: [unknown, number][]): Case[] =>
  cases.map(([value, n]) => ({ args: [value, n] }))

// ---- font-cmap ------------------------------------------------------------------------------------

/** segments sorted by their end; `[start, end, idDelta, rangeOffset]` */
const SEG: [number, number, number, number][] = [
  [0x41, 0x5a, -0x40, 0],
  [0x61, 0x7a, -0x60 + 40, 0],
  [0x131, 0x131, -0x131 + 80, 0],
  [0x17f, 0x17f, -0x17f + 81, 0],
  [0x3b1, 0x3b3, 0, 6],
  [0x212a, 0x212a, -0x212a + 82, 0],
]
const F4 = sfnt(0x10000, [['cmap', cmapTable([[3, 1, cmap4(SEG, [7, 0, 9])]])]])
const GROUPS: [number, number, number][] = [
  [0x41, 0x5a, 1],
  [0x1f600, 0x1f64f, 100],
  [0xac00, 0xd7a3, 200],
]
const F12 = sfnt(0x10000, [['cmap', cmapTable([[3, 10, cmap12(GROUPS)]])]])
const FBOTH = sfnt(0x10000, [
  ['head', [0, 0, 0, 0]],
  [
    'cmap',
    cmapTable([
      [3, 1, cmap4(SEG, [7, 0, 9])],
      [3, 10, cmap12(GROUPS)],
    ]),
  ],
])
const F4_UNICODE = sfnt(0x10000, [['cmap', cmapTable([[0, 3, cmap4(SEG, [7, 0, 9])]])]])
const F4_MAC = sfnt(0x10000, [['cmap', cmapTable([[1, 0, cmap4(SEG, [7, 0, 9])]])]])
const F_NOCMAP = sfnt(0x10000, [['name', [0, 0, 0, 0]]])
const F_ZERO_GROUP = sfnt(0x10000, [['cmap', cmapTable([[3, 10, cmap12([[0x41, 0x41, 0]])]])]])

const cmapCases: Case[] = [
  { args: [fontHex(F4), 'ABCxyz'], note: 'format 4: ranges with a delta' },
  { args: [fontHex(F4), 'AB\u00e9'], note: 'format 4: a character between two segments' },
  { args: [fontHex(F4), '\u03b1\u03b3'], note: 'format 4: glyph ids through the range offset' },
  { args: [fontHex(F4), '\u03b1\u03b2'], note: 'format 4: glyph 0 in the array is unmapped' },
  {
    args: [fontHex(F4), '\u0131\u017f\u212a'],
    note: 'dotless i, long s and the Kelvin sign are code points of their own',
  },
  { args: [fontHex(F4), '\u{1F600}'], note: 'format 4 holds no astral code point' },
  { args: [fontHex(F4), '\u00a0'], note: 'a no-break space is a drawn character' },
  { args: [fontHex(F4), 'A\r\nB\n\r'], note: 'only line breaks are free' },
  { args: [fontHex(F12), '\u{1F600}\u{1F64F}'], note: 'format 12: astral groups' },
  { args: [fontHex(F12), '\u{1F650}'], note: 'format 12: just outside a group' },
  { args: [fontHex(F12), '\ud55c\uae00'], note: 'format 12: Hangul' },
  { args: [fontHex(F12), '\u0020'], note: 'format 12: below the first group' },
  { args: [fontHex(F_ZERO_GROUP), 'A'], note: 'format 12: a group that maps to glyph 0' },
  { args: [fontHex(FBOTH), '\u{1F600}'], note: 'format 12 is preferred over format 4' },
  { args: [fontHex(F4_UNICODE), 'AB'], note: 'a Unicode platform subtable counts' },
  { args: [fontHex(F4_MAC), 'AB'], note: 'a Macintosh subtable does not' },
  { args: [fontHex(F_NOCMAP), 'A'], note: 'no cmap table' },
  { args: [fontHex(F4).slice(0, 20), 'A'], note: 'a truncated font does not throw' },
  { args: ['', ''], note: 'no text needs no font' },
  { args: ['', '\r\n'], note: 'only line breaks needs no font' },
  { args: ['', 'A'], note: 'an empty font' },
]

// ---- font-locate, font-similar ------------------------------------------------------------------------------

const os2Font = (weight: number, panose: [number, number, number, number], length = 78) =>
  fontHex(
    sfnt(0x10000, [
      ['head', [0, 0, 0, 0]],
      ['OS/2', os2Table(weight, panose, length)],
    ]),
  )

const faceSpec = (psName: string, flags = 0, embedded: string | null = null) => ({
  psName,
  flags,
  embedded,
})
const face = (spec: { psName: string; flags: number; embedded: string | null }) => ({
  psName: spec.psName,
  flags: spec.flags,
  embedded: spec.embedded === null ? null : Buffer.from(spec.embedded, 'hex'),
})

const os2Cases: Case[] = [
  { args: [null], note: 'no font' },
  { args: ['00010000'], note: 'too short' },
  { args: [os2Font(700, [2, 11, 0, 3])], note: 'sans by PANOSE, bold weight' },
  { args: [os2Font(400, [2, 5, 0, 3])], note: 'serif by PANOSE' },
  { args: [os2Font(400, [2, 2, 0, 9])], note: 'monospaced by PANOSE' },
  { args: [os2Font(300, [3, 0, 0, 0])], note: 'hand written is brush' },
  { args: [os2Font(0, [4, 0, 0, 0])], note: 'weight 0 and an unknown kind say nothing' },
  { args: [os2Font(400, [2, 0, 0, 0])], note: 'a serif style outside both ranges' },
  { args: [os2Font(400, [2, 15, 0, 3])], note: 'the top of the sans range' },
  { args: [os2Font(400, [2, 10, 0, 3])], note: 'the top of the serif range' },
  { args: [os2Font(400, [2, 16, 0, 3])], note: 'past the sans range' },
  { args: [os2Font(600, [2, 11, 0, 3], 40)], note: 'a table too short to hold PANOSE' },
  { args: [fontHex(sfnt(0x10000, [['head', [0, 0, 0, 0]]]))], note: 'no OS/2 table' },
  { args: ['000100000032000000000000'], note: 'more tables than the file holds' },
  { args: ['000100000041000000000000'], note: 'a table count past the limit' },
]

const sourceCases: Case[] = [
  { args: [faceSpec('ABCDEF+Arial-BoldMT'), null], note: 'a Latin name: sans, bold' },
  { args: [faceSpec('TimesNewRoman', 64), null], note: 'the italic flag' },
  { args: [faceSpec('Foo', 1 << 18), null], note: 'forced bold by the flags' },
  { args: [faceSpec('Foo', 2 | 32), null], note: 'serif by the flags' },
  { args: [faceSpec('Foo', 1 | 32), null], note: 'fixed pitch by the flags is mono for Latin' },
  { args: [faceSpec('Foo', 1 | 32), 'ko'], note: 'fixed pitch does not count for Korean' },
  {
    args: [faceSpec('Foo', 8 | 32), 'ko'],
    note: 'a script face by the flags is brush outside Latin',
  },
  { args: [faceSpec('Foo', 8 | 32), 'latin'], note: 'but not in Latin' },
  { args: [faceSpec('Foo', 0), null], note: 'nothing says: sans' },
  { args: [faceSpec('Foo', 4), null], note: 'symbolic only: the flags say sans' },
  {
    args: [faceSpec('12345', 0, os2Font(700, [2, 5, 0, 3])), null],
    note: 'a numeric name: the embedded OS/2 says serif and bold',
  },
  {
    args: [faceSpec('12345', 2 | 32, os2Font(300, [4, 0, 0, 0])), null],
    note: 'OS/2 without a style falls to the flags',
  },
  { args: [faceSpec('HYGothic'), null], note: 'a Korean name' },
  {
    args: [faceSpec('\ubc14\ud0d5'), 'ja'],
    note: 'a Hangul name; the script of the stand-in is only for the flags',
  },
  { args: [faceSpec('MS-Mincho', 0), null], note: 'Japanese serif' },
  { args: [faceSpec('SimSun-Italic', 64), null], note: 'Chinese serif, italic twice' },
  { args: [faceSpec('Foo', 4294967296 + 2 + 32), null], note: 'flags past 32 bits wrap as int32' },
]

// ---- the installed fonts ------------------------------------------------------------------------------
//
// findSystemFont, findFontCovering and similarFontFor read the font folders of the machine, so their
// answers depended on it. Both sides are pointed at a home folder of fixture fonts instead (the last
// argument of each case): the TypeScript through HOME for the length of the call (os.homedir), the
// Rust through the argument. The system folders are still scanned first, the same ones by both sides;
// the families named below are not what a machine installs, so they are answered by the fixture alone.

type NameRecord = [number, number, number, number, string]

const be16 = (...values: number[]): number[] => values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff])

function nameTable(records: NameRecord[]): number[] {
  const strings: number[] = []
  const rows: number[] = []
  for (const [platform, encoding, language, nameId, text] of records) {
    const bytes =
      platform === 1 ? [...Buffer.from(text, 'latin1')] : [...Buffer.from(text, 'utf16le').swap16()]
    rows.push(...be16(platform, encoding, language, nameId, bytes.length, strings.length))
    strings.push(...bytes)
  }
  return [...be16(0, records.length, 6 + 12 * records.length), ...rows, ...strings]
}

const asciiCmap = (): number[] => cmapTable([[3, 1, cmap4([[0x20, 0x7e, 1 - 0x20, 0]])]])

interface FixtureFace {
  family: string
  sub: string
  ps: string
  cmap?: number[]
  weight?: number
  panose?: [number, number, number, number]
  extraNames?: NameRecord[]
  extraTables?: [string, number[]][]
}

function fixtureFace(spec: FixtureFace): number[] {
  return sfnt(0x10000, [
    ['head', [0, 0, 0, 0]],
    ['glyf', [0, 0, 0, 0]],
    [
      'name',
      nameTable([
        [3, 1, 0x409, 1, spec.family],
        [3, 1, 0x409, 2, spec.sub],
        [3, 1, 0x409, 6, spec.ps],
        ...(spec.extraNames ?? []),
      ]),
    ],
    ['cmap', spec.cmap ?? asciiCmap()],
    ['OS/2', os2Table(spec.weight ?? 400, spec.panose ?? [2, 11, 6, 4])],
    ...(spec.extraTables ?? []),
  ])
}

/** a collection of faces: the table records of every face point into the one file */
function fixtureCollection(faces: number[][]): number[] {
  const head = [0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, ...be16(0, faces.length)]
  let base = head.length + 4 * faces.length
  const offsets: number[] = []
  const body: number[] = []
  for (const face of faces) {
    const shifted = [...face]
    const tables = (face[4]! << 8) | face[5]!
    for (let t = 0; t < tables; t++) {
      const at = 12 + 16 * t + 8
      const value =
        (((face[at]! << 24) | (face[at + 1]! << 16) | (face[at + 2]! << 8) | face[at + 3]!) >>> 0) +
        base
      shifted.splice(
        at,
        4,
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      )
    }
    offsets.push(base)
    body.push(...shifted)
    base += face.length
  }
  return [
    ...head,
    ...offsets.flatMap((o) => [(o >>> 24) & 0xff, (o >>> 16) & 0xff, (o >>> 8) & 0xff, o & 0xff]),
    ...body,
  ]
}

const HANGUL_CMAP = (): number[] =>
  cmapTable([
    [
      3,
      10,
      cmap12([
        [0x20, 0x7e, 1],
        [0xac00, 0xd7a3, 100],
      ]),
    ],
  ])

const FIXTURE_FONTS: Record<string, number[]> = {
  'arial.ttf': fixtureFace({ family: 'Arial', sub: 'Regular', ps: 'ArialMT' }),
  'arialbd.ttf': fixtureFace({ family: 'Arial', sub: 'Bold', ps: 'Arial-BoldMT', weight: 700 }),
  'arialbi.ttf': fixtureFace({
    family: 'Arial',
    sub: 'Bold Italic',
    ps: 'Arial-BoldItalicMT',
    weight: 700,
  }),
  'helvetica.ttf': fixtureFace({ family: 'Helvetica', sub: 'Regular', ps: 'Helvetica' }),
  'sub/helvoblique.ttf': fixtureFace({
    family: 'Helvetica',
    sub: 'Oblique',
    ps: 'Helvetica-Oblique',
  }),
  'cour.ttf': fixtureFace({
    family: 'Courier New',
    sub: 'Regular',
    ps: 'CourierNewPSMT',
    panose: [2, 2, 6, 9],
  }),
  'times.ttf': fixtureFace({
    family: 'Times New Roman',
    sub: 'Regular',
    ps: 'TimesNewRomanPSMT',
    panose: [2, 2, 6, 3],
  }),
  'timesbd.ttf': fixtureFace({
    family: 'Times New Roman',
    sub: 'Bold',
    ps: 'TimesNewRomanPS-BoldMT',
    weight: 700,
    panose: [2, 2, 6, 3],
  }),
  'batang.ttf': fixtureFace({
    family: 'Batang',
    sub: 'Regular',
    ps: 'Batang',
    cmap: HANGUL_CMAP(),
    panose: [2, 3, 6, 0],
    extraNames: [[3, 1, 0x412, 1, '\ubc14\ud0d5']],
  }),
  'dotum.ttf': fixtureFace({
    family: 'Dotum',
    sub: 'Regular',
    ps: 'Dotum',
    cmap: HANGUL_CMAP(),
  }),
  'emoji.ttf': fixtureFace({
    family: 'Color Emoji',
    sub: 'Regular',
    ps: 'ColorEmoji',
    cmap: cmapTable([[3, 10, cmap12([[0x1f600, 0x1f64f, 1]])]]),
    extraTables: [['sbix', [0, 0, 0, 0]]],
  }),
  'letters.ttf': fixtureFace({
    family: 'Latin Extra',
    sub: 'Regular',
    ps: 'LatinExtra',
    cmap: cmapTable([
      [
        3,
        1,
        cmap4([
          [0x20, 0x20, 1 - 0x20, 0],
          [0x131, 0x131, 1 - 0x131, 0],
          [0x17f, 0x17f, 1 - 0x17f, 0],
          [0x212a, 0x212a, 1 - 0x212a, 0],
        ]),
      ],
    ]),
  }),
  'collection.ttc': fixtureCollection([
    fixtureFace({ family: 'Collection Sans', sub: 'Regular', ps: 'CollectionSans-Regular' }),
    fixtureFace({
      family: 'Collection Sans',
      sub: 'Bold',
      ps: 'CollectionSans-Bold',
      weight: 700,
    }),
  ]),
  'a/b/deep.ttf': fixtureFace({ family: 'Deep Face', sub: 'Regular', ps: 'DeepFace' }),
  'a/b/c/hidden.ttf': fixtureFace({ family: 'Hidden Face', sub: 'Regular', ps: 'HiddenFace' }),
  'broken.ttf': [...Buffer.from('this is not a font file')],
  'empty.ttf': [],
  'short.otf': [0, 1, 0, 0, 0, 3, 0, 0],
  'notes.txt': [...Buffer.from('not a font by its name')],
}

const FONT_HOME = ((): string => {
  const home = mkdtempSync(join(tmpdir(), 'b4pdf-fonts-'))
  const folder =
    process.platform === 'darwin'
      ? 'Library/Fonts'
      : process.platform === 'win32'
        ? 'AppData/Local/Microsoft/Windows/Fonts'
        : '.fonts'
  for (const [name, bytes] of Object.entries(FIXTURE_FONTS)) {
    const target = join(home, folder, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, Buffer.from(bytes))
  }
  process.on('exit', () => rmSync(home, { recursive: true, force: true }))
  return home
})()

/** run the TypeScript with the process's home folder on the fixture fonts */
function inFontHome<T>(run: () => T): T {
  const before = process.env.HOME
  process.env.HOME = FONT_HOME
  try {
    return run()
  } finally {
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
}

/** every case ends with the home folder, which the Rust side takes as its argument */
const withFontHome = (cases: Case[]): Case[] =>
  cases.map((c) => ({ ...c, args: [...(c.args as unknown[]), FONT_HOME] }))

const similarCases: Case[] = [
  { args: [faceSpec('Arial'), 'Hello', false], note: 'Latin sans' },
  { args: [faceSpec('Arial-BoldItalicMT'), 'Hello', false], note: 'bold italic keeps its weight' },
  { args: [faceSpec('TimesNewRomanPS-BoldMT'), 'Hello', true], note: 'italic asked for' },
  { args: [faceSpec('CourierNewPSMT'), 'Hello', false], note: 'mono' },
  { args: [faceSpec('Batang'), '\ud55c\uae00', false], note: 'a Korean serif run' },
  {
    args: [faceSpec('SomethingUnknown'), '\u{1F600}', false],
    note: 'a character no installed face maps',
  },
  { args: [faceSpec('Arial'), '', false], note: 'nothing drawn' },
  { args: [faceSpec('TimesNewRomanPSMT'), 'Hello', false], note: 'Latin serif' },
  {
    args: [faceSpec('Times-Bold'), 'Hello', true],
    note: 'bold and italic asked: the bold face comes, not stroked',
  },
  { args: [faceSpec('Helvetica'), 'Hello', false], note: 'the first look-alike that is installed' },
  {
    args: [faceSpec('Batang-Bold'), '\ud55c\uae00', false],
    note: 'a bold source with a regular stand-in',
  },
  { args: [faceSpec('HYGothic'), '\ud55c\uae00', false], note: 'a Korean sans stand-in' },
  { args: [faceSpec('Foo'), 'H\u0131', false], note: 'no look-alike draws every character' },
  { args: [faceSpec('Foo', 1 | 32), 'abc', false], note: 'fixed pitch by the flags' },
  {
    args: [faceSpec('Foo', 0, os2Font(700, [2, 5, 0, 3])), 'abc', false],
    note: 'serif and bold by the embedded OS/2',
  },
]

const locateCases: Case[] = [
  { args: ['ArialMT', 'Arial'], note: 'by PostScript name' },
  { args: ['', 'Arial'], note: 'by family alone' },
  { args: ['Arial-BoldMT', 'Arial'], note: 'by family with style tokens' },
  { args: ['NoSuchFace', 'NoSuchFamily'], note: 'nothing' },
  { args: ['', ''], note: 'no name at all' },
  { args: ['HELVETICA', ''], note: 'case and punctuation do not matter' },
  { args: ['Foo-Bold', 'Arial'], note: 'the style tokens of the name rank the family' },
  { args: ['Foo-BoldItalic', 'Arial'], note: 'both tokens' },
  {
    args: ['Foo-Italic', 'Arial'],
    note: 'a wanted token no face has: Regular wins by fewer extras',
  },
  { args: ['Foo-Demibold', 'Times New Roman'], note: 'a neighbouring weight' },
  { args: ['', 'Times New Roman'], note: 'Regular preferred without tokens' },
  { args: ['CollectionSans-Bold', ''], note: 'a face of a collection, extracted' },
  { args: ['', 'Collection Sans'], note: 'the family of a collection' },
  { args: ['', '\ubc14\ud0d5'], note: 'a localized family name' },
  { args: ['', 'Hidden Face'], note: 'three folders down is not scanned' },
  { args: ['', 'Deep Face'], note: 'two folders down is' },
  { args: ['Helvetica-Oblique', ''], note: 'a face in a subfolder' },
  { args: ['', 'Helvetica'], note: 'two faces of a family, Regular wins' },
  { args: ['ColorEmoji', ''], note: 'a color font is found by name' },
  { args: ['', 'Broken'], note: 'files that are no fonts are skipped' },
]

const coveringCases: Case[] = [
  { args: ['Hello'], note: 'Latin' },
  { args: ['\ud55c\uae00'], note: 'Hangul' },
  { args: ['\r\n'], note: 'only line breaks' },
  { args: ['\u{1F600}'], note: 'emoji: only color fonts' },
  { args: ['\u0131\u017f \u212a'], note: 'letters outside ASCII' },
  { args: ['abc'], note: 'plain ASCII: the plainest face' },
  { args: ['\ud55c\uae00 abc'], note: 'Hangul and Latin in one face' },
  { args: ['ab\u0131'], note: 'no face has both' },
  { args: [' '], note: 'only a space' },
  { args: ['\u212a'], note: 'the Kelvin sign' },
  { args: ['\u{1F600}a'], note: 'the color face does not count' },
]

const truetypeCases: Case[] = [
  { args: ['00010000'], note: 'glyf flavor' },
  { args: ['4f54544f'], note: 'CFF flavor' },
  { args: ['74727565'], note: 'a "true" font' },
  { args: ['0001'], note: 'too short' },
  { args: [''], note: 'empty' },
]

// ---- read-text --------------------------------------------------------------------------------------

const text3 = (text: string, extra: Record<string, unknown> = {}) => ({
  w: 600,
  h: 800,
  text: { text, ...extra },
})

const readCases: Case[] = [
  {
    args: [
      {
        meta: { Title: 'T\u00e9st \u{1F600}', Author: 'Ann' },
        pages: [text3('Hello\r\nWorld  \r\n'), { w: 300, h: 400, noText: true }],
      },
      'PDFDATA',
      {},
    ],
    note: 'text with CRLF, a page without a text layer, both info entries',
  },
  {
    args: [{ meta: { Title: '', Author: 'Ann' }, pages: [text3('abc\u00a0 ')] }, 'PDFDATA', {}],
    note: 'an empty title is left out; white space at the end goes',
  },
  {
    args: [{ pages: [text3('x\ufeff')] }, 'PDFDATA', {}],
    note: 'a byte order mark at the end goes too',
  },
  {
    args: [
      {
        pages: [
          text3('Te\r\nst', {
            generated: [2],
            origins: [
              [0, 0],
              [10, 100],
              [0, 0],
              [0, 0],
              [15, 100.5],
              [0, 0],
            ],
            sizes: [10, 10, 10, 10, 10, 10],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'a generated break between glyphs on one baseline is dropped',
  },
  {
    args: [
      {
        pages: [
          text3('Te\r\nst', {
            generated: [2],
            origins: [
              [0, 0],
              [10, 100],
              [0, 0],
              [0, 0],
              [60, 100],
              [0, 0],
            ],
            sizes: [10, 10, 10, 10, 10, 10],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'a wide gap becomes a space',
  },
  {
    args: [
      {
        pages: [
          text3('Te\r\nst', {
            generated: [2],
            origins: [
              [0, 0],
              [10, 100],
              [0, 0],
              [0, 0],
              [15, 110],
              [0, 0],
            ],
            sizes: [10, 10, 10, 10, 10, 10],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'another baseline keeps the break',
  },
  {
    args: [
      {
        pages: [
          text3('Te\r\nst', {
            generated: [2],
            origins: [
              [0, 0],
              [10, 100],
              [0, 0],
              [0, 0],
              [5, 100],
              [0, 0],
            ],
            sizes: [10, 10, 10, 10, 10, 10],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'running right to left keeps the break',
  },
  {
    args: [
      {
        pages: [
          text3('Te\r\nst', {
            generated: [2],
            origins: [
              [0, 0],
              [10, 100],
              [0, 0],
              [0, 0],
              [15, 100],
              [0, 0],
            ],
            sizes: [0, 0, 0, 0, 0, 0],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'a font size of 0 keeps the break',
  },
  {
    args: [{ pages: [text3('Te\r\nst', { generated: [] })] }, 'PDFDATA', {}],
    note: 'a break pdfium did not generate stays',
  },
  {
    args: [{ pages: [text3('\r\nTe\r\n', { generated: [0, 4] })] }, 'PDFDATA', {}],
    note: 'a break at either end is never joined',
  },
  {
    args: [{ pages: [text3('ab\r\ncd', { count: 7, generated: [2] })] }, 'PDFDATA', {}],
    note: 'a count that is not the text length is not joined',
  },
  { args: [{ pages: [text3('a\rb')] }, 'PDFDATA', {}], note: 'a lone CR is a line break' },
  {
    args: [
      {
        pages: [
          text3('\u{1F600}\r\n\u{1F601}', {
            generated: [3],
            origins: [
              [0, 0],
              [0, 0],
              [10, 50],
              [0, 0],
              [0, 0],
              [11, 50],
              [0, 0],
            ],
          }),
        ],
      },
      'PDFDATA',
      {},
    ],
    note: 'astral characters are two units',
  },
  {
    args: [
      { pages: [text3('abcde'), text3('fghij'), text3('klmno')] },
      'PDFDATA',
      { charBudget: 7 },
    ],
    note: 'the budget cuts the second page and stops',
  },
  {
    args: [{ pages: [text3('abcde'), text3('fghij')] }, 'PDFDATA', { charBudget: 5 }],
    note: 'the budget ran out exactly: the next page is not read',
  },
  {
    args: [{ pages: [text3('abcde')] }, 'PDFDATA', { charBudget: 0 }],
    note: 'a budget of nothing',
  },
  {
    args: [{ pages: [text3('abcde'), text3('fghij')] }, 'PDFDATA', { charBudget: 100 }],
    note: 'a budget that is enough',
  },
  {
    args: [
      { pages: [text3('p1'), text3('p2'), text3('p3')] },
      'PDFDATA',
      { pages: [3, 1, 3, 99, 0, 1.5] },
    ],
    note: 'listed pages, once each and in order',
  },
  {
    args: [{ pages: [text3('p1'), text3('p2'), text3('p3')] }, 'PDFDATA', { pages: [] }],
    note: 'an empty list is a list',
  },
  {
    args: [
      { pages: [text3('p1'), text3('p2'), text3('p3')] },
      'PDFDATA',
      { fromPage: 2, toPage: 2 },
    ],
    note: 'one page',
  },
  {
    args: [
      { pages: [text3('p1'), text3('p2'), text3('p3')] },
      'PDFDATA',
      { fromPage: 9, toPage: 1 },
    ],
    note: 'a span clamped to the document',
  },
  {
    args: [{ pages: [text3('p1'), text3('p2'), text3('p3')] }, 'PDFDATA', { fromPage: 1.5 }],
    note: 'a fractional start',
  },
  {
    args: [{ pages: [{ w: 5, h: 6, loadFail: true }, text3('ok')] }, 'PDFDATA', {}],
    note: 'a page that does not load',
  },
  {
    args: [{ getTextZero: true, pages: [text3('abc')] }, 'PDFDATA', {}],
    note: 'pdfium writes nothing',
  },
  {
    args: [{ metaShort: true, meta: { Title: 'T' }, pages: [text3('abc')] }, 'PDFDATA', {}],
    note: 'the metadata read writes nothing',
  },
  {
    args: [
      { mallocFail: [2], meta: { Title: 'T', Author: 'A' }, pages: [text3('abc')] },
      'PDFDATA',
      {},
    ],
    note: 'no room for the title tag',
  },
  {
    args: [
      { mallocFail: [3], meta: { Title: 'T', Author: 'A' }, pages: [text3('abc')] },
      'PDFDATA',
      {},
    ],
    note: 'no room for the title value',
  },
  {
    args: [{ mallocFail: [6], pages: [text3('abc')] }, 'PDFDATA', {}],
    note: 'no room for the page text',
  },
  {
    args: [{ mallocFail: [7], pages: [text3('ab\r\ncd', { generated: [2] })] }, 'PDFDATA', {}],
    note: 'no room for the origins',
  },
  {
    args: [{ password: 'pw', pages: [text3('secret')] }, 'PDFDATA', { password: 'pw' }],
    note: 'an encrypted file with its password',
  },
  {
    args: [{ password: 'pw', pages: [text3('secret')] }, 'PDFDATA', {}],
    note: 'an encrypted file without it',
  },
  {
    args: [{ password: 'pw', pages: [text3('secret')] }, 'PDFDATA', { password: '' }],
    note: 'an empty password is none',
  },
  { args: [{ loadFail: true, pages: [] }, 'PDFDATA', {}], note: 'the document does not load' },
  { args: [{ pages: [] }, 'PDFDATA', {}], note: 'no pages' },
]

// ---- redaction ----------------------------------------------------------------------------------------

const R1 = { pageIndex: 0, rect: [10, 20, 50, 60] }
const IMG = { type: 3, bounds: [10, 20, 50, 60], data: 'aabbcc' }
const redactCases: Case[] = [
  {
    args: [
      {
        pages: [
          {
            annots: [annot(1, 1, [0, 0, 30, 30]), annot(2, 1, [200, 200, 220, 220])],
            objects: [{ type: 1, bounds: [0, 0, 100, 100] }, IMG],
          },
        ],
      },
      'PDFDATA',
      [R1],
    ],
    note: 'an annotation under the rect goes, a blackout is added',
  },
  {
    args: [{ pages: [{ objects: [IMG] }, { objects: [IMG] }] }, 'PDFDATA', [R1]],
    note: 'an image placed twice cannot be redacted',
  },
  {
    args: [
      {
        pages: [
          { objects: [{ type: 5, bounds: [0, 0, 100, 100], children: [{ type: 3, data: '01' }] }] },
        ],
      },
      'PDFDATA',
      [R1],
    ],
    note: 'a form holding an image',
  },
  {
    args: [
      {
        pages: [
          {
            objects: [
              {
                type: 5,
                bounds: [0, 0, 100, 100],
                children: [{ type: 1 }, { type: 5, children: [{ type: 3, data: '02' }] }],
              },
            ],
          },
        ],
      },
      'PDFDATA',
      [R1],
    ],
    note: 'a form holding a form holding an image',
  },
  {
    args: [
      { pages: [{ objects: [{ type: 5, bounds: [0, 0, 100, 100], children: [{ type: 1 }] }] }] },
      'PDFDATA',
      [R1],
    ],
    note: 'a form without an image is fine',
  },
  {
    args: [
      { pages: [{ objects: [{ type: 5, bounds: [0, 0, 100, 100], children: [{ alias: 0 }] }] }] },
      'PDFDATA',
      [R1],
    ],
    note: 'a form that holds itself',
  },
  {
    args: [
      {
        pages: [
          {
            objects: [
              { type: 3, bounds: [200, 200, 300, 300], data: '11' },
              { type: 3, bounds: null, data: '11' },
              { null: true, type: 3 },
            ],
          },
          { objects: [{ type: 3, data: '11' }] },
        ],
      },
      'PDFDATA',
      [R1],
    ],
    note: 'images away from the rect, without bounds or without a handle',
  },
  {
    args: [{ pages: [{ annots: [annot(1, 20, [0, 0, 30, 30])] }] }, 'PDFDATA', [R1]],
    note: 'a form field under the rect',
  },
  {
    args: [
      { pages: [{ annots: [annot(1, 20, [500, 500, 530, 530]), annot(2, 20, null, {})] }] },
      'PDFDATA',
      [R1],
    ],
    note: 'a field whose rect cannot be read',
  },
  {
    args: [{ pages: [{ annots: [annot(1, 20, [500, 500, 530, 530])] }] }, 'PDFDATA', [R1]],
    note: 'a form field away from the rect',
  },
  {
    args: [
      { pages: [{ annots: [annot(1, 1, [0, 0, 30, 30], { annotNull: true })] }] },
      'PDFDATA',
      [R1],
    ],
    note: 'an annotation that does not open (the form check)',
  },
  {
    args: [{ pages: [{ annots: [annot(1, 1, null)] }] }, 'PDFDATA', [R1]],
    note: 'a plain annotation whose rect cannot be read',
  },
  {
    args: [
      { pages: [{ annots: [annot(1, 1, [0, 0, 30, 30], { removeFail: true })] }] },
      'PDFDATA',
      [R1],
    ],
    note: 'an annotation that cannot be removed',
  },
  {
    args: [{ pages: [{ createAnnotFail: true }] }, 'PDFDATA', [R1]],
    note: 'the redaction annotation cannot be created',
  },
  { args: [{ pages: [{ setRectFail: true }] }, 'PDFDATA', [R1]], note: 'the rect is refused' },
  { args: [{ pages: [{ setColorFail: true }] }, 'PDFDATA', [R1]], note: 'the color is refused' },
  {
    args: [{ pages: [{ applyFail: true }] }, 'PDFDATA', [R1]],
    note: 'the redaction does not apply',
  },
  { args: [{ blackoutFail: 'create', pages: [{}] }, 'PDFDATA', [R1]], note: 'no blackout rect' },
  {
    args: [{ blackoutFail: 'fill', pages: [{}] }, 'PDFDATA', [R1]],
    note: 'the fill is refused: the rect is destroyed',
  },
  {
    args: [{ blackoutFail: 'mode', pages: [{}] }, 'PDFDATA', [R1]],
    note: 'the draw mode is refused',
  },
  {
    args: [{ pages: [{ genFail: true }] }, 'PDFDATA', [R1]],
    note: 'the page content cannot be written',
  },
  {
    args: [{ loadPageFail: [1], pages: [{}] }, 'PDFDATA', [R1]],
    note: 'the census cannot load a page',
  },
  {
    args: [{ loadPageFail: [2], pages: [{}] }, 'PDFDATA', [R1]],
    note: 'the check cannot load the page',
  },
  {
    args: [{ loadPageFail: [3], pages: [{}] }, 'PDFDATA', [R1]],
    note: 'the redaction cannot load the page',
  },
  {
    args: [{ rawShort: true, pages: [{ objects: [IMG] }] }, 'PDFDATA', [R1]],
    note: 'the image bytes read short',
  },
  {
    args: [{ pages: [{ objects: [{ type: 3, bounds: [10, 20, 50, 60] }] }] }, 'PDFDATA', [R1]],
    note: 'an image with no data',
  },
  { args: [{ saveFail: true, pages: [{}] }, 'PDFDATA', [R1]], note: 'the save fails' },
  { args: [{ loadFail: true, pages: [{}] }, 'PDFDATA', [R1]], note: 'the document does not load' },
  {
    args: [
      { pages: [{}, {}, {}] },
      'PDFDATA',
      [
        { pageIndex: 2, rect: [60, 50, 10, 5] },
        { pageIndex: 0, rect: [0.5, 1.5, 2.25, 3.125] },
        { pageIndex: 1, rect: [-5, -6, -1, -2] },
      ],
    ],
    note: 'three regions, reversed and fractional coordinates',
  },
  {
    args: [{ pages: [{}] }, 'PDFDATA', [{ pageIndex: 1, rect: [1, 2, 3, 4] }]],
    note: 'a page past the end',
  },
  {
    args: [
      { pages: [{}] },
      'PDFDATA',
      [
        { pageIndex: 0, rect: [1, 2, 3, 4] },
        { pageIndex: 0, rect: [1, 2, 3, 2] },
      ],
    ],
    note: 'an empty rect after a good one: nothing is touched',
  },
]

const validateCases: Case[] = [
  { args: [[R1, { pageIndex: 3, rect: [4, 3, 2, 1] }]], note: 'two regions' },
  { args: [[]], note: 'none' },
  { args: [null], note: 'not a list' },
  { args: [Array.from({ length: 501 }, () => R1)], note: 'too many' },
  { args: [Array.from({ length: 500 }, () => R1)], note: 'as many as allowed' },
  { args: [[null]], note: 'a null region' },
  { args: [[5]], note: 'a number as a region' },
  { args: [[[]]], note: 'an array as a region' },
  { args: [[{ pageIndex: '0', rect: [1, 2, 3, 4] }]], note: 'a page index as text' },
  { args: [[{ pageIndex: 1.5, rect: [1, 2, 3, 4] }]], note: 'a fractional page index' },
  { args: [[{ pageIndex: -1, rect: [1, 2, 3, 4] }]], note: 'a negative page index' },
  { args: [[{ pageIndex: null, rect: [1, 2, 3, 4] }]], note: 'a null page index' },
  { args: [[{ rect: [1, 2, 3, 4] }]], note: 'no page index' },
  { args: [[R1, { pageIndex: 0 }]], note: 'no rect, second region' },
  { args: [[{ pageIndex: 0, rect: [1, 2, 3] }]], note: 'three coordinates' },
  { args: [[{ pageIndex: 0, rect: [1, 2, '3', 4] }]], note: 'a coordinate as text' },
  { args: [[{ pageIndex: 0, rect: [1, 2, null, 4] }]], note: 'a null coordinate' },
  { args: [[{ pageIndex: 0, rect: [1e39, 2, 3, 4] }]], note: 'outside float32' },
  { args: [[{ pageIndex: 0, rect: [-3.5e38, 2, 3, 4] }]], note: 'inside float32' },
  { args: [[{ pageIndex: 0, rect: [1, 2, 1, 4] }]], note: 'no width' },
  { args: [[{ pageIndex: 0, rect: [1, 2, 3, 2] }]], note: 'no height' },
  { args: [[{ pageIndex: 4, rect: [0, 0, 0, 0] }]], note: 'a rect of nothing on page 5' },
  {
    args: [[{ pageIndex: 0, rect: { 0: 1, length: 4 } }]],
    note: 'an object that looks like a list',
  },
  { args: [[{ pageIndex: 0, rect: 'abcd' }]], note: 'a string' },
  { args: [[{ pageIndex: 0, rect: [-0, 2, 3, 4] }]], note: 'negative zero' },
]

// ---- annot-flatten ------------------------------------------------------------------------------------

const flattenCases: Case[] = [
  {
    args: [{ pages: [{ annots: [HL] }, { annots: [] }, { annots: [NOTE] }] }, 'PDFDATA'],
    note: 'pages with annotations are flattened, the rest left alone',
  },
  { args: [{ pages: [{}, {}] }, 'PDFDATA'], note: 'nothing to flatten: the bytes come back' },
  {
    args: [{ pages: [{ annots: [HL], flatten: 2 }] }, 'PDFDATA'],
    note: 'pdfium says nothing to do (2) and the file is rewritten anyway',
  },
  { args: [{ pages: [{ annots: [HL], flatten: 0 }] }, 'PDFDATA'], note: 'the flatten fails' },
  { args: [{ pages: [{}, { loadFail: true }] }, 'PDFDATA'], note: 'the second page does not load' },
  { args: [{ loadFail: true, pages: [{}] }, 'PDFDATA'], note: 'the document does not load' },
  { args: [{ saveFail: true, pages: [{ annots: [HL] }] }, 'PDFDATA'], note: 'the save fails' },
  { args: [{ pages: [] }, 'PDFDATA'], note: 'no pages' },
]

// ---- font-subset ----------------------------------------------------------------------------------------

const CFF = (spec: Parameters<typeof cffFont>[0]) => fontHex(cffFont(spec))
const TTF = fontHex(
  sfnt(0x10000, [
    ['head', [0, 0, 0, 0]],
    ['glyf', [1, 2, 3, 4]],
  ]),
)

const cffCases: Case[] = [
  { args: [CFF({ fmt: 2, nGlyphs: 10 })], note: 'a CID-keyed charset of ranges is rewritten' },
  { args: [CFF({ fmt: 1, nGlyphs: 10 })], note: 'a four byte charset: format 1' },
  { args: [CFF({ fmt: 1, nGlyphs: 300 })], note: 'format 1 cannot hold 298 glyphs' },
  { args: [CFF({ fmt: 0, nGlyphs: 10 })], note: 'a charset of one SID per glyph' },
  { args: [CFF({ fmt: 0, nGlyphs: 2 })], note: 'a charset too small to rewrite' },
  { args: [CFF({ fmt: 0, nGlyphs: 1 })], note: 'one glyph needs no rewrite' },
  { args: [CFF({ fmt: 0, nGlyphs: 0, charset: [0] })], note: 'no glyphs at all' },
  { args: [CFF({ cid: false })], note: 'not CID-keyed: as it is' },
  { args: [TTF], note: 'glyf flavor: as it is' },
  { args: ['4f54544f'], note: 'shorter than a header' },
  { args: [fontHex(sfnt(0x4f54544f, [['head', [0, 0, 0, 0]]]))], note: 'OTTO without a CFF table' },
  { args: [CFF({ emptyTop: true })], note: 'no top DICT' },
  { args: [CFF({ charsetOffset: 1 })], note: 'a charset offset in the header' },
  { args: [CFF({ noCharsetOp: true })], note: 'no charset operator' },
  { args: [CFF({ noCharStringsOp: true })], note: 'no CharStrings operator' },
  { args: [CFF({ realOperand: true })], note: 'a real number operand reads as NaN' },
  { args: [CFF({ charset: [7, 0, 0, 0, 0, 0] })], note: 'an unknown charset format' },
  { args: [CFF({ offSize: 0 })], note: 'an INDEX with offSize 0' },
  { args: [CFF({ offSize: 7 })], note: 'an INDEX with offSize 7' },
  { args: [CFF({ offSize: 4 })], note: 'an INDEX with offSize 4' },
  { args: [CFF({ offSize: 3 })], note: 'an INDEX with offSize 3' },
  { args: [CFF({ offSize: 2 })], note: 'an INDEX with offSize 2' },
  { args: [CFF({ charStringsOffset: 100000 })], note: 'CharStrings far past the end' },
  { args: [CFF({ hdrSize: 255 })], note: 'a header size past the end' },
  { args: [CFF({ truncate: 60 })], note: 'cut inside the name INDEX' },
  { args: [CFF({ truncate: 74 })], note: 'cut inside the top DICT' },
  { args: [CFF({ truncate: 90 })], note: 'cut before the charset' },
  { args: [CFF({ fmt: 2, nGlyphs: 70000 })], note: 'a glyph count past 16 bits wraps in the file' },
]

const hbResult = 'cafebabe0102'
const subsetCases: Case[] = [
  {
    args: [{ result: hbResult }, TTF, 'Hello \u{1F600}'],
    note: 'a subset of the glyphs of the text',
  },
  { args: [{ result: hbResult }, TTF, ''], note: 'no text' },
  { args: [{ result: hbResult, inputFail: true }, TTF, 'x'], note: 'no subset input' },
  { args: [{ result: hbResult, subsetFail: true }, TTF, 'x'], note: 'the subset fails' },
  { args: [{ result: hbResult, emptyResult: true }, TTF, 'x'], note: 'an empty result' },
  {
    args: [{ result: hbResult, memorySize: 8 }, TTF, 'x'],
    note: 'the font does not fit the memory',
  },
]

// ---- generated-output --------------------------------------------------------------------------------------

const outCase = (name: unknown, existing: string[] | null = null, files?: Case['files']): Case => ({
  args: ['$DIR/out', name, existing],
  ...(files ? { files } : {}),
})

const generatedCases: Case[] = [
  outCase('report.pdf'),
  outCase('report.pdf', null, { 'out/report.pdf': 'x' }),
  outCase('report.pdf', null, { 'out/report.pdf': 'x', 'out/report-2.pdf': 'x' }),
  outCase('report', ['$DIR/out/report.pdf', '$DIR/out/report-2.pdf', '$DIR/out/report-3.pdf']),
  outCase('a:b.pdf'),
  outCase('../../etc/passwd'),
  outCase('x/y\\z.pdf'),
  outCase('\u0001ab\u001f\u0000c.pdf'),
  outCase(' spaces .PDF '),
  outCase(''),
  outCase('   '),
  outCase('.'),
  outCase('..'),
  outCase(null),
  outCase(0),
  outCase(5),
  outCase(['a', 'b']),
  outCase({ toString: 1 }),
  outCase('?'),
  outCase('r\u00e9sum\u00e9.Pdf'),
  outCase('a.pdf.pdf'),
  outCase('\u0130\u0131\u017f\u212a \u{1F600}.pdf'),
  outCase('x.pdf', ['$DIR/out/x.pdf']),
]

// ---- note-link ---------------------------------------------------------------------------------------------------

const linkCases: Case[] = [
  { args: ['/n/notes/a.md', '/n/pdfs/b.pdf', 'linux'], note: 'up and down' },
  { args: ['/n/a.md', '/n/b c(1).pdf', 'linux'], note: 'spaces and parentheses are encoded' },
  { args: ['/n/a.md', '/n/x/y/z.pdf', 'linux'], note: 'below the note' },
  {
    args: ['/n/a.md', '/n/#?&\u00e9\u{1F600}.pdf', 'darwin'],
    note: 'reserved and astral characters',
  },
  {
    args: ['/n/sp ace/a.md', '/n/sp ace', 'linux'],
    note: 'the PDF is the note folder: a file URL',
  },
  { args: ['/n/a.md', '/n/b.pdf', null], note: 'the platform of the host' },
  { args: ['C:\\notes\\a.md', 'C:\\pdfs\\b c.pdf', 'win32'], note: 'Windows, one drive' },
  { args: ['C:\\a\\n.md', 'D:\\p\\x y.pdf', 'win32'], note: 'another drive: a file URL' },
  {
    args: ['\\\\srv\\share\\n\\a.md', '\\\\srv\\share\\p\\b#.pdf', 'win32'],
    note: 'one UNC share',
  },
  {
    args: ['\\\\srv\\share\\n\\a.md', '\\\\srv\\other\\p\\b#.pdf', 'win32'],
    note: 'another UNC share: a UNC URL',
  },
  { args: ['c:\\a\\n.md', 'C:\\a\\x.pdf', 'win32'], note: 'the drive letter in either case' },
  { args: ['C:\\a\\n.md', 'C:\\a', 'win32'], note: 'Windows, the PDF is the note folder' },
]

const quote = (excerpt: string, page = 3, extra: Record<string, unknown> = {}) => ({
  kind: 'quote',
  excerpt,
  page,
  ...extra,
})

const insertCases: Case[] = [
  { args: ['/n/a.md', '/n/p/b.pdf', quote('one line'), 'linux'], note: 'a one line quote' },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('first\r\nsecond\rthird\n\nfifth   \n'), 'linux'],
    note: 'line breaks, blank lines and trailing spaces',
  },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('\n\n  \nbody\n \n\n'), 'linux'],
    note: 'blank lines at both ends go',
  },
  { args: ['/n/a.md', '/n/p/b.pdf', quote(''), 'linux'], note: 'an empty excerpt is a link alone' },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('  \n \t '), 'linux'],
    note: 'a white space excerpt too',
  },
  {
    args: [
      '/n/a.md',
      '/n/p/b.pdf',
      quote(
        'see ![x](http://e/i.png) and <img src=x> and <IMG src=y> and <imgx> and \\![a] and \\\\![b] and \\\\\\![c]',
      ),
      'linux',
    ],
    note: 'images lose their meaning, escaped ones stay',
  },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('text', 7, { body: '  a memo with ![x](u)  ' }), 'linux'],
    note: 'a body',
  },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('text', 7, { body: '   ' }), 'linux'],
    note: 'a white space body is none',
  },
  {
    args: [
      '/n/a.md',
      '/n/p/b.pdf',
      { kind: 'overview', heading: '  Overview <img src=1> ', body: 'the body' },
      'linux',
    ],
    note: 'an overview',
  },
  {
    args: ['/n/a.md', '/n/p/b.pdf', { kind: 'overview', heading: 'H', body: '' }, 'linux'],
    note: 'an overview without a body',
  },
  {
    args: ['C:\\n\\a.md', 'D:\\p\\b.pdf', quote('x'), 'win32'],
    note: 'a file URL for another drive',
  },
  {
    args: ['/n/a.md', '/n/p/b.pdf', quote('x \u0131\u017f\u212a \u{1F600}'), null],
    note: 'the platform of the host',
  },
]

const longText = (n: number, ch = 'a'): string => ch.repeat(n)
const parseInsertCases: Case[] = [
  { args: [quote('x')], note: 'a quote' },
  {
    args: [quote('x', 4, { body: 'b', title: '  A \n\t B  ' })],
    note: 'body and a title squeezed',
  },
  { args: [quote('x', 4, { title: longText(400) })], note: 'a title cut at 300' },
  { args: [quote('x', 4, { title: '   ' })], note: 'a blank title is none' },
  { args: [quote('x', 4, { title: 5 })], note: 'a title that is not text' },
  { args: [quote(longText(20000))], note: 'an excerpt of the largest size' },
  { args: [quote(longText(20001))], note: 'one over' },
  { args: [quote('\u{1F600}'.repeat(10001))], note: 'counted in UTF-16 units: 20002' },
  { args: [quote('\u{1F600}'.repeat(10000))], note: 'counted in UTF-16 units: 20000' },
  { args: [quote('x', 4, { body: longText(200001) })], note: 'a body one over' },
  { args: [quote('x', 4, { body: null })], note: 'a null body' },
  { args: [quote('x', 4, { body: 7 })], note: 'a body that is not text' },
  { args: [quote('x', 0)], note: 'page 0' },
  { args: [quote('x', 1.5)], note: 'a fractional page' },
  { args: [quote('x', 1000000)], note: 'the last page' },
  { args: [quote('x', 1000001)], note: 'one past it' },
  { args: [quote('x', '2' as unknown as number)], note: 'a page as text' },
  { args: [{ kind: 'quote', page: 1 }], note: 'no excerpt' },
  { args: [{ kind: 'quote', excerpt: 'x' }], note: 'no page' },
  {
    args: [{ kind: 'overview', heading: 'H', body: 'B', title: 'T', path: '/etc/passwd' }],
    note: 'an overview, a path dropped',
  },
  { args: [{ kind: 'overview', heading: '   ', body: 'B' }], note: 'a blank heading' },
  { args: [{ kind: 'overview', heading: 'H', body: ' \n ' }], note: 'a blank body' },
  { args: [{ kind: 'overview', heading: longText(201), body: 'B' }], note: 'a heading one over' },
  {
    args: [{ kind: 'overview', heading: longText(200), body: 'B' }],
    note: 'a heading of the largest size',
  },
  { args: [{ kind: 'other' }], note: 'an unknown kind' },
  { args: [null], note: 'null' },
  { args: ['quote'], note: 'text' },
  { args: [[]], note: 'an array' },
  { args: [0], note: 'a number' },
]

const openRequestCases: Case[] = [
  { args: [{ title: 'Doc' }] },
  { args: [{ title: '  ' }], note: 'a blank title' },
  { args: [{ title: 7 }], note: 'a title that is not text' },
  { args: [null] },
  { args: ['x'] },
  { args: [[]] },
  { args: [{}] },
  { args: [{ title: longText(301) }], note: 'cut at 300' },
]

const notePathCases: Case[] = [
  { args: ['/a/b/Doc.PDF', 'Note', 'linux'], note: 'the extension in any case' },
  { args: ['C:\\a\\Doc.pdf', 'Note', 'win32'], note: 'Windows' },
  { args: ['/a/b/noext', 'Note', 'linux'], note: 'no extension' },
  { args: ['/a/b/x.pdf.pdf', 'Note', 'linux'], note: 'only the last extension goes' },
  { args: ['/a/b/c.pdf', '\ub178\ud2b8', 'darwin'], note: 'a Korean word' },
  { args: ['/a/b/c.pdf', 'Note', null], note: 'the platform of the host' },
  { args: ['c.pdf', 'Note', 'linux'], note: 'no folder' },
]

const dialogCases: Case[] = [
  { args: ['en', 'noteWord'] },
  { args: ['ko', 'dialogTitle'] },
  { args: ['fr', 'filterMarkdown'], note: 'an unknown language is English' },
  { args: ['constructor', 'noteWord'], note: 'a name every object has' },
  { args: ['__proto__', 'noteWord'], note: 'the prototype itself' },
  { args: ['toString', 'dialogTitle'], note: 'a function' },
  { args: ['ko', 'nope'], note: 'an unknown key' },
  { args: ['', 'noteWord'], note: 'the empty language' },
]

/** the case of the service: `calls` run one after another over the scripted dependencies */
const svc = (
  extra: Record<string, unknown>,
  calls: unknown[],
  files?: Case['files'],
  note?: string,
): Case => ({
  args: [{ platform: 'linux', ...extra, calls }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})
const open = (pdfPath: string | null, owner = 1, request: unknown = {}) => ({
  op: 'open',
  owner,
  pdfPath,
  request,
})
const insert = (pdfPath: string | null, request: unknown = quote('quoted', 2), owner = 1) => ({
  op: 'insert',
  owner,
  pdfPath,
  request,
})
const after = (pdfPath: string) => ({ op: 'afterSave', pdfPath })
const PDF = '/p/doc.pdf'

const serviceCases: Case[] = [
  svc(
    { untitled: ['/p/untitled.pdf'] },
    [open(null), open(''), open('/p/untitled.pdf'), insert(null)],
    undefined,
    'no PDF, an empty path, an untitled PDF',
  ),
  svc(
    { host: { open: 'missing' } },
    [open(PDF), insert(PDF)],
    undefined,
    'the shell gave no openNote',
  ),
  svc({ host: { insert: 'missing' } }, [open(PDF)], undefined, 'or no insertIntoNote'),
  svc(
    { store: { found: { notePath: '/n/a.md', matchedBy: 'path' } } },
    [open(PDF), insert(PDF), insert(PDF, { kind: 'overview', heading: 'H', body: 'B' })],
    undefined,
    'a linked note found by path',
  ),
  svc(
    { store: { found: { notePath: '/n/a.md', matchedBy: 'docHash' } }, hash: 'hh' },
    [open(PDF)],
    undefined,
    'found by hash: the link is set for this path',
  ),
  svc(
    {
      store: { found: { notePath: '/n/a.md', matchedBy: 'path' } },
      host: { open: false, insert: false },
    },
    [open(PDF), insert(PDF)],
    undefined,
    'the shell refuses',
  ),
  svc(
    { pick: ['/n/new'], fileExists: false, createFile: true, noteWord: 'Note' },
    [open(PDF, 1, { title: 'My Title' })],
    undefined,
    'no link: the person picks a path; .md added; header from the title',
  ),
  svc(
    { pick: ['/n/new.MD'], fileExists: false, createFile: true },
    [open(PDF)],
    undefined,
    'a path that is Markdown already; header from the file name',
  ),
  svc(
    { pick: ['/n/new.md'], fileExists: true },
    [open(PDF)],
    undefined,
    'the note exists: it is linked as it is',
  ),
  svc(
    { pick: [null, '', 'relative/new.md'] },
    [open(PDF), open(PDF), open(PDF)],
    undefined,
    'cancelled twice, then not absolute',
  ),
  svc(
    { pick: ['$DIR/n/notes', '$DIR/n/notes'] },
    [open(PDF), open(PDF)],
    { 'n/keep.txt': 'x' },
    'the default file calls: create, then find it there',
  ),
  svc(
    { pick: ['$DIR/n/race'], fileExists: false },
    [open(PDF)],
    { 'n/race.md': 'mine' },
    'a file that appeared meanwhile is not overwritten',
  ),
  svc(
    { pick: ['$DIR/missing/dir/note'] },
    [open(PDF)],
    undefined,
    'the default create fails: the Node message',
  ),
  svc(
    { pick: ['/n/x.md'], fileExists: { throws: 'access broke' } },
    [open(PDF)],
    undefined,
    'fileExists throws',
  ),
  svc(
    { pick: ['/n/x.md'], fileExists: false, createFile: { throws: 'create broke' } },
    [open(PDF)],
    undefined,
    'createNoteFile throws',
  ),
  svc({ hashThrows: 'hash broke' }, [open(PDF)], undefined, 'hashing throws'),
  svc({ storeThrows: 'no store' }, [open(PDF)], undefined, 'the store throws'),
  svc({ store: { findThrows: 'find broke' } }, [open(PDF)], undefined, 'find throws'),
  svc(
    { store: { found: { notePath: '/n/a.md', matchedBy: 'docHash' }, setThrows: 'set broke' } },
    [open(PDF)],
    undefined,
    'set throws',
  ),
  svc(
    { pick: ['/n/x.md'], fileExists: true, store: { setThrows: 'set broke' } },
    [open(PDF)],
    undefined,
    'set throws after a pick',
  ),
  svc({ pickThrows: 'dialog broke' }, [open(PDF)], undefined, 'the dialog throws'),
  svc({ noteWordThrows: 'word broke' }, [open(PDF)], undefined, 'the note word throws'),
  svc({ hostThrows: 'host broke' }, [open(PDF)], undefined, 'the host throws: the call rejects'),
  svc(
    { untitledThrows: 'untitled broke' },
    [open(PDF)],
    undefined,
    'isUntitled throws: the call rejects',
  ),
  svc(
    {
      store: { found: { notePath: '/n/a.md', matchedBy: 'path' } },
      host: { open: { throws: 'open broke' }, insert: { throws: 'insert broke', plain: true } },
    },
    [open(PDF), insert(PDF)],
    undefined,
    'the shell throws an Error, then a plain value',
  ),
  svc(
    { pick: ['/n/a.md', '/n/b.md'], fileExists: true, pickReenter: { owner: 1, pdfPath: PDF } },
    [open(PDF, 1), open(PDF, 1)],
    undefined,
    'a second request of the same view while the dialog is open: busy; then free again',
  ),
  svc(
    { pick: ['/n/a.md', '/n/b.md'], fileExists: true, pickReenter: { owner: 2, pdfPath: PDF } },
    [open(PDF, 1)],
    undefined,
    'another view may ask',
  ),
  svc(
    { store: { links: ['/x/doc.pdf'] }, hash: 'new' },
    [after('/x/doc.pdf'), after('/x/other.pdf')],
    undefined,
    'after a save: the linked path follows the hash',
  ),
  svc(
    { platform: 'win32', store: { links: ['/x/doc.pdf'] } },
    [after('/x/DOC.pdf')],
    undefined,
    'on Windows the key is lower case',
  ),
  svc(
    { store: { links: ['/x/doc.pdf'] } },
    [after('/x/DOC.pdf')],
    undefined,
    'elsewhere it is not',
  ),
  svc(
    { store: { readThrows: 'read broke', links: ['/x/doc.pdf'] } },
    [after('/x/doc.pdf')],
    undefined,
    'reading the links throws: a warning',
  ),
  svc(
    { store: { links: ['/x/doc.pdf'] }, hashThrows: 'hash broke' },
    [after('/x/doc.pdf')],
    undefined,
    'hashing throws: a warning',
  ),
  svc(
    { store: { links: ['/x/doc.pdf'], updateThrows: 'update broke' } },
    [after('/x/doc.pdf')],
    undefined,
    'the update throws: a warning',
  ),
  svc({ storeThrows: 'no store' }, [after('/x/doc.pdf')], undefined, 'no store: a warning'),
  svc(
    { platform: 'win32', pick: ['C:\\n\\x.md'], fileExists: true },
    [open('C:\\p\\doc.pdf'), insert('C:\\p\\doc.pdf')],
    undefined,
    'Windows paths',
  ),
]

// ---- signature-store -------------------------------------------------------------------------------------------------

const IMAGE = { kind: 'image', image: 'iVBORw0=', width: 100, height: 40 }
const STROKES = {
  kind: 'strokes',
  width: 80,
  height: 30,
  paths: [
    [1, 2, 3, 4],
    [5, 6, 7, 8, 9, 10],
  ],
}
const entry = (id: string, data: unknown, createdAt?: unknown) => ({
  id,
  ...(createdAt === undefined ? {} : { createdAt }),
  data,
})

const dataCases: Case[] = [
  { args: [IMAGE] },
  { args: [STROKES] },
  { args: [{ ...IMAGE, width: 0 }], note: 'no width' },
  { args: [{ ...IMAGE, height: -1 }], note: 'negative height' },
  { args: [{ ...IMAGE, width: '100' }], note: 'width as text' },
  { args: [{ ...IMAGE, width: null }], note: 'null width' },
  { args: [{ ...IMAGE, image: '' }], note: 'an empty image' },
  { args: [{ ...IMAGE, image: 5 }], note: 'an image that is not text' },
  { args: [{ ...IMAGE, kind: 'other' }], note: 'an unknown kind' },
  { args: [{ width: 1, height: 1 }], note: 'no kind' },
  { args: [{ ...STROKES, paths: [] }], note: 'no paths' },
  { args: [{ ...STROKES, paths: [[1, 2, 3]] }], note: 'a path of 3' },
  { args: [{ ...STROKES, paths: [[1, 2, 3, 4, 5]] }], note: 'an odd path' },
  { args: [{ ...STROKES, paths: [[1, 2, 3, '4']] }], note: 'a coordinate as text' },
  { args: [{ ...STROKES, paths: [[1, 2, 3, null]] }], note: 'a null coordinate' },
  { args: [{ ...STROKES, paths: 'x' }], note: 'paths that are not a list' },
  { args: [{ ...STROKES, paths: [5] }], note: 'a path that is not a list' },
  { args: [null] },
  { args: ['image'] },
  { args: [[]], note: 'an array' },
  { args: [7] },
]

const sanitizeCases: Case[] = [
  {
    args: [[entry('a', IMAGE, 5), entry('b', STROKES)]],
    note: 'two good entries; no createdAt reads 0',
  },
  {
    args: [
      [
        entry('a', IMAGE, 5),
        entry('a', STROKES, 6),
        entry('', IMAGE),
        entry('c', { ...IMAGE, width: 0 }),
        null,
        5,
        'x',
        [],
        { data: IMAGE },
        { id: 7, data: IMAGE },
      ],
    ],
    note: 'a duplicate id, an empty id, bad data and bad entries drop',
  },
  {
    args: [[entry('a', IMAGE, 'late'), entry('b', IMAGE, null), entry('c', IMAGE, -3.5)]],
    note: 'createdAt that is not a number reads 0',
  },
  {
    args: [[entry('a', { ...IMAGE, note: 'kept', 10: 'ten', 2: 'two' })]],
    note: 'the data keeps its keys, integer keys first',
  },
  { args: [{ not: 'a list' }] },
  { args: [null] },
  { args: [[]] },
]

const SIG_LIST = Array.from({ length: 10 }, (_, i) =>
  entry(`s${i}`, { ...IMAGE, image: `img${i}` }, i),
)
const addCases: Case[] = [
  { args: [[], IMAGE, 1000], note: 'the first signature' },
  {
    args: [[entry('s1', IMAGE, 1), entry('s2', STROKES, 2)], STROKES, 3000],
    note: 'an identical payload is refreshed to the front',
  },
  {
    args: [[entry('s1', IMAGE, 1)], { ...IMAGE, image: 'other' }, null],
    note: 'another image, the clock of the call',
  },
  { args: [[entry('s1', IMAGE, 1)], { ...IMAGE, width: 101 }, 5], note: 'another width' },
  { args: [[entry('s1', IMAGE, 1)], { ...IMAGE, height: 41 }, 5], note: 'another height' },
  { args: [[entry('s1', IMAGE, 1)], STROKES, 5], note: 'another kind' },
  {
    args: [[entry('s1', STROKES, 1)], { ...STROKES, paths: [[1, 2, 3, 4]] }, 5],
    note: 'fewer paths',
  },
  {
    args: [
      [entry('s1', STROKES, 1)],
      {
        ...STROKES,
        paths: [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ],
      },
      5,
    ],
    note: 'a shorter path',
  },
  {
    args: [
      [entry('s1', STROKES, 1)],
      {
        ...STROKES,
        paths: [
          [1, 2, 3, 4],
          [5, 6, 7, 8, 9, 11],
        ],
      },
      5,
    ],
    note: 'one coordinate differs',
  },
  { args: [SIG_LIST, { ...IMAGE, image: 'new' }, 99], note: 'the oldest of ten is evicted' },
  { args: [SIG_LIST, { ...IMAGE, image: 'img4' }, 99], note: 'a duplicate among ten keeps ten' },
  {
    args: [[entry('s1', { ...IMAGE, extra: 1 }, 1)], IMAGE, 5],
    note: 'extra keys do not matter to sameness',
  },
]

const removeCases: Case[] = [
  { args: [[entry('a', IMAGE, 1), entry('b', STROKES, 2)], 'a'] },
  { args: [[entry('a', IMAGE, 1)], 'zzz'], note: 'an id that is not there' },
  { args: [[], 'a'] },
]

const SAVED = JSON.stringify([entry('a', IMAGE, 5), entry('b', STROKES, 6)])
const loadCases: Case[] = [
  { args: ['$DIR/s.json'], files: { 's.json': SAVED } },
  { args: ['$DIR/s.json'], note: 'no file' },
  { args: ['$DIR/s.json'], files: { 's.json': '{broken' }, note: 'broken JSON' },
  {
    args: ['$DIR/s.json'],
    files: { 's.json': '\ufeff' + SAVED },
    note: 'a byte order mark is no JSON white space',
  },
  { args: ['$DIR/s.json'], files: { 's.json': { dir: true } }, note: 'a folder' },
  {
    args: ['$DIR/s.json'],
    files: {
      's.json': JSON.stringify([entry('a', IMAGE), entry('a', IMAGE), entry('b', { kind: 'x' })]),
    },
    note: 'entries that sanitize away',
  },
  { args: ['$DIR/s.json'], files: { 's.json': '{"a":1}' }, note: 'JSON that is not a list' },
]

const saveCases: Case[] = [
  { args: ['$DIR/store/s.json', [entry('a', IMAGE, 5)]], note: 'the folder is made' },
  {
    args: ['$DIR/s.json', [entry('a', STROKES, 5.5), entry('b', { ...IMAGE, 10: 1, 2: 2 }, 1e21)]],
    files: { 's.json': 'old' },
    note: 'the file is replaced; numbers print as JSON prints them',
  },
  { args: ['$DIR/s.json', []], note: 'an empty list' },
  {
    args: ['$DIR/f/s.json', []],
    files: { f: 'a file where the folder should be' },
    note: 'the folder cannot be made',
  },
  {
    args: ['$DIR/d', []],
    files: { 'd/keep': 'x' },
    note: 'the target is a folder: the rename fails',
  },
]

// ---- system-certificates ----------------------------------------------------------------------------------------------

const cert = (name: string) => CERTS.find((c) => c.name === name)!
const derB64 = (name: string): string =>
  cert(name)
    .pem.split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('')
const sha = (n: number): string => n.toString(16).padStart(2, '0').repeat(20).toUpperCase()
const NSS_HOME = '$DIR/home'
const DB = `sql:${NSS_HOME}/.pki/nssdb`
const DB_P = `sql:${NSS_HOME}/.mozilla/firefox/p`
const NSS_FILES: Case['files'] = { 'home/.pki/nssdb/cert9.db': 'db' }
const keyLine = (i: number, algo: string, id: string, nick: string): string =>
  `< ${i}> ${algo}      ${id}   ${nick}`
const ID = '5a3b2c1d4e5f60718293a4b5c6d7e8f901234567'

const pwArgs = ['-f', '<scratch>/store-pw']
const keysRule = (
  db: string,
  stdout: string,
  extra: Record<string, unknown> = {},
  pw: string[] = [],
) => ({
  file: 'certutil',
  args: ['-K', '-d', db, ...pw],
  code: 0,
  stdout,
  ...extra,
})
const pemRule = (
  db: string,
  nick: string,
  name: string,
  extra: Record<string, unknown> = {},
  pw: string[] = [],
) => ({
  file: 'certutil',
  args: ['-L', '-d', db, '-n', nick, '-a', ...pw],
  code: 0,
  stdout: name === '' ? 'not a certificate' : cert(name).pem,
  ...extra,
})

const KEYS = [
  keyLine(0, 'rsa', ID, 'Zed Late'),
  keyLine(1, 'rsa', ID, 'Bob Expired'),
  keyLine(2, 'ec', ID, 'Carol EC'),
  keyLine(3, 'rsa', ID, 'Alice Signer'),
  keyLine(4, 'rsa', 'abc', 'short key id'),
  'a header line that is not a key',
  '',
].join('\n')

const listing = (extra: Record<string, unknown>, files?: Case['files'], note?: string): Case => ({
  args: [{ platform: 'linux', home: NSS_HOME, certs: CERTS, ...extra }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})

const dirsCases: Case[] = [
  { args: [NSS_HOME], files: NSS_FILES, note: 'the shared database' },
  { args: [NSS_HOME], note: 'nothing there' },
  {
    args: [NSS_HOME],
    files: {
      ...NSS_FILES,
      'home/.mozilla/firefox/zzz.default/cert9.db': 'x',
      'home/.mozilla/firefox/abc.default/cert9.db': 'x',
      'home/.mozilla/firefox/nodb/key4.db': 'x',
      'home/.mozilla/firefox/profiles.ini': 'x',
      'home/snap/firefox/common/.mozilla/firefox/p1/cert9.db': 'x',
      'home/.var/app/org.mozilla.firefox/.mozilla/firefox/flat/cert9.db': 'x',
    },
    note: 'Firefox profiles in three places, those with a cert9.db; a file among them is no profile',
  },
  {
    args: [NSS_HOME],
    files: { 'home/.mozilla/firefox/p/cert9.db': { dir: true } },
    note: 'a folder named cert9.db counts as existing',
  },
]

const keyListCases: Case[] = [
  { args: [KEYS] },
  { args: [''] },
  { args: ['< 0> RSA ' + ID + ' Upper'], note: 'the algorithm is case sensitive' },
  { args: ['<0>  rsa  ' + ID + '   Name with  spaces  \r'], note: 'spaces and a carriage return' },
  { args: ['< 0> rsa ' + ID + ' \u00e9\u0131\u017f\u212a \u{1F600}'], note: 'non-ASCII nicknames' },
  { args: ['< 0> rsa ' + ID], note: 'no nickname' },
  { args: ['  < 0> rsa ' + ID + ' Indented'], note: 'an indented line' },
  {
    args: ['< 0> rsa 1234567 Short\n< 1> rsa 12345678 Eight'],
    note: 'a key id of 7 digits, then 8',
  },
]

const winRows = (rows: unknown): string => JSON.stringify(rows)
const winRow = (thumb: string, name: string) => ({
  Thumbprint: thumb,
  Subject: 'CN=x',
  Der: derB64(name),
})

const winParseCases: Case[] = [
  {
    args: [winRows([winRow(sha(0xab), 'rsa-valid'), winRow(sha(0xcd).toLowerCase(), 'ec')])],
    note: 'two rows; a thumbprint in lower case is upper-cased',
  },
  { args: [winRows(winRow(sha(0xab), 'rsa-valid'))], note: 'one object, not a list' },
  { args: ['\ufeff' + winRows([winRow(sha(1), 'rsa-valid')])], note: 'a byte order mark' },
  { args: [''], note: 'nothing' },
  { args: ['  \n '], note: 'white space' },
  { args: ['null'], note: 'null' },
  {
    args: [
      '[null, 5, "x", {"Thumbprint": 5, "Der": "AA"}, {"Thumbprint": "' +
        sha(2) +
        '"}, {"Thumbprint": "short", "Der": "AA"}, {"Thumbprint": "' +
        sha(3) +
        '", "Der": "QQ=="}]',
    ],
    note: 'rows that are not certificate rows drop',
  },
  { args: ['{broken'], note: 'broken JSON' },
  { args: ['[1,]'], note: 'array ends after a comma' },
  { args: ['[1 2]'], note: 'missing comma in an array' },
  { args: ['{"a":1,}'], note: 'object ends after a comma' },
  { args: ['{"a" 1}'], note: 'missing colon' },
  { args: ['{"a":1 "b":2}'], note: 'missing comma in an object' },
  { args: ['01'], note: 'leading zero' },
  { args: ['[-]'], note: 'minus alone' },
  { args: ['[1.]'], note: 'fraction without digits' },
  { args: ['[1e+]'], note: 'exponent without digits' },
  { args: ['"abc'], note: 'unterminated string' },
  { args: ['["a\\x"]'], note: 'bad escape' },
  { args: ['["a\\u12G4"]'], note: 'bad unicode escape' },
  { args: ['[tru'], note: 'cut literal' },
  { args: ['[trux]'], note: 'wrong literal' },
  { args: ['[fals1]'], note: 'a digit in a literal' },
  { args: ['[1] x'], note: 'text after the value' },
  { args: ['[\r\n\r\n 1 x'], note: 'line and column after CRLF' },
  { args: ['this is not json at all really'], note: 'long source, error at the start' },
  {
    args: ['[1,2,3,4,5,6,7,8,9,10,11,12,x,13,14,15,16,17,18,19]'],
    note: 'long source, error in the middle',
  },
  {
    args: ['[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,x]'],
    note: 'long source, error near the end',
  },
  { args: ['[1,2,3,4,5,6,7,8,9,10,x]'], note: 'source of 21 characters' },
  { args: ['[1,2,3,4,5,6,7,8,9,x]'], note: 'source of 20 characters' },
  { args: ['undefined'], note: 'undefined' },
  { args: ['NaN'], note: 'NaN' },
  { args: ['["\\\\'], note: 'cut escape' },
]

const winChainCases: Case[] = [
  { args: [JSON.stringify([derB64('rsa-valid'), derB64('rsa-late')])] },
  { args: [JSON.stringify(derB64('rsa-valid'))], note: 'one string' },
  { args: [JSON.stringify([1, null, derB64('ec'), { a: 1 }])], note: 'only strings count' },
  { args: [''] },
  { args: ['\ufeff[]'] },
  { args: ['{broken'], note: 'broken JSON' },
  { args: ['[1,]'], note: 'array ends after a comma' },
  { args: ['[1 2]'], note: 'missing comma in an array' },
  { args: ['{"a":1,}'], note: 'object ends after a comma' },
  { args: ['{"a" 1}'], note: 'missing colon' },
  { args: ['{"a":1 "b":2}'], note: 'missing comma in an object' },
  { args: ['01'], note: 'leading zero' },
  { args: ['[-]'], note: 'minus alone' },
  { args: ['[1.]'], note: 'fraction without digits' },
  { args: ['[1e+]'], note: 'exponent without digits' },
  { args: ['"abc'], note: 'unterminated string' },
  { args: ['["a\\x"]'], note: 'bad escape' },
  { args: ['["a\\u12G4"]'], note: 'bad unicode escape' },
  { args: ['[tru'], note: 'cut literal' },
  { args: ['[trux]'], note: 'wrong literal' },
  { args: ['[fals1]'], note: 'a digit in a literal' },
  { args: ['[1] x'], note: 'text after the value' },
  { args: ['[\r\n\r\n 1 x'], note: 'line and column after CRLF' },
  { args: ['this is not json at all really'], note: 'long source, error at the start' },
  {
    args: ['[1,2,3,4,5,6,7,8,9,10,11,12,x,13,14,15,16,17,18,19]'],
    note: 'long source, error in the middle',
  },
  {
    args: ['[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,x]'],
    note: 'long source, error near the end',
  },
  { args: ['[1,2,3,4,5,6,7,8,9,10,x]'], note: 'source of 21 characters' },
  { args: ['[1,2,3,4,5,6,7,8,9,x]'], note: 'source of 20 characters' },
  { args: ['undefined'], note: 'undefined' },
  { args: ['NaN'], note: 'NaN' },
  { args: ['["\\\\'], note: 'cut escape' },
]

const PSARGS = (script: string): string[] => ['-NoProfile', '-NonInteractive', '-Command', script]
const winList = (extra: Record<string, unknown>, rules: unknown[], note?: string): Case =>
  listing({ platform: 'win32', rules, ...extra }, undefined, note)

const listCases: Case[] = [
  listing(
    {
      rules: [
        keysRule(DB, KEYS),
        pemRule(DB, 'Zed Late', 'rsa-late'),
        pemRule(DB, 'Bob Expired', 'rsa-expired'),
        pemRule(DB, 'Alice Signer', 'rsa-valid'),
      ],
    },
    NSS_FILES,
    'three RSA identities: valid ones first, by name; an EC key and a short id are not offered',
  ),
  listing(
    {
      rules: [
        keysRule(DB, KEYS),
        pemRule(DB, 'Zed Late', 'rsa-late', { code: 1 }),
        pemRule(DB, 'Bob Expired', '', {}),
        pemRule(DB, 'Alice Signer', 'rsa-no-cn'),
      ],
    },
    NSS_FILES,
    'a nickname that does not export, one that is no certificate',
  ),
  listing(
    { rules: [keysRule(DB, '', { missing: true, code: 1 })] },
    NSS_FILES,
    'certutil is not installed',
  ),
  listing(
    {
      rules: [
        keysRule(DB, '', {
          code: 255,
          stderr: 'certutil: could not authenticate to token NSS Certificate DB.',
        }),
        keysRule(DB_P, KEYS),
        pemRule(DB_P, 'Alice Signer', 'rsa-korean'),
      ],
    },
    { ...NSS_FILES, 'home/.mozilla/firefox/p/cert9.db': 'x' },
    'the shared store is locked, the profile is not',
  ),
  listing(
    { rules: [keysRule(DB, '', { code: 1, stderr: 'some other failure' })] },
    NSS_FILES,
    'a failure that is not a lock says nothing',
  ),
  listing({ rules: [] }, undefined, 'no database at all'),
  listing(
    {
      storePassword: 'open sesame',
      rules: [
        keysRule(DB, KEYS, {}, pwArgs),
        pemRule(DB, 'Alice Signer', 'rsa-valid', {}, pwArgs),
        pemRule(DB, 'Zed Late', 'rsa-late', {}, pwArgs),
        pemRule(DB, 'Bob Expired', 'rsa-expired', {}, pwArgs),
      ],
    },
    NSS_FILES,
    'a store password goes through a file',
  ),
  listing(
    { storePassword: '', rules: [keysRule(DB, '')] },
    NSS_FILES,
    'an empty store password is none',
  ),
  listing({ platform: 'darwin', rules: [] }, undefined, 'macOS is not offered'),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: winRows([
          winRow(sha(1), 'rsa-late'),
          winRow(sha(2), 'ec'),
          winRow(sha(3), 'rsa-expired'),
          winRow(sha(4), 'rsa-valid'),
          { Thumbprint: sha(5), Subject: 'x', Der: 'AAAA' },
          winRow('bad', 'rsa-valid'),
        ]),
      },
    ],
    'the personal store: RSA only, expired last',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 1,
        stdout: winRows([winRow(sha(1), 'rsa-late')]),
      },
    ],
    'PowerShell fails: nothing',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '' }],
    'nothing printed',
  ),
  winList(
    { now: 4_000_000_000_000 },
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: winRows(winRow(sha(9), 'rsa-late')),
      },
    ],
    'by the clock of the call a valid one has expired',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '{broken' }],
    'broken JSON: the call fails',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[1,]' }],
    'the call fails: array ends after a comma',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[1 2]' }],
    'the call fails: missing comma in an array',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '{"a":1,}' }],
    'the call fails: object ends after a comma',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '{"a" 1}' }],
    'the call fails: missing colon',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '{"a":1 "b":2}',
      },
    ],
    'the call fails: missing comma in an object',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '01' }],
    'the call fails: leading zero',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[-]' }],
    'the call fails: minus alone',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[1.]' }],
    'the call fails: fraction without digits',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[1e+]' }],
    'the call fails: exponent without digits',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '"abc' }],
    'the call fails: unterminated string',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '["a\\x"]' }],
    'the call fails: bad escape',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '["a\\u12G4"]',
      },
    ],
    'the call fails: bad unicode escape',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[tru' }],
    'the call fails: cut literal',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[trux]' }],
    'the call fails: wrong literal',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[fals1]' }],
    'the call fails: a digit in a literal',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '[1] x' }],
    'the call fails: text after the value',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '[\r\n\r\n 1 x',
      },
    ],
    'the call fails: line and column after CRLF',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: 'this is not json at all really',
      },
    ],
    'the call fails: long source, error at the start',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '[1,2,3,4,5,6,7,8,9,10,11,12,x,13,14,15,16,17,18,19]',
      },
    ],
    'the call fails: long source, error in the middle',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,x]',
      },
    ],
    'the call fails: long source, error near the end',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '[1,2,3,4,5,6,7,8,9,10,x]',
      },
    ],
    'the call fails: source of 21 characters',
  ),
  winList(
    {},
    [
      {
        file: 'powershell.exe',
        args: PSARGS(WINDOWS_LIST_SCRIPT),
        code: 0,
        stdout: '[1,2,3,4,5,6,7,8,9,x]',
      },
    ],
    'the call fails: source of 20 characters',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: 'undefined' }],
    'the call fails: undefined',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: 'NaN' }],
    'the call fails: NaN',
  ),
  winList(
    {},
    [{ file: 'powershell.exe', args: PSARGS(WINDOWS_LIST_SCRIPT), code: 0, stdout: '["\\\\' }],
    'the call fails: cut escape',
  ),
]

const NSS_REF = { source: 'nss', dir: `${NSS_HOME}/.pki/nssdb`, nickname: 'Alice Signer' }
const pk12 = (extra: Record<string, unknown>, pw: string[] = []) => ({
  file: 'pk12util',
  args: [
    '-o',
    '<scratch>/identity.p12',
    '-d',
    DB,
    '-n',
    'Alice Signer',
    '-w',
    '<scratch>/export-pw',
    ...pw,
  ],
  ...extra,
})
const opening = (extra: Record<string, unknown>, note?: string): Case => ({
  args: [{ platform: 'linux', home: NSS_HOME, certs: CERTS, ref: NSS_REF, ...extra }],
  ...(note ? { note } : {}),
})
const WIN_REF = { source: 'windows', thumbprint: sha(0xab) }
const chainRule = (extra: Record<string, unknown>) => ({
  file: 'powershell.exe',
  args: PSARGS(WINDOWS_CHAIN_SCRIPT),
  ...extra,
})
const signRule = (extra: Record<string, unknown>) => ({
  file: 'powershell.exe',
  args: PSARGS(WINDOWS_SIGN_SCRIPT),
  ...extra,
})
const winOpen = (extra: Record<string, unknown>, note?: string): Case =>
  opening({ platform: 'win32', ref: WIN_REF, ...extra }, note)
const CHAIN_OUT = JSON.stringify([derB64('rsa-valid'), derB64('rsa-late')])

const openCases: Case[] = [
  opening(
    { rules: [pk12({ code: 0, writeOut: 'deadbeef00' })] },
    'exported through pk12util into memory',
  ),
  opening(
    {
      storePassword: 'open sesame',
      rules: [pk12({ code: 0, writeOut: 'cafe' }, ['-k', '<scratch>/store-pw'])],
    },
    'with the store password in a file',
  ),
  opening({ rules: [pk12({ code: 0, missing: true })] }, 'pk12util is not installed'),
  opening(
    { rules: [pk12({ code: 1, stderr: 'pk12util: PKCS12 Export: authentication failed' })] },
    'the store is locked',
  ),
  opening(
    { rules: [pk12({ code: 1, stderr: 'pk12util: the key cannot be exported' })] },
    'the key does not export',
  ),
  opening({ rules: [pk12({ code: 0 })] }, 'a success that wrote no file: the read fails'),
  opening({ platform: 'darwin', rules: [] }, 'macOS is not offered'),
  winOpen(
    { rules: [chainRule({ code: 0, stdout: CHAIN_OUT })] },
    'the Windows store signs in place: the chain',
  ),
  winOpen(
    {
      digest: 'deadbeef',
      rules: [
        chainRule({ code: 0, stdout: CHAIN_OUT }),
        signRule({ code: 0, stdout: 'AAECAw==\n' }),
      ],
    },
    'and signs a digest',
  ),
  winOpen(
    {
      digest: 'deadbeef',
      rules: [chainRule({ code: 0, stdout: CHAIN_OUT }), signRule({ code: 1, stdout: 'AAECAw==' })],
    },
    'the signature fails',
  ),
  winOpen(
    {
      digest: 'deadbeef',
      rules: [chainRule({ code: 0, stdout: CHAIN_OUT }), signRule({ code: 0, stdout: '  ' })],
    },
    'an empty signature',
  ),
  winOpen(
    {
      digest: '00ff',
      rules: [chainRule({ code: 0, stdout: CHAIN_OUT }), signRule({ code: 1, missing: true })],
    },
    'PowerShell is gone by then',
  ),
  winOpen(
    { ref: { source: 'windows', thumbprint: 'nothex' }, rules: [] },
    'a thumbprint that is not one',
  ),
  winOpen({ rules: [chainRule({ code: 0, missing: true })] }, 'PowerShell is not there'),
  winOpen({ rules: [chainRule({ code: 1 })] }, 'the chain cannot be built'),
  winOpen({ rules: [chainRule({ code: 0, stdout: '{broken' })] }, 'the chain is broken JSON'),
  winOpen({ rules: [chainRule({ code: 0, stdout: '[]' })] }, 'an empty chain'),
  winOpen(
    { rules: [chainRule({ code: 0, stdout: '\ufeff' + JSON.stringify(derB64('ec')) })] },
    'one certificate with a byte order mark',
  ),
  winOpen({ rules: [] }, 'no rule at all'),
]

const storeErrorCases: Case[] = [
  { args: ['cert-password'] },
  { args: ['cert-store-locked'] },
  { args: ['cert-invalid'] },
]

const runCases: Case[] = [
  { args: ['/bin/sh', ['-c', 'printf out; printf err >&2; exit 0']], note: 'output of both kinds' },
  { args: ['/bin/sh', ['-c', 'printf out; exit 3']], note: 'an exit code' },
  { args: ['/bin/sh', ['-c', 'kill -9 $$']], note: 'killed by a signal: code 1' },
  {
    args: ['/bin/sh', ['-c', 'printf %s "$B4_PDF_VAR"'], { B4_PDF_VAR: 'from the call \u00e9' }],
    note: 'variables added to the environment',
  },
  { args: ['/bin/sh', ['-c', 'cat; printf done']], note: 'stdin is closed' },
  { args: ['$DIR/no-such-tool', []], note: 'the file does not exist: missing' },
  {
    args: ['$DIR/not-executable', []],
    files: { 'not-executable': { text: '#!/bin/sh\n', mode: 0o644 } },
    note: 'permission denied is not missing',
  },
  { args: ['/bin/sh', ['-c', 'printf "\\303\\251\\377x"']], note: 'bytes that are not UTF-8' },
]

// ---- wasm-path, ocr ------------------------------------------------------------------------------------------------------

const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', ...extra })
const wasm = (files: Case['files'], resources: string | null = '/res', note?: string): Case => ({
  args: [{ dir: '$DIR', resources }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})

const PDFIUM_PKG = {
  'node_modules/@embedpdf/pdfium/package.json': pkg('@embedpdf/pdfium'),
  'node_modules/@embedpdf/pdfium/pdfium.wasm': 'w',
}
const pdfiumCases: Case[] = [
  wasm(PDFIUM_PKG, '/res', 'installed: the package file'),
  wasm(undefined, '/res', 'not installed: the packaged path'),
  wasm(undefined, null, 'not installed and no resources path'),
  wasm(undefined, '', 'an empty resources path'),
  wasm(
    {
      'node_modules/@embedpdf/pdfium/package.json': pkg('@embedpdf/pdfium', {
        exports: { '.': './index.js' },
      }),
      'node_modules/@embedpdf/pdfium/pdfium.wasm': 'w',
    },
    '/res',
    'sealed by an exports map',
  ),
  wasm(
    { 'node_modules/@embedpdf/pdfium/package.json': pkg('@embedpdf/pdfium') },
    '/res',
    'installed without the file',
  ),
]

const QPDF_PKG = {
  'node_modules/@neslinesli93/qpdf-wasm/package.json': pkg('@neslinesli93/qpdf-wasm', {
    main: 'dist/qpdf.js',
  }),
  'node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.js': 'x',
}
const qpdfCases: Case[] = [
  wasm(QPDF_PKG, '/res', 'next to the package entry'),
  wasm(undefined, '/res', 'not installed'),
  wasm(
    {
      'node_modules/@neslinesli93/qpdf-wasm/package.json': pkg('@neslinesli93/qpdf-wasm', {
        main: 'dist/qpdf.js',
      }),
    },
    '/res',
    'the entry file is missing',
  ),
  wasm(undefined, null, 'not installed and no resources path'),
]

const hbCases: Case[] = [
  wasm(
    {
      'node_modules/harfbuzzjs/package.json': pkg('harfbuzzjs', { main: 'index.js' }),
      'node_modules/harfbuzzjs/index.js': 'x',
      'node_modules/harfbuzzjs/hb-subset.wasm': 'w',
    },
    '/res',
    'an old harfbuzzjs: at the package root',
  ),
  wasm(
    {
      'node_modules/harfbuzzjs/package.json': pkg('harfbuzzjs', {
        exports: { '.': './dist/index.js' },
      }),
      'node_modules/harfbuzzjs/dist/index.js': 'x',
      'node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm': 'w',
    },
    '/res',
    'a new one: sealed, the wasm beside the entry',
  ),
  wasm(
    {
      'node_modules/harfbuzzjs/package.json': pkg('harfbuzzjs', {
        exports: { '.': './dist/index.js' },
      }),
      'node_modules/harfbuzzjs/dist/index.js': 'x',
    },
    '/res',
    'a new one without the wasm',
  ),
  wasm(undefined, '/res', 'not installed'),
  wasm(undefined, null, 'not installed and no resources path'),
]

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const OCR_JSON =
  '{"lines":[{"t":"Hello","c":0.9,"b":[0.1,0.2,0.3,0.4],"chars":[{"t":"H","b":[0.1,0.2,0.15,0.4]},{"t":"e","b":[0.15,0.2,0.2,0.4]}]},{"t":"World \u00e9","c":0.5,"b":[0,0,1,1]},{"t":"","c":1,"b":[0.5,0.5,0.6,0.6],"chars":[]}],"paper":0.9}'
const helper = (output: string, extra = ''): Case['files'] => ({
  'res/ocr/vision-ocr': {
    text: `#!/bin/sh\ncat > "$(dirname "$0")/in.bin"\n${extra}printf '%s' '${output}'\n`,
    mode: 0o755,
  },
})
const ocr = (
  resources: string | null,
  png: string,
  files?: Case['files'],
  note?: string,
): Case => ({
  args: [{ resources, png, here: mainDir }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})

const ocrCases: Case[] = [
  ocr('$DIR/res', PNG, helper(OCR_JSON), 'lines with boxes and characters'),
  ocr(
    '$DIR/res',
    'iVBO Rw0K\nGgo-_w',
    helper('{"lines":[]}'),
    'a base64 text with white space and the URL alphabet',
  ),
  ocr('$DIR/res', '', helper('{"lines":[]}'), 'an empty image'),
  ocr(
    '$DIR/res',
    PNG,
    helper('\ufeff{"lines":[{"t":"bom","c":1,"b":[0,0,1,1]}]}'),
    'a byte order mark before the JSON',
  ),
  ocr(
    '$DIR/res',
    PNG,
    helper(OCR_JSON, 'exit 1\n'),
    'the helper fails: no lines, the viewer moves on',
  ),
  ocr('$DIR/res', PNG, helper('not json'), 'an answer that is not JSON'),
  ocr('$DIR/res', PNG, helper('{"paper":1}'), 'no lines'),
  ocr('$DIR/res', PNG, helper('{"lines":{"t":"x"}}'), 'lines that are no list'),
  ocr('$DIR/res', PNG, helper('null'), 'null: a TypeError'),
  ocr('$DIR/res', PNG, helper('5'), 'a number has no lines'),
  ocr('$DIR/res', PNG, helper('{"lines":[{"t":"x","c":1}]}'), 'a line without a box'),
  ocr('$DIR/res', PNG, helper('{"lines":[null]}'), 'a null line'),
  ocr(
    '$DIR/res',
    PNG,
    helper('{"lines":[{"t":"x","c":1,"b":[0,0,1]}]}'),
    'a box with three numbers',
  ),
  ocr('$DIR/res', PNG, helper('{"lines":[{"c":1,"b":"abcd"}]}'), 'a box that is text'),
  ocr(
    '$DIR/res',
    PNG,
    helper('{"lines":[{"t":"x","c":1,"b":[0,0,1,1],"chars":"abc"}]}'),
    'characters that are no list',
  ),
  ocr(
    '$DIR/res',
    PNG,
    helper('{"lines":[{"t":"x","c":1,"b":[0,0,1,1],"chars":[null]}]}'),
    'a null character',
  ),
  ocr(
    '$DIR/res',
    PNG,
    helper('{"lines":[{"t":"x","c":1,"b":[0,0,1,1],"chars":[{"t":"x"}]}]}'),
    'a character without a box',
  ),
  ocr(
    '$DIR/res',
    PNG,
    { 'res/ocr/vision-ocr': { text: '#!/bin/sh\nprintf x\n', mode: 0o644 } },
    'a helper that cannot run',
  ),
  ocr('$DIR/res', PNG, undefined, 'no helper'),
  ocr(null, PNG, undefined, 'no resources folder'),
]

// ---- the cases of the functions that take more than a value ------------------------------------------------------------

const asPdfium = (m: FakePdfium): Pdfium => m as unknown as Pdfium

const nearlyCases: Case[] = [
  { args: [bitmapHex(60, 80), 60, 80, null], note: 'white' },
  { args: [bitmapHex(60, 80, specks(5, 13)), 60, 80, null], note: 'a few specks' },
  { args: [bitmapHex(60, 80, specks(40, 13)), 60, 80, null], note: 'too much ink' },
  {
    args: [bitmapHex(200, 200, [[50, 50, 56, 54, 0]]), 200, 200, null],
    note: 'a stroke in one cell: little ink, but dense',
  },
  {
    args: [
      bitmapHex(60, 80, [
        [0, 0, 1, 80, 0],
        [59, 0, 60, 80, 0],
        [0, 0, 60, 1, 0],
      ]),
      60,
      80,
      null,
    ],
    note: 'ink in the margins only',
  },
  {
    args: [
      bitmapHex(
        60,
        80,
        specks(25, 13).map(([a, b, c, d]) => [a!, b!, c!, d!, 160]),
      ),
      60,
      80,
      null,
    ],
    note: 'gray 160 is not ink',
  },
  {
    args: [
      bitmapHex(
        60,
        80,
        specks(25, 13).map(([a, b, c, d]) => [a!, b!, c!, d!, 159]),
      ),
      60,
      80,
      null,
    ],
    note: 'gray 159 is',
  },
  { args: ['', 0, 0, null], note: 'no area' },
  {
    args: [bitmapHex(60, 80, [], 248, 0), 60, 80, 248],
    note: 'a padded stride: the padding is not read',
  },
  {
    args: [bitmapHex(60, 80).slice(0, 200), 60, 80, null],
    note: 'a buffer too short: missing pixels are not ink',
  },
  {
    args: [bitmapHex(10, 10, [[4, 4, 5, 5, 0]]), 10, 10, null],
    note: 'a tiny bitmap with one dark pixel',
  },
]

const shrinkCases: Case[] = [
  { args: [patternHex(8, 4), 8, 4, 32, 4], note: 'half size' },
  { args: [patternHex(8, 4, 40), 8, 4, 40, 4], note: 'a padded stride' },
  { args: [patternHex(10, 10), 10, 10, 40, 100], note: 'never scaled up' },
  { args: [patternHex(5, 3), 5, 3, 20, 2], note: 'rounded to 2 by 1' },
  { args: [patternHex(1, 1), 1, 1, 4, 240], note: 'one pixel' },
  { args: [patternHex(3, 300), 3, 300, 12, 100], note: 'a tall strip: at least one pixel wide' },
  { args: [patternHex(7, 7), 7, 7, 28, 3], note: 'cells that do not divide evenly' },
  {
    args: [patternHex(4, 4).slice(0, 40), 4, 4, 16, 2],
    note: 'a short buffer: missing pixels average to 0',
  },
]

const removeMatchingCases: Case[] = [
  {
    args: [{ pages: [{ annots: [HL] }] }, 0, [del(0, 5, 'highlight', [10, 20, 110, 40])]],
    note: 'by object number',
  },
  {
    args: [{ pages: [{ annots: [HL] }] }, 0, [del(0, 77, 'highlight', [10, 20, 110, 40])]],
    note: 'by identity',
  },
  {
    args: [{ pages: [{ annots: [HL] }] }, 0, [del(0, 5, 'underline', [10, 20, 110, 40])]],
    note: 'nothing matches',
  },
  {
    args: [
      { pages: [{ annots: [HL, NOTE] }] },
      0,
      [
        del(0, 5, 'highlight', [10, 20, 110, 40]),
        del(0, 6, 'note', [200, 310, 260, 325], 'hello'),
        del(0, 6, 'note', [200, 310, 260, 325], 'hello'),
      ],
    ],
    note: 'several; the last is already gone',
  },
  { args: [{ pages: [{ annots: [HL] }] }, 0, []], note: 'no deletes' },
]

const atomicCases: Case[] = [
  { args: ['$DIR/out.pdf', '%PDF-1.7 \u00e9 \u{1F600}'], note: 'a new file' },
  { args: ['$DIR/out.pdf', 'new'], files: { 'out.pdf': 'old content' }, note: 'replaced' },
  { args: ['$DIR/out.pdf', ''], note: 'empty' },
  { args: ['$DIR/no/such/out.pdf', 'x'], note: 'no folder' },
  { args: ['$DIR/d', 'x'], files: { 'd/keep': 'x' }, note: 'a folder is the target' },
]

const isValidCases = pagesCases([
  [1, 0],
  [0, 0],
  [-1, 0],
  [1.5, 0],
  ['1', 0],
  [9007199254740991, 0],
  [9007199254740992, 0],
  [null, 0],
  [true, 0],
  [[1], 0],
  [1e21, 0],
]).map((c) => ({ args: [c.args[0]] }))
const hasValidCases = pagesCases([
  [[1, 2, 3], 3],
  [[1, 2, 2], 3],
  [[1, 2], 3],
  [[], 0],
  ['x', 1],
  [[0], 1],
  [[1, '2'], 2],
  [[2, 1], 2],
  [null, 0],
  [[1.5], 1],
  [[1, 2], null as unknown as number],
])

const saveAsCases: Case[] = [
  { args: ['/a/b.png', 3] },
  { args: ['/a/b.PNG', 1] },
  { args: ['/a/b.png', 0] },
  { args: ['rel/b.png', 2], note: 'not absolute' },
  { args: ['/a/b.jpg', 2], note: 'not a PNG' },
  { args: ['/a/b.png', 2.7] },
  { args: ['/a/.png', 2] },
  { args: ['/a/b.png', 100] },
  { args: ['/a/b.png', 4294967296], note: 'more than an array can hold' },
  { args: ['/a/b.png\n', 2], note: 'a line break after the extension' },
]

// ---- the group ---------------------------------------------------------------------------------------------------------------

const hexOfBuffer = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const u8 = (hex: unknown): Uint8Array => new Uint8Array(Buffer.from(hex as string, 'hex'))
const bytesInfo = (b: Buffer | null) => (b ? { len: b.length, sha1: sha1(b) } : null)

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')
const maskScratch = (text: string): string =>
  text.replace(/\S*seuoffice-cert-[A-Za-z0-9]{6}/g, '<scratch>')

/** the call, with a temp file's random name in a thrown message written `<hex>` */
async function masked<T>(
  run: () => T | Promise<T>,
  mask: (text: string) => string = maskTmp,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) error.message = mask(error.message)
    throw error
  }
}

let hbCurrent: FakeHb | null = null
const hbExports = new Proxy(
  {},
  {
    get(_target, prop) {
      const hb = hbCurrent
      if (!hb) return undefined
      const value = Reflect.get(hb, prop)
      return typeof value === 'function' ? value.bind(hb) : value
    },
  },
)

async function withHb<T>(world: HbWorld, cx: TsContext, run: () => Promise<T>): Promise<T> {
  const fake = new FakeHb(world)
  hbCurrent = fake
  const real = WebAssembly.instantiate
  const patched: unknown = async () => ({ instance: { exports: hbExports } })
  WebAssembly.instantiate = patched as typeof WebAssembly.instantiate
  try {
    return await run()
  } finally {
    WebAssembly.instantiate = real
    hbCurrent = null
    for (const line of fake.log) cx.log(line)
  }
}

/** the wasm paths read process.resourcesPath, which Electron sets and Node does not */
const resources = {
  set(value: string | null): void {
    if (value === null) delete proc.resourcesPath
    else proc.resourcesPath = value
  },
  get(): string | undefined {
    return proc.resourcesPath
  },
}

let imports = 0

async function wasmPath(
  a: unknown[],
  cx: TsContext,
  name: 'pdfiumWasmPath' | 'qpdfWasmPath' | 'hbSubsetWasmPath',
) {
  const spec = a[0] as { resources: string | null }
  const copy = join(cx.dir, 'wasm-path.ts')
  copyFileSync(join(mainDir, 'wasm-path.ts'), copy)
  const saved = resources.get()
  resources.set(spec.resources)
  try {
    const mod = await import(`${pathToFileURL(copy).href}?run=${++imports}`)
    // the copy sits in the case's folder, which Node resolves through symlinks
    return String(mod[name]()).split(realpathSync(cx.dir)).join(cx.dir)
  } finally {
    resources.set(saved ?? null)
    rmSync(copy)
  }
}

async function ocrOf(a: unknown[]) {
  const spec = a[0] as { resources: string | null; png: string }
  const saved = resources.get()
  resources.set(spec.resources)
  // a copy of ocr.ts next to the original: the module keeps its engine in a variable, so every
  // case needs a module of its own (a query on the import does not make tsx load it again)
  const copy = join(mainDir, `ocr-b4pdf-${process.pid}-${++imports}.ts`)
  copyFileSync(join(mainDir, 'ocr.ts'), copy)
  try {
    const mod = await import(pathToFileURL(copy).href)
    return await mod.ocrPagePng(spec.png)
  } finally {
    resources.set(saved ?? null)
    rmSync(copy, { force: true })
  }
}

// the note service ----------------------------------------------------------------------------------------------------------

interface HostMode {
  throws?: string
  plain?: boolean
}
type Mode = boolean | 'missing' | HostMode

async function noteService(cfg: Record<string, any>, cx: TsContext): Promise<unknown[]> {
  const q = JSON.stringify
  const log = (line: string) => cx.log(line)
  const boom = (message: string, plain = false): never => {
    // a value that is no Error is read as text
    throw plain ? message : new Error(message)
  }
  const answer = (mode: Mode | undefined): boolean => {
    if (mode === undefined) return true
    if (typeof mode === 'boolean') return mode
    if (mode === 'missing') return true
    return boom(mode.throws ?? '', mode.plain)
  }
  const stored = cfg.store ?? {}
  const store = {
    readNoteLinks: async () => {
      log('store.readNoteLinks()')
      if (stored.readThrows) boom(stored.readThrows)
      const links = Object.create(null) as Record<
        string,
        { notePath: string; docHash: string; updatedAt: number }
      >
      for (const key of stored.links ?? []) links[key] = { notePath: '', docHash: '', updatedAt: 0 }
      return { version: 1 as const, links }
    },
    findNoteLink: async (pdfPath: string, docHash: string) => {
      log(`store.findNoteLink(${q(pdfPath)},${q(docHash)})`)
      if (stored.findThrows) boom(stored.findThrows)
      return stored.found ? { ...stored.found, pdfKey: 'k', docHash: '', updatedAt: 0 } : null
    },
    setNoteLink: async (pdfPath: string, link: { notePath: string; docHash: string }) => {
      log(`store.setNoteLink(${q(pdfPath)},${q(link.notePath)},${q(link.docHash)})`)
      if (stored.setThrows) boom(stored.setThrows)
    },
    updateNoteLinkDocHash: async (pdfPath: string, docHash: string) => {
      log(`store.updateNoteLinkDocHash(${q(pdfPath)},${q(docHash)})`)
      if (stored.updateThrows) boom(stored.updateThrows)
      return true
    },
  }
  const hostCfg = cfg.host ?? {}
  let picks = 0
  let service: ReturnType<typeof createNoteLinkService> | null = null
  const deps: NoteLinkDeps = {
    store: () => {
      log('deps.store()')
      if (cfg.storeThrows) boom(cfg.storeThrows)
      return store as never
    },
    hashFile: async (path: string) => {
      log(`deps.hashFile(${q(path)})`)
      if (cfg.hashThrows) boom(cfg.hashThrows)
      return cfg.hash ?? 'h0'
    },
    isUntitled: (path: string) => {
      log(`deps.isUntitled(${q(path)})`)
      if (cfg.untitledThrows) boom(cfg.untitledThrows)
      return (cfg.untitled ?? []).includes(path)
    },
    pickNotePath: async (owner: number, defaultPath: string) => {
      log(`deps.pickNotePath(${owner},${q(defaultPath)})`)
      if (cfg.pickThrows) boom(cfg.pickThrows)
      if (cfg.pickReenter) {
        const again = cfg.pickReenter as { owner?: number; pdfPath: string }
        let shown: string
        try {
          shown = JSON.stringify(await service!.open(again.owner ?? owner, again.pdfPath, {}))
        } catch (error) {
          shown = `threw ${error instanceof Error ? error.message : String(error)}`
        }
        log(`reentrant open: ${shown}`)
      }
      const at = picks++
      return (cfg.pick ?? [])[at] ?? null
    },
    noteWord: () => {
      log('deps.noteWord()')
      if (cfg.noteWordThrows) boom(cfg.noteWordThrows)
      return cfg.noteWord ?? 'Note'
    },
    host: () => {
      log('deps.host()')
      if (cfg.hostThrows) boom(cfg.hostThrows)
      return {
        ...(hostCfg.open === 'missing'
          ? {}
          : {
              openNote: async (path: string) => {
                log(`host.openNote(${q(path)})`)
                return answer(hostCfg.open)
              },
            }),
        ...(hostCfg.insert === 'missing'
          ? {}
          : {
              insertIntoNote: async (path: string, text: string) => {
                log(`host.insertIntoNote(${q(path)},${q(text)})`)
                return answer(hostCfg.insert)
              },
            }),
      }
    },
    ...(cfg.createFile === undefined || cfg.createFile === 'default'
      ? {}
      : {
          createNoteFile: async (path: string, text: string) => {
            log(`deps.createNoteFile(${q(path)},${q(text)})`)
            return answer(cfg.createFile)
          },
        }),
    ...(cfg.fileExists === undefined || cfg.fileExists === 'default'
      ? {}
      : {
          fileExists: async (path: string) => {
            log(`deps.fileExists(${q(path)})`)
            return answer(cfg.fileExists)
          },
        }),
    platform: cfg.platform,
  }
  service = createNoteLinkService(deps)
  const svc = service
  const results: unknown[] = []
  for (const call of cfg.calls as {
    op: string
    owner?: number
    pdfPath: string | null
    request?: unknown
  }[]) {
    try {
      if (call.op === 'open') {
        results.push(
          await svc.open(call.owner ?? 1, call.pdfPath, parseNoteOpenRequest(call.request)),
        )
      } else if (call.op === 'insert') {
        results.push(await svc.insert(call.owner ?? 1, call.pdfPath, call.request as never))
      } else {
        const warn = console.warn
        console.warn = (label: string, err: unknown) =>
          log(`warn ${label} ${err instanceof Error ? err.message : String(err)}`)
        try {
          await svc.afterSave(call.pdfPath as string)
        } finally {
          console.warn = warn
        }
        results.push(null)
      }
    } catch (error) {
      results.push({ threw: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

// the system store -------------------------------------------------------------------------------------------------------------

interface RunRule {
  file: string
  args: string[]
  code?: number
  stdout?: string
  stderr?: string
  missing?: boolean
  writeOut?: string
}

function scriptedEnv(
  cfg: Record<string, any>,
  cx: TsContext,
  state: { exportPw: string | null },
): SystemStoreEnv {
  const run: Runner = async (file, args, options) => {
    const maskedArgs = args.map(maskScratch)
    cx.log(
      `run ${file} ${JSON.stringify(maskedArgs)} ${options?.env ? JSON.stringify(options.env) : 'null'}`,
    )
    args.forEach((a, i) => {
      if ((a === '-f' || a === '-w' || a === '-k') && args[i + 1] !== undefined) {
        let content: string
        try {
          content = readFileSync(args[i + 1]!, 'utf8')
        } catch {
          content = ''
        }
        if (a === '-w') {
          state.exportPw = content.trimEnd()
          cx.log(`file ${a} export-pw ${/^[A-Za-z0-9_-]{24}\n$/.test(content)}`)
        } else {
          cx.log(`file ${a} ${JSON.stringify(content)}`)
        }
      }
    })
    const rule = (cfg.rules as RunRule[] | undefined)?.find(
      (r) =>
        r.file === file &&
        r.args.length === maskedArgs.length &&
        r.args.every((x, i) => x === maskedArgs[i]),
    )
    if (!rule) {
      cx.log('no rule')
      return { code: 127, stdout: '', stderr: 'no rule', missing: false }
    }
    const out = args.indexOf('-o')
    if (rule.writeOut !== undefined && out >= 0 && args[out + 1] !== undefined) {
      writeFileSync(args[out + 1]!, Buffer.from(rule.writeOut, 'hex'))
    }
    return {
      code: rule.code ?? 0,
      stdout: rule.stdout ?? '',
      stderr: rule.stderr ?? '',
      missing: rule.missing ?? false,
    }
  }
  return {
    platform: cfg.platform,
    home: cfg.home,
    run,
    now: () => new Date(cfg.now ?? cx.now),
  }
}

export const group: Group = {
  'annot-delete.applyAnnotDeletes': {
    ts: (a, cx) =>
      withPdfium(a[0] as World, cx, async () =>
        utf8(
          await applyAnnotDeletes(bytesOf(a[1]), a[2] as Parameters<typeof applyAnnotDeletes>[1]),
        ),
      ),
    cases: deleteCases,
  },
  'annot-delete.removeMatchingAnnots': {
    ts: (a, cx) =>
      withPdfium(a[0] as World, cx, (m) => {
        const page = m._FPDF_LoadPage(1, a[1] as number)
        removeMatchingAnnots(asPdfium(m), page, a[2] as Parameters<typeof removeMatchingAnnots>[2])
        return undefined
      }),
    cases: removeMatchingCases,
  },
  'annot-flatten.flattenAnnotsBytes': {
    ts: (a, cx) =>
      withPdfium(a[0] as World, cx, async () => utf8(await flattenAnnotsBytes(bytesOf(a[1])))),
    cases: flattenCases,
  },
  'pdf/atomic-write.writePdfAtomically': {
    ts: (a) => masked(() => writePdfAtomically(a[0] as string, bytesOf(a[1]))),
    cases: atomicCases,
  },
  'blank-pages.RENDER_LONG_SIDE': constant(RENDER_LONG_SIDE),
  'blank-pages.THUMB_LONG_SIDE': constant(THUMB_LONG_SIDE),
  'blank-pages.MAX_THUMBS': constant(MAX_THUMBS),
  'blank-pages.isNearlyWhite': {
    ts: (a) =>
      isNearlyWhite(u8(a[0]), a[1] as number, a[2] as number, (a[3] as number | null) ?? undefined),
    cases: nearlyCases,
  },
  'blank-pages.shrinkBitmap': {
    ts: (a) => {
      const t = shrinkBitmap(
        u8(a[0]),
        a[1] as number,
        a[2] as number,
        a[3] as number,
        a[4] as number,
      )
      return { width: t.width, height: t.height, bgra: hexOfBuffer(t.bgra) }
    },
    cases: shrinkCases,
  },
  'blank-pages.findBlankPages': {
    ts: (a, cx) => {
      const fake = new FakePdfium(a[0] as World)
      const progress: string[] = []
      try {
        const result = findBlankPages(
          fake as unknown as BlankPagesPdfium,
          1,
          a[1] ? (done, total) => progress.push(`progress(${done},${total})`) : undefined,
        )
        return {
          pageCount: result.pageCount,
          candidates: result.candidates.map((c) => ({
            page: c.page,
            reason: c.reason,
            thumb: c.thumb
              ? {
                  width: c.thumb.width,
                  height: c.thumb.height,
                  len: c.thumb.bgra.length,
                  sha1: sha1(c.thumb.bgra),
                }
              : null,
          })),
        }
      } finally {
        for (const line of fake.log) cx.log(line)
        for (const line of progress) cx.log(line)
      }
    },
    cases: blankCases,
  },
  'disk-watch.DISK_WATCH_MAX_WAITS': constant(DISK_WATCH_MAX_WAITS),
  'disk-watch.DISK_WATCH_MISSING_CONFIRMATIONS': constant(DISK_WATCH_MISSING_CONFIRMATIONS),
  'disk-watch.endsLikeWholePdf': { ts: (a) => endsLikeWholePdf(u8(a[0])), cases: endsCases },
  'disk-watch.watchDiskFile': {
    ts: (a, cx) => watchSteps(a[0] as WatchSpec, cx),
    cases: watchCases,
  },
  'pdf/export-images.isValidExportPageNumber': {
    ts: (a) => isValidExportPageNumber(a[0]),
    cases: isValidCases,
  },
  'pdf/export-images.hasValidExportPageNumbers': {
    ts: (a) => hasValidExportPageNumbers(a[0], a[1] as number),
    cases: hasValidCases,
  },
  'pdf/export-images.buildExportImagePaths': {
    ts: (a) =>
      buildExportImagePaths(a[0] as string, a[1], a[2] as unknown[], a[3] as 'png' | 'jpg'),
    cases: exportCases,
  },
  'pdf/export-images.buildSaveAsImagePaths': {
    ts: (a) => buildSaveAsImagePaths(a[0] as string, a[1] as number),
    cases: saveAsCases,
  },
  'font-cmap.fontCoversText': {
    ts: (a) => fontCoversText(Buffer.from(a[0] as string, 'hex'), a[1] as string),
    cases: cmapCases,
  },
  'font-locate.isTruetype': {
    ts: (a) => isTruetype(Buffer.from(a[0] as string, 'hex')),
    cases: truetypeCases,
  },
  'font-locate.findSystemFont': {
    ts: (a) => inFontHome(() => bytesInfo(findSystemFont(a[0] as string, a[1] as string))),
    cases: withFontHome(locateCases),
  },
  'font-locate.findFontCovering': {
    ts: (a) => inFontHome(() => bytesInfo(findFontCovering(a[0] as string))),
    cases: withFontHome(coveringCases),
  },
  'font-similar.os2Traits': {
    ts: (a) => os2Traits(a[0] === null ? null : Buffer.from(a[0] as string, 'hex')),
    cases: os2Cases,
  },
  'font-similar.sourceTraits': {
    ts: (a) =>
      sourceTraits(
        face(a[0] as ReturnType<typeof faceSpec>),
        (a[1] as 'ko' | 'ja' | 'zh' | 'latin' | null) ?? undefined,
      ),
    cases: sourceCases,
  },
  'font-similar.similarFontFor': {
    ts: (a) => {
      const found = inFontHome(() =>
        similarFontFor(
          face(a[0] as ReturnType<typeof faceSpec>),
          a[1] as string,
          a[2] ? { italic: true } : {},
        ),
      )
      return found
        ? {
            len: found.bytes.length,
            sha1: sha1(found.bytes),
            bold: found.bold,
            sourceBold: found.sourceBold,
          }
        : null
    },
    cases: withFontHome(similarCases),
  },
  'font-subset.identityCffCharset': {
    ts: (a) => Buffer.from(identityCffCharset(Buffer.from(a[0] as string, 'hex'))).toString('hex'),
    cases: cffCases,
  },
  'font-subset.subsetTtf': {
    ts: (a, cx) =>
      withHb(a[0] as HbWorld, cx, async () =>
        (await subsetTtf(Buffer.from(a[1] as string, 'hex'), a[2] as string)).toString('hex'),
      ),
    cases: subsetCases,
  },
  'generated-output.uniqueGeneratedPdfPath': {
    ts: (a) =>
      uniqueGeneratedPdfPath(
        a[0] as string,
        a[1] as string,
        a[2] ? (path) => (a[2] as string[]).includes(path) : undefined,
      ),
    cases: generatedCases,
  },
  'note-link.pdfLinkFromNote': {
    ts: (a) =>
      pdfLinkFromNote(
        a[0] as string,
        a[1] as string,
        (a[2] as NodeJS.Platform | null) ?? undefined,
      ),
    cases: linkCases,
  },
  'note-link.noteInsertText': {
    ts: (a) =>
      noteInsertText(
        a[0] as string,
        a[1] as string,
        a[2] as Parameters<typeof noteInsertText>[2],
        (a[3] as NodeJS.Platform | null) ?? undefined,
      ),
    cases: insertCases,
  },
  'note-link.parseNoteInsertRequest': {
    ts: (a) => parseNoteInsertRequest(a[0]),
    cases: parseInsertCases,
  },
  'note-link.parseNoteOpenRequest': {
    ts: (a) => parseNoteOpenRequest(a[0]),
    cases: openRequestCases,
  },
  'note-link.defaultNotePath': {
    ts: (a) =>
      defaultNotePath(
        a[0] as string,
        a[1] as string,
        (a[2] as NodeJS.Platform | null) ?? undefined,
      ),
    cases: notePathCases,
  },
  'note-link.NOTE_DIALOG_TEXT': constant(NOTE_DIALOG_TEXT),
  'note-link.noteDialogText': {
    ts: (a) => noteDialogText(a[0] as 'en', a[1] as 'noteWord'),
    cases: dialogCases,
  },
  'note-link.createNoteLinkService': {
    ts: (a, cx) => noteService(a[0] as Record<string, any>, cx),
    cases: serviceCases,
  },
  'ocr.ocrPagePng': { ts: (a) => ocrOf(a), cases: ocrCases },
  'read-text.readPdfText': {
    ts: (a, cx) =>
      withPdfium(a[0] as World, cx, () =>
        readPdfText(bytesOf(a[1]), a[2] as Parameters<typeof readPdfText>[1]),
      ),
    cases: readCases,
  },
  'redaction.MAX_REDACTION_REGIONS': constant(MAX_REDACTION_REGIONS),
  'redaction.validateRedactionRegions': {
    ts: (a) => validateRedactionRegions(a[0]),
    cases: validateCases,
  },
  'redaction.redactPdf': {
    ts: (a, cx) =>
      withPdfium(a[0] as World, cx, async () =>
        utf8(await redactPdf(bytesOf(a[1]), a[2] as never)),
      ),
    cases: redactCases,
  },
  'signature-store.MAX_SAVED_SIGNATURES': constant(MAX_SAVED_SIGNATURES),
  'signature-store.isSignatureData': { ts: (a) => isSignatureData(a[0]), cases: dataCases },
  'signature-store.sanitizeSignatures': {
    ts: (a) => sanitizeSignatures(a[0]),
    cases: sanitizeCases,
  },
  'signature-store.addSignature': {
    ts: (a, cx) =>
      addSignature(a[0] as never, a[1] as never, (a[2] as number | null) ?? cx.now).map((s, i) =>
        i === 0 ? { ...s, id: '<uuid>' } : s,
      ),
    cases: addCases,
  },
  'signature-store.removeSignature': {
    ts: (a) => removeSignature(a[0] as never, a[1] as string),
    cases: removeCases,
  },
  'signature-store.loadSignatures': { ts: (a) => loadSignatures(a[0] as string), cases: loadCases },
  'signature-store.saveSignatures': {
    ts: (a) => saveSignatures(a[0] as string, a[1] as never),
    cases: saveCases,
  },
  'system-certificates.SystemStoreError': {
    ts: (a) => {
      const e = new SystemStoreError(a[0] as 'cert-invalid')
      return { code: e.code, message: e.message }
    },
    cases: storeErrorCases,
  },
  'system-certificates.runCommand': {
    ts: (a) =>
      runCommand(
        a[0] as string,
        a[1] as string[],
        a[2] ? { env: a[2] as Record<string, string> } : undefined,
      ),
    cases: runCases,
  },
  'system-certificates.nssDatabaseDirs': {
    ts: (a) => nssDatabaseDirs(a[0] as string),
    cases: dirsCases,
  },
  'system-certificates.parseNssKeyList': {
    ts: (a) => parseNssKeyList(a[0] as string),
    cases: keyListCases,
  },
  'system-certificates.WINDOWS_LIST_SCRIPT': constant(WINDOWS_LIST_SCRIPT),
  'system-certificates.WINDOWS_CHAIN_SCRIPT': constant(WINDOWS_CHAIN_SCRIPT),
  'system-certificates.WINDOWS_SIGN_SCRIPT': constant(WINDOWS_SIGN_SCRIPT),
  'system-certificates.parseWindowsCertificates': {
    ts: (a) => {
      try {
        return parseWindowsCertificates(a[0] as string).map((r) => ({
          thumbprint: r.thumbprint,
          der: r.der.toString('hex'),
        }))
      } catch (error) {
        if (error instanceof SyntaxError) return { syntaxError: error.message }
        throw error
      }
    },
    cases: winParseCases,
  },
  'system-certificates.parseWindowsChain': {
    ts: (a) => {
      try {
        return parseWindowsChain(a[0] as string).map((b) => b.toString('hex'))
      } catch (error) {
        if (error instanceof SyntaxError) return { syntaxError: error.message }
        throw error
      }
    },
    cases: winChainCases,
  },
  'system-certificates.listSystemCertificates': {
    ts: (a, cx) => {
      const cfg = a[0] as Record<string, any>
      return masked(
        () => listSystemCertificates(cfg.storePassword, scriptedEnv(cfg, cx, { exportPw: null })),
        maskScratch,
      )
    },
    cases: listCases,
  },
  'system-certificates.openSystemSigner': {
    ts: (a, cx) => {
      const cfg = a[0] as Record<string, any>
      const state = { exportPw: null as string | null }
      return masked(async () => {
        const identity = await openSystemSigner(
          cfg.ref,
          cfg.storePassword,
          scriptedEnv(cfg, cx, state),
        )
        if (identity.kind === 'p12') {
          const ok =
            /^[A-Za-z0-9_-]{24}$/.test(identity.password) && state.exportPw === identity.password
          return { kind: 'p12', p12: hexOfBuffer(identity.p12), passwordOk: ok }
        }
        const out: Record<string, unknown> = {
          kind: 'in-place',
          chainDer: identity.signer.chainDer.map((d) => Buffer.from(d).toString('hex')),
        }
        if (typeof cfg.digest === 'string') {
          try {
            out.signature = Buffer.from(
              await identity.signer.signDigest(Buffer.from(cfg.digest, 'hex')),
            ).toString('hex')
          } catch (error) {
            out.signError = (error as SystemStoreError).code
          }
        }
        return out
      }, maskScratch)
    },
    cases: openCases,
  },
  'wasm-path.pdfiumWasmPath': {
    ts: (a, cx) => wasmPath(a, cx, 'pdfiumWasmPath'),
    cases: pdfiumCases,
  },
  'wasm-path.qpdfWasmPath': { ts: (a, cx) => wasmPath(a, cx, 'qpdfWasmPath'), cases: qpdfCases },
  'wasm-path.hbSubsetWasmPath': {
    ts: (a, cx) => wasmPath(a, cx, 'hbSubsetWasmPath'),
    cases: hbCases,
  },
}
