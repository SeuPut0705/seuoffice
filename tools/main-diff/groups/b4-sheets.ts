/**
 * Group `b4-sheets`: the Electron-free modules of apps/sheets/src/main, and the
 * two small pieces of packages/xlsx-gateway the sheets main process reads.
 *
 * Where two apps have a file of the same name the function is named
 * `sheets/<file>.<export>`. A class is a list of steps (`ops`) and answers one
 * entry per step. Numbers a spec writes as NaN reach Rust as `null`, which it
 * reads as NaN again. The sidecar client is driven by a fake process, fake
 * timers and a fake line reader that log each call as one log line; how a
 * request ended is recorded under its label (`outcomes`).
 */
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import readline from 'node:readline'
import { ZodError, z } from 'zod'
import { CSV_IMPORT_DEFAULT_LIMIT_MB } from '../../../packages/xlsx-gateway/src/gateway/csv-limits.ts'
import { legacyCsvCharsetFor } from '../../../packages/xlsx-gateway/src/shared/document-locale.ts'
import { atomicWriteFile } from '../../../apps/sheets/src/main/atomic-write.ts'
import { ShutdownLatch, closeGuardDecision } from '../../../apps/sheets/src/main/close-guard.ts'
import { refreshCsvDigest } from '../../../apps/sheets/src/main/csv-digest.ts'
import {
  delimitedImportLimit,
  setDelimitedImportLimit,
} from '../../../apps/sheets/src/main/csv-import-limit.ts'
import { legacyCsvCharset } from '../../../apps/sheets/src/main/document-locale.ts'
import { ImportRegistry } from '../../../apps/sheets/src/main/import-registry.ts'
import {
  evenPageRanges,
  stitchPlan,
  variantForPage,
} from '../../../apps/sheets/src/main/pdf-page-variants.ts'
import {
  CSS_PX_PER_INCH,
  MICRONS_PER_INCH,
  printOptionsFor,
} from '../../../apps/sheets/src/main/print-options.ts'
import {
  SaveAsExportTargets,
  resolveSheetsSaveAsPick,
  sheetsSaveAsFilters,
  sheetsSaveAsSuggestion,
} from '../../../apps/sheets/src/main/save-as-formats.ts'
import { SaveEditsTransferStore } from '../../../apps/sheets/src/main/save-edits-transfer.ts'
import {
  SAVE_FAILURE_LOG_FILE,
  SAVE_FAILURE_LOG_MAX_BYTES,
  appendSaveFailure,
  describeReopenFailure,
  reopenFailureNote,
  scrubDetail,
  sessionSourceFormat,
} from '../../../apps/sheets/src/main/save-failure-log.ts'
import { sessionAfterRename, xlsxSiblingOf } from '../../../apps/sheets/src/main/session-rename.ts'
import {
  continuedOpenOptions,
  sessionToContinue,
} from '../../../apps/sheets/src/main/session-reopen.ts'
import {
  PASTED_FILE_TTL_MS,
  cleanupExpiredPastedFiles,
  cleanupImportTempDirectory,
  cleanupSessionResources,
} from '../../../apps/sheets/src/main/temp-files.ts'
import { resolveWorkbookSave } from '../../../apps/sheets/src/main/workbook-save-resolve.ts'
import { XlsxSidecarClient } from '../../../apps/sheets/src/main/xlsx-sidecar-client.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

type Any = any

// apps/* is loaded as CommonJS and reads its own copy of @seuoffice/i18n: the
// language the spec sets must be set on that copy, not on an ES import's
const i18n = createRequire(import.meta.url)('@seuoffice/i18n') as {
  getRequestedLocale: () => string
  getUiLang: () => string
  setUiLang: (lang: string, requested?: string) => void
}

const str = (a: unknown[], i: number): string => a[i] as string

/** the cases of a function: one per argument list */
const each = (...lists: unknown[][]): Case[] => lists.map((args) => ({ args }))

/** a constant: its second case adds a file, so the two answers differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

/** the call, with a temp file's random name in a thrown message written `<hex>` */
async function masked<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) error.message = maskTmp(error.message)
    throw error
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// ---- atomic-write ----

const atomicWrite: Record<string, FnSpec> = {
  'sheets/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: [
      { args: ['$DIR/a.xlsx', 'new'] },
      { args: ['$DIR/a.xlsx', 'new'], files: { 'a.xlsx': 'old' } },
      { args: ['$DIR/a.xlsx', ''], files: { 'a.xlsx': 'old' }, note: 'empty data' },
      {
        args: ['$DIR/a.xlsx', 'new\u{1F600}'],
        files: { 'a.xlsx': { text: 'old', mode: 0o444 } },
        note: 'a read-only target is replaced',
      },
      {
        args: ['$DIR/a.xlsx', 'new'],
        files: { 'a.xlsx.unsaved.tmp': 'stale' },
        note: 'a stale rescue copy goes',
      },
      {
        args: ['$DIR/a.xlsx', 'new'],
        files: { 'a.xlsx': { dir: true } },
        note: 'a folder as target: rescue copy, then the error',
      },
      { args: ['$DIR/none/a.xlsx', 'new'], note: 'no folder' },
    ],
  },
}

// ---- close-guard ----

const latch = (a: unknown[]): unknown => {
  const l = new ShutdownLatch()
  return (a[0] as string[]).map((op) => {
    if (op === 'mark') {
      l.mark()
      return null
    }
    if (op === 'reset') {
      l.reset()
      return null
    }
    return l.active
  })
}

const closeGuard: Record<string, FnSpec> = {
  'close-guard.closeGuardDecision': {
    ts: (a) => closeGuardDecision(a[0] as Any),
    cases: each(
      [{ pendingEdits: 0, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: 3, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: 3, destroyed: true, shuttingDown: false }],
      [{ pendingEdits: 3, destroyed: false, shuttingDown: true }],
      [{ pendingEdits: 3, destroyed: true, shuttingDown: true }],
      [{ pendingEdits: -1, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: 0.5, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: -0, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: Number.NaN, destroyed: false, shuttingDown: false }],
      [{ pendingEdits: 1e300, destroyed: false, shuttingDown: false }],
    ),
  },
  'close-guard.ShutdownLatch': {
    ts: (a) => latch(a),
    cases: each(
      [[]],
      [['active']],
      [['active', 'mark', 'active']],
      [['mark', 'mark', 'active', 'reset', 'active', 'reset', 'active']],
      [['reset', 'active', 'mark', 'active']],
    ),
  },
}

// ---- csv-digest ----

const SRC = { path: '$DIR/conv/a.xlsx', csvSourcePath: '$DIR/a.csv' }

const csvDigest: Record<string, FnSpec> = {
  'csv-digest.refreshCsvDigest': {
    ts: (a) => {
      const sessions = new Map(a[0] as [string, Any][])
      refreshCsvDigest(sessions, str(a, 1), str(a, 2))
      return [...sessions]
    },
    cases: [
      {
        args: [
          [
            ['s1', SRC],
            ['s2', { path: '$DIR/other.xlsx' }],
            ['s3', { path: 'z', csvSourceSha: 'old', csvSourcePath: '$DIR/link.csv', tail: 1 }],
            ['s4', { csvSourcePath: '$DIR/b.csv', path: 'w' }],
          ],
          '$DIR/a.csv',
          'NEW',
        ],
        files: {
          'a.csv': 'x',
          'link.csv': { link: 'a.csv' },
          'b.csv': 'y',
        },
        note: 'two spellings of one file (a hard link) both move; another file and a session without a source do not; the key order of a session stays',
      },
      {
        args: [[['s1', SRC]], '$DIR/gone.csv', 'NEW'],
        files: { 'a.csv': 'x' },
        note: 'the target names nothing',
      },
      {
        args: [[['s1', { path: 'p', csvSourcePath: '$DIR/gone.csv' }]], '$DIR/a.csv', 'NEW'],
        files: { 'a.csv': 'x' },
        note: 'the source names nothing',
      },
      {
        args: [[['s1', { path: 'p', csvSourcePath: '$DIR/sub/../a.csv' }]], '$DIR/a.csv', 'NEW'],
        files: { 'a.csv': 'x', sub: { dir: true } },
        note: 'dot-dot spelling of the same file',
      },
      {
        args: [[['s1', { path: 'p', csvSourcePath: null }]], '$DIR/a.csv', 'NEW'],
        files: { 'a.csv': 'x' },
        note: 'a null source cannot be read',
      },
      { args: [[], '$DIR/a.csv', 'NEW'], files: { 'a.csv': 'x' }, note: 'no sessions' },
      {
        args: [[['s1', { path: 'p', csvSourcePath: '$DIR/d' }]], '$DIR/d', 'NEW'],
        files: { d: { dir: true } },
        note: 'a folder has an identity too',
      },
    ],
  },
}

// ---- csv-import-limit ----

const DEFAULT_LIMIT = CSV_IMPORT_DEFAULT_LIMIT_MB * 1024 * 1024

/** the limit set to each value in turn, on a limit at its default */
function limitSteps(steps: unknown[]): number[] {
  setDelimitedImportLimit(DEFAULT_LIMIT)
  const seen = [delimitedImportLimit()]
  for (const bytes of steps) {
    setDelimitedImportLimit(bytes as number)
    seen.push(delimitedImportLimit())
  }
  setDelimitedImportLimit(DEFAULT_LIMIT)
  return seen
}

const LIMIT_CASES = each(
  [[]],
  [[1000]],
  [[1000, -1, 0, 0.5, 3]],
  [[Number.NaN, 5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
  [['12', null, 7]],
  [[1e300, 2 ** 53, 1.5e9]],
  [[-0, 1]],
  [[3, 4, 3]],
)

const csvImportLimit: Record<string, FnSpec> = {
  'sheets/csv-import-limit.delimitedImportLimit': {
    ts: (a) => limitSteps(a[0] as unknown[]).pop(),
    cases: LIMIT_CASES,
  },
  'sheets/csv-import-limit.setDelimitedImportLimit': {
    ts: (a) => limitSteps(a[0] as unknown[]),
    cases: LIMIT_CASES,
  },
}

// ---- document-locale, xlsx-gateway ----

const documentLocale: Record<string, FnSpec> = {
  'document-locale.legacyCsvCharset': {
    ts: (a) => {
      const before = i18n.getRequestedLocale()
      i18n.setUiLang('en', str(a, 0))
      try {
        return legacyCsvCharset()
      } finally {
        i18n.setUiLang(i18n.getUiLang(), before)
      }
    },
    cases: each(
      ['zh'],
      ['zh-CN'],
      ['zh_TW'],
      ['zh-Hant-HK'],
      ['ja-JP'],
      ['ko_KR'],
      ['en-US'],
      ['de'],
      [''],
      ['xx'],
      ['\u212Ao'],
    ),
  },
  'xlsx-gateway/csv-limits.CSV_IMPORT_DEFAULT_LIMIT_MB': constant(CSV_IMPORT_DEFAULT_LIMIT_MB),
  'xlsx-gateway/document-locale.legacyCsvCharsetFor': {
    ts: (a) => legacyCsvCharsetFor(str(a, 0)),
    cases: each(
      ['zh'],
      ['zh-TW'],
      ['ja'],
      ['ko'],
      ['en'],
      ['zh-CN'],
      ['ZH'],
      [''],
      ['fr'],
      ['\u0131a'],
    ),
  },
}

// ---- import-registry ----

type RegistryStep = { op: string; owner?: number; as?: string; id?: string }

const importRegistry: Record<string, FnSpec> = {
  'import-registry.ImportRegistry': {
    ts: (a) => {
      const registry = new ImportRegistry()
      const named = new Map<string, AbortController>()
      return (a[0] as RegistryStep[]).map((step) => {
        const owner = step.owner as number
        switch (step.op) {
          case 'start':
            named.set(step.as as string, registry.start(owner))
            return null
          case 'cancel':
            return registry.cancel(owner)
          case 'controllerFor': {
            const found = registry.controllerFor(owner)
            if (found === undefined) return null
            return [...named].find(([, controller]) => controller === found)?.[0] ?? null
          }
          case 'wasCancelled':
            return registry.wasCancelled(named.get(step.id as string) as AbortController)
          default:
            return registry.finish(owner, named.get(step.id as string) as AbortController)
        }
      })
    },
    cases: each(
      [[]],
      [[{ op: 'cancel', owner: 1 }]],
      [
        [
          { op: 'start', owner: 1, as: 'a' },
          { op: 'controllerFor', owner: 1 },
          { op: 'wasCancelled', id: 'a' },
          { op: 'cancel', owner: 1 },
          { op: 'wasCancelled', id: 'a' },
          { op: 'cancel', owner: 1 },
          { op: 'finish', owner: 1, id: 'a' },
          { op: 'finish', owner: 1, id: 'a' },
          { op: 'cancel', owner: 1 },
          { op: 'controllerFor', owner: 1 },
        ],
      ],
      [
        [
          { op: 'start', owner: 1, as: 'a' },
          { op: 'start', owner: 1, as: 'b' },
          { op: 'controllerFor', owner: 1 },
          { op: 'finish', owner: 1, id: 'a' },
          { op: 'cancel', owner: 1 },
          { op: 'wasCancelled', id: 'a' },
          { op: 'wasCancelled', id: 'b' },
          { op: 'finish', owner: 1, id: 'b' },
        ],
      ],
      [
        [
          { op: 'start', owner: 1, as: 'a' },
          { op: 'start', owner: 2, as: 'b' },
          { op: 'cancel', owner: 2 },
          { op: 'wasCancelled', id: 'a' },
          { op: 'wasCancelled', id: 'b' },
          { op: 'finish', owner: 1, id: 'b' },
          { op: 'finish', owner: 2, id: 'a' },
          { op: 'controllerFor', owner: 3 },
        ],
      ],
      [
        [
          { op: 'start', owner: Number.NaN, as: 'n' },
          { op: 'cancel', owner: Number.NaN },
          { op: 'start', owner: 0, as: 'z' },
          { op: 'cancel', owner: -0 },
          { op: 'wasCancelled', id: 'n' },
          { op: 'wasCancelled', id: 'z' },
        ],
      ],
      [
        [
          { op: 'start', owner: 1, as: 'a' },
          { op: 'start', owner: 2, as: 'a' },
          { op: 'controllerFor', owner: 1 },
          { op: 'controllerFor', owner: 2 },
        ],
      ],
    ),
  },
}

// ---- pdf-page-variants ----

const FLAGS = [
  { hasFirst: false, hasEven: false },
  { hasFirst: true, hasEven: false },
  { hasFirst: false, hasEven: true },
  { hasFirst: true, hasEven: true },
]

const pdfPageVariants: Record<string, FnSpec> = {
  'pdf-page-variants.variantForPage': {
    ts: (a) => variantForPage(a[0] as number, a[1] as Any),
    cases: [1, 2, 3, 4, 0, -2, 2.5, 1.5, 100, Number.NaN].flatMap((page) =>
      FLAGS.map((flags): Case => ({ args: [page, flags] })),
    ),
  },
  'pdf-page-variants.evenPageRanges': {
    ts: (a) => evenPageRanges(a[0] as number),
    cases: each([0], [1], [2], [3], [4], [5], [10], [3.5], [-4], [Number.NaN], [1001]),
  },
  'pdf-page-variants.stitchPlan': {
    ts: (a) => stitchPlan(a[0] as number, a[1] as Any),
    cases: [0, 1, 2, 5, 6, 2.5, -1, Number.NaN].flatMap((total) =>
      FLAGS.map((flags): Case => ({ args: [total, flags] })),
    ),
  },
}

// ---- print-options ----

const pdfRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fileName: 'a.pdf',
  html: '<p>x</p>',
  landscape: false,
  pageSize: 'A4',
  margins: { top: 0.5, bottom: 0.5, left: 0.25, right: 0.25 },
  scale: 1,
  ...over,
})

const printOptions: Record<string, FnSpec> = {
  'print-options.MICRONS_PER_INCH': constant(MICRONS_PER_INCH),
  'print-options.CSS_PX_PER_INCH': constant(CSS_PX_PER_INCH),
  'print-options.printOptionsFor': {
    ts: (a) => printOptionsFor(a[0] as Any),
    cases: each(
      [pdfRequest()],
      [pdfRequest({ landscape: true, pageSize: 'Letter', scale: 0.75 })],
      [pdfRequest({ deviceName: 'HP LaserJet', copies: 3, collate: true })],
      [pdfRequest({ deviceName: '', copies: 0, collate: false })],
      [pdfRequest({ pageSize: { width: 8.5, height: 11 } })],
      [pdfRequest({ pageSize: { width: 0.00001968, height: 0.0000197 } })],
      [pdfRequest({ pageSize: { width: 100, height: 0.1 }, scale: 2 })],
      [pdfRequest({ margins: { top: 0, bottom: 3, left: 0.0052, right: 0.0053 }, scale: 0.1 })],
      [pdfRequest({ margins: { top: 0.015625, bottom: 0.0078125, left: -0.0078125, right: 1 } })],
      [pdfRequest({ scale: 0.995 })],
      [pdfRequest({ scale: Number.NaN })],
      [pdfRequest({ headerTemplate: '<span></span>', outPath: '/x.pdf' })],
    ),
  },
}

// ---- save-as-formats ----

const saveAsFormats: Record<string, FnSpec> = {
  'sheets/save-as-formats.sheetsSaveAsFilters': {
    ts: (a, cx) =>
      sheetsSaveAsFilters(a[0] as boolean, a[1] as boolean, (key) => {
        cx.log(key)
        return str(a, 2) + key
      }),
    cases: each(
      [false, false, ''],
      [false, true, ''],
      [true, false, ''],
      [true, true, ''],
      [false, true, 'L:'],
      [true, true, '\u{1F600} '],
    ),
  },
  'sheets/save-as-formats.sheetsSaveAsSuggestion': {
    ts: (a) => sheetsSaveAsSuggestion(str(a, 0)),
    cases: each(
      ['/a/Report.xlsx'],
      ['Report.XLSM'],
      ['a.xls'],
      ['a.CSV'],
      ['a.tsv'],
      ['a.ods'],
      ['a.Ods'],
      ['a.pdf'],
      ['a.xlsx.bak'],
      ['a.xlsx.xlsx'],
      ['a.csv\n'],
      ['noext'],
      [''],
      ['.csv'],
      ['a.c\u017Fv'],
      ['a.cs\u0076'],
      ['\u{1F600}.xlsx'],
      ['dir.xlsx/name'],
    ),
  },
  'sheets/save-as-formats.resolveSheetsSaveAsPick': {
    ts: (a) => resolveSheetsSaveAsPick(str(a, 0), a[1] as boolean, a[2] as boolean),
    cases: [
      '/a/b.pdf',
      '/a/b.PDF',
      '/a/b.ods',
      '/a/b.Ods',
      '/a/b.csv',
      '/a/b.CSV',
      '/a/b.xlsx',
      '/a/b.XLSX',
      '/a/b.xlsm',
      '/a/b.xls',
      '/a/b',
      '/a.d/b',
      'C:\\a.d\\b',
      'C:\\a\\b.ext',
      '/a/.hidden',
      '',
      '/a/b.',
      '\u0130.pdf',
      '/a/b.p\u0131df',
      '/\u{1F600}/b.xlsx',
    ].flatMap((path) =>
      [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ].map(([macro, copies]): Case => ({ args: [path, macro, copies] })),
    ),
  },
  'sheets/save-as-formats.SaveAsExportTargets': {
    ts: (a) => {
      const targets = new SaveAsExportTargets()
      return (a[0] as [string, number, string?][]).map(([op, id, path]) => {
        if (op === 'authorize') {
          targets.authorize(id, path as string)
          return null
        }
        if (op === 'take') return targets.take(id, path as string)
        targets.forget(id)
        return null
      })
    },
    cases: each(
      [[]],
      [[['take', 1, '/a.pdf']]],
      [
        [
          ['authorize', 1, '/a.pdf'],
          ['take', 1, '/a.pdf'],
          ['take', 1, '/a.pdf'],
        ],
      ],
      [
        [
          ['authorize', 1, '/a.pdf'],
          ['take', 1, '/b.pdf'],
          ['take', 2, '/a.pdf'],
          ['take', 1, '/a.pdf'],
        ],
      ],
      [
        [
          ['authorize', 1, '/a.pdf'],
          ['authorize', 1, '/b.pdf'],
          ['take', 1, '/a.pdf'],
          ['take', 1, '/b.pdf'],
        ],
      ],
      [
        [
          ['authorize', 1, '/a.pdf'],
          ['authorize', 2, '/a.pdf'],
          ['forget', 1],
          ['forget', 3],
          ['take', 1, '/a.pdf'],
          ['take', 2, '/a.pdf'],
        ],
      ],
      [
        [
          ['authorize', Number.NaN, '/n.pdf'],
          ['take', Number.NaN, '/n.pdf'],
          ['authorize', 0, '/z.pdf'],
          ['take', -0, '/z.pdf'],
        ],
      ],
    ),
  },
}

// ---- save-edits-transfer ----

type TransferStep = {
  op: string
  transferId?: string
  sessionId?: string
  total?: number
  seq?: number
  edits?: unknown[]
  now?: number
  idle?: number
}

/** a fake `setInterval`: each call a log line, and the callback kept while it is set */
function transferScenario(a: unknown[], cx: TsContext): unknown {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  let callback: (() => void) | null = null
  ;(globalThis as Any).setInterval = (fn: () => void, ms: number) => {
    cx.log('setInterval', ms)
    callback = fn
    return {
      unref() {
        cx.log('unref')
      },
    }
  }
  ;(globalThis as Any).clearInterval = () => {
    cx.log('clearInterval')
    callback = null
  }
  const store = new SaveEditsTransferStore()
  try {
    return (a[0] as TransferStep[]).map((step) => {
      const now = step.now ?? cx.now
      try {
        switch (step.op) {
          case 'begin':
            store.begin(
              { transferId: step.transferId, sessionId: step.sessionId, total: step.total } as Any,
              now,
            )
            return null
          case 'addChunk':
            store.addChunk(
              {
                sessionId: step.sessionId as string,
                transferId: step.transferId as string,
                seq: step.seq as number,
                edits: step.edits as Any,
              },
              now,
            )
            return null
          case 'take':
            return store.take(step.transferId as string, step.sessionId as string)
          case 'discard':
            store.discard(step.transferId as string, step.sessionId as string)
            return null
          case 'discardSession':
            store.discardSession(step.sessionId as string)
            return null
          case 'sweep':
            store.sweep(now, step.idle)
            return null
          case 'tick': {
            const fire = callback
            if (fire !== null) {
              const realNow = Date.now
              Date.now = () => now
              try {
                fire()
              } finally {
                Date.now = realNow
              }
            }
            return null
          }
          case 'dispose':
            store.dispose()
            return null
          default:
            return store.openTransferCount
        }
      } catch (error) {
        return { error: (error as Error).message }
      }
    })
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
}

const e = (sheetId: string, row: number): Record<string, unknown> => ({
  sheetId,
  row,
  column: 0,
  value: row,
})

const saveEditsTransfer: Record<string, FnSpec> = {
  'save-edits-transfer.SaveEditsTransferStore': {
    ts: (a, cx) => transferScenario(a, cx),
    cases: each(
      [[]],
      [[{ op: 'count' }]],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 3 },
          {
            op: 'addChunk',
            transferId: 't1',
            sessionId: 's',
            seq: 0,
            edits: [e('a', 0), e('b', 1)],
          },
          { op: 'count' },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 1, edits: [e('a', 2)] },
          { op: 'take', transferId: 't1', sessionId: 's' },
          { op: 'count' },
          { op: 'take', transferId: 't1', sessionId: 's' },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't1', sessionId: 'other', total: 1 },
          { op: 'count' },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't2', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't3', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't4', sessionId: 's', total: 1 },
          { op: 'begin', transferId: 't5', sessionId: 's', total: 1 },
          { op: 'count' },
          { op: 'discard', transferId: 't2', sessionId: 's' },
          { op: 'begin', transferId: 't5', sessionId: 's', total: 1 },
          { op: 'count' },
        ],
      ],
      [
        [
          { op: 'addChunk', transferId: 'nope', sessionId: 's', seq: 0, edits: [] },
          { op: 'begin', transferId: 't1', sessionId: 's', total: 2 },
          { op: 'addChunk', transferId: 't1', sessionId: 'wrong', seq: 0, edits: [] },
          { op: 'take', transferId: 't1', sessionId: 'wrong' },
          { op: 'discard', transferId: 't1', sessionId: 'wrong' },
          { op: 'count' },
          { op: 'take', transferId: 'nope', sessionId: 's' },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 5 },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 1, edits: [e('a', 0)] },
          { op: 'count' },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 0, edits: [] },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 2 },
          {
            op: 'addChunk',
            transferId: 't1',
            sessionId: 's',
            seq: 0,
            edits: [e('a', 0), e('a', 1)],
          },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 1, edits: [e('a', 2)] },
          { op: 'count' },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 0, edits: [] },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 4 },
          { op: 'addChunk', transferId: 't1', sessionId: 's', seq: 0, edits: [e('a', 0)] },
          { op: 'take', transferId: 't1', sessionId: 's' },
          { op: 'count' },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 0 },
          { op: 'take', transferId: 't1', sessionId: 's' },
          { op: 'begin', transferId: 't2', sessionId: 's', total: Number.NaN },
          { op: 'addChunk', transferId: 't2', sessionId: 's', seq: 0, edits: [] },
          { op: 'take', transferId: 't2', sessionId: 's' },
          { op: 'begin', transferId: 't3', sessionId: 's', total: 1.5 },
          { op: 'addChunk', transferId: 't3', sessionId: 's', seq: Number.NaN, edits: [] },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1, now: 1000 },
          { op: 'sweep', now: 121000 },
          { op: 'count' },
          { op: 'sweep', now: 121001 },
          { op: 'count' },
          { op: 'begin', transferId: 't2', sessionId: 's', total: 1, now: 5000 },
          { op: 'sweep', now: 6000, idle: 999 },
          { op: 'count' },
          { op: 'sweep', now: 6000, idle: 1000 },
          { op: 'count' },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1, now: 0 },
          { op: 'begin', transferId: 't2', sessionId: 's', total: 1, now: 100000 },
          { op: 'tick', now: 130000 },
          { op: 'count' },
          {
            op: 'addChunk',
            transferId: 't2',
            sessionId: 's',
            seq: 0,
            edits: [e('a', 0)],
            now: 200000,
          },
          { op: 'tick', now: 321000 },
          { op: 'count' },
          { op: 'tick', now: 500000 },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1, now: 0 },
          { op: 'begin', transferId: 't2', sessionId: 'u', total: 1, now: 0 },
          { op: 'begin', transferId: 't3', sessionId: 's', total: 1, now: 0 },
          { op: 'discardSession', sessionId: 's' },
          { op: 'count' },
          { op: 'discardSession', sessionId: 'nobody' },
          { op: 'dispose' },
          { op: 'count' },
          { op: 'dispose' },
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1, now: 400000 },
        ],
      ],
      [
        [
          { op: 'begin', transferId: 't1', sessionId: 's', total: 1, now: 0 },
          { op: 'begin', transferId: 't2', sessionId: 's', total: 1, now: 500000 },
          { op: 'count' },
          {
            op: 'addChunk',
            transferId: 't2',
            sessionId: 's',
            seq: 0,
            edits: [e('a', 0)],
            now: 900000,
          },
          { op: 'count' },
        ],
      ],
    ),
  },
}

// ---- save-failure-log ----

/** the issues of a failed parse, as `{ path, code }` */
function issuesOf(schema: z.ZodType, input: unknown): { path: unknown[]; code: string }[] {
  const parsed = schema.safeParse(input)
  if (parsed.success) return []
  return parsed.error.issues.map((issue) => ({ path: [...issue.path], code: issue.code }))
}

const six = z.object({
  a: z.string(),
  b: z.string(),
  c: z.string(),
  d: z.string(),
  e: z.string(),
  f: z.string(),
})

const ZOD_CASES: unknown[][] = [
  [{ zod: issuesOf(z.object({ a: z.string(), b: z.number() }), {}) }],
  [{ zod: issuesOf(z.array(z.object({ id: z.number() })), [{ id: 'x' }, { id: 1 }, { id: 'y' }]) }],
  [{ zod: issuesOf(z.string(), 5) }],
  [{ zod: issuesOf(six, {}) }],
  [{ zod: issuesOf(six.pick({ a: true, b: true, c: true, d: true }), {}) }],
  [{ zod: issuesOf(z.object({ a: z.string() }).strict(), { a: 'x', extra: 1 }) }],
  [{ zod: issuesOf(z.object({ ok: z.boolean(), n: z.number().max(3) }), { ok: 1, n: 9 }) }],
  [{ zod: [] }],
  [{ zod: [{ path: [''], code: 'custom' }] }],
  [{ zod: [{ path: ['', ''], code: 'custom' }] }],
  [{ zod: [{ path: ['a', 0, 'b', 12.5], code: 'invalid_type' }] }],
  [{ zod: [{ path: ['/tmp/a.xlsx', 'x'], code: 'custom' }] }],
]

const reopenFailure: Record<string, FnSpec> = {
  'save-failure-log.describeReopenFailure': {
    ts: (a) => {
      const e = a[0] as Any
      let thrown: unknown
      if ('zod' in e) thrown = new ZodError(e.zod.map((i: object) => ({ ...i, message: '' })))
      else if ('error' in e) thrown = new Error(e.error)
      else if ('undefined' in e) thrown = undefined
      else thrown = e.value
      return describeReopenFailure(thrown)
    },
    cases: each(
      ...ZOD_CASES,
      [{ error: 'XLSX sidecar request timed out.' }],
      [{ error: 'XLSX sidecar request timed out. ' }],
      [{ error: 'XLSX sidecar exited: segfault in /usr/lib/x.so' }],
      [{ error: 'XLSX sidecar exited with code 1 and signal null.' }],
      [{ error: 'XLSX sidecar stopped.' }],
      [{ error: 'XLSX sidecar stdin failed (broken pipe).' }],
      [{ error: 'XLSX sidecar failed to start (/opt/app/sidecar): spawn EACCES' }],
      [{ error: 'XLSX sidecar exitedX' }],
      [{ error: ' XLSX sidecar exited' }],
      [{ error: 'a\nXLSX sidecar exited' }],
      [{ error: 'XLSX sidecar crashed' }],
      [{ error: 'Cannot open C:\\Users\\a\\b.xlsx: not a zip.' }],
      [{ error: '' }],
      [{ value: 'XLSX sidecar exited: plain string' }],
      [{ value: { message: 'XLSX sidecar request timed out.' } }],
      [{ value: null }],
      [{ value: 42 }],
      [{ value: [1, null, [2, 'x']] }],
      [{ value: true }],
      [{ undefined: true }],
    ),
  },
  'save-failure-log.reopenFailureNote': {
    ts: (a) => reopenFailureNote(a[0] as Any),
    cases: each(
      [{ kind: 'timeout', detail: '' }],
      [{ kind: 'unreadable', detail: 'zip is damaged' }],
      [{ kind: 'reply-shape', detail: 'a.b invalid_type; +2' }],
      [{ kind: 'sidecar-ended', detail: '\u{1F600}' }],
    ),
  },
}

const sessionSource: Record<string, FnSpec> = {
  'save-failure-log.sessionSourceFormat': {
    ts: (a) => sessionSourceFormat(a[0] as Any),
    cases: each(
      [{ path: '/a/b.xlsx' }],
      [{ path: '/a/b.XLSM' }],
      [{ path: '/a/b.xls' }],
      [{ path: '/a/b.abcdef' }],
      [{ path: '/a/b.abcde' }],
      [{ path: '/a/b.' }],
      [{ path: '/a/b' }],
      [{ path: '/a/.git' }],
      [{ path: 'C:\\a.b\\c' }],
      [{ path: 'a.TAR.GZ' }],
      [{ path: 'a.\u0131' }],
      [{ path: 'a.\u212A' }],
      [{ path: '/a/b.xlsx', csvSourcePath: '/a/b.csv' }],
      [{ path: '/a/b.xlsx', csvSourcePath: null }],
      [{ path: '/a/b.xlsx', csvImport: true }],
      [{ path: '/a/b.xlsx', csvImport: false }],
      [{ path: '/a/b.xlsx', unsavedNew: true }],
      [{ path: '/a/b.xlsx', unsavedNew: false }],
      [{ path: '/a/b.xlsx', csvImport: true, unsavedNew: true }],
      [{ path: '/a/b.xlsx', suggestSaveAs: '/a/b.xlsx', importTempDir: '/tmp/x' }],
      [{ path: '/a/b.xls', suggestSaveAs: '/a/b.xlsx' }],
      [{ path: '/a/b.xls', importTempDir: '/tmp/x' }],
      [{ path: '/a/b.xlsx', password: 'x' }],
      [{ path: '/a/b.xlsx', password: '' }],
      [{ path: '/a/b.csv', csvImport: true, password: 'x' }],
      [{ path: '/a/b.xlsx', unsavedNew: true, password: 'x' }],
    ),
  },
}

const LONG = 'abc '.repeat(70)
const SCRUB_CASES = each(
  [''],
  ['plain text'],
  ['  spaced \t out\n\nlines  '],
  ['\u00a0nbsp\ufeff and bom\u00a0'],
  ['Cannot open /Users/alice/Documents/file.xlsx.'],
  ['Cannot open /Users/alice/Documents/file.xlsx, then /tmp/a;'],
  ['C:\\Users\\bob\\x.xlsx: failed'],
  ['c:/temp/x.xlsx failed'],
  ['\\\\server\\share\\x.xlsx'],
  ['zip entry </xl/fonts> is broken'],
  ['a/b and a.b/c and w/x'],
  ['<</path> and </end>'],
  ['(/path/to/file) in brackets'],
  ['"/quoted/path" and \'/single/path\' and `/tick/path`'],
  ['/ alone and //double and /x'],
  ['paths /a/b|c<d>e'],
  ['end /a/b...'],
  ['x:/ y:\\ z:'],
  ['\u{1F600} /tmp/\u{1F600}/file.xlsx'],
  [LONG],
  ['x'.repeat(240)],
  ['x'.repeat(241)],
  ['x'.repeat(239)],
  [`${'\u{1F600}'.repeat(100)}tail`],
  [`${'x'.repeat(238)}\u{1F600}`],
  [`${'x'.repeat(237)}\u{1F600}`],
  ['/very/long/path '.repeat(30)],
)

const scrub: Record<string, FnSpec> = {
  'save-failure-log.scrubDetail': { ts: (a) => scrubDetail(str(a, 0)), cases: SCRUB_CASES },
}

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  failure: { kind: 'unreadable', detail: 'zip is damaged' },
  sourceFormat: 'xlsx',
  stagedBytes: 1234,
  appVersion: '1.2.3',
  ...over,
})

const OLD_LINES =
  '{"time":"2026-01-01T00:00:00.000Z","n":1}\n{"time":"2026-01-02T00:00:00.000Z","n":2}\n{"time":"2026-01-03T00:00:00.000Z","n":3}\n{"time":"2026-01-04T00:00:00.000Z","n":4}\n'

const saveFailureLog: Record<string, FnSpec> = {
  'save-failure-log.SAVE_FAILURE_LOG_FILE': constant(SAVE_FAILURE_LOG_FILE),
  'save-failure-log.SAVE_FAILURE_LOG_MAX_BYTES': constant(SAVE_FAILURE_LOG_MAX_BYTES),
  ...scrub,
  ...reopenFailure,
  ...sessionSource,
  'save-failure-log.appendSaveFailure': {
    ts: (a, cx) => {
      const now = a[2] == null ? new Date(cx.now) : new Date(a[2] as number)
      appendSaveFailure(str(a, 0), a[1] as Any, now, a[3] == null ? undefined : (a[3] as number))
    },
    cases: [
      { args: ['$DIR/log.jsonl', entry(), null, null], note: 'a new file' },
      {
        args: ['$DIR/log.jsonl', entry({ stagedBytes: null }), 1700000000123, null],
        files: { 'log.jsonl': '{"x":1}\n' },
        note: 'appended to an existing record',
      },
      {
        args: ['$DIR/log.jsonl', entry({ stagedBytes: 1.5 }), 0, null],
        note: 'the epoch; a fractional size',
      },
      {
        args: [
          '$DIR/log.jsonl',
          entry({ failure: { kind: 'timeout', detail: 'q"uo\\te \u0001 \u2028 \u{1F600}' } }),
          null,
          null,
        ],
        note: 'JSON.stringify escapes',
      },
      {
        args: ['$DIR/log.jsonl', entry({ stagedBytes: Number.NaN }), null, null],
        note: 'NaN is null',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 100],
        files: { 'log.jsonl': OLD_LINES },
        note: 'trimmed: the older half goes, to a line break',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 400],
        files: { 'log.jsonl': OLD_LINES },
        note: 'under the cap: kept whole',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 0],
        files: { 'log.jsonl': OLD_LINES },
        note: 'a cap of nothing: the whole file is over, and the new line is in the second half or not',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 1],
        files: { 'log.jsonl': 'no line break at all' },
        note: 'no line break in the kept half: emptied',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 50.5],
        files: { 'log.jsonl': `\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\n${OLD_LINES}` },
        note: 'a fractional cap; astral characters in the older half',
      },
      {
        args: ['$DIR/log.jsonl', entry(), null, 60],
        files: { 'log.jsonl': { hex: '41ff42ff0a43ff0a44' } },
        note: 'bytes that are not UTF-8 are read as U+FFFD',
      },
      {
        args: ['$DIR/log.jsonl', entry(), 8.64e15 + 1, null],
        note: 'an invalid time: nothing is written',
      },
      {
        args: ['$DIR/log.jsonl', entry(), 8.64e15, null],
        note: 'the last valid time',
      },
      { args: ['$DIR/none/log.jsonl', entry(), null, null], note: 'no folder: nothing happens' },
      {
        args: ['$DIR/log.jsonl', entry(), null, null],
        files: { 'log.jsonl': { dir: true } },
        note: 'a folder as the log: nothing happens',
      },
      ...(() => {
        const e = entry()
        const failure = e.failure as { kind: string; detail: string }
        const line = `${JSON.stringify({
          time: new Date(0).toISOString(),
          app: e.appVersion,
          source: e.sourceFormat,
          bytes: e.stagedBytes,
          kind: failure.kind,
          detail: failure.detail,
        })}\n`
        const size = Buffer.byteLength(line)
        return [size, size - 1].map((cap): Case => ({
          args: ['$DIR/log.jsonl', entry(), 0, cap],
          note: `a new file of exactly ${size} bytes under a cap of ${cap}`,
        }))
      })(),
    ],
  },
}

// ---- session-rename ----

const renameSessions: Record<string, FnSpec> = {
  'session-rename.xlsxSiblingOf': {
    ts: (a) => xlsxSiblingOf(str(a, 0)),
    cases: each(
      ['/a/b.csv'],
      ['/a/b.tar.gz'],
      ['/a/b'],
      ['dir.d/file'],
      ['dir.d/file.xls'],
      [''],
      ['.'],
      ['a.'],
      ['a..b'],
      ['.hidden'],
      ['a.b\nc'],
      ['a.\u{1F600}'],
      ['\u{1F600}.csv'],
      ['C:\\a.b\\c.tsv'],
      ['a.xlsx'],
    ),
  },
  'session-rename.sessionAfterRename': {
    ts: (a) => sessionAfterRename(a[0] as Any, str(a, 1), str(a, 2)),
    cases: each(
      [{ path: '/a/old.xlsx' }, '/a/old.xlsx', '/a/new.xlsx'],
      [{ path: '/a/other.xlsx' }, '/a/old.xlsx', '/a/new.xlsx'],
      [{ path: '/tmp/c/x.xlsx', csvSourcePath: '/a/old.csv' }, '/a/old.csv', '/a/new.csv'],
      [{ path: '/tmp/c/x.xlsx', restoreTarget: '/a/old.xlsx' }, '/a/old.xlsx', '/a/new.xlsx'],
      [{ path: '/tmp/c/x.xlsx', odsSourcePath: '/a/old.ods' }, '/a/old.ods', '/a/new.ods'],
      [
        { path: '/tmp/c/x.xlsx', suggestSaveAs: '/a/old.xlsx', importTempDir: '/tmp/c' },
        '/a/old.xls',
        '/a/new.xls',
      ],
      [{ path: '/tmp/c/x.xlsx', suggestSaveAs: '/a/old.xlsx' }, '/a/old.tsv', '/a/renamed.tsv'],
      [{ path: '/tmp/c/x.xlsx', suggestSaveAs: '/a/else.xlsx' }, '/a/old.xls', '/a/new.xls'],
      [{ path: '/a/old.xls', suggestSaveAs: '/a/old.xlsx' }, '/a/old.xls', '/a/new.xls'],
      [{ path: '/a/old.xls', suggestSaveAs: null }, '/a/old.xls', '/a/new.xls'],
      [{ path: '/tmp/x.xlsx', suggestSaveAs: null }, '/a/old.xls', '/a/new.xls'],
      [
        {
          extra: 1,
          odsSourcePath: '/a/old.xlsx',
          path: '/a/old.xlsx',
          csvSourcePath: '/a/old.xlsx',
          restoreTarget: '/a/old.xlsx',
          tail: { k: 'v' },
        },
        '/a/old.xlsx',
        '/a/new.xlsx',
      ],
      [
        {
          path: '/a/old.xlsx',
          csvSourcePath: '/a/old.xlsx',
          restoreTarget: '/a/keep.xlsx',
          suggestSaveAs: '/a/old.xlsx',
        },
        '/a/old.xlsx',
        '/a/new.xlsx',
      ],
      [{ path: '/a/old.xlsx' }, '/a/old.xlsx', '/a/old.xlsx'],
      [{ path: '' }, '', '/a/new.xlsx'],
    ),
  },
}

// ---- session-reopen ----

const reopenSessions: Record<string, FnSpec> = {
  'session-reopen.sessionToContinue': {
    ts: (a) => sessionToContinue(a[0] as Any, str(a, 1)),
    cases: each(
      [[], '/a.xlsx'],
      [[{ path: '/a.xlsx' }], '/a.xlsx'],
      [[{ path: '/a.xlsx', suggestSaveAs: '/a.xlsx' }], '/a.xlsx'],
      [[{ path: '/a.xlsx', suggestSaveAs: '/a.xlsx' }], '/b.xlsx'],
      [[{ path: '/tmp/x.xlsx', csvSourcePath: '/a.csv' }], '/tmp/x.xlsx'],
      [[{ path: '/tmp/x.xlsx', importTempDir: '/tmp' }], '/tmp/x.xlsx'],
      [[{ path: '/tmp/x.xlsx', restoreTarget: '/a.xlsx' }], '/a.xlsx'],
      [[{ path: '/tmp/x.xlsx', restoreTarget: '/a.xlsx' }], '/tmp/x.xlsx'],
      [[{ path: '/a.xlsx', restoreTarget: null, password: 'x' }], '/a.xlsx'],
      [[{ path: '/a.xlsx', unsavedNew: true }], '/a.xlsx'],
      [[{ path: '/a.xlsx', unsavedNew: false }], '/a.xlsx'],
      [[{ path: '/a.xlsx', unsavedRestore: true }], '/a.xlsx'],
      [[{ path: '/a.xlsx', unsavedRestore: 1 }], '/a.xlsx'],
      [[{ path: '/a.xlsx', odsSourcePath: '/a.ods' }], '/a.xlsx'],
      [[{ path: '/a.xlsx', csvImport: true, odsConverted: true, emptySource: true }], '/a.xlsx'],
      [[{ path: '/a.xlsx', password: null }], '/a.xlsx'],
      [
        [
          { path: '/a.xlsx', password: 'first' },
          { path: '/b.xlsx', password: 'other' },
          { path: '/a.xlsx', password: 'last' },
          { path: '/a.xlsx' },
        ],
        '/a.xlsx',
      ],
    ),
  },
  'session-reopen.continuedOpenOptions': {
    ts: (a) => continuedOpenOptions(a[0] as Any),
    cases: each(
      [{ path: '/a.xlsx' }],
      [{ path: '/a.xlsx', importTempDir: '/tmp/x', sessionId: 's' }],
      [
        {
          path: '/a.xlsx',
          odsSourcePath: '/a.ods',
          formulasDropped: 0,
          password: '',
          odsConverted: false,
          unsavedRestore: true,
          recoveryOriginalPath: '/o.xlsx',
          recoveryIdentity: { id: 1, nested: ['a', null] },
          unsavedNew: false,
          emptySource: true,
          restoreTarget: '/r.xlsx',
          csvSourcePath: '/c.csv',
          csvImport: true,
          suggestSaveAs: '/s.xlsx',
        },
      ],
      [{ path: '/a.xlsx', password: null, csvSourcePath: null }],
    ),
  },
}

// ---- temp-files ----

const UUID_A = '123e4567-e89b-12d3-a456-426614174000'
const UUID_B = 'ABCDEF01-2345-4789-ABCD-0123456789AB'
const SESS = '$DIR/tmp/seuoffice-sheets-sessions'
const IMPS = '$DIR/tmp/seuoffice-imports'

const sessionOptions = (over: Record<string, unknown>): Record<string, unknown> => ({
  snapshotPath: `${SESS}/${UUID_A}.xlsx`,
  tempRoot: '$DIR/tmp',
  closeSidecar: 'ok',
  ...over,
})

const SESSION_FILES = {
  [`tmp/seuoffice-sheets-sessions/${UUID_A}.xlsx`]: 'snap',
  [`tmp/seuoffice-sheets-sessions/${UUID_B}.XLSX`]: 'snap upper',
  'tmp/seuoffice-sheets-sessions/other.xlsx': 'not a snapshot',
  [`tmp/seuoffice-imports/${UUID_A}/data.csv`]: 'a,b',
  [`tmp/seuoffice-imports/${UUID_A}/sub/deep.txt`]: 'deep',
  'tmp/seuoffice-imports/notauuid/data.csv': 'x',
  [`tmp/${UUID_A}.xlsx`]: 'outside the folder',
  [`tmp/seuoffice-sheets-sessions/nested/${UUID_A}.xlsx`]: 'nested',
}

const tempFiles: Record<string, FnSpec> = {
  'temp-files.PASTED_FILE_TTL_MS': constant(PASTED_FILE_TTL_MS),
  'temp-files.cleanupSessionResources': {
    ts: async (a, cx) => {
      const o = a[0] as Any
      await cleanupSessionResources({
        snapshotPath: o.snapshotPath,
        importTempDir: o.importTempDir,
        tempRoot: o.tempRoot,
        closeSidecar: () => {
          cx.log('closeSidecar')
          if (o.closeSidecar === 'throw') throw new Error('gone')
          return o.closeSidecar === 'reject' ? Promise.reject(new Error('gone')) : Promise.resolve()
        },
      })
    },
    cases: [
      { args: [sessionOptions({})], files: SESSION_FILES, note: 'the snapshot goes' },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/${UUID_B}.XLSX` })],
        files: SESSION_FILES,
        note: 'upper case matches',
      },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/other.xlsx` })],
        files: SESSION_FILES,
        note: 'not the shape of a snapshot',
      },
      {
        args: [sessionOptions({ snapshotPath: `$DIR/tmp/${UUID_A}.xlsx` })],
        files: SESSION_FILES,
        note: 'not in the sessions folder',
      },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/nested/${UUID_A}.xlsx` })],
        files: SESSION_FILES,
        note: 'nested: not a direct child',
      },
      {
        args: [
          sessionOptions({
            snapshotPath: `$DIR/tmp/x/../seuoffice-sheets-sessions/${UUID_A}.xlsx`,
          }),
        ],
        files: SESSION_FILES,
        note: 'resolved before it is judged',
      },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/${UUID_A}.xlsx/` })],
        files: SESSION_FILES,
        note: 'a trailing slash passes the check and the removal fails',
      },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/${UUID_A}.xl\u017Fx` })],
        files: { ...SESSION_FILES, [`tmp/seuoffice-sheets-sessions/${UUID_A}.xl\u017Fx`]: 'x' },
        note: 'U+017F is not an s',
      },
      {
        args: [
          sessionOptions({ snapshotPath: `${SESS}/00000000-0000-9000-a000-000000000000.xlsx` }),
        ],
        files: { 'tmp/seuoffice-sheets-sessions/00000000-0000-9000-a000-000000000000.xlsx': 'v9' },
        note: 'version 9 is not a version',
      },
      {
        args: [
          sessionOptions({ snapshotPath: `${SESS}/00000000-0000-4000-c000-000000000000.xlsx` }),
        ],
        files: { 'tmp/seuoffice-sheets-sessions/00000000-0000-4000-c000-000000000000.xlsx': 'vc' },
        note: 'variant c is not a variant',
      },
      {
        args: [sessionOptions({ snapshotPath: `${SESS}/${UUID_A}.xlsx` })],
        files: { [`tmp/seuoffice-sheets-sessions/${UUID_A}.xlsx`]: { dir: true } },
        note: 'a folder is not removed by rm without recursive',
      },
      {
        args: [sessionOptions({ importTempDir: `${IMPS}/${UUID_A}` })],
        files: SESSION_FILES,
        note: 'the import folder goes with its contents',
      },
      {
        args: [sessionOptions({ importTempDir: `${IMPS}/notauuid` })],
        files: SESSION_FILES,
        note: 'not the shape of an import folder',
      },
      {
        args: [sessionOptions({ importTempDir: `$DIR/tmp/${UUID_A}` })],
        files: SESSION_FILES,
        note: 'not in the imports folder',
      },
      {
        args: [sessionOptions({ importTempDir: `${IMPS}/${UUID_B}` })],
        files: SESSION_FILES,
        note: 'an import folder that is not there',
      },
      {
        args: [sessionOptions({ closeSidecar: 'reject', importTempDir: `${IMPS}/${UUID_A}` })],
        files: SESSION_FILES,
        note: 'a close that rejects is swallowed',
      },
      {
        args: [sessionOptions({ closeSidecar: 'throw' })],
        files: SESSION_FILES,
        note: 'a close that throws is swallowed',
      },
      {
        args: [sessionOptions({ snapshotPath: 'relative/x.xlsx' })],
        note: 'a relative snapshot',
      },
    ],
  },
  'temp-files.cleanupImportTempDirectory': {
    ts: (a) => cleanupImportTempDirectory(str(a, 0), str(a, 1)),
    cases: [
      { args: ['$DIR/tmp', `${IMPS}/${UUID_A}`], files: SESSION_FILES },
      { args: ['$DIR/tmp', `${IMPS}/${UUID_B.toLowerCase()}`], files: SESSION_FILES },
      { args: ['$DIR/tmp', `${IMPS}/${UUID_A}/`], files: SESSION_FILES, note: 'trailing slash' },
      { args: ['$DIR/tmp', `${IMPS}/notauuid`], files: SESSION_FILES },
      {
        args: ['$DIR/tmp', `${IMPS}/${UUID_A}/sub`],
        files: SESSION_FILES,
        note: 'not a direct child',
      },
      { args: ['$DIR/tmp', `$DIR/tmp/imports/${UUID_A}`], files: SESSION_FILES },
      { args: ['$DIR/tmp', '$DIR/tmp/seuoffice-imports'], files: SESSION_FILES },
      {
        args: ['$DIR/tmp', `${IMPS}/${UUID_A}`],
        files: { [`tmp/seuoffice-imports/${UUID_A}`]: 'a file, not a folder' },
        note: 'a file under the name is removed too',
      },
      {
        args: ['$DIR/tmp', `${IMPS}/${UUID_A}`],
        files: { [`tmp/seuoffice-imports/${UUID_A}`]: { dir: true } },
        note: 'an empty folder',
      },
      { args: ['$DIR/tmp', `${IMPS}/${UUID_A}`], note: 'nothing there' },
    ],
  },
  'temp-files.cleanupExpiredPastedFiles': {
    ts: (a, cx) => cleanupExpiredPastedFiles(str(a, 0), a[1] == null ? cx.now : (a[1] as number)),
    cases: [
      {
        args: ['$DIR/tmp', 1_700_000_000_000],
        files: {
          'tmp/seuoffice-pasted/pasted-20260101-000000-1.png': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-2.JPG': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-3.jpeg': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-4.gif': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-5.WebP': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-6.bmp': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-1-000000-7.png': { text: 'old', mtimeMs: 1_600_000_000_000 },
          'tmp/seuoffice-pasted/pasted-20260101-000000-.png': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/other.png': { text: 'old', mtimeMs: 1_600_000_000_000 },
          'tmp/seuoffice-pasted/pasted-20260101-000000-8.png.bak': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-9.pn\u017F': {
            text: 'old',
            mtimeMs: 1_600_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-10.png': {
            text: 'new',
            mtimeMs: 1_699_999_999_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-11.png': {
            dir: true,
            mtimeMs: 1_600_000_000_000,
          },
        },
        note: 'only owned old files',
      },
      {
        args: ['$DIR/tmp', 1_700_000_000_000],
        files: {
          'tmp/seuoffice-pasted/pasted-20260101-000000-1.png': {
            text: 'x',
            mtimeMs: 1_699_395_200_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-2.png': {
            text: 'x',
            mtimeMs: 1_699_395_199_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-3.png': {
            text: 'x',
            mtimeMs: 1_699_395_201_000,
          },
        },
        note: 'the cutoff is the TTL before now: a file at the cutoff stays',
      },
      {
        args: ['$DIR/tmp', null],
        files: {
          'tmp/seuoffice-pasted/pasted-20260101-000000-1.png': {
            text: 'x',
            mtimeMs: 1_700_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-2.png': {
            text: 'x',
            mtimeMs: 1_794_000_000_000,
          },
        },
        note: 'the clock of the call',
      },
      { args: ['$DIR/tmp', 1_700_000_000_000], note: 'no pasted folder' },
      {
        args: ['$DIR/tmp', 1_700_000_000_000],
        files: { 'tmp/seuoffice-pasted': 'a file, not a folder' },
        note: 'the pasted folder is a file',
      },
      {
        args: ['$DIR/tmp', 1_700_000_000_000],
        files: {
          'tmp/seuoffice-pasted/nested/pasted-20260101-000000-1.png': {
            text: 'x',
            mtimeMs: 1_500_000_000_000,
          },
          'tmp/seuoffice-pasted/pasted-20260101-000000-2.png': {
            text: 'x',
            mtimeMs: 1_500_000_000_000,
          },
        },
        note: 'a nested file is not looked at',
      },
    ],
  },
}

// ---- workbook-save-resolve ----

/** a request with nothing in it */
const saveRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sheetOps: [],
  sheetOrder: [],
  edits: [],
  structuralOps: [],
  filterStates: [],
  hyperlinkEdits: [],
  cfStates: [],
  dvStates: [],
  sheetProtections: [],
  protectedRangeStates: [],
  pageSetupStates: [],
  noteStates: [],
  visualAdditions: [],
  tableAdditions: [],
  pivotAdditions: [],
  sparklineAdditions: [],
  formulaValues: [],
  pivotRefreshUpdates: [],
  slicerState: null,
  ...over,
})

const NAMES = [
  ['u1', 'Sheet1'],
  ['u2', 'Sheet2'],
  ['u3', 'Data'],
]

const resolveCases: Case[] = [
  { args: [NAMES, saveRequest()], note: 'nothing' },
  { args: [[], saveRequest()], note: 'no sheets, nothing' },
  {
    args: [
      NAMES,
      saveRequest({
        edits: [
          { sheetId: 'u1', row: 0, column: 1, writeValue: true, value: 'x', formula: '=A1' },
          {
            sheetId: 'u2',
            row: 2,
            column: 3,
            value: 5,
            style: { bold: true },
            rich: [{ t: 'a' }],
            styleReset: true,
          },
          { sheetId: 'u1', row: 1, column: 1, value: null },
          { sheetId: 'u3', row: 1, column: 1 },
        ],
        chartEdits: [{ id: 1 }],
        visualEdits: [{ drawingPath: '/xl/drawings/drawing1.xml' }],
        definedNamesState: { names: [] },
        themeState: { name: 't' },
        workbookProtectionState: { lock: true },
        pivotCacheRefreshPaths: ['/xl/pivotCache/c1.xml'],
        externalLinkOps: [{ kind: 'break', index: 1 }],
      }),
    ],
    note: 'edits, and the fields that pass through',
  },
  {
    args: [NAMES, saveRequest({ edits: [{ sheetId: 'zz', row: 0, column: 0 }] })],
    note: 'unknown sheet in an edit',
  },
  { args: [NAMES, saveRequest({ edits: [{ row: 0, column: 0 }] })], note: 'no sheet id' },
  {
    args: [NAMES, saveRequest({ edits: [{ sheetId: 7, row: 0, column: 0 }] })],
    note: 'a number as sheet id',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'add-sheet', sheetId: 'n1', name: 'Added' },
          { kind: 'rename-sheet', sheetId: 'u1', newName: 'Renamed' },
          { kind: 'set-sheet-hidden', sheetId: 'u2', hidden: true },
          { kind: 'set-sheet-tab-color', sheetId: 'n1', color: '#ff0000' },
          { kind: 'set-sheet-tab-color', sheetId: 'u3', color: null },
          { kind: 'remove-sheet', sheetId: 'u3' },
          { kind: 'reorder-sheets' },
        ],
        sheetOrder: ['u2', 'n1', 'u1'],
        edits: [{ sheetId: 'n1', row: 0, column: 0, value: 'in the new sheet' }],
      }),
    ],
    note: 'every op; order uses the renamed names, not for an added sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'duplicate-sheet', sheetId: 'd1', sourceSheetId: 'u1', name: 'Copy' },
          { kind: 'add-sheet', sheetId: 'n1', name: 'Plain' },
          { kind: 'rename-sheet', sheetId: 'd1', newName: 'Copy2' },
        ],
        sheetOrder: ['u1', 'd1', 'n1'],
      }),
    ],
    note: 'a duplicate remembers its source',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [{ kind: 'duplicate-sheet', sheetId: 'd1', sourceSheetId: 'nope', name: 'C' }],
      }),
    ],
    note: 'a duplicate of an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'add-sheet', sheetId: 'n1', name: 'A' },
          { kind: 'duplicate-sheet', sheetId: 'd1', sourceSheetId: 'n1', name: 'C' },
        ],
      }),
    ],
    note: 'a duplicate of an added sheet is refused: only the file sheets are sources',
  },
  {
    args: [
      NAMES,
      saveRequest({ sheetOps: [{ kind: 'duplicate-sheet', sheetId: 'd1', name: 'C' }] }),
    ],
    note: 'a duplicate with no source',
  },
  {
    args: [
      NAMES,
      saveRequest({ sheetOps: [{ kind: 'rename-sheet', sheetId: 'nope', newName: 'X' }] }),
    ],
    note: 'rename of an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'set-sheet-tab-color', sheetId: 'u1', color: '#00f' },
          { kind: 'set-sheet-tab-color', sheetId: 'u2', color: '#0f0' },
        ],
        sheetOrder: ['nope'],
      }),
    ],
    note: 'only tab colors: no sheet plan, so the order is not read',
  },
  {
    args: [
      NAMES,
      saveRequest({ sheetOps: [{ kind: 'reorder-sheets' }], sheetOrder: ['u3', 'u1', 'u2'] }),
    ],
    note: 'only a reorder',
  },
  {
    args: [
      NAMES,
      saveRequest({ sheetOps: [{ kind: 'reorder-sheets' }], sheetOrder: ['u3', 'nope'] }),
    ],
    note: 'an unknown sheet in the order',
  },
  {
    args: [
      [
        ['u1', ''],
        ['u2', 'B'],
      ],
      saveRequest({ edits: [{ sheetId: 'u1', row: 0, column: 0 }] }),
    ],
    note: 'an empty file name is no name',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [{ kind: 'add-sheet', sheetId: 'n1', name: '' }],
        edits: [{ sheetId: 'n1', row: 0, column: 0 }],
      }),
    ],
    note: 'an added sheet with no name',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [{ kind: 'add-sheet', sheetId: 'u1', name: null }],
        edits: [{ sheetId: 'u1', row: 0, column: 0 }],
      }),
    ],
    note: 'a null name falls through to the file name (??)',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [{ kind: 'add-sheet', sheetId: 'u1', name: 'Shadow' }],
        edits: [{ sheetId: 'u1', row: 0, column: 0 }],
      }),
    ],
    note: 'an added sheet shadows a file sheet of the same id',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [{ kind: 'add-sheet', sheetId: 'n1' }],
        edits: [{ sheetId: 'n1', row: 0, column: 0 }],
      }),
    ],
    note: 'an added sheet with no name at all',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'rename-sheet', sheetId: 'u1' },
          { kind: 'rename-sheet', sheetId: 'u2', newName: null },
          { kind: 'set-sheet-hidden', sheetId: 'u3' },
        ],
        sheetOrder: ['u1', 'u2', 'u3'],
      }),
    ],
    note: 'a rename without a new name keeps the name in the order',
  },
  {
    args: [
      NAMES,
      saveRequest({
        sheetOps: [
          { kind: 'rename-sheet', sheetId: 'u1', newName: 'First' },
          { kind: 'rename-sheet', sheetId: 'u1', newName: 'Second' },
        ],
        sheetOrder: ['u1'],
      }),
    ],
    note: 'two renames of one sheet: the later one orders',
  },
  {
    args: [
      NAMES,
      saveRequest({
        bulkConstantFills: [
          { sheetId: 'u1', range: { r: 1 }, value: 'x' },
          { sheetId: 'u2', sheetName: 'overridden', fill: 1 },
        ],
      }),
    ],
    note: 'bulk fills: the sheet name first, and a key of the fill overrides it in place',
  },
  {
    args: [NAMES, saveRequest({ bulkConstantFills: null })],
    note: 'a null list of fills is no fills',
  },
  {
    args: [NAMES, saveRequest({ bulkConstantFills: [{ sheetId: 'zz' }] })],
    note: 'a fill on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        structuralOps: [
          { sheetId: 'u1', kind: 'delete-range', range: { startRow: 0 } },
          { sheetId: 'u2', kind: 'set-size', start: 0, end: 2, size: 20 },
          { sheetId: 'u1', kind: 'set-outline', start: 1, end: 3, level: 2, collapsed: true },
          { sheetId: 'u1', kind: 'set-outline', start: 1, end: 3, level: 0 },
          { sheetId: 'u1', kind: 'outline-summary', summaryBelow: true, summaryRight: false },
          { sheetId: 'u3', kind: 'set-hidden', start: 4, end: 4, hidden: false },
          { sheetId: 'u3', kind: 'set-style', start: 0, end: 0, style: { w: 1 } },
          { sheetId: 'u2', kind: 'insert', index: 3, count: 2, before: true },
          { sheetId: 'u2', kind: 'delete', index: 5, count: 1 },
          { sheetId: 'u1', kind: 'unknown-kind', range: null, extra: 1 },
          { sheetId: 'u1', kind: 'size-and-range', range: 1, size: 2 },
        ],
      }),
    ],
    note: 'every shape of structural op; grouped by sheet in first-seen order',
  },
  {
    args: [
      NAMES,
      saveRequest({ structuralOps: [{ sheetId: 'zz', kind: 'delete', index: 0, count: 1 }] }),
    ],
    note: 'structural op on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        filterStates: [
          {
            sheetId: 'u1',
            filter: { range: 'A1:B2' },
            hiddenRows: [2, 3],
            visibilityRange: { a: 1 },
          },
          { sheetId: 'u2', filter: null },
          { sheetId: 'u3' },
        ],
        hyperlinkEdits: [
          { sheetId: 'u2', row: 0, column: 0, target: 'http://x' },
          { sheetId: 'u1', row: 1, column: 1, target: null },
          { sheetId: 'u2', row: 2, column: 2 },
        ],
        cfStates: [{ sheetId: 'u1', rules: [{ r: 1 }] }, { sheetId: 'u3' }],
        dvStates: [{ sheetId: 'u2', rules: [] }],
        sheetProtections: [{ sheetId: 'u1', locked: true, password: 'p' }],
        protectedRangeStates: [{ sheetId: 'u3', ranges: [{ id: 1 }] }],
        pageSetupStates: [{ sheetId: 'u2', orientation: 'landscape', scale: 90 }],
        noteStates: [{ sheetId: 'u1', notes: [{ row: 0, text: 'n' }] }],
        visualAdditions: [
          { sheetId: 'u1', anchor: { r: 1 }, chart: { c: 1 } },
          { sheetId: 'u2', shape: { s: 1 }, image: { i: 1 } },
        ],
        cellImageAdditions: [{ sheetId: 'u3', row: 0, column: 0, bytes: 'abc' }],
        sparklineAdditions: [{ sheetId: 'u2', group: 1, sparklines: [] }],
      }),
    ],
    note: 'every kind of per-sheet state',
  },
  {
    args: [NAMES, saveRequest({ hyperlinkEdits: [{ sheetId: 'zz', row: 0, column: 0 }] })],
    note: 'a hyperlink on an unknown sheet',
  },
  {
    args: [NAMES, saveRequest({ sheetProtections: [{ sheetId: 'zz' }] })],
    note: 'a protection on an unknown sheet',
  },
  {
    args: [NAMES, saveRequest({ cellImageAdditions: [{ sheetId: 'zz' }] })],
    note: 'a cell image on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        tableAdditions: [
          {
            sheetId: 'u1',
            area: { r: 1 },
            name: 'T1',
            columnNames: ['a', 'b'],
            style: 'TableStyleMedium2',
            bandedRows: true,
            headerRow: true,
            totalsRow: false,
            firstColumn: false,
            lastColumn: true,
            bandedColumns: false,
            filterButton: true,
          },
          { sheetId: 'u2', area: {}, name: 'T2', columnNames: [] },
        ],
        tableEdits: [
          { sheetId: 'u1', name: 'T1', rename: 'T9' },
          { sheetName: 'stale', sheetId: 'u2', kind: 'drop' },
          { kind: 'resize', sheetId: 'u3', area: { r: 2 } },
        ],
      }),
    ],
    note: 'tables: the options object; tableEdits keep their keys and the sheet name at the end, or where it was',
  },
  { args: [NAMES, saveRequest({ tableEdits: null })], note: 'null table edits' },
  {
    args: [NAMES, saveRequest({ tableEdits: [{ sheetId: 'zz' }] })],
    note: 'a table edit on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        pivotAdditions: [
          {
            sheetId: 'u2',
            sourceSheetId: 'u1',
            sourceArea: { r: 1 },
            location: 'A1',
            name: 'P',
            fieldNames: ['a'],
            rowFieldIndices: [0],
            columnFieldIndex: 1,
            pageFieldIndices: [],
            pageLevelItems: [],
            pageItems: [],
            rowItems: [],
            rowLevelItems: [],
            rowLines: [],
            columnItems: [],
            columnFieldIndices: [],
            colLevelItems: [],
            colLines: [],
            groupings: [],
            filters: [],
            rowHiddenItems: [],
            colHiddenItems: [],
            values: [{ v: 1 }],
          },
          { sheetId: 'u3', sourceSheetId: 'u3' },
        ],
      }),
    ],
    note: 'a pivot',
  },
  {
    args: [NAMES, saveRequest({ pivotAdditions: [{ sheetId: 'u1', sourceSheetId: 'zz' }] })],
    note: 'a pivot over an unknown source',
  },
  {
    args: [NAMES, saveRequest({ pivotAdditions: [{ sheetId: 'yy', sourceSheetId: 'zz' }] })],
    note: 'both unknown: the sheet is read first',
  },
  {
    args: [
      NAMES,
      saveRequest({
        slicerState: {
          slicers: [
            { sheetId: 'u1', part: '/xl/slicers/s1.xml', name: 's1' },
            { sheetName: 'old', sheetId: 'u2', n: 1 },
          ],
          removals: ['/xl/slicers/s0.xml'],
        },
      }),
    ],
    note: 'slicers',
  },
  {
    args: [NAMES, saveRequest({ slicerState: { slicers: [], removals: [] } })],
    note: 'empty slicer state',
  },
  {
    args: [NAMES, saveRequest({ slicerState: { slicers: [{ sheetId: 'zz' }], removals: [] } })],
    note: 'slicer on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        formulaValues: [
          { sheetId: 'u2', row: 0, column: 0, value: 1.5 },
          { sheetId: 'u1', row: 1, column: 1, value: { error: '#DIV/0!' } },
          { sheetId: 'u2', row: 2, column: 2, value: null },
          { sheetId: 'u2', row: 3, column: 3, value: 'text' },
          { sheetId: 'u1', row: 4, column: 4, value: false },
        ],
      }),
    ],
    note: 'formula values grouped by sheet',
  },
  {
    args: [NAMES, saveRequest({ formulaValues: [{ sheetId: 'zz', row: 0, column: 0, value: 1 }] })],
    note: 'a value on an unknown sheet',
  },
  {
    args: [
      NAMES,
      saveRequest({
        redactionStates: [
          {
            sheetName: 'Sheet1',
            marks: [
              {
                startRow: 0,
                endRow: 1,
                startColumn: 0,
                endColumn: 1,
                label: 'L',
                previousFill: '#fff',
              },
              { startRow: 2, endRow: 3, startColumn: 2, endColumn: 3, previousFill: null },
              { startRow: 4, endRow: 5, startColumn: 4, endColumn: 5, extra: 'dropped' },
            ],
          },
          { marks: [] },
        ],
      }),
    ],
    note: 'redaction marks: previousFill carried when the key is there',
  },
  { args: [NAMES, saveRequest({ redactionStates: [] })], note: 'no marks' },
  { args: [NAMES, saveRequest({ redactionStates: null })], note: 'marks never loaded' },
  {
    args: [
      NAMES,
      saveRequest({
        pivotRefreshUpdates: [
          { cachePath: '/c1', sheetId: 'u1', newOutputRef: 'A1:C9' },
          {
            cachePath: '/c2',
            sheetId: 'u2',
            newOutputRef: 'B2:D8',
            relayout: {
              sheetId: 'ignored',
              sourceSheetId: 'u3',
              rows: 3,
              sourceSheetName: 'replaced',
            },
          },
        ],
      }),
    ],
    note: 'pivot refresh updates with and without a relayout',
  },
  {
    args: [
      NAMES,
      saveRequest({
        pivotRefreshUpdates: [
          { cachePath: '/c', sheetId: 'u1', newOutputRef: 'A1', relayout: { sourceSheetId: 'zz' } },
        ],
      }),
    ],
    note: 'a relayout over an unknown source',
  },
  {
    args: [
      NAMES,
      saveRequest({
        pivotRefreshUpdates: [{ cachePath: '/c', sheetId: 'zz', newOutputRef: 'A1' }],
      }),
    ],
    note: 'an update on an unknown sheet',
  },
  { args: [NAMES, saveRequest({ edits: undefined })], note: 'no edits at all' },
  { args: [NAMES, saveRequest({ slicerState: undefined })], note: 'no slicer state at all' },
  {
    args: [
      NAMES,
      saveRequest({
        edits: [{ sheetId: 'zz' }],
        structuralOps: [{ sheetId: 'yy' }],
        sheetOps: [{ kind: 'rename-sheet', sheetId: 'xx' }],
      }),
    ],
    note: 'the first unknown sheet to be read is the one named: sheet ops first',
  },
  {
    args: [NAMES, saveRequest({ edits: [{ sheetId: 'zz' }], structuralOps: [{ sheetId: 'yy' }] })],
    note: 'edits before structural ops',
  },
  {
    args: [
      NAMES,
      saveRequest({
        filterStates: [{ sheetId: 'ww' }],
        hyperlinkEdits: [{ sheetId: 'vv' }],
        structuralOps: [{ sheetId: 'yy' }],
      }),
    ],
    note: 'structural ops before filters before links',
  },
  {
    args: [
      [
        ['u1', ''],
        ['u2', 'B'],
      ],
      saveRequest({
        sheetOps: [{ kind: 'duplicate-sheet', sheetId: 'd1', sourceSheetId: 'u1', name: 'C' }],
      }),
    ],
    note: 'a duplicate of a file sheet whose name is empty is refused',
  },
]

const workbookSaveResolve: Record<string, FnSpec> = {
  'workbook-save-resolve.resolveWorkbookSave': {
    ts: (a) => resolveWorkbookSave(new Map(a[0] as [string, string][]), a[1] as Any),
    cases: resolveCases,
  },
}

// ---- xlsx-sidecar-client ----

type ClientStep = {
  op: string
  label?: string
  method?: string
  args?: unknown[]
  id?: number
  child?: number
  text?: string
  code?: number | null
  signal?: string | null
  message?: string
  index?: number
  error?: string | null
  timer?: number
}

interface FakeProcess {
  child: Any
  exited: boolean
  stderrHandler: ((chunk: string) => void) | null
  lineHandler: ((line: string) => void) | null
  closed: boolean
}

async function clientScenario(a: unknown[], cx: TsContext): Promise<unknown> {
  const [binaryPath, options, steps] = a as [string, { spawnFailures?: unknown[] }, ClientStep[]]
  const failures = options.spawnFailures ?? []
  const processes: FakeProcess[] = []
  let attempts = 0
  let uuids = 0
  const writeCallbacks: ((error?: Error) => void)[] = []
  const timers: { fn: () => void; active: boolean; id: number }[] = []
  const stdouts = new Map<object, FakeProcess>()

  const fakeSpawn = (path: string): unknown => {
    cx.log('spawn', path)
    const failure = failures[attempts]
    attempts += 1
    if (failure !== null && failure !== undefined) {
      throw typeof failure === 'string' ? new Error(failure) : (failure as { value: unknown }).value
    }
    const index = processes.length
    const child = new EventEmitter() as Any
    const proc: FakeProcess = {
      child,
      exited: false,
      stderrHandler: null,
      lineHandler: null,
      closed: false,
    }
    child.pid = 1000 + index
    child.killed = false
    child.stdin = Object.assign(new EventEmitter(), {
      write(data: string, callback?: (error?: Error) => void): boolean {
        cx.log('write', data, typeof callback === 'function')
        if (callback) writeCallbacks.push(callback)
        return true
      },
    })
    child.stdout = {}
    child.stderr = {
      setEncoding(): void {},
      on(event: string, handler: (chunk: string) => void): void {
        if (event === 'data') proc.stderrHandler = handler
      },
    }
    child.kill = (): boolean => {
      cx.log('kill')
      const sent = !proc.exited
      if (sent) child.killed = true
      return sent
    }
    stdouts.set(child.stdout, proc)
    processes.push(proc)
    return child
  }
  const fakeCreateInterface = (opts: { input: object }): unknown => {
    const proc = stdouts.get(opts.input) as FakeProcess
    return {
      on(event: string, handler: (line: string) => void): void {
        if (event === 'line') proc.lineHandler = handler
      },
      close(): void {
        cx.log('closeLines')
        proc.closed = true
      },
    }
  }

  const realSpawn = childProcess.spawn
  const realCreateInterface = readline.createInterface
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realWarn = console.warn
  const cryptoObject = globalThis.crypto as Any
  ;(childProcess as Any).spawn = fakeSpawn
  ;(readline as Any).createInterface = fakeCreateInterface
  syncBuiltinESMExports()
  ;(globalThis as Any).setTimeout = (fn: () => void, ms: number) => {
    cx.log('setTimeout', ms)
    const timer = { fn, active: true, id: timers.length + 1 }
    timers.push(timer)
    return timer
  }
  ;(globalThis as Any).clearTimeout = (timer: { id: number; active: boolean }) => {
    cx.log('clearTimeout', timer.id)
    timer.active = false
  }
  console.warn = (...args: unknown[]) => {
    cx.log('warn', ...args.map((x) => (x instanceof Error ? x.message : x)))
  }
  Object.defineProperty(cryptoObject, 'randomUUID', {
    value: () => {
      uuids += 1
      return `uuid-${uuids}`
    },
    configurable: true,
    writable: true,
  })
  try {
    const client = new XlsxSidecarClient(binaryPath)
    const offs = new Map<number, () => unknown>()
    const outcomes: Record<string, unknown> = {}
    const results: unknown[] = []
    for (const step of steps) {
      const target = (): FakeProcess => processes[step.child ?? processes.length - 1] as FakeProcess
      switch (step.op) {
        case 'call': {
          const label = step.label as string
          const callArgs = (step.args ?? []).map((x) => (x === null ? undefined : x))
          outcomes[label] = 'pending'
          ;(client as Any)[step.method as string](...callArgs).then(
            (value: unknown) => {
              outcomes[label] = value === undefined ? {} : { ok: value }
            },
            (error: Error) => {
              outcomes[label] = { err: error.message }
            },
          )
          results.push(null)
          break
        }
        case 'start':
          client.start()
          results.push(null)
          break
        case 'stop':
          client.stop()
          results.push(null)
          break
        case 'pid':
          results.push(client.getProcessId())
          break
        case 'onExit': {
          const id = step.id as number
          offs.set(
            id,
            client.onProcessExit(() => cx.log('exitListener', id)),
          )
          results.push(null)
          break
        }
        case 'offExit':
          results.push((offs.get(step.id as number) as () => unknown)())
          break
        case 'line': {
          const proc = target()
          if (!proc.closed) proc.lineHandler?.(step.text as string)
          results.push(null)
          break
        }
        case 'stderr':
          target().stderrHandler?.(step.text as string)
          results.push(null)
          break
        case 'exit': {
          const proc = target()
          proc.exited = true
          proc.child.emit('exit', step.code ?? null, step.signal ?? null)
          results.push(null)
          break
        }
        case 'error':
          target().child.emit('error', new Error(step.message as string))
          results.push(null)
          break
        case 'stdinError':
          target().child.stdin.emit('error', new Error('write EPIPE'))
          results.push(null)
          break
        case 'writeDone': {
          const callback = writeCallbacks[step.index as number] as (error?: Error) => void
          callback(step.error == null ? undefined : new Error(step.error))
          results.push(null)
          break
        }
        default: {
          const timer = timers[(step.timer as number) - 1]
          if (timer?.active) {
            timer.active = false
            timer.fn()
          }
          results.push(null)
        }
      }
      await tick()
    }
    return { results, outcomes }
  } finally {
    ;(childProcess as Any).spawn = realSpawn
    ;(readline as Any).createInterface = realCreateInterface
    syncBuiltinESMExports()
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    console.warn = realWarn
    delete cryptoObject.randomUUID
  }
}

const ok = (requestId: string, result?: unknown): string =>
  JSON.stringify({ version: 1, requestId, ok: true, ...(result === undefined ? {} : { result }) })
const fail = (requestId: string, error?: unknown): string =>
  JSON.stringify({ version: 1, requestId, ok: false, ...(error === undefined ? {} : { error }) })

const open = (label: string, ...rest: unknown[]): ClientStep => ({
  op: 'call',
  label,
  method: 'open',
  args: ['/a/b.xlsx', ...rest],
})
const call = (label: string, method: string, ...args: unknown[]): ClientStep => ({
  op: 'call',
  label,
  method,
  args,
})
const line = (text: string, child?: number): ClientStep => ({
  op: 'line',
  text,
  ...(child === undefined ? {} : { child }),
})

const noFailures = {}

const clientCases: Case[] = [
  { args: ['/bin/sidecar', noFailures, []], note: 'nothing' },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        { op: 'pid' },
        open('a'),
        { op: 'pid' },
        line(ok('uuid-1', { sessionId: 's1' })),
        { op: 'pid' },
      ],
    ],
    note: 'open and its reply; the pid',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a', 'ko', 'yyyy-mm-dd', { timeoutMs: 5000 }),
        open('b', null, null, {}),
        open('c', 'en'),
      ],
    ],
    note: 'open: the locale default, the date format, the timeout',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a', null, null, { timeoutMs: Number.NaN }), open('b', null, null, { timeoutMs: 0 })],
    ],
    note: 'odd timeouts',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'readRange', {
          sessionId: 's',
          sheetId: 'x',
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
        }),
        call('b', 'readFormulaCells', { sessionId: 's', sheetId: 'x' }),
        call('c', 'findCells', { sessionId: 's', needle: 'q' }),
        call('d', 'readRowOutline', { sessionId: 's', sheetId: 'x' }),
        call('e', 'readMedia', { sessionId: 's', visualId: 'v' }),
        line(ok('uuid-1', [1, 2])),
        line(ok('uuid-2')),
        line(ok('uuid-3', null)),
        line(ok('uuid-4', 'text')),
        line(ok('uuid-5', { k: 1 })),
      ],
    ],
    note: 'the reads, answered with every kind of result',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'archiveManifest', '/x.xlsx'),
        call('b', 'readEntries', { path: '/x', entries: ['a'], outputDir: '/o' }),
        call('c', 'scanEntries', { path: '/x', entries: ['a'], needle: 'n' }),
        call('d', 'saveArchive', {
          sourcePath: '/s',
          targetPath: '/t',
          replacements: [],
          removals: [],
          additions: [],
        }),
        call('e', 'recalcCells', { path: '/x', edits: [], reads: [], reportStale: true }),
        call('f', 'updateExternalLinks', { path: '/x', allowRemoteSources: false, baseDir: '/b' }),
        call('g', 'readExternalLinks', { path: '/x' }),
        call('h', 'readExternalLinkUsage', { path: '/x' }),
        call('i', 'listExternalLinks', { path: '/x' }),
      ],
    ],
    note: 'the archive commands: the longer timeout',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'convertWorkbook', { path: '/a.xls', targetPath: '/a.xlsx' }),
        call('b', 'convertWorkbook', { path: '/b.xls', targetPath: '/b.xlsx' }),
        call('c', 'convertWorkbook', { path: '/c.xls', targetPath: '/c.xlsx' }),
        call('d', 'convertWorkbook', { path: '/d.xls', targetPath: '/d.xlsx' }),
        call('e', 'convertWorkbook', { path: '/e.xls', targetPath: '/e.xlsx' }),
        call('f', 'convertWorkbook', { path: '/f.xls', targetPath: '/f.xlsx' }),
        line(ok('uuid-1', { sheets: 3, cells: 40, formulasDropped: 2, extra: 'x' })),
        line(ok('uuid-2', { sheets: '3', cells: null, formulasDropped: 1.5 })),
        line(ok('uuid-3', {})),
        line(ok('uuid-4')),
        line(ok('uuid-5', null)),
        line(ok('uuid-6', 'text')),
      ],
    ],
    note: 'convertWorkbook: a count that is not a number is 0',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'convertToOds', { path: '/a.xlsx', targetPath: '/a.ods' }),
        call('b', 'convertToOds', { path: '/b.xlsx', targetPath: '/b.ods' }),
        call('c', 'convertToOds', { path: '/c.xlsx', targetPath: '/c.ods' }),
        call('d', 'convertToOds', { path: '/d.xlsx', targetPath: '/d.ods' }),
        call('e', 'convertToOds', { path: '/e.xlsx', targetPath: '/e.ods' }),
        line(
          ok('uuid-1', {
            sheets: 2,
            cells: 9,
            formulasDropped: 1,
            dropped: {
              charts: 1,
              images: 2,
              conditionalFormats: 3,
              validations: 4,
              pivots: 5,
              comments: 6,
              macros: 7,
              shapes: 8,
              slicers: 9,
              sparklines: 10,
              extra: 11,
            },
          }),
        ),
        line(ok('uuid-2', { sheets: 1, dropped: { charts: '1', macros: 2 } })),
        line(ok('uuid-3', { dropped: null })),
        line(ok('uuid-4', { dropped: 'text' })),
        line(ok('uuid-5')),
      ],
    ],
    note: 'convertToOds: every count, and what an older sidecar leaves out',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        open('b'),
        open('c'),
        open('d'),
        open('e'),
        line(fail('uuid-1', { code: 'bad', message: 'cannot open' })),
        line(fail('uuid-2')),
        line(fail('uuid-3', { code: 'bad' })),
        line(fail('uuid-4', { message: 5 })),
        line(fail('uuid-5', null)),
      ],
    ],
    note: 'a failure reply: the message, none, a number',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        open('b'),
        open('c'),
        open('d'),
        open('e'),
        line(fail('uuid-1', 'just a string')),
        line(fail('uuid-2', { message: { nested: 1 } })),
        line(fail('uuid-3', { message: [1, null, 2] })),
        line(fail('uuid-4', { message: null })),
        line(fail('uuid-5', { message: '' })),
      ],
    ],
    note: 'more odd failure replies',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        line('not json at all'),
        line(JSON.stringify({ version: 2, requestId: 'uuid-1', ok: true })),
        line(JSON.stringify({ version: 1, ok: true })),
        line(JSON.stringify({ version: 1, requestId: 5, ok: true })),
        line(JSON.stringify({ version: 1, requestId: 'uuid-1', ok: 'yes' })),
        line(JSON.stringify([1, 2])),
        line('"a string"'),
        line('7'),
        line('true'),
        line(''),
        line(ok('uuid-9', 'for nobody')),
        { op: 'exit', code: 3 },
      ],
    ],
    note: 'noise and replies that match nothing; the noise is kept as stderr',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'stderr', text: 'boom: ' },
        { op: 'stderr', text: 'bad things happened\n' },
        { op: 'onExit', id: 0 },
        { op: 'onExit', id: 1 },
        { op: 'offExit', id: 1 },
        { op: 'offExit', id: 1 },
        { op: 'exit', code: 1, signal: null },
        { op: 'pid' },
        open('b'),
        { op: 'pid' },
        { op: 'exit', code: 0 },
      ],
    ],
    note: 'the process dies: pending rejected with its stderr, listeners told, the next request spawns again',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), call('b', 'close', 's'), { op: 'exit', code: 137, signal: 'SIGKILL' }],
    ],
    note: 'exit without stderr: code and signal',
  },
  {
    args: ['/bin/sidecar', noFailures, [open('a'), { op: 'exit' }]],
    note: 'exit with no code and no signal',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), { op: 'stderr', text: '   \n ' }, { op: 'exit', code: 2 }],
    ],
    note: 'a stderr of white space counts as none',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'onExit', id: 0 },
        { op: 'error', message: 'spawn /bin/sidecar ENOENT' },
        { op: 'pid' },
      ],
    ],
    note: 'the error event',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'stderr', text: 'x'.repeat(300) },
        { op: 'onExit', id: 0 },
        { op: 'stdinError' },
        { op: 'pid' },
      ],
    ],
    note: 'stdin error: the message is cut at 200',
  },
  {
    args: ['/bin/sidecar', noFailures, [open('a'), { op: 'stdinError' }]],
    note: 'stdin error without stderr: broken pipe',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), { op: 'stderr', text: 'y'.repeat(9000) + 'END' }, { op: 'exit', code: 1 }],
    ],
    note: 'stderr is kept to its last 8192',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'stderr', text: `${'z'.repeat(8190)}\u{1F600}` },
        { op: 'stderr', text: 'tail' },
        { op: 'exit', code: 1 },
      ],
    ],
    note: 'stderr counted in UTF-16 units, cut between characters',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), line('noise: line one'), line('{broken'), { op: 'exit', code: 1 }],
    ],
    note: 'noise lines end up in the exit message',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        call('b', 'readRange', { sessionId: 's', sheetId: 'x', range: {} }),
        { op: 'timeout', timer: 1 },
        { op: 'timeout', timer: 1 },
        { op: 'timeout', timer: 2 },
        line(ok('uuid-1')),
        line(ok('uuid-2')),
      ],
    ],
    note: 'a timeout: the request is cancelled sidecar-side and rejected; a late reply is dropped; a timer fires once',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'close', 's'),
        { op: 'timeout', timer: 1 },
        call('b', 'close', 's'),
        line(ok('uuid-2')),
      ],
    ],
    note: 'a close that times out is not cancelled',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('r1', 'readRange', { sessionId: 's1', sheetId: 'x', range: {} }),
        call('r2', 'readFormulaCells', { sessionId: 's1', sheetId: 'x' }),
        call('r3', 'findCells', { sessionId: 's2', needle: 'q' }),
        call('r4', 'readRowOutline', { sessionId: 's1', sheetId: 'x' }),
        call('r5', 'readMedia', { sessionId: 's1', visualId: 'v' }),
        call('w1', 'convertWorkbook', { path: '/a', targetPath: '/b', sessionId: 's1' }),
        call('r6', 'readRange', { sessionId: 5, sheetId: 'x', range: {} }),
        call('c', 'close', 's1'),
        call('c2', 'close', '5'),
        line(fail('uuid-1', { message: 'cancelled' })),
        line(ok('uuid-8')),
      ],
    ],
    note: 'close cancels the queued reads of its own session only, then asks to close',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [call('c', 'close', 's1'), line(ok('uuid-1', { ignored: true }))],
    ],
    note: 'close with nothing queued; its reply is dropped',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        call('a', 'findCells', {
          sessionId: 's',
          command: 'other',
          version: 9,
          requestId: 'mine',
          extra: [1, { b: 2 }],
        }),
        call('b', 'readMedia', { sessionId: 's', visualId: 'v', 2: 'two', 10: 'ten', 1: 'one' }),
        call('c', 'readRange', {
          sessionId: 's',
          sheetId: 'x',
          range: { startRow: 1.5, endRow: Number.NaN },
        }),
        call('d', 'readRowOutline', { sessionId: 's', sheetId: '\u{1F600}"\\\n\u2028' }),
      ],
    ],
    note: 'the payload: the input spreads over the command, over version and request id; integer keys first',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'writeDone', index: 0 },
        { op: 'writeDone', index: 0, error: 'EPIPE' },
        line(ok('uuid-1')),
      ],
    ],
    note: 'a stdin write that fails rejects its request; one that succeeds does nothing',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), line(ok('uuid-1')), { op: 'writeDone', index: 0, error: 'late failure' }],
    ],
    note: 'a write failure after the reply is ignored',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        call('b', 'readRange', { sessionId: 's', sheetId: 'x', range: {} }),
        { op: 'onExit', id: 0 },
        { op: 'stop' },
        { op: 'exit', code: 0 },
        { op: 'pid' },
        open('c'),
        { op: 'stop' },
        { op: 'stop' },
      ],
    ],
    note: 'stop: the reader closed, the process killed, pending rejected, no crash notice; the old process exiting later is ignored',
  },
  {
    args: ['/bin/sidecar', noFailures, [{ op: 'stop' }, { op: 'pid' }]],
    note: 'stop before any process',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), { op: 'exit', code: 1 }, { op: 'stop' }, { op: 'pid' }],
    ],
    note: 'stop after the process died',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'stop' },
        line(ok('uuid-1')),
        { op: 'stderr', text: 'late' },
        open('b'),
        { op: 'exit', code: 5, child: 1 },
      ],
    ],
    note: 'a closed reader emits no line; a late stderr is kept; a new process after stop',
  },
  {
    args: [
      '/bin/sidecar',
      { spawnFailures: ['spawn UNKNOWN'] },
      [open('a'), open('b'), { op: 'pid' }, line(ok('uuid-1'))],
    ],
    note: 'a spawn that throws rejects the request; the next one spawns',
  },
  {
    args: [
      '/bin/sidecar',
      { spawnFailures: [{ value: 'a thrown string' }, { value: 42 }, { value: null }] },
      [open('a'), open('b'), open('c'), open('d')],
    ],
    note: 'what is thrown that is not an Error is read as String(value)',
  },
  {
    args: [
      '/bin/sidecar',
      { spawnFailures: ['EACCES'] },
      [{ op: 'start' }, { op: 'pid' }, { op: 'start' }, { op: 'pid' }, { op: 'start' }],
    ],
    note: 'prewarm: a failure is warned, not raised; a spawn that works spawns once',
  },
  {
    args: ['/bin/sidecar', noFailures, [{ op: 'start' }, open('a'), { op: 'start' }]],
    note: 'prewarm before the first request: one process',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'exit', code: 1 },
        open('b'),
        { op: 'stderr', text: 'second process' },
        { op: 'exit', code: 2 },
        { op: 'pid' },
      ],
    ],
    note: "the stderr is the new process's after a respawn",
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        { op: 'onExit', id: 0 },
        { op: 'onExit', id: 1 },
        { op: 'onExit', id: 2 },
        open('a'),
        { op: 'offExit', id: 1 },
        { op: 'exit', code: 1 },
        { op: 'offExit', id: 0 },
      ],
    ],
    note: 'exit listeners are told in the order they subscribed, minus those that left',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), open('b'), open('c'), { op: 'stop' }, { op: 'stop' }],
    ],
    note: 'stop rejects every pending request in order and clears each timer',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [open('a'), { op: 'timeout', timer: 1 }, { op: 'exit', code: 1 }, { op: 'pid' }],
    ],
    note: 'a timeout leaves the process up',
  },
  {
    args: [
      '/bin/sidecar',
      noFailures,
      [
        open('a'),
        { op: 'exit', code: 1 },
        { op: 'onExit', id: 0 },
        open('b'),
        { op: 'error', message: 'oops', child: 0 },
        { op: 'stdinError', child: 0 },
        { op: 'exit', code: 2, child: 0 },
        { op: 'pid' },
      ],
    ],
    note: 'events of a process that is no longer the current one change nothing',
  },
]

const xlsxSidecarClient: Record<string, FnSpec> = {
  'xlsx-sidecar-client.XlsxSidecarClient': {
    ts: (a, cx) => clientScenario(a, cx),
    cases: clientCases,
  },
}

export const group: Group = {
  ...atomicWrite,
  ...closeGuard,
  ...csvDigest,
  ...csvImportLimit,
  ...documentLocale,
  ...importRegistry,
  ...pdfPageVariants,
  ...printOptions,
  ...saveAsFormats,
  ...saveEditsTransfer,
  ...saveFailureLog,
  ...renameSessions,
  ...reopenSessions,
  ...tempFiles,
  ...workbookSaveResolve,
  ...xlsxSidecarClient,
}
