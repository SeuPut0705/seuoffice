/**
 * Group `files`: app routing, recent files, rename validation, the crash log
 * and its heartbeat, and the atomic writers of packages/electron-utils.
 *
 * A function that is only a constant has one answer, so its second case puts
 * a file in the folder: the folder after the call is part of the comparison.
 * A temp file's random name is written `<hex>` on both sides.
 */
import {
  DIAGRAM_RE,
  DOCX_RE,
  EPUB_RE,
  HTML_RE,
  HWP_RE,
  MINDMAP_RE,
  ODS_RE,
  ODT_RE,
  PDF_RE,
  PPTX_RE,
  TEXT_RE,
  WORD97_RE,
  XLSX_RE,
  appForPath,
  documentExtension,
  renameStaysInApp,
} from '../../../apps/shell/src/main/app-routing.ts'
import {
  CRASH_LOG_FILE,
  CRASH_LOG_MAX_BYTES,
  appendCrashLog,
  crashLine,
  errorReason,
} from '../../../apps/shell/src/main/crash-log.ts'
import type { CrashEntry } from '../../../apps/shell/src/main/crash-log.ts'
import {
  HEARTBEAT_FILE,
  HEARTBEAT_MS,
  goneEntryFrom,
  heartbeatPath,
  parseHeartbeat,
  startHeartbeat,
} from '../../../apps/shell/src/main/crash-heartbeat.ts'
import type { Heartbeat } from '../../../apps/shell/src/main/crash-heartbeat.ts'
import {
  EXT_FAMILY,
  STAT_PATHS_MAX,
  capStatPaths,
  matchesExtFamily,
  normalizeRecentQuery,
  pageRecentPaths,
  statPathEntries,
  statPathEntriesAsync,
} from '../../../apps/shell/src/main/recent-files.ts'
import {
  RENAME_ILLEGAL_NAME_CHARS,
  isSameFile,
  isValidRawRenameName,
  isValidRenameName,
  pdfSaveAsTarget,
} from '../../../apps/shell/src/main/rename-validation.ts'
import {
  atomicCopyFile,
  atomicMoveFile,
  atomicWriteFile,
  atomicWriteVia,
  isSaveTempName,
  tempPathBeside,
  writeJsonAtomic,
} from '../../../packages/electron-utils/src/atomic-write.ts'
import { writeFile } from 'node:fs/promises'
import type { Case, FileSpec, Group } from '../types.ts'

const str = (a: unknown[], i: number): string => a[i] as string

/** `RE.test(text)` for each text */
function testing(re: RegExp, texts: string[]) {
  return {
    ts: (a: unknown[]) => re.test(str(a, 0)),
    cases: texts.map((t): Case => ({ args: [t] })),
  }
}

/** a constant: its second case adds a file, so the two answers differ */
function constant(value: unknown) {
  return {
    ts: () => value,
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ] as Case[],
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

/** `new Date()` reads the clock of the call while `fn` runs */
function withClock<T>(now: number, fn: () => T): T {
  const Real = Date
  class Clock extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now)
      else super(...(args as [number]))
    }
    static now(): number {
      return now
    }
  }
  globalThis.Date = Clock as unknown as DateConstructor
  try {
    return fn()
  } finally {
    globalThis.Date = Real
  }
}

/** an error holding the `name` and `code` keys of `value`, or `value` itself */
function thrown(value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { isError?: unknown }).isError === true) {
    const keys = value as Record<string, unknown>
    const error = new Error('message') as Error & { code?: unknown }
    if ('name' in keys) error.name = keys.name as string
    if ('code' in keys) error.code = keys.code
    return error
  }
  return value
}

const date = (a: unknown[], i: number, now: number): Date =>
  a[i] == null ? new Date(now) : new Date(a[i] as number)

const NAMES = [
  'a.docx',
  'A.DOCX',
  'a.Docx ',
  'a.docx\n',
  'a.doc',
  'a.DOT',
  'a.odt',
  'a.ods',
  'a.xlsx',
  'a.xlsm',
  'a.xls',
  'a.csv',
  'a.tsv',
  'a.ppt',
  'a.pptx',
  'a.odp',
  'a.otp',
  'a.pdf',
  'a.PDF',
  'a.pdf\n',
  'a.html',
  'a.htm',
  'a.xhtml',
  'a.xmind',
  'a.mm',
  'a.hwp',
  'a.hwpx',
  'a.hwpxx',
  'a.epub',
  'a.drawio',
  'a.dio',
  'a.vsdx',
  'a.drawio.svg',
  'a.DRAWIO.PNG',
  'a.svg',
  'a.png',
  'a.md',
  'a.markdown',
  'a.txt',
  'a.json',
  'a.jsonl',
  'docx',
  '.docx',
  '.drawio.svg',
  '',
  'a.docx.bak',
  'a.tar.gz',
  'dir.d/noext',
  'C:\\docs\\a.docx',
  '\u00fcn\u00ef\u{1F600}.docx',
  'a.pd\u0066',
  'a.p\u0131df',
  'a.xml\u017F',
  'a.drawio.\u017Fvg',
  'a.\u212Aml',
  'a.\u0130',
]

const MTIME = 1_700_000_000_123

/** files for the stat cases */
const statFiles: Record<string, FileSpec> = {
  'a.docx': { text: 'hello', mtimeMs: MTIME },
  'b.XLSX': { text: '', mtimeMs: 1_600_000_000_000 },
  'c.drawio.svg': { text: '<svg/>', mtimeMs: 1_500_000_000_456 },
  'folder.pdf': { dir: true, mtimeMs: 1_700_000_000_000 },
  '\u00fcn\u00ef\u{1F600}.md': { hex: 'c3a9', mtimeMs: 1_400_000_000_000 },
  noext: { text: 'n', mtimeMs: 1_300_000_000_000 },
}

const statPaths = [
  '$DIR/a.docx',
  '$DIR/b.XLSX',
  '$DIR/c.drawio.svg',
  '$DIR/folder.pdf',
  '$DIR/none.pdf',
  '$DIR/\u00fcn\u00ef\u{1F600}.md',
  '$DIR/noext',
  '',
  '$DIR/a.docx',
]

const statCases: Case[] = [
  {
    args: [statPaths, ['$DIR/a.docx', '$DIR/none.pdf', '$DIR/\u00fcn\u00ef\u{1F600}.md']],
    files: statFiles,
  },
  { args: [statPaths, []], files: statFiles, note: 'nothing starred' },
  { args: [[], ['$DIR/a.docx']], files: statFiles, note: 'no paths' },
  {
    args: [['$DIR/missing.docx', '$DIR/a.docx/inside'], ['$DIR/missing.docx']],
    files: statFiles,
    note: 'missing, and a file used as a folder',
  },
  { args: [['$DIR/folder.pdf/'], []], files: statFiles, note: 'a folder with a trailing slash' },
]

const rawJson = (text: string): unknown => JSON.parse(text)

const PAGE_FILES: Record<string, FileSpec> = {
  'a.docx': { text: 'a', mtimeMs: MTIME },
  'b.doc': { text: 'bb', mtimeMs: MTIME + 1000 },
  'c.odt': { text: 'ccc', mtimeMs: MTIME + 2000 },
  'd.xlsx': { text: 'd', mtimeMs: MTIME + 3000 },
  'e.csv': { text: 'e', mtimeMs: MTIME + 4000 },
  'f.drawio.svg': { text: 'f', mtimeMs: MTIME + 5000 },
  'g.drawio.png': { text: 'g', mtimeMs: MTIME + 6000 },
  'h.svg': { text: 'h', mtimeMs: MTIME + 7000 },
}
const PAGE_PATHS = [
  'a.docx',
  'b.doc',
  'c.odt',
  'd.xlsx',
  'e.csv',
  'f.drawio.svg',
  'g.drawio.png',
  'h.svg',
  'gone.docx',
].map((n) => `$DIR/${n}`)

const pageCase = (raw: unknown, starred: string[] = [], paths: string[] = PAGE_PATHS): Case => ({
  args: [paths, raw, starred],
  files: PAGE_FILES,
})

// a valid heartbeat file as the main process writes it
const beatText = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      version: 1,
      startedAt: 1_794_450_000_000,
      at: 1_794_452_000_000,
      memory: { appMB: 300, heapMB: 90 },
      ...extra,
    },
    null,
    2,
  )

const HEX_OK = 'a.docx.0123456789ab.tmp'

const heartbeatCase = (
  opts: Record<string, unknown>,
  files?: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [
    {
      userDataDir: '$DIR/ud',
      logPath: '$DIR/ud/crash-log.jsonl',
      memory: { appMB: 120, freeMB: 800 },
      steps: [],
      ...opts,
    },
  ],
  files,
  note,
})

const crashLogLines = (n: number, kind = 'renderer'): string =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', kind, n: i }),
  ).join('\n') + '\n'

export const group: Group = {
  'app-routing.DOCX_RE': testing(DOCX_RE, NAMES),
  'app-routing.ODT_RE': testing(ODT_RE, NAMES),
  'app-routing.WORD97_RE': testing(WORD97_RE, NAMES),
  'app-routing.ODS_RE': testing(ODS_RE, NAMES),
  'app-routing.XLSX_RE': testing(XLSX_RE, NAMES),
  'app-routing.PPTX_RE': testing(PPTX_RE, NAMES),
  'app-routing.PDF_RE': testing(PDF_RE, NAMES),
  'app-routing.HTML_RE': testing(HTML_RE, NAMES),
  'app-routing.MINDMAP_RE': testing(MINDMAP_RE, NAMES),
  'app-routing.HWP_RE': testing(HWP_RE, NAMES),
  'app-routing.EPUB_RE': testing(EPUB_RE, NAMES),
  'app-routing.DIAGRAM_RE': testing(DIAGRAM_RE, NAMES),
  'app-routing.TEXT_RE': testing(TEXT_RE, NAMES),
  'app-routing.documentExtension': {
    ts: (a) => documentExtension(str(a, 0)),
    cases: [
      ...NAMES,
      'a.DrAwIo.SvG',
      'x.drawio.svg.png',
      'ABC.\u0131',
      'a.\u03A3',
      'a.\u0130X',
    ].map((n): Case => ({ args: [n] })),
  },
  'app-routing.appForPath': {
    ts: (a) => appForPath(str(a, 0)),
    cases: NAMES.map((n): Case => ({ args: [n] })),
  },
  'app-routing.renameStaysInApp': {
    ts: (a) => renameStaysInApp(str(a, 0), str(a, 1)),
    cases: (
      [
        ['a.docx', 'b.docx'],
        ['a.docx', 'b.odt'],
        ['a.odt', 'b.docx'],
        ['a.odt', 'b.ODT'],
        ['a.docx', 'b.doc'],
        ['a.doc', 'b.dot'],
        ['a.doc', 'b.doc'],
        ['a.docx', 'b.pdf'],
        ['a.docx', 'b.xyz'],
        ['a.xyz', 'b.pdf'],
        ['a.xlsx', 'b.csv'],
        ['a.xlsx', 'b.ods'],
        ['a.ods', 'b.xlsx'],
        ['a.ods', 'b.ODS'],
        ['a.pptx', 'b.ppt'],
        ['a.pptx', 'b.odp'],
        ['a.odp', 'b.otp'],
        ['a.odp', 'b.pptx'],
        ['a.ppt', 'b.PPT'],
        ['a.ppt', 'b.pptx'],
        ['a.pdf', 'b.PDF'],
        ['a.md', 'b.txt'],
        ['a.html', 'b.htm'],
        ['a.xmind', 'b.mm'],
        ['a.xmind', 'b.xmind'],
        ['a.mm', 'b.mm'],
        ['a.drawio', 'b.dio'],
        ['a.drawio', 'b.drawio'],
        ['a.drawio', 'b.drawio.svg'],
        ['a.drawio.svg', 'b.drawio.svg'],
        ['a.drawio.svg', 'b.drawio.png'],
        ['a.drawio.png', 'b.DRAWIO.PNG'],
        ['a.vsdx', 'b.drawio'],
        ['a.drawio.svg', 'b.svg'],
        ['a.hwp', 'b.hwpx'],
        ['a.epub', 'b.epub'],
        ['a.epub', 'b.pdf'],
        ['', 'b.pdf'],
        ['a.docx', ''],
        ['\u00fcn\u00ef.docx', '\u{1F600}.docx'],
      ] as [string, string][]
    ).map(([from, to]): Case => ({ args: [from, to] })),
  },

  'recent-files.STAT_PATHS_MAX': constant(STAT_PATHS_MAX),
  'recent-files.EXT_FAMILY': constant(EXT_FAMILY),
  'recent-files.statPathEntries': {
    ts: (a) => statPathEntries(a[0] as string[], new Set(a[1] as string[])),
    cases: statCases,
  },
  'recent-files.statPathEntriesAsync': {
    ts: (a) => statPathEntriesAsync(a[0] as string[], new Set(a[1] as string[])),
    cases: statCases,
  },
  'recent-files.capStatPaths': {
    ts: (a) => capStatPaths(a[0] as string[]),
    cases: [0, 1, 3, 199, 200, 201, 250].map((n): Case => ({
      args: [Array.from({ length: n }, (_, i) => `p${i}`)],
    })),
  },
  'recent-files.normalizeRecentQuery': {
    ts: (a) => normalizeRecentQuery(a[0]),
    cases: [
      { args: [] },
      { args: [null] },
      { args: [{}] },
      { args: [{ offset: 10, limit: 20 }] },
      { args: [{ offset: '10', limit: '5' }] },
      { args: [{ offset: -5, limit: -1 }] },
      { args: [{ offset: 'abc', limit: 'abc' }] },
      { args: [{ offset: 1.9, limit: 300 }] },
      { args: [{ offset: -0.5, limit: 0.9 }] },
      { args: [{ limit: 0 }] },
      { args: [{ offset: null, limit: null }] },
      { args: [{ offset: true, limit: '0x10' }] },
      { args: [{ offset: '', limit: ' ' }] },
      { args: [{ offset: ' 7 ', limit: '1e2' }] },
      { args: [{ offset: [7], limit: [] }] },
      { args: [{ offset: [1, 2], limit: {} }] },
      { args: [{ offset: 1e300, limit: 1e300 }] },
      { args: [{ offset: '-0', limit: '-0' }] },
      { args: [{ offset: { toString: 1 } }], note: 'an object that converts to no primitive' },
      { args: [{ ext: '.XLSX' }] },
      { args: [{ ext: ' ..Md ' }] },
      { args: [{ ext: '...' }] },
      { args: [{ ext: '' }] },
      { args: [{ ext: 5 }] },
      { args: [{ ext: '\u212A' }] },
      { args: [{ ext: '\u0130' }] },
      { args: [{ ext: '\u00a0Docx\u00a0' }] },
      { args: [{ ext: '\u{1F600}.PNG' }] },
      { args: ['text'] },
      { args: [5] },
      { args: [[1, 2]] },
      { args: [false] },
    ],
  },
  'recent-files.matchesExtFamily': {
    ts: (a) => matchesExtFamily(str(a, 0), str(a, 1)),
    cases: (
      [
        ['docx', 'docx'],
        ['odt', 'docx'],
        ['pdf', 'docx'],
        ['csv', 'xlsx'],
        ['csv', 'csv'],
        ['xlsx', 'xls'],
        ['drawio.svg', 'drawio'],
        ['svg', 'drawio'],
        ['htm', 'html'],
        ['mm', 'xmind'],
        ['json', 'md'],
        ['', ''],
        ['x', 'x'],
        ['DOCX', 'docx'],
        ['x', 'constructor'],
        ['x', '__proto__'],
        ['x', 'toString'],
        ['x', 'hasOwnProperty'],
        ['x', 'valueOf'],
        ['constructor', 'constructor'],
        ['x', 'tostring'],
      ] as [string, string][]
    ).map(([e, f]): Case => ({ args: [e, f] })),
  },
  'recent-files.pageRecentPaths': {
    ts: async (a) => pageRecentPaths(a[0] as string[], a[1], new Set(a[2] as string[])),
    cases: [
      pageCase(undefined),
      pageCase({ limit: 3 }, ['$DIR/a.docx']),
      pageCase({ offset: 3, limit: 3 }),
      pageCase({ offset: '8', limit: '5' }, ['$DIR/gone.docx']),
      pageCase({ offset: 100 }),
      pageCase({ limit: 0 }),
      pageCase({ ext: 'docx' }, ['$DIR/c.odt']),
      pageCase({ ext: '.XLSX' }),
      pageCase({ ext: 'drawio' }),
      pageCase({ ext: 'drawio.png' }),
      pageCase({ ext: 'svg' }),
      pageCase({ ext: 'pdf' }),
      pageCase({ ext: 'docx', offset: 1, limit: 1 }),
      pageCase({ ext: 'constructor' }),
      pageCase({ ext: '__proto__' }),
      pageCase({ ext: 'constructor' }, [], []),
      pageCase(null, [], []),
      pageCase({ offset: { toString: 1 } }),
    ],
  },

  'rename-validation.RENAME_ILLEGAL_NAME_CHARS': testing(RENAME_ILLEGAL_NAME_CHARS, [
    'a',
    'a/b',
    'a\\b',
    'a:b',
    'a*',
    'a?',
    'a"',
    'a<',
    'a>',
    'a|',
    'a\u0000b',
    'a\u001fb',
    'a\u0020b',
    'a\u007fb',
    '\u{1F600}',
    '\u00fcn\u00ef',
    '',
  ]),
  'rename-validation.isValidRawRenameName': {
    ts: (a) => isValidRawRenameName(str(a, 0)),
    cases: renameNames().map((n): Case => ({ args: [n] })),
  },
  'rename-validation.isValidRenameName': {
    ts: (a) => isValidRenameName(str(a, 0)),
    cases: renameNames().map((n): Case => ({ args: [n] })),
  },
  'rename-validation.isSameFile': {
    ts: (a) => isSameFile(str(a, 0), str(a, 1)),
    cases: [
      { args: ['$DIR/a.pdf', '$DIR/a.pdf'], files: { 'a.pdf': 'a' } },
      { args: ['$DIR/a.pdf', '$DIR/b.pdf'], files: { 'a.pdf': 'a', 'b.pdf': 'a' } },
      { args: ['$DIR/a.pdf', '$DIR/./a.pdf'], files: { 'a.pdf': 'a' } },
      { args: ['$DIR/a.pdf', '$DIR/sub/../a.pdf'], files: { 'a.pdf': 'a', sub: { dir: true } } },
      {
        args: ['$DIR/a.pdf', '$DIR/A.PDF'],
        files: { 'a.pdf': 'a' },
        note: 'case variant: same file only on a case-insensitive volume',
      },
      {
        args: ['$DIR/a.pdf', '$DIR/b.pdf'],
        files: { 'a.pdf': 'a', 'b.pdf': { link: 'a.pdf' } },
        note: 'two hard links to one file: two paths, one file',
      },
      {
        args: ['$DIR/a.pdf', '$DIR/sub/b.pdf'],
        files: { 'a.pdf': 'a', sub: { dir: true }, 'sub/b.pdf': { link: 'a.pdf' } },
        note: 'a hard link in another folder',
      },
      { args: ['$DIR/a.pdf', '$DIR/none.pdf'], files: { 'a.pdf': 'a' } },
      { args: ['$DIR/none.pdf', '$DIR/a.pdf'], files: { 'a.pdf': 'a' } },
      { args: ['$DIR/none.pdf', '$DIR/none.pdf'] },
      { args: ['$DIR/sub', '$DIR/sub'], files: { sub: { dir: true } } },
      { args: ['$DIR/sub', '$DIR/a.pdf'], files: { sub: { dir: true }, 'a.pdf': 'a' } },
      { args: ['', ''] },
    ],
  },
  'rename-validation.pdfSaveAsTarget': {
    ts: (a) => pdfSaveAsTarget(a[0] as { canceled: boolean; filePath?: string }, str(a, 1)),
    cases: [
      {
        args: [{ canceled: false, filePath: '$DIR/copy.pdf' }, '$DIR/open.pdf'],
        files: { 'open.pdf': 'a', 'copy.pdf': { link: 'open.pdf' } },
        note: 'the pick is a hard link to the open file: no copy onto itself',
      },
      {
        args: [{ canceled: true, filePath: '$DIR/b.pdf' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a', 'b.pdf': 'b' },
      },
      { args: [{ canceled: false }, '$DIR/a.pdf'], files: { 'a.pdf': 'a' } },
      { args: [{ canceled: false, filePath: '' }, '$DIR/a.pdf'], files: { 'a.pdf': 'a' } },
      {
        args: [{ canceled: false, filePath: '$DIR/a.pdf' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a' },
      },
      {
        args: [{ canceled: false, filePath: '$DIR/./a.pdf' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a' },
      },
      {
        args: [{ canceled: false, filePath: '$DIR/A.PDF' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a' },
        note: 'case variant',
      },
      {
        args: [{ canceled: false, filePath: '$DIR/b.pdf' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a', 'b.pdf': 'b' },
      },
      {
        args: [{ canceled: false, filePath: '$DIR/new.pdf' }, '$DIR/a.pdf'],
        files: { 'a.pdf': 'a' },
      },
      { args: [{ canceled: false, filePath: '$DIR/new.pdf' }, '$DIR/none.pdf'] },
    ],
  },

  'crash-log.CRASH_LOG_FILE': constant(CRASH_LOG_FILE),
  'crash-log.CRASH_LOG_MAX_BYTES': constant(CRASH_LOG_MAX_BYTES),
  'crash-log.crashLine': {
    ts: (a, cx) => crashLine(a[0] as CrashEntry, date(a, 1, cx.now)),
    cases: [
      {
        args: [
          {
            kind: 'renderer',
            reason: 'crashed',
            exitCode: 139,
            editor: 'docs',
            process: 'GPU',
            program: 'claude',
            cause: 'TypeError:ENOENT',
            appMB: 512,
            freeMB: 100,
            totalMB: 16384,
            aiStreams: 2,
            cliChildren: 0,
            mainMB: 300,
            heapMB: 90,
            heapLimitMB: 4096,
            upMin: 12,
            beatAgeMin: 1,
          },
        ],
      },
      { args: [{ kind: 'low-memory' }] },
      { args: [{}], note: 'no kind: the key is left out' },
      { args: [{ kind: null }] },
      {
        args: [{ kind: { a: 1, 2: 'x', 10: 'y' } }],
        note: 'kind is written as given, integer keys first',
      },
      { args: [{ kind: 'main-gone', zzz: 1, reason: 'a'.repeat(48) }] },
      { args: [{ kind: 'x', reason: 'a'.repeat(49) }] },
      { args: [{ kind: 'x', reason: '' }] },
      { args: [{ kind: 'x', reason: '-start', editor: '1', process: 'a b_c.d:e-f' }] },
      {
        args: [
          {
            kind: 'x',
            reason: 'C:\\Users\\me\\doc.docx',
            editor: 'a/b',
            process: 'two\nlines',
            program: 'tail\n',
          },
        ],
      },
      { args: [{ kind: 'x', reason: '\u00e9', editor: '\u{1F600}', cause: 'caf\u00e9' }] },
      { args: [{ kind: 'x', reason: 5, editor: null, process: [], program: {}, cause: true }] },
      { args: [{ kind: 'x', exitCode: 1.5 }] },
      { args: [{ kind: 'x', exitCode: '1' }] },
      { args: [{ kind: 'x', exitCode: -3 }] },
      { args: [{ kind: 'x', exitCode: 0 }] },
      { args: [{ kind: 'x', exitCode: 1e21 }] },
      {
        args: [
          {
            kind: 'x',
            appMB: -1,
            freeMB: 1.5,
            totalMB: '5',
            aiStreams: 0,
            cliChildren: 1e21,
            mainMB: null,
          },
        ],
      },
      { args: [{ kind: 'x', upMin: 3, beatAgeMin: 4, heapLimitMB: 4294967296 }] },
      { args: [{ kind: 'x', at: 'ignored', version: 1 }] },
      { args: [{ kind: 'x' }, 0] },
      { args: [{ kind: 'x' }, -1] },
      { args: [{ kind: 'x' }, 951_782_400_000] },
      { args: [{ kind: 'x' }, 253_402_300_799_999] },
      { args: [{ kind: 'x' }, 253_402_300_800_000] },
      { args: [{ kind: 'x' }, -62_198_755_200_000] },
      { args: [{ kind: 'x' }, -62_167_219_200_000] },
      { args: [{ kind: 'x' }, 8.64e15] },
      { args: [{ kind: 'x' }, 8.64e15 + 1] },
      { args: [{ kind: 'x' }, 1e20], note: 'an invalid date throws RangeError' },
      { args: [{ kind: 'x' }, 1.9] },
      { args: [{ kind: 'x' }, -1.9] },
    ],
  },
  'crash-log.errorReason': {
    ts: (a) => errorReason(thrown(a[0])),
    cases: [
      { args: [{ isError: true, name: 'TypeError', code: 'ENOENT' }] },
      { args: [{ isError: true }] },
      { args: [{ isError: true, name: 'My Err', code: 5 }] },
      { args: [{ isError: true, name: 'bad/name', code: 'E1' }] },
      { args: [{ isError: true, name: null, code: null }] },
      { args: [{ isError: true, name: '', code: '' }] },
      { args: [{ isError: true, name: 'a'.repeat(49), code: 'b'.repeat(48) }] },
      { args: [{ isError: true, code: 'EACCES' }] },
      { args: [{ isError: true, name: 'caf\u00e9' }] },
      { args: [{ isError: false, name: 'X' }] },
      { args: ['text'] },
      { args: [5] },
      { args: [null] },
      { args: [true] },
      { args: [{}] },
      { args: [[1]] },
      { args: [] },
    ],
  },
  'crash-log.appendCrashLog': {
    ts: (a, cx) =>
      appendCrashLog(
        str(a, 0),
        a[1] as CrashEntry,
        (a[2] ?? undefined) as number | undefined,
        date(a, 3, cx.now),
      ),
    cases: [
      { args: ['$DIR/crash-log.jsonl', { kind: 'renderer', reason: 'crashed' }, null, null] },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'renderer' }, null, null],
        files: { 'crash-log.jsonl': crashLogLines(2) },
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'low-memory', appMB: 1 }, 400, null],
        files: { 'crash-log.jsonl': crashLogLines(8) },
        note: 'past the cap: the oldest lines go',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 401, null],
        files: { 'crash-log.jsonl': crashLogLines(8) },
        note: 'odd cap: half is floored',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 10, null],
        files: { 'crash-log.jsonl': crashLogLines(3) },
        note: 'a cap below one line',
      },
      { args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 0, null], files: { 'crash-log.jsonl': '' } },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 300, null],
        files: { 'crash-log.jsonl': `\n\n${crashLogLines(5)}\n\n` },
        note: 'blank lines are dropped',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 250, null],
        files: {
          'crash-log.jsonl':
            '{"k":"\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9"}\n{"k":"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"}\n{"k":"last"}\n',
        },
        note: 'bytes, not characters',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 200, null],
        files: {
          'crash-log.jsonl': {
            hex:
              '7b2261223a2201ff227d0a' +
              '7b2262223a317d0a' +
              '7b2263223a317d0a' +
              '7b2264223a317d0a' +
              '7b2265223a317d0a',
          },
        },
        note: 'invalid UTF-8 in the old log',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 100, null],
        files: { 'crash-log.jsonl': { dir: true } },
        note: 'the log is a folder: best effort',
      },
      {
        args: ['$DIR/none/crash-log.jsonl', { kind: 'x' }, null, null],
        note: 'no folder: best effort',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, null, null],
        files: { 'crash-log.jsonl': { text: crashLogLines(2), mode: 0o444 } },
        note: 'read-only log',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 100, null],
        files: { 'crash-log.jsonl': { text: crashLogLines(5), mode: 0o444 } },
        note: 'read-only log past the cap',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, null, 1e20],
        note: 'an invalid date throws before the file is touched',
      },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, null, 253_402_300_800_000],
        files: { 'crash-log.jsonl': crashLogLines(1) },
      },
      { args: ['$DIR/crash-log.jsonl', { kind: 'x' }, null, 0] },
      {
        args: ['$DIR/crash-log.jsonl', { kind: 'x' }, 80, null],
        files: { 'crash-log.jsonl': 'line-0001\nline-0002\nline-0003\nline-0004\n' },
        note: 'the new line (45 bytes) tips 40 + 45 over 80; the kept tail is exactly the budget of 40',
      },
    ],
  },

  'crash-heartbeat.HEARTBEAT_FILE': constant(HEARTBEAT_FILE),
  'crash-heartbeat.HEARTBEAT_MS': constant(HEARTBEAT_MS),
  'crash-heartbeat.heartbeatPath': {
    ts: (a) => heartbeatPath(str(a, 0)),
    cases: ['$DIR', '/a/b/', '', 'a', '/a/../b', '\u00fcn\u00ef/\u{1F600}', '/'].map((d): Case => ({
      args: [d],
    })),
  },
  'crash-heartbeat.parseHeartbeat': {
    ts: (a) => parseHeartbeat(a[0]),
    cases: [
      { args: [{ version: 1, startedAt: 10, at: 20, memory: { appMB: 300, heapMB: 90 } }] },
      { args: [{ version: 1, startedAt: 0, at: 0, memory: {}, ended: 'quit' }] },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: {}, ended: 'os' }] },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: {}, ended: 'crash' }] },
      { args: [{ version: 1, startedAt: 10, at: 20, ended: 'quit' }], note: 'no memory' },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: null }] },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: 5 }] },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: 'x' }] },
      {
        args: [{ version: 1, startedAt: 10, at: 20, memory: [1, 2, 'x', -1, 4] }],
        note: 'an array memory: its indexes are the keys',
      },
      {
        args: [
          {
            version: 1,
            startedAt: 10,
            at: 20,
            memory: { b: 1, 10: 2, 2: 3, a: 4, c: 1.5, d: -1, e: '5', f: null, g: 1e21, h: 0 },
          },
        ],
        note: 'integer keys first',
      },
      {
        args: [rawJson('{"version":1,"startedAt":10,"at":20,"memory":{"__proto__":5,"a":1}}')],
        note: 'an own __proto__ key sets no key',
      },
      { args: [{ version: 2, startedAt: 10, at: 20, memory: {} }] },
      { args: [{ version: '1', startedAt: 10, at: 20, memory: {} }] },
      { args: [{ version: 1, startedAt: -1, at: 20, memory: {} }] },
      { args: [{ version: 1, startedAt: 10, at: -0.5, memory: {} }] },
      { args: [{ version: 1, startedAt: 1.5, at: 2.5, memory: {} }] },
      { args: [{ version: 1, startedAt: '10', at: 20, memory: {} }] },
      { args: [{ version: 1, startedAt: 10, memory: {} }] },
      { args: [{ version: 1, startedAt: 10, at: 20, memory: {}, extra: 1 }] },
      { args: [[]] },
      { args: [[1, 2]] },
      { args: ['text'] },
      { args: [5] },
      { args: [0] },
      { args: [''] },
      { args: [false] },
      { args: [null] },
      { args: [] },
    ],
  },
  'crash-heartbeat.goneEntryFrom': {
    ts: (a) => goneEntryFrom(a[0] as Heartbeat | null, a[1] as number),
    cases: [
      { args: [null, 1_794_452_400_000] },
      {
        args: [
          {
            version: 1,
            startedAt: 1_794_450_000_000,
            at: 1_794_452_000_000,
            memory: { appMB: 300, heapMB: 90 },
          },
          1_794_452_400_000,
        ],
      },
      {
        args: [
          {
            version: 1,
            startedAt: 1_794_450_000_000,
            at: 1_794_452_000_000,
            memory: {},
            ended: 'quit',
          },
          1_794_452_400_000,
        ],
      },
      {
        args: [
          {
            version: 1,
            startedAt: 1_794_450_000_000,
            at: 1_794_452_000_000,
            memory: {},
            ended: 'os',
          },
          1_794_452_400_000,
        ],
      },
      {
        args: [{ version: 1, startedAt: 0, at: 59_999, memory: {} }, 0],
        note: 'less than a minute, and a clock before the beat',
      },
      {
        args: [{ version: 1, startedAt: 100, at: 50, memory: { appMB: 1 } }, 60_000_000],
        note: 'a beat before the start',
      },
      {
        args: [
          { version: 1, startedAt: 0, at: 120_000, memory: { kind: 5, upMin: 7, 3: 1, zz: 2 } },
          300_000,
        ],
        note: 'memory keys named like the line',
      },
      { args: [{ version: 1, startedAt: 0, at: 180_000.5, memory: { appMB: 2 } }, 480_000.9] },
    ],
  },
  'crash-heartbeat.startHeartbeat': {
    ts: (a, cx) => {
      const o = a[0] as {
        userDataDir: string
        logPath: string
        memory: unknown
        memoryThrows?: boolean
        writeThrows?: boolean
        steps: string[]
      }
      let clock = cx.now
      const handle = withClock(cx.now, () =>
        startHeartbeat({
          userDataDir: o.userDataDir,
          logPath: o.logPath,
          memory: () => {
            if (o.memoryThrows) throw new Error('memory')
            return o.memory as never
          },
          now: () => clock++,
          intervalMs: 3_600_000,
          ...(o.writeThrows
            ? {
                writeJson: () => {
                  throw new Error('write')
                },
              }
            : {}),
        }),
      )
      for (const step of o.steps) {
        if (step === 'quit') handle.markEnded('quit')
        else if (step === 'os') handle.markEnded('os')
        else handle.stop()
      }
      handle.stop()
      return undefined
    },
    cases: [
      heartbeatCase({}, undefined, 'first run: one beat'),
      heartbeatCase(
        {},
        { 'ud/crash-heartbeat.json': beatText() },
        'the previous run died: a main-gone line',
      ),
      heartbeatCase(
        {},
        { 'ud/crash-heartbeat.json': beatText({ ended: 'quit' }) },
        'the previous run ended on purpose',
      ),
      heartbeatCase(
        {},
        {
          'ud/crash-heartbeat.json': beatText({ ended: 'os' }),
          'ud/crash-log.jsonl': crashLogLines(2),
        },
      ),
      heartbeatCase(
        {},
        { 'ud/crash-heartbeat.json': beatText(), 'ud/crash-log.jsonl': crashLogLines(2) },
        'the line is appended',
      ),
      heartbeatCase({}, { 'ud/crash-heartbeat.json': '{"version":1,' }, 'unreadable heartbeat'),
      heartbeatCase(
        {},
        { 'ud/crash-heartbeat.json': '\ufeff' + beatText() },
        'a byte order mark is no JSON white space',
      ),
      heartbeatCase(
        {},
        { 'ud/crash-heartbeat.json': { dir: true } },
        'a folder where the heartbeat is',
      ),
      heartbeatCase({ steps: ['quit'] }, { 'ud/crash-heartbeat.json': beatText() }),
      heartbeatCase({ steps: ['os'] }),
      heartbeatCase({ steps: ['quit', 'os'] }, undefined, 'the second mark is ignored'),
      heartbeatCase({ steps: ['stop', 'quit'] }, undefined, 'no mark after stop'),
      heartbeatCase(
        { memoryThrows: true, steps: ['quit'] },
        undefined,
        'the beat goes out without figures',
      ),
      heartbeatCase(
        { writeThrows: true, steps: ['quit'] },
        { 'ud/crash-heartbeat.json': beatText() },
        'a writer that throws',
      ),
      heartbeatCase({ memory: { 2: 1, b: 2, 10: 3 } }),
      heartbeatCase(
        { userDataDir: '$DIR/ud', logPath: '$DIR/none/crash-log.jsonl' },
        { 'ud/crash-heartbeat.json': beatText() },
        'a log that cannot be written',
      ),
      heartbeatCase({}, { 'ud/crash-heartbeat.json': beatText({ at: 1e20, startedAt: 1e20 }) }),
    ],
  },

  'atomic-write.isSaveTempName': {
    ts: (a) => isSaveTempName(str(a, 0)),
    cases: [
      HEX_OK,
      'A.0123456789AB.TMP',
      'a.unsaved.tmp',
      'a.UNSAVED.tmp',
      'a.docx.Unsaved.TMP',
      'a.un\u017Faved.tmp',
      '.0123456789ab.tmp',
      'a.0123456789a.tmp',
      'a.0123456789abc.tmp',
      'a.0123456789ag.tmp',
      'x.y.0123456789ab.tmp',
      `${HEX_OK}\n`,
      `${HEX_OK}.bak`,
      'a.0123456789ab.tmp2',
      '\ud55c\uae00.unsaved.tmp',
      '\u{1F600}.0123456789ab.tmp',
      'a\n.unsaved.tmp',
      'unsaved.tmp',
      '.unsaved.tmp',
      '..unsaved.tmp',
      '',
      'a.docx',
    ].map((n): Case => ({ args: [n] })),
  },
  'atomic-write.tempPathBeside': {
    ts: (a) => maskTmp(tempPathBeside(str(a, 0))),
    cases: [
      '$DIR/a.docx',
      'x.txt',
      '',
      '$DIR/dir/',
      '$DIR/' + 'a'.repeat(300),
      '$DIR/' + '\ud55c'.repeat(100) + '.docx',
      '$DIR/' + '\u{1F600}'.repeat(60),
      '$DIR/' + 'a'.repeat(200),
      '$DIR/' + 'a'.repeat(201),
      '$DIR/' + '\u00e9'.repeat(101),
      '/',
      '$DIR/sub/\u00fcn\u00ef.pdf',
    ].map((p): Case => ({ args: [p] })),
  },
  'atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: [
      { args: ['$DIR/a.docx', 'new'] },
      { args: ['$DIR/a.docx', 'new'], files: { 'a.docx': 'old' } },
      { args: ['$DIR/a.docx', ''], files: { 'a.docx': 'old' }, note: 'empty data' },
      {
        args: ['$DIR/a.docx', 'new\u{1F600}'],
        files: { 'a.docx': { text: 'old', mode: 0o444 } },
        note: 'a read-only target is replaced',
      },
      {
        args: ['$DIR/a.docx', 'new'],
        files: { 'a.docx.unsaved.tmp': 'stale' },
        note: 'a stale rescue copy goes',
      },
      {
        args: ['$DIR/a.docx', 'new'],
        files: { a: 'x', 'a.docx.unsaved.tmp': 'stale', 'b.docx.0123456789ab.tmp': 'other' },
      },
      {
        args: ['$DIR/a.docx', 'new'],
        files: { 'a.docx': { dir: true } },
        note: 'a folder as target: rescue copy, then the error',
      },
      {
        args: ['$DIR/a.docx', 'new'],
        files: { 'a.docx': { dir: true }, 'a.docx.unsaved.tmp': 'older rescue' },
        note: 'the rescue copy is replaced',
      },
      { args: ['$DIR/none/a.docx', 'new'], note: 'no folder' },
      {
        args: ['$DIR/ro/a.docx', 'new'],
        files: { 'ro/a.docx': 'old', ro: { dir: true, mode: 0o555 } },
        note: 'a read-only folder',
      },
      {
        args: ['$DIR/f/a.docx', 'new'],
        files: { f: 'a file' },
        note: 'a file where the folder is',
      },
      {
        args: ['$DIR/' + '\ud55c'.repeat(100) + '.docx', 'new'],
        note: 'a long name is cut for the temp',
      },
      { args: ['$DIR/\u00fcn\u00ef\u{1F600}.docx', 'caf\u00e9'] },
    ],
  },
  'atomic-write.atomicCopyFile': {
    ts: (a) => masked(() => atomicCopyFile(str(a, 0), str(a, 1))),
    cases: [
      { args: ['$DIR/src.bin', '$DIR/dst.bin'], files: { 'src.bin': 'source' } },
      { args: ['$DIR/src.bin', '$DIR/dst.bin'], files: { 'src.bin': 'source', 'dst.bin': 'old' } },
      {
        args: ['$DIR/src.bin', '$DIR/dst.bin'],
        files: { 'src.bin': { hex: '00ff10', mode: 0o444 } },
        note: 'a read-only source',
      },
      {
        args: ['$DIR/src.bin', '$DIR/dst.bin'],
        files: { 'src.bin': '', 'dst.bin': 'old', 'dst.bin.unsaved.tmp': 'stale' },
      },
      { args: ['$DIR/missing.bin', '$DIR/dst.bin'], note: 'no source' },
      {
        args: ['$DIR/src.bin', '$DIR/none/dst.bin'],
        files: { 'src.bin': 'source' },
        note: 'no folder',
      },
      {
        args: ['$DIR/src.bin', '$DIR/dst.bin'],
        files: { 'src.bin': 'source', 'dst.bin': { dir: true } },
        note: 'a folder as target',
      },
      {
        args: ['$DIR/src.bin', '$DIR/ro/dst.bin'],
        files: { 'src.bin': 'source', ro: { dir: true, mode: 0o555 } },
        note: 'a read-only folder',
      },
      {
        args: ['$DIR/\u00fcn\u00ef.bin', '$DIR/\u{1F600}.bin'],
        files: { '\u00fcn\u00ef.bin': 'x' },
      },
    ],
  },
  'atomic-write.atomicMoveFile': {
    ts: (a) => masked(() => atomicMoveFile(str(a, 0), str(a, 1))),
    cases: [
      { args: ['$DIR/t.tmp', '$DIR/dst.bin'], files: { 't.tmp': 'temp' } },
      { args: ['$DIR/t.tmp', '$DIR/dst.bin'], files: { 't.tmp': 'temp', 'dst.bin': 'old' } },
      {
        args: ['$DIR/t.tmp', '$DIR/dst.bin'],
        files: { 't.tmp': { text: 'temp', mode: 0o444 }, 'dst.bin': 'old' },
        note: 'a read-only temp',
      },
      { args: ['$DIR/missing.tmp', '$DIR/dst.bin'], note: 'no temp' },
      {
        args: ['$DIR/t.tmp', '$DIR/dst.bin'],
        files: { 't.tmp': 'temp', 'dst.bin': { dir: true } },
        note: 'a folder as target: the temp stays',
      },
      {
        args: ['$DIR/t.tmp', '$DIR/none/dst.bin'],
        files: { 't.tmp': 'temp' },
        note: 'no folder: the temp stays',
      },
      {
        args: ['$DIR/t.tmp', '$DIR/dst.bin'],
        files: { 't.tmp': 'temp', 'dst.bin.unsaved.tmp': 'rescue' },
        note: 'a rescue copy is not cleared by a move',
      },
      { args: ['$DIR/', '$DIR/dst.bin'], note: 'a folder as the temp' },
    ],
  },
  'atomic-write.atomicWriteVia': {
    ts: (a) =>
      masked(() =>
        atomicWriteVia(str(a, 0), async (tmp) => {
          await writeFile(tmp, str(a, 2))
          if (str(a, 1) === 'fail') throw Object.assign(new Error('boom'), { code: 'EBOOM' })
        }),
      ),
    cases: [
      { args: ['$DIR/a.pptx', 'ok', 'streamed'] },
      { args: ['$DIR/a.pptx', 'ok', 'streamed'], files: { 'a.pptx': 'old' } },
      {
        args: ['$DIR/a.pptx', 'fail', 'partial'],
        files: { 'a.pptx': 'old' },
        note: 'the writer fails: the target is untouched, the temp goes',
      },
      {
        args: ['$DIR/a.pptx', 'ok', ''],
        files: { 'a.pptx': 'old', 'a.pptx.unsaved.tmp': 'stale' },
      },
      {
        args: ['$DIR/a.pptx', 'ok', 'streamed'],
        files: { 'a.pptx': { dir: true } },
        note: 'a folder as target',
      },
      { args: ['$DIR/none/a.pptx', 'ok', 'streamed'], note: 'no folder' },
      {
        args: ['$DIR/a.pptx', 'ok', 'streamed'],
        files: { 'a.pptx': { text: 'old', mode: 0o444 } },
      },
    ],
  },
  'atomic-write.writeJsonAtomic': {
    ts: (a) => masked(() => writeJsonAtomic(str(a, 0), a[1])),
    cases: [
      { args: ['$DIR/state.json', { a: 1, b: [1, 2, { c: null }], d: 'x', e: true }] },
      { args: ['$DIR/state.json', { a: 1 }], files: { 'state.json': '{"old":true}' } },
      { args: ['$DIR/state.json', { empty: {}, list: [], nested: { list: [[], {}] } }] },
      {
        args: [
          '$DIR/state.json',
          { n: [0, -1, 1.5, 0.1, 1e21, 1e-7, 123456789012345680000, 5e-324] },
        ],
      },
      {
        args: ['$DIR/state.json', { 10: 'a', 2: 'b', z: 'c', 1: 'd' }],
        note: 'integer keys first',
      },
      { args: ['$DIR/state.json', { s: 'caf\u00e9 \u{1F600} \u2028 \u007f "q" \\ / \n\t\u0001' }] },
      {
        args: ['$DIR/state.json', rawJson('{"__proto__":{"x":1},"a":2}')],
        note: 'an own __proto__ key is written',
      },
      { args: ['$DIR/state.json', []] },
      { args: ['$DIR/state.json', null] },
      { args: ['$DIR/state.json', 'text'] },
      { args: ['$DIR/state.json', 42] },
      { args: ['$DIR/a/b/c/state.json', { deep: true }], note: 'the folders are made' },
      {
        args: ['$DIR/f/state.json', { a: 1 }],
        files: { f: 'a file' },
        note: 'a file where the folder is',
      },
      {
        args: ['$DIR/state.json', { a: 1 }],
        files: { 'state.json': { dir: true } },
        note: 'a folder as target',
      },
      {
        args: ['$DIR/ro/state.json', { a: 2 }],
        files: { 'ro/state.json': '{"a":1}', ro: { dir: true, mode: 0o555 } },
        note: 'a read-only folder: the in-place write',
      },
      {
        args: ['$DIR/ro/state.json', { a: 2 }],
        files: { ro: { dir: true, mode: 0o555 } },
        note: 'a read-only folder, no target: the in-place write fails',
      },
      {
        args: ['$DIR/state.json', { a: 1 }],
        files: { 'state.json': { text: '{"old":1}', mode: 0o444 } },
        note: 'a read-only target',
      },
      { args: ['$DIR/' + '\ud55c'.repeat(100) + '.json', { a: 1 }] },
    ],
  },
}

/** names for the rename gate */
function renameNames(): string[] {
  return [
    'report',
    'report ',
    ' report',
    '\u00a0x',
    'x\u00a0',
    'x\ufeff',
    '\ufeffx',
    'a\u2028',
    'a\u2029b',
    '',
    ' ',
    '.',
    '..',
    'con',
    'CON',
    'CON.pdf',
    'con.',
    'con.a\u2028b',
    'con.a\nb',
    'conx',
    'xcon',
    'nul.txt',
    'aux.',
    'PRN.tar.gz',
    'com1',
    'COM9.txt',
    'com0',
    'com10',
    'lpt1',
    'LPT9.x',
    'lpt0',
    'lpt10',
    'file.',
    'file ',
    'a b',
    'a'.repeat(255),
    'a'.repeat(256),
    '\ud55c'.repeat(255),
    '\ud55c'.repeat(256),
    '\u{1F600}'.repeat(127),
    '\u{1F600}'.repeat(128),
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    'a\u0000b',
    'a\u001fb',
    'a\u007fb',
    'a\tb',
    '\u00fcn\u00ef\u{1F600}.docx',
    'report.docx',
    '.hidden',
    'a.drawio.svg',
  ]
}
