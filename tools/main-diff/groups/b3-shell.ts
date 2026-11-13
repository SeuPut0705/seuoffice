/**
 * Group `b3-shell`: the default-app service, the control server and its
 * handlers, document links, the shell's atomic writer, and the small gates of
 * the PDF, diagram, CSV and feedback code.
 *
 * Fakes record what they are called with as log lines; the same fake exists
 * in crates/main-core/src/calls/b3_shell.rs. A function that is only a
 * constant has one answer, so its second case puts a file in the folder.
 * Functions that answer later (a promise, a timer, a socket) are driven by a
 * list of steps (`ops`) the spec runs in order, with a pause after each step
 * that lets every promise settle.
 *
 * Names that are not exports of their module: `shell-atomic-write.*` is
 * apps/shell/src/main/atomic-write.ts (the electron-utils file of the same
 * name is `atomic-write.*` of group `files`), and `control-server.serve` is
 * the connection function of control-server.ts, which is not exported: the
 * spec reaches it through a real socket.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { atomicCopyFile, atomicWriteFile } from '../../../apps/shell/src/main/atomic-write.ts'
import {
  controlEndpointPath,
  parseEnvelope,
  startControlServer,
} from '../../../apps/shell/src/main/control-server.ts'
import { controlHandler } from '../../../apps/shell/src/main/control-handlers.ts'
import { csvImportLimitMb } from '../../../apps/shell/src/main/csv-import-limit.ts'
import {
  OFFICE_TYPES,
  createDefaultAppService,
  execFileRunner,
  macAppBundlePath,
  parseLinuxStatus,
  parseMacStatus,
  parseRegValue,
} from '../../../apps/shell/src/main/default-app.ts'
import {
  diagramOpenChecking,
  openDiagramChecked,
} from '../../../apps/shell/src/main/diagram-open-gate.ts'
import {
  DOCUMENT_LINKS_FILE,
  DocumentLinks,
  documentLinkMenuModel,
  documentLinksAt,
  handoffStoreEvents,
  isFreshlySavedPath,
  linkPathKey,
  parseDocumentLinks,
  readDocumentLinksFile,
  watchMakeEvents,
} from '../../../apps/shell/src/main/document-links.ts'
import type { DocumentLink } from '../../../apps/shell/src/main/document-links.ts'
import { documentLinkMenuItems } from '../../../apps/shell/src/main/document-links-menu.ts'
import { createDocumentPasswordPrompt } from '../../../apps/shell/src/main/document-password-prompt.ts'
import type { DocumentPasswordPrompt } from '../../../apps/shell/src/main/document-password-prompt.ts'
import {
  FEEDBACK_STRINGS,
  FEEDBACK_SURVEY_URL,
  feedbackDetails,
  feedbackText,
  platformLabel,
} from '../../../apps/shell/src/main/feedback.ts'
import { createPdfConvertUiHandlers } from '../../../apps/shell/src/main/pdf-convert-ui-handlers.ts'
import {
  pdfSaveAsDefaultPath,
  pdfSaveAsFilters,
  pdfSaveAsFormatOf,
  pdfSaveAsPickedPath,
} from '../../../apps/shell/src/main/pdf-save-as-formats.ts'
import {
  CONTROL_FILE,
  CONTROL_MAX_REQUEST_BYTES,
  CONTROL_PROTOCOL,
} from '../../../packages/cli/src/control-protocol.ts'
import type { ControlReply } from '../../../packages/cli/src/control-protocol.ts'
import {
  queueGenerateHandoff,
  recordGenerateConverted,
  reportGenerateRunStarted,
  resetGenerateHandoffsForTest,
  setGenerateTabIdResolver,
  takeGenerateHandoff,
} from '../../../packages/electron-utils/src/generate-handoff.ts'
import '../electron-fake.ts'
import type { Case, FileSpec, Group } from '../types.ts'

// pdf-note-tabs.ts reaches `ipcMain` of 'electron' through the Markdown note
// queue: the shared fake answers it (electron-fake.ts, imported above)
const { insertIntoNoteTab, isNoteFile, openNoteTab } =
  await import('../../../apps/shell/src/main/pdf-note-tabs.ts')

const str = (a: unknown[], i: number): string => a[i] as string
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** a constant: its second case adds a file, so the two answers differ */
function constant(value: unknown) {
  return {
    ts: () => value,
    single: 'a constant',
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

/** a `Date` whose `new Date()` and `Date.now()` read `now` */
function clockClass(now: number): DateConstructor {
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
  return Clock as unknown as DateConstructor
}

/** `new Date()` and `Date.now()` read the clock of the call while `fn` runs */
function withClock<T>(now: number, fn: () => T): T {
  const Real = Date
  globalThis.Date = clockClass(now)
  try {
    return fn()
  } finally {
    globalThis.Date = Real
  }
}

async function withClockAsync<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const Real = Date
  globalThis.Date = clockClass(now)
  try {
    return await fn()
  } finally {
    globalThis.Date = Real
  }
}

/** `process.platform` is `platform` while `fn` runs */
function withPlatform<T>(platform: string, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

/** `console.warn` becomes a log line; an `Error` argument is written as its message */
async function withWarnings<T>(
  log: (...line: unknown[]) => void,
  run: () => Promise<T> | T,
): Promise<T> {
  const real = console.warn
  console.warn = (...line: unknown[]) =>
    log(...line.map((part) => (part instanceof Error ? maskTmp(part.message) : part)))
  try {
    return await run()
  } finally {
    console.warn = real
  }
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')
/** a long argument (a script) is logged as its SHA-1 */
const short = (text: string): string => (text.length > 100 ? `sha1:${sha1(text)}` : text)

// ---------------------------------------------------------------------------
// atomic-write (the shell's), control-protocol, csv-import-limit, feedback,
// pdf-save-as-formats
// ---------------------------------------------------------------------------

const LONG_NAME = '\ud55c'.repeat(70)

function writeCase(args: unknown[], files?: Record<string, FileSpec>, note?: string): Case {
  return { args, ...(files ? { files } : {}), ...(note ? { note } : {}) }
}

const EXISTING = { 'a.docx': 'old text' }

const SOURCE_FILES = { 'src.bin': 'source bytes \u00e9\u{1F600}' }

const pdfSaveAsNames = [
  'a.pdf',
  'A.PDF',
  'a.Pdf',
  'a.pdf.pdf',
  'a.pdfx',
  'a.pdf\n',
  '.pdf',
  'pdf',
  'dir.pdf/b',
  'C:\\dir.pdf\\b.pdf',
  'a.md',
  'a.MD',
  'a.mD',
  'a.docx',
  'a.DOCX',
  'a.pptx',
  'a.xlsx',
  'a.epub',
  'a.png',
  'a.PNG',
  'a.txt',
  'a',
  'a.',
  'a..',
  '',
  '.md',
  '.hidden',
  '/x.y/z',
  '/x.y/.md',
  'dir.md/x',
  'a.md.',
  'a.xl\u017Fx',
  'a.p\u0131ng',
  'a.\u212Aml',
  'a.\u0130',
  'a.PN\u0047',
  '\u00fcn\u00ef\u{1F600}.pdf',
  '\u00fcn\u00ef\u{1F600}.docx',
  '\u00fcn\u00ef.\u{1F600}',
  'a.docx\\b',
  'x/a.b/c.md',
]

const FEEDBACK_PARAMS = [
  { version: '1.2.3', os: 'macOS', language: 'ko' },
  { version: '{os}', os: '{language}', language: '{version}' },
  { version: '\u00fcn\u00ef \u{1F600}', os: '', language: '\u0131\u017F\u212A' },
]

const commonGroup: Group = {
  'shell-atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: [
      writeCase(['$DIR/a.docx', 'new text'], undefined, 'a new file'),
      writeCase(['$DIR/a.docx', 'new text'], EXISTING, 'replaces a file'),
      writeCase(['$DIR/a.docx', ''], EXISTING, 'an empty file replaces text'),
      writeCase(['$DIR/\u00fcn\u00ef.docx', '\u00e9\u{1F600}\ud55c']),
      writeCase(['$DIR/' + LONG_NAME, 'long name'], undefined, 'a name cut for its temp file'),
      writeCase(['$DIR/missing/a.docx', 'x'], undefined, 'no folder: the temp file cannot be made'),
      writeCase(
        ['$DIR/d', 'x'],
        { d: { dir: true } },
        'the target is a folder: the rename fails and the temp file goes',
      ),
      writeCase(
        ['$DIR/' + LONG_NAME, 'x'],
        { [LONG_NAME]: { dir: true } },
        'the same with a long name',
      ),
      writeCase(
        ['$DIR/ro/a.docx', 'x'],
        { ro: { dir: true, mode: 0o555 } },
        'a folder that refuses the temp file',
      ),
      writeCase(['$DIR/a.docx/b', 'x'], EXISTING, 'a file where a folder is expected'),
    ],
  },
  'shell-atomic-write.atomicCopyFile': {
    ts: (a) => masked(() => atomicCopyFile(str(a, 0), str(a, 1))),
    cases: [
      writeCase(['$DIR/src.bin', '$DIR/out.bin'], SOURCE_FILES, 'a new copy'),
      writeCase(['$DIR/src.bin', '$DIR/out.bin'], { ...SOURCE_FILES, 'out.bin': 'old' }),
      writeCase(['$DIR/missing.bin', '$DIR/out.bin'], undefined, 'no source'),
      writeCase(['$DIR/src.bin', '$DIR/nope/out.bin'], SOURCE_FILES, 'no folder for the copy'),
      writeCase(
        ['$DIR/src.bin', '$DIR/d'],
        { ...SOURCE_FILES, d: { dir: true } },
        'the target is a folder',
      ),
      writeCase(['$DIR/src.bin', '$DIR/' + LONG_NAME], SOURCE_FILES, 'a long name'),
    ],
  },

  'control-protocol.CONTROL_FILE': constant(CONTROL_FILE),
  'control-protocol.CONTROL_PROTOCOL': constant(CONTROL_PROTOCOL),
  'control-protocol.CONTROL_MAX_REQUEST_BYTES': constant(CONTROL_MAX_REQUEST_BYTES),

  'csv-import-limit.csvImportLimitMb': {
    ts: (a) => csvImportLimitMb(a[0] as Record<string, unknown>),
    cases: [
      {},
      { csvImportLimitMb: 64 },
      { csvImportLimitMb: 128 },
      { csvImportLimitMb: 256 },
      { csvImportLimitMb: 100 },
      { csvImportLimitMb: 512 },
      { csvImportLimitMb: 0 },
      { csvImportLimitMb: -64 },
      { csvImportLimitMb: 64.5 },
      { csvImportLimitMb: 1e21 },
      { csvImportLimitMb: '64' },
      { csvImportLimitMb: null },
      { csvImportLimitMb: [64] },
      { csvImportLimitMb: { valueOf: 64 } },
      { csvImportLimitMb: true },
      { other: 128, csvImportLimitMb: 128 },
      { 2: 1, csvImportLimitMb: 64, 10: 2 },
    ].map((settings): Case => ({ args: [settings] })),
  },

  'feedback.FEEDBACK_SURVEY_URL': constant(FEEDBACK_SURVEY_URL),
  'feedback.FEEDBACK_STRINGS': constant(FEEDBACK_STRINGS),
  'feedback.feedbackText': {
    ts: (a) => feedbackText(a[0] as 'en' | 'ko', a[1] as 'details', (a[2] ?? undefined) as never),
    cases: [
      ['en', 'menuLabel'],
      ['ko', 'menuLabel'],
      ['en', 'dialogBody'],
      ['ko', 'dialogBody'],
      ['en', 'btnOpen'],
      ['ko', 'btnCancel'],
      ['en', 'details'],
      ['ko', 'details'],
      ['en', 'details', FEEDBACK_PARAMS[0]],
      ['ko', 'details', FEEDBACK_PARAMS[0]],
      ['en', 'details', FEEDBACK_PARAMS[1]],
      ['ko', 'details', FEEDBACK_PARAMS[2]],
      ['en', 'details', { version: 7, os: null, other: 'x' }],
      ['en', 'details', { version: '1', os: 2.5 }],
      ['en', 'details', {}],
      ['en', 'btnOpen', { version: 'x' }],
      ['en', 'nope'],
      ['ko', 'nope', { x: 1 }],
      ['en', ''],
      ['ko', 'DETAILS'],
    ].map((args): Case => ({ args })),
  },
  'feedback.platformLabel': {
    ts: (a) => platformLabel(str(a, 0)),
    cases: [
      'win32',
      'darwin',
      'linux',
      'freebsd',
      'aix',
      'WIN32',
      'Darwin',
      '',
      'win32 ',
      '\u00fcn\u00ef\u{1F600}',
      'linux\n',
      'sunos',
    ].map((p): Case => ({ args: [p] })),
  },
  'feedback.feedbackDetails': {
    ts: (a) =>
      feedbackDetails(
        a[0] as 'en' | 'ko',
        a[1] as { version: string; os: string; language: string },
      ),
    cases: FEEDBACK_PARAMS.flatMap((env) =>
      (['en', 'ko'] as const).map((lang): Case => ({ args: [lang, env] })),
    ),
  },

  'pdf-save-as-formats.pdfSaveAsFilters': {
    ts: (a, cx) =>
      pdfSaveAsFilters((key) => {
        cx.log(key)
        return `${str(a, 0)}${key}`
      }),
    cases: ['', 'T:', '\u00fcn\u00ef \u{1F600} '].map((prefix): Case => ({ args: [prefix] })),
  },
  'pdf-save-as-formats.pdfSaveAsDefaultPath': {
    ts: (a) => pdfSaveAsDefaultPath(str(a, 0)),
    cases: pdfSaveAsNames.map((name): Case => ({ args: [name] })),
  },
  'pdf-save-as-formats.pdfSaveAsPickedPath': {
    ts: (a) => pdfSaveAsPickedPath(str(a, 0)),
    cases: pdfSaveAsNames.map((name): Case => ({ args: [name] })),
  },
  'pdf-save-as-formats.pdfSaveAsFormatOf': {
    ts: (a) => pdfSaveAsFormatOf(str(a, 0)),
    cases: pdfSaveAsNames.map((name): Case => ({ args: [name] })),
  },
}

// ---------------------------------------------------------------------------
// control-server, control-handlers
// ---------------------------------------------------------------------------

const USER_DATA_PATHS = [
  '/Users/x/Library/Application Support/seuoffice',
  '/home/x/.config/seuoffice/',
  '/a/./b/../c',
  'C:\\Users\\x\\AppData\\Roaming\\seuoffice',
  '',
  '.',
  '\u00fcn\u00ef\u{1F600}/\ud55c\uae00',
  '/a//b',
]

const ENVELOPE_LINES: string[] = [
  '{"token":"t","request":{"cmd":"open","path":"/a.docx"}}',
  '{"token":"t","request":{"cmd":"selection","path":"/a.docx"}}',
  '{"token":"t","request":{"cmd":"open","path":"/a.pptx","target":{"kind":"slide","slide":2,"el":"x"}}}',
  '{"request":{"cmd":"open","path":"/a"},"extra":[1,2],"token":"t","2":"b","10":"c","1":"a"}',
  '{"token":"","request":{"cmd":"open","path":""}}',
  '{"token":"t","request":{"cmd":"close","path":"/a"}}',
  '{"token":"t","request":{"cmd":"open","path":5}}',
  '{"token":"t","request":{"cmd":"open"}}',
  '{"token":"t","request":{"path":"/a"}}',
  '{"token":"t","request":{"cmd":"OPEN","path":"/a"}}',
  '{"token":5,"request":{"cmd":"open","path":"/a"}}',
  '{"token":null,"request":{"cmd":"open","path":"/a"}}',
  '{"request":{"cmd":"open","path":"/a"}}',
  '{"token":"t"}',
  '{"token":"t","request":null}',
  '{"token":"t","request":0}',
  '{"token":"t","request":"open"}',
  '{"token":"t","request":[]}',
  '{"token":"t","request":{"cmd":["open"],"path":"/a"}}',
  '[]',
  '[{"token":"t"}]',
  '{}',
  'null',
  'true',
  '5',
  '"str"',
  '',
  ' ',
  '{',
  '{"token":"t","request":{"cmd":"open","path":"/a"}',
  '{"token":"t","request":{"cmd":"open","path":"/a"}}}',
  "{'token':'t'}",
  '\ufeff{"token":"t","request":{"cmd":"open","path":"/a"}}',
  '  {"token":"t","request":{"cmd":"open","path":"/a"}}\r',
  '{"token":"\u00fcn\u00ef\u{1F600}","request":{"cmd":"selection","path":"/\u00e9"}}',
  '{"__proto__":{"x":1},"token":"t","request":{"cmd":"open","path":"/a"}}',
  '{"token":"t","token":"u","request":{"cmd":"open","path":"/a"}}',
  '{"token":"t","request":{"cmd":"open","path":"/a","target":{"b":1,"a":2,"1":3}}}',
  '{"token":"t","request":{"cmd":"open","path":"/a"},"n":1e400,"m":-0,"k":1.50}',
]

/** the case folder as the user-data folder of a server */
async function startAndRead(userData: string): Promise<unknown> {
  let server
  try {
    server = await startControlServer(userData, async () => ({ ok: true, result: {} }))
  } catch (error) {
    const code = (error as { code?: string }).code
    throw Object.assign(new Error(`listen ${code}`), { code })
  }
  const file = join(userData, CONTROL_FILE)
  const text = readFileSync(file, 'utf8')
  const mode = statSync(file).mode & 0o777
  const { token } = server.endpoint
  server.close()
  return {
    endpoint: { ...server.endpoint, token: '<token>', pid: server.endpoint.pid === process.pid },
    file: text.split(token).join('<token>'),
    mode: mode.toString(8),
  }
}

interface ServeOp {
  /** text the client writes; `$TOKEN` is the server's token */
  send?: string
  /** the handler call (by order) that answers now */
  settle?: number
  value?: unknown
  /** rejects with an `Error` of this message */
  reject?: string
  /** rejects with this string, not an `Error` */
  rejectValue?: string
}

/** The token as long as the server's (24 random bytes as hex) */
const TOKEN_LENGTH = 48

/** `send` text of exactly `units` UTF-16 code units once `$TOKEN` is written out */
function envelopeOf(units: number, pad: string): string {
  const frame = (fill: string): string =>
    `{"token":"$TOKEN","request":{"cmd":"selection","path":"/a"},"pad":"${fill}"}\n`
  const base = frame('').length - '$TOKEN'.length + TOKEN_LENGTH
  const count = Math.floor((units - base) / pad.length)
  const text = frame(pad.repeat(count))
  const filler = units - (text.length - '$TOKEN'.length + TOKEN_LENGTH)
  return frame(pad.repeat(count) + 'x'.repeat(filler))
}

const REQUEST_LINE = '{"token":"$TOKEN","request":{"cmd":"open","path":"/a.docx"}}\n'
const OK_REPLY = { ok: true, result: { opened: '/a.docx' } }

async function serve(ops: ServeOp[], log: (...line: unknown[]) => void, dir: string) {
  const calls: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  const server = await startControlServer(
    dir,
    (request) =>
      new Promise<ControlReply>((resolve, reject) => {
        log('handler', request)
        calls.push({ resolve: resolve as (v: unknown) => void, reject })
      }),
  )
  const { token } = server.endpoint
  const socket = connect(server.endpoint.endpoint)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  let received = ''
  let closed = false
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => (received += chunk))
  socket.on('close', () => (closed = true))
  socket.on('error', () => {})
  try {
    for (const op of ops) {
      if (op.send !== undefined) socket.write(op.send.split('$TOKEN').join(token))
      else {
        const call = calls[op.settle!]
        if (op.reject !== undefined) call.reject(new Error(op.reject))
        else if (op.rejectValue !== undefined) call.reject(op.rejectValue)
        else call.resolve(op.value)
      }
      await pause(40)
    }
    await pause(60)
    return {
      outcome: !closed ? 'open' : received ? 'reply' : 'destroyed',
      ...(received ? { reply: received } : {}),
    }
  } finally {
    socket.destroy()
    server.close()
  }
}

const sendOp = (send: string): ServeOp => ({ send })
const settleOp = (settle: number, value: unknown): ServeOp => ({ settle, value })

const serveCases: Case[] = [
  [sendOp(REQUEST_LINE), settleOp(0, OK_REPLY)],
  [
    sendOp(REQUEST_LINE),
    settleOp(0, { ok: false, error: { reason: 'unsupported', message: 'm' } }),
  ],
  [sendOp(REQUEST_LINE)],
  [sendOp(REQUEST_LINE.replace('$TOKEN', 'wrong'))],
  [sendOp(REQUEST_LINE.replace('$TOKEN', '$TOKEN$TOKEN'))],
  [sendOp(REQUEST_LINE.replace('$TOKEN', 'x'.repeat(TOKEN_LENGTH)))],
  [sendOp('{"token":"$TOKEN","request":{"cmd":"close","path":"/a"}}\n')],
  [sendOp('not json\n')],
  [sendOp('\n')],
  [sendOp('{"token":"$TOKEN","request":{"cmd":"open","path":"/a"}}')],
  [
    sendOp('{"token":"$TOKEN","request":'),
    sendOp('{"cmd":"selection","path":"/b"}}\n'),
    settleOp(0, OK_REPLY),
  ],
  [
    sendOp('{"token":"$TOKEN","request":{"cmd":"selection","path":"/b"}}'),
    sendOp('\n'),
    settleOp(0, OK_REPLY),
  ],
  [sendOp(REQUEST_LINE + 'trailing bytes'), settleOp(0, OK_REPLY)],
  [sendOp(REQUEST_LINE), sendOp('more'), settleOp(0, OK_REPLY), settleOp(1, OK_REPLY)],
  [sendOp(REQUEST_LINE), sendOp('more'), settleOp(1, OK_REPLY), settleOp(0, { ok: false })],
  [sendOp(REQUEST_LINE), settleOp(0, OK_REPLY), sendOp(REQUEST_LINE)],
  [sendOp(REQUEST_LINE), { settle: 0, reject: 'the editor crashed' }],
  [sendOp(REQUEST_LINE), { settle: 0, rejectValue: 'plain text' }],
  [sendOp(REQUEST_LINE), settleOp(0, null)],
  [sendOp(REQUEST_LINE), settleOp(0, 0)],
  [sendOp(REQUEST_LINE), settleOp(0, '')],
  [sendOp(REQUEST_LINE), settleOp(0, false)],
  [sendOp(REQUEST_LINE), settleOp(0, 'text')],
  [sendOp(REQUEST_LINE), settleOp(0, [1, 'b'])],
  [
    sendOp(REQUEST_LINE),
    settleOp(0, { 2: 'b', a: 1, 10: 'c', n: 1e21, m: -0, u: '\u00e9\u{1F600}' }),
  ],
  [sendOp(envelopeOf(CONTROL_MAX_REQUEST_BYTES, 'x')), settleOp(0, OK_REPLY)],
  [sendOp(envelopeOf(CONTROL_MAX_REQUEST_BYTES + 1, 'x'))],
  [sendOp(envelopeOf(CONTROL_MAX_REQUEST_BYTES - 1, 'x')), settleOp(0, OK_REPLY)],
  [sendOp(envelopeOf(40_000, '\u00e9')), settleOp(0, OK_REPLY)],
  [sendOp(envelopeOf(60_000, '\u{1F600}')), settleOp(0, OK_REPLY)],
  [sendOp(envelopeOf(66_000, '\u{1F600}'))],
  [sendOp(envelopeOf(66_000, '\u00e9'))],
  [sendOp('x'.repeat(CONTROL_MAX_REQUEST_BYTES + 1))],
  [sendOp('x'.repeat(CONTROL_MAX_REQUEST_BYTES))],
  [
    sendOp('x'.repeat(CONTROL_MAX_REQUEST_BYTES / 2)),
    sendOp('y'.repeat(CONTROL_MAX_REQUEST_BYTES / 2)),
    sendOp('z'),
  ],
  [],
].map((ops): Case => ({ args: [ops] }))

const controlGroup: Group = {
  'control-server.controlEndpointPath': {
    ts: (a) => withPlatform(str(a, 1), () => controlEndpointPath(str(a, 0))),
    cases: ['darwin', 'linux', 'win32'].flatMap((platform) =>
      USER_DATA_PATHS.map((path): Case => ({ args: [path, platform] })),
    ),
  },
  'control-server.parseEnvelope': {
    ts: (a) => parseEnvelope(str(a, 0)),
    cases: ENVELOPE_LINES.map((line): Case => ({ args: [line] })),
  },
  'control-server.startControlServer': {
    ts: (a) => startAndRead(str(a, 0)),
    cases: [
      { args: ['$DIR'], note: 'a new server' },
      {
        args: ['$DIR'],
        files: { 'control.sock': 'stale' },
        note: 'a stale socket path is removed',
      },
      {
        args: ['$DIR'],
        files: { 'control.json': { text: 'old', mode: 0o644 } },
        note: 'an old control file keeps its mode',
      },
      {
        args: ['$DIR'],
        files: { 'control.sock': { dir: true } },
        note: 'the socket path is a folder: it cannot be removed and the listen fails',
      },
      { args: ['$DIR/\u00fcn\u00ef \u{1F600}'], files: { '\u00fcn\u00ef \u{1F600}/x': '1' } },
    ],
  },
  'control-server.serve': {
    ts: (a, cx) => serve(a[0] as ServeOp[], cx.log, cx.dir),
    cases: serveCases,
  },
}

/** the ops of `controlHandler` */
interface ContentsCfg {
  destroyed?: boolean
  /** `isLoading()` answers, one per call, the last one for every later call */
  loading?: boolean[]
  /** `executeJavaScript` answers; `{ $undefined: true }` and `{ $reject: true }` are those */
  replies?: unknown[]
}

interface TabCfg {
  path: string
  id: string
  kind: string
  contents: string
}

interface ControlCfg {
  tabs?: TabCfg[]
  /** `openDocument(path)` adds this tab and answers true; any other path answers false */
  opens?: TabCfg[]
  contents?: Record<string, ContentsCfg>
  readyTimeoutMs?: number
}

async function runControl(
  cfg: ControlCfg,
  requests: unknown[],
  cx: { now: number; log: (...line: unknown[]) => void },
) {
  const tabs = [...(cfg.tabs ?? [])]
  const states = new Map<string, { loading: number; reply: number }>()
  const contentsOf = (name: string) => {
    const state = states.get(name) ?? { loading: 0, reply: 0 }
    states.set(name, state)
    const spec = cfg.contents?.[name] ?? {}
    return {
      isDestroyed: () => {
        cx.log('isDestroyed', name)
        return spec.destroyed === true
      },
      isLoading: () => {
        cx.log('isLoading', name)
        const seq = spec.loading ?? []
        const answer = seq.length === 0 ? false : seq[Math.min(state.loading, seq.length - 1)]
        state.loading += 1
        return answer
      },
      executeJavaScript: async (script: string, gesture: boolean) => {
        cx.log('exec', name, script, gesture)
        const seq = spec.replies ?? []
        const reply = seq.length === 0 ? undefined : seq[Math.min(state.reply, seq.length - 1)]
        state.reply += 1
        const marker = reply as { $undefined?: boolean; $reject?: boolean } | undefined
        if (marker?.$reject) throw new Error('executeJavaScript refused')
        if (reply === undefined || marker?.$undefined) return undefined
        return clone(reply)
      },
    }
  }
  const tabFor = (t: Omit<TabCfg, 'path'>) => ({
    id: t.id,
    kind: t.kind,
    webContents: contentsOf(t.contents),
  })
  const host = {
    reveal: () => cx.log('reveal'),
    openDocument: (path: string) => {
      cx.log('openDocument', path)
      const added = cfg.opens?.find((o) => o.path === path)
      if (!added) return false
      tabs.push({ ...added })
      return true
    },
    activateTab: (id: string) => cx.log('activateTab', id),
    findTab: (path: string) => {
      cx.log('findTab', path)
      const tab = tabs.find((t) => t.path === path)
      return tab ? tabFor(tab) : undefined
    },
    ...(cfg.readyTimeoutMs !== undefined ? { readyTimeoutMs: cfg.readyTimeoutMs } : {}),
  }
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  let clock = cx.now
  Date.now = () => clock
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    clock += ms ?? 0
    cx.log('wait', ms)
    queueMicrotask(callback)
    return 0
  }) as unknown as typeof setTimeout
  try {
    const handler = controlHandler(host as never)
    const replies: unknown[] = []
    for (const request of requests) replies.push(await handler(request as never))
    return replies
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSetTimeout
  }
}

const OK_JS = { status: 'ok', result: { selection: 'A1', n: 1e21, '2': 'b', a: 1, '10': 'c' } }
const SLIDES = { path: '$DIR/a.pptx', id: 't1', kind: 'slides', contents: 'c1' }
const DOCS = { path: '$DIR/a.docx', id: 't2', kind: 'docs', contents: 'c2' }
const SHEETS = { path: '$DIR/a.xlsx', id: 't3', kind: 'sheets', contents: 'c3' }
const PDF = { path: '$DIR/a.pdf', id: 't4', kind: 'pdf', contents: 'c4' }
const FILES_ALL: Record<string, FileSpec> = {
  'a.pptx': 'x',
  'a.docx': 'x',
  'a.xlsx': 'x',
  'a.pdf': 'x',
  'a.txt': 'x',
  '\u00fcn\u00ef \u{1F600}.docx': 'x',
}
const open = (path: string, target?: unknown) => ({
  cmd: 'open',
  path,
  ...(target === undefined ? {} : { target }),
})
const selection = (path: string) => ({ cmd: 'selection', path })

function controlCase(
  cfg: ControlCfg,
  requests: unknown[],
  note: string,
  files: Record<string, FileSpec> = FILES_ALL,
): Case {
  return { args: [cfg, requests], files, note }
}

const controlHandlerGroup: Group = {
  'control-handlers.controlHandler': {
    ts: (a, cx) => runControl(a[0] as ControlCfg, a[1] as unknown[], cx),
    cases: [
      controlCase({}, [open('$DIR/none.docx'), selection('$DIR/none.docx')], 'a missing file'),
      controlCase(
        { tabs: [SLIDES] },
        [open('$DIR/a.pptx')],
        'an open tab is activated and nothing is asked',
      ),
      controlCase(
        { opens: [{ path: '$DIR/a.docx', id: 'n', kind: 'docs', contents: 'cn' }] },
        [open('$DIR/a.docx')],
        'a file with no tab opens',
      ),
      controlCase({}, [open('$DIR/a.docx')], 'a file that cannot be opened'),
      controlCase(
        {
          opens: [{ path: '$DIR/a.docx', id: 'n', kind: 'docs', contents: 'cn' }],
          contents: { cn: { replies: [OK_JS] } },
        },
        [open('$DIR/a.docx', { kind: 'block', block: 3 })],
        'opened, then the target goes to the new tab',
        { ...FILES_ALL },
      ),
      controlCase(
        {
          tabs: [SLIDES],
          contents: { c1: { replies: [OK_JS] } },
        },
        [open('$DIR/a.pptx', { kind: 'slide', slide: 2, el: 'x', 2: 1, b: 2, 10: 3 })],
        'a slide target answered ok',
      ),
      controlCase(
        {
          tabs: [DOCS, SHEETS, PDF],
          contents: {
            c2: { replies: [OK_JS] },
            c3: { replies: [OK_JS] },
            c4: { replies: [OK_JS] },
          },
        },
        [
          open('$DIR/a.docx', { kind: 'block', block: 1 }),
          open('$DIR/a.xlsx', { kind: 'range', sheet: 'S', range: 'A1:B2' }),
          open('$DIR/a.pdf', { kind: 'page', page: 4 }),
        ],
        'every kind of tab with its own target',
      ),
      controlCase(
        { tabs: [DOCS, SLIDES, SHEETS, PDF] },
        [
          open('$DIR/a.docx', { kind: 'slide', slide: 1 }),
          open('$DIR/a.pptx', { kind: 'page', page: 1 }),
          open('$DIR/a.xlsx', { kind: 'block', block: 1 }),
          open('$DIR/a.pdf', { kind: 'range', range: 'A1' }),
        ],
        'a target of another kind than the tab takes',
      ),
      controlCase(
        {
          tabs: [{ path: '$DIR/a.docx', id: 'm', kind: 'mindmap', contents: 'cm' }],
          readyTimeoutMs: 500,
        },
        [
          open('$DIR/a.docx', { kind: 'slide' }),
          open('$DIR/a.docx', { kind: 'target' }),
          open('$DIR/a.docx', 'text'),
          open('$DIR/a.docx', 5),
          open('$DIR/a.docx', [1]),
        ],
        'a tab kind that takes no target',
      ),
      controlCase(
        {
          tabs: [{ path: '$DIR/a.docx', id: 'm', kind: 'mindmap', contents: 'cm' }],
          contents: { cm: { replies: [{ status: 'ok', result: { reached: true } }] } },
        },
        [open('$DIR/a.docx', {}), open('$DIR/a.docx', { kind: null })],
        'a target without a kind on a kind that has none passes the check',
      ),
      controlCase(
        { tabs: [{ path: '$DIR/a.docx', id: 'x', kind: 'toString', contents: 'cx' }] },
        [open('$DIR/a.docx', { kind: 'toString' }), open('$DIR/a.docx', { kind: 'slide' })],
        'a tab kind the table inherits from Object.prototype',
      ),
      controlCase(
        { tabs: [DOCS, { path: '$DIR/a.pptx', id: 'p', kind: '__proto__', contents: 'cp' }] },
        [open('$DIR/a.pptx', { kind: 'block' })],
        'the kind __proto__',
      ),
      controlCase(
        { tabs: [SLIDES] },
        [
          open('$DIR/a.pptx', 0),
          open('$DIR/a.pptx', ''),
          open('$DIR/a.pptx', null),
          open('$DIR/a.pptx', false),
        ],
        'falsy targets are no target',
      ),
      controlCase(
        {
          opens: [{ path: '$DIR/a.docx', id: 'n', kind: 'docs', contents: 'cn' }],
          contents: { cn: { replies: [{ status: 'not_ready' }, OK_JS] } },
        },
        [{ cmd: 'open', path: '$DIR/a.docx', target: { kind: 'block', block: 1 } }],
        'a target is not read again until the file opened',
        { 'a.docx': 'x' },
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { replies: [OK_JS] } } },
        [selection('$DIR/a.xlsx'), selection('$DIR/a.docx')],
        'selection of an open and of a closed file',
      ),
      controlCase(
        {
          tabs: [SHEETS],
          contents: {
            c3: {
              replies: [
                {
                  status: 'error',
                  error: { reason: 'out_of_range', message: 'm', detail: { max: 9 } },
                },
              ],
            },
          },
        },
        [selection('$DIR/a.xlsx'), open('$DIR/a.xlsx', { kind: 'range', range: 'Z9' })],
        'an error of the renderer is passed on',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { loading: [true, true, false], replies: [OK_JS] } } },
        [selection('$DIR/a.xlsx')],
        'a document that is still loading is asked again after 250 ms',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { destroyed: true } }, readyTimeoutMs: 600 },
        [selection('$DIR/a.xlsx')],
        'a destroyed view never becomes ready',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { loading: [true] } }, readyTimeoutMs: 1000 },
        [selection('$DIR/a.xlsx')],
        'loading for good: the timeout answers',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { loading: [true] } }, readyTimeoutMs: 0 },
        [selection('$DIR/a.xlsx')],
        'a zero timeout',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { loading: [true] } }, readyTimeoutMs: 250 },
        [selection('$DIR/a.xlsx')],
        'the deadline is not passed until a poll is later than it',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { loading: [true] } } },
        [selection('$DIR/a.xlsx')],
        'the default timeout of 20 s',
      ),
      controlCase(
        {
          tabs: [SHEETS],
          contents: {
            c3: {
              replies: [
                { $reject: true },
                { $undefined: true },
                [1, 2],
                'text',
                7,
                null,
                { status: 'ok', result: { done: 1 } },
              ],
            },
          },
        },
        [selection('$DIR/a.xlsx')],
        'replies that are no reply: a rejection, undefined, an array, text, a number, null',
      ),
      controlCase(
        {
          tabs: [SHEETS],
          contents: {
            c3: { replies: [{ status: 'not_ready' }, { status: 'weird' }, { status: 'ok' }] },
          },
        },
        [selection('$DIR/a.xlsx')],
        'not_ready and an unknown status ask again; ok without a result',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { replies: [{ status: 'error' }] } } },
        [selection('$DIR/a.xlsx')],
        'an error without its detail',
      ),
      controlCase(
        { tabs: [SHEETS], contents: { c3: { replies: [{ status: 'ok', result: null }] } } },
        [selection('$DIR/a.xlsx')],
        'a null result is kept',
      ),
      controlCase(
        { tabs: [SLIDES], contents: { c1: { replies: [OK_JS] } } },
        [
          open('$DIR/a.pptx', {
            kind: 'slide',
            slide: 1e21,
            el: '\u00fcn\u00ef\u{1F600}',
            z: -0,
            list: [1, { 2: 'b', a: 1 }],
          }),
        ],
        'the target is written into the script as JSON',
      ),
      controlCase(
        {
          tabs: [{ ...DOCS, path: '$DIR/\u00fcn\u00ef \u{1F600}.docx' }],
          contents: { c2: { replies: [OK_JS] } },
        },
        [
          open('$DIR/\u00fcn\u00ef \u{1F600}.docx', { kind: 'block', block: 2 }),
          selection('$DIR/\u00fcn\u00ef \u{1F600}.docx'),
        ],
        'a path with non-ASCII characters',
      ),
      controlCase(
        { tabs: [SHEETS], readyTimeoutMs: 300 },
        [
          { cmd: 'other', path: '$DIR/a.xlsx' },
          { cmd: 'open', path: '$DIR/a.txt' },
        ],
        'a command that is not open is a selection; a file no editor opens',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// default-app
// ---------------------------------------------------------------------------

interface ScriptEntry {
  cmd: string
  /** the arguments joined with U+0001 contain this */
  includes?: string
  /** the arguments joined with U+0001 end with this */
  suffix?: string
  out?: string
  /** rejects with an `Error` of this message */
  fail?: string
}

interface AppCfg {
  platform: string
  packaged?: boolean
  exePath?: string
  registeredAppName?: string
  script?: ScriptEntry[]
  /** files `readFile` answers, by path below the home folder */
  files?: Record<string, string>
  /** leave `readFile` out, so the default reads the real disk */
  noReadFile?: boolean
  openFails?: boolean
  /** `os.homedir()`: only Rust reads it */
  home: string
}

async function runDefaultApp(
  cfg: AppCfg,
  ops: string[],
  cx: { log: (...line: unknown[]) => void },
): Promise<unknown[]> {
  const home = homedir()
  const service = createDefaultAppService({
    platform: cfg.platform as NodeJS.Platform,
    packaged: cfg.packaged ?? true,
    exePath: cfg.exePath ?? '',
    registeredAppName: cfg.registeredAppName ?? 'SeuOffice',
    run: async (cmd, args) => {
      cx.log('run', cmd, args.map(short))
      const joined = args.join('\u0001')
      const hit = cfg.script?.find(
        (e) =>
          e.cmd === cmd &&
          (e.includes === undefined || joined.includes(e.includes)) &&
          (e.suffix === undefined || joined.endsWith(e.suffix)),
      )
      if (!hit) throw new Error('not scripted')
      if (hit.fail !== undefined) throw new Error(hit.fail)
      return hit.out ?? ''
    },
    openExternal: async (url) => {
      cx.log('openExternal', url)
      if (cfg.openFails) throw new Error('no browser')
    },
    ...(cfg.noReadFile
      ? {}
      : {
          readFile: (p: string) => {
            const rel = p.startsWith(`${home}/`) ? p.slice(home.length + 1) : p
            cx.log('readFile', rel)
            const text = cfg.files?.[rel]
            if (text === undefined) throw new Error('ENOENT')
            return text
          },
        }),
  })
  const out: unknown[] = []
  for (const op of ops) out.push(op === 'status' ? await service.status() : await service.set())
  return out
}

const HOME = homedir()
const MAC_EXE = '/Applications/SeuOffice.app/Contents/MacOS/SeuOffice'
const ME = 'com.seuoffice.app'
const macOut = (types: unknown[], me: unknown = ME): string => JSON.stringify({ me, types })
const macStatusEntry = (out: string, fail?: string): ScriptEntry => ({
  cmd: 'osascript',
  includes: 'LSCopyDefaultRoleHandlerForContentType',
  ...(fail === undefined ? { out } : { fail }),
})
const macSetEntry = (fail?: string): ScriptEntry => ({
  cmd: 'osascript',
  includes: 'LSSetDefaultRoleHandlerForContentType',
  ...(fail === undefined ? { out: '{"me":"x","failed":[]}' } : { fail }),
})
const macType = (id: unknown, name: unknown = null) => ({ uti: 'u', id, name })

const LINUX_ID = 'seuoffice.desktop'
type LinuxOwner = string | { fail: string }
/** one `xdg-mime query default` answer per Office type */
const linuxScript = (owners: LinuxOwner[]): ScriptEntry[] =>
  OFFICE_TYPES.map((t, i) => {
    const owner = owners[Math.min(i, owners.length - 1)]
    return {
      cmd: 'xdg-mime',
      suffix: t.mime,
      ...(typeof owner === 'string' ? { out: owner } : { fail: owner.fail }),
    }
  })
const LINUX_SET: ScriptEntry = { cmd: 'xdg-mime', includes: 'default\u0001seuoffice.desktop' }

const regOut = (name: string, value: string): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\X\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`
const USER_CHOICE = (ext: string) => `FileExts\\.${ext}\\UserChoice`
type WinOwner = string | null | 'fail'
/** the user choice of each type: a ProgId, an empty answer, or a refused query */
const winChoices = (owners: WinOwner[]): ScriptEntry[] =>
  OFFICE_TYPES.map((t, i) => {
    const owner = owners[Math.min(i, owners.length - 1)]
    return {
      cmd: 'reg',
      includes: USER_CHOICE(t.ext),
      ...(owner === 'fail'
        ? { fail: 'not found' }
        : { out: owner === null ? '\r\n' : regOut('ProgId', owner) }),
    }
  })
const winClass = (ext: string, value: string | 'fail' | null): ScriptEntry => ({
  cmd: 'reg',
  includes: `HKCR\\.${ext}\u0001`,
  ...(value === 'fail'
    ? { fail: 'not found' }
    : { out: value === null ? '\r\n' : regOut('(Default)', value) }),
})
const winName = (progId: string, name: string | 'fail' | null): ScriptEntry => ({
  cmd: 'reg',
  includes: `HKCR\\${progId}\u0001`,
  ...(name === 'fail'
    ? { fail: 'not found' }
    : { out: name === null ? '\r\n' : regOut('(Default)', name) }),
})
const OURS = OFFICE_TYPES.map((t) => t.progId)

const WIN = { platform: 'win32', home: HOME }
const winCases: Case[] = [
  {
    args: [{ ...WIN, script: winChoices(OURS) }, ['status']],
    note: 'every type is ours',
  },
  {
    args: [
      {
        ...WIN,
        script: [
          ...winChoices(['Word.Document.12', ...OURS.slice(1)]),
          winName('Word.Document.12', 'Microsoft Word'),
        ],
      },
      ['status'],
    ],
    note: 'one other owner, named',
  },
  {
    args: [
      {
        ...WIN,
        script: [
          ...winChoices(['fail', null, ...OURS.slice(2)]),
          winClass('docx', 'Word.Document.12'),
          winClass('xlsx', 'seuoffice.ExcelWorkbook'),
          winName('Word.Document.12', 'Word'),
        ],
      },
      ['status'],
    ],
    note: 'no user choice: the class default decides; an empty answer is none',
  },
  {
    args: [{ ...WIN, script: [] }, ['status']],
    note: 'every query refused',
  },
  {
    args: [
      {
        ...WIN,
        script: [...winChoices([null]), ...OFFICE_TYPES.map((t) => winClass(t.ext, null))],
      },
      ['status'],
    ],
    note: 'nothing answers a value',
  },
  {
    args: [
      {
        ...WIN,
        script: [
          ...winChoices(['A.One', 'B.Two', 'A.One', 'C.Three', 'B.Two', OURS[5], OURS[6]]),
          winName('A.One', 'Same Name'),
          winName('B.Two', 'Same Name'),
          winName('C.Three', null),
        ],
      },
      ['status'],
    ],
    note: 'other owners with one name between two, and one that names nothing',
  },
  {
    args: [
      { ...WIN, script: [...winChoices(['A.One', OURS[1]]), winName('A.One', 'fail')] },
      ['status'],
    ],
    note: 'the name lookup is refused: the ProgId stands',
  },
  {
    args: [{ ...WIN, packaged: false, script: winChoices(OURS) }, ['status', 'set']],
    note: 'a dev build',
  },
  {
    args: [
      {
        ...WIN,
        script: [
          {
            cmd: 'reg',
            includes: 'HKCU\\Software\\RegisteredApplications',
            out: regOut('SeuOffice', 'Software\\SeuOffice\\Capabilities'),
          },
          ...winChoices(OURS),
        ],
      },
      ['set'],
    ],
    note: 'registered for the user: the page of the app',
  },
  {
    args: [
      {
        ...WIN,
        registeredAppName: 'Seu Office \u00e9\u{1F600}&x',
        script: [
          { cmd: 'reg', includes: 'HKCU\\Software\\RegisteredApplications', fail: 'not found' },
          { cmd: 'reg', includes: 'HKLM\\Software\\RegisteredApplications', out: regOut('x', 'y') },
          ...winChoices(OURS),
        ],
      },
      ['set'],
    ],
    note: 'registered for the machine, a name that needs escaping',
  },
  {
    args: [
      {
        ...WIN,
        script: [
          { cmd: 'reg', includes: 'HKCU\\Software\\RegisteredApplications', out: '\r\n' },
          { cmd: 'reg', includes: 'HKLM\\Software\\RegisteredApplications', fail: 'x' },
          ...winChoices(OURS),
        ],
      },
      ['set', 'status'],
    ],
    note: 'registered nowhere: the plain list',
  },
  {
    args: [{ ...WIN, openFails: true, script: winChoices(['X.y', OURS[1]]) }, ['set']],
    note: 'the page cannot be opened',
  },
]

const defaultAppCases: Case[] = [
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macStatusEntry(macOut([macType(ME), macType(ME)]))],
      },
      ['status'],
    ],
    note: 'mac: ours',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [
          macStatusEntry(
            macOut([
              macType(ME),
              macType('com.other', 'Other App'),
              macType('com.other2', null),
              macType(null),
              macType('com.other', 'Other App'),
            ]),
          ),
        ],
      },
      ['status'],
    ],
    note: 'mac: other owners, named or not, one missing',
  },
  {
    args: [
      { platform: 'darwin', exePath: MAC_EXE, home: HOME, script: [macStatusEntry(macOut([]))] },
      ['status'],
    ],
    note: 'mac: no types',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macStatusEntry(macOut([macType(null), macType(null)]))],
      },
      ['status'],
    ],
    note: 'mac: nobody owns a type',
  },
  {
    args: [
      { platform: 'darwin', exePath: MAC_EXE, home: HOME, script: [macStatusEntry('not json')] },
      ['status'],
    ],
    note: 'mac: an answer that is no JSON',
  },
  {
    args: [
      { platform: 'darwin', exePath: MAC_EXE, home: HOME, script: [macStatusEntry('{"me":"x"}')] },
      ['status'],
    ],
    note: 'mac: an answer without types',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macStatusEntry('', 'osascript failed')],
      },
      ['status'],
    ],
    note: 'mac: the command fails',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: '/usr/bin/seuoffice',
        home: HOME,
        script: [macStatusEntry(macOut([]))],
      },
      ['status', 'set'],
    ],
    note: 'mac: not inside an app bundle',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macSetEntry(), macStatusEntry(macOut([macType(ME)]))],
      },
      ['set'],
    ],
    note: 'mac: set, then the status',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macSetEntry('refused'), macStatusEntry(macOut([macType('com.other', 'Other')]))],
      },
      ['set', 'status'],
    ],
    note: 'mac: set refused, the status says what stuck',
  },
  {
    args: [
      { platform: 'darwin', packaged: false, exePath: MAC_EXE, home: HOME, script: [] },
      ['status', 'set'],
    ],
    note: 'a dev build claims nothing',
  },
  {
    args: [{ platform: 'linux', home: HOME, script: linuxScript([`${LINUX_ID}\n`]) }, ['status']],
    note: 'linux: ours',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        script: linuxScript([
          LINUX_ID,
          'org.other.desktop\n',
          '  \n',
          LINUX_ID,
          'org.other.desktop',
          'zz-other.desktop',
          LINUX_ID,
        ]),
        files: {
          '.local/share/applications/org.other.desktop':
            '[Desktop Entry]\r\nName=Other Editor  \r\nName[ko]=x\r\n',
          '/usr/share/applications/zz-other.desktop': 'Name=Second\n',
        },
      },
      ['status'],
    ],
    note: 'linux: other owners named from desktop files, in the folders in order',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        script: linuxScript(['a.desktop', 'b.desktop', 'c.desktop', 'd.desktop']),
        files: {
          '/usr/local/share/applications/a.desktop': 'junk\nName=Local A\n',
          '/usr/share/applications/a.desktop': 'Name=System A\n',
          '/usr/share/applications/b.desktop': 'no name line\n',
          '/usr/share/applications/c.desktop': '[Desktop Entry]\nName=\n',
          '.local/share/applications/d.desktop': 'Name=\u00fcn\u00ef\u{1F600}\u00a0 \ufeff\n',
        },
      },
      ['status'],
    ],
    note: 'linux: the first folder with a Name line wins; none: the id without .desktop',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        noReadFile: true,
        script: linuxScript(['zz-no-such-app-seuoffice-test.desktop']),
      },
      ['status'],
    ],
    note: 'linux: the default reader finds nothing',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        script: linuxScript(['', ' ', '\u00a0', '\ufeff', '\u0085']),
      },
      ['status'],
    ],
    note: 'linux: empty answers, and the white space JavaScript trims',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        script: linuxScript([LINUX_ID, LINUX_ID, { fail: 'xdg-mime missing' }]),
      },
      ['status'],
    ],
    note: 'linux: a query fails',
  },
  {
    args: [
      { platform: 'linux', home: HOME, script: [LINUX_SET, ...linuxScript([LINUX_ID])] },
      ['set'],
    ],
    note: 'linux: set, then the status',
  },
  {
    args: [
      {
        platform: 'linux',
        home: HOME,
        script: [{ ...LINUX_SET, fail: 'xdg-mime failed' }, ...linuxScript(['x.desktop'])],
        files: {},
      },
      ['set', 'status'],
    ],
    note: 'linux: set refused',
  },
  ...winCases,
  {
    args: [{ platform: 'freebsd', home: HOME, script: [] }, ['status', 'set']],
    note: 'a platform with no support',
  },
  {
    args: [
      {
        platform: 'darwin',
        exePath: MAC_EXE,
        home: HOME,
        script: [macStatusEntry(macOut([macType(5), macType('x', 7), macType(null, 'n')]))],
      },
      ['status'],
    ],
    note: 'mac: ids that are numbers',
  },
]

const MAC_STATUS_JSON: unknown[] = [
  { me: 'a', types: [] },
  { me: 'a', types: [{ id: 'a' }] },
  { me: 'a', types: [{ id: 'a' }, { id: 'a', name: 'x' }] },
  { me: 'a', types: [{ id: 'b', name: 'B' }] },
  { me: 'a', types: [{ id: 'b', name: 'B' }, { id: 'c', name: 'B' }, { id: 'b' }] },
  { me: 'a', types: [{ id: 'b' }, { id: 'b', name: null }, { id: 'c', name: '' }] },
  { me: 'a', types: [{ id: null, name: 'N' }] },
  { me: 'a', types: [{ id: null }, { id: 'a' }] },
  { me: 'a', types: [{ id: null }, { id: null }] },
  { types: [{ id: 'a' }] },
  { types: [{ name: 'only a name' }] },
  { me: 'a', types: [{}] },
  { me: 'a', types: [{ id: 5 }, { id: 5 }, { id: 'a' }] },
  { me: 5, types: [{ id: 5 }, { id: '5' }] },
  { me: 'a', types: [{ id: ['a'] }, { id: { k: 1 } }, { id: ['a'] }] },
  { me: 'a', types: [{ id: true, name: false }] },
  { me: 'a', types: [1, 'x', [], true] },
  { me: 'a', types: [null] },
  { me: 'a', types: [{ id: 'a' }, null] },
  { me: 'a', types: null },
  { me: 'a', types: 'abc' },
  { me: 'a', types: {} },
  { me: 'a', types: 7 },
  { me: 'a' },
  null,
  7,
  'text',
  true,
  [],
  { me: 'a', types: [{ id: '\u00fcn\u00ef\u{1F600}', name: '\u00e9' }], extra: 1 },
]

const REG_OUTPUTS = [
  '    ProgId    REG_SZ    Word.Document.12',
  '\r\nHKEY_CLASSES_ROOT\\.docx\r\n    (Default)    REG_SZ    seuoffice.WordDocument\r\n\r\n',
  'HKEY_X\n    ProgId    REG_SZ    A B C   \nnext',
  '    ProgId    REG_EXPAND_SZ    %SystemRoot%\\x',
  '    ProgId    REG_DWORD    0x1',
  '    ProgId REG_SZ',
  '    ProgId    REG_SZ    ',
  '    ProgId    REG_SZ    x',
  '    REG_SZ    x',
  '    ProgId    reg_sz    x',
  'A REG_SZ B',
  'A\tREG_SZ\tB',
  'A  REG_SZ  B  C  ',
  '  \tName with spaces    REG_BINARY    0A0B',
  'A    REG_SZ    first\nB    REG_SZ    second',
  'junk\nA    REG_SZ    second',
  '',
  '\r\n\r\n',
  'no match at all',
  '   \n   ',
  'A\u2028B    REG_SZ    v',
  'A    REG_SZ    v\u2028w',
  'A    REG_SZ    \ufeffv\ufeff',
  'A    REG_SZ\u00a0\u00a0v',
  '\u00fcn\u00ef    REG_SZ    \u{1F600}\u00e9',
  'A    REG_SZ    v\rB',
  'A    REG_\u00e9    v',
]

const defaultAppGroup: Group = {
  'default-app.OFFICE_TYPES': constant(OFFICE_TYPES),
  'default-app.execFileRunner': {
    ts: (a) => execFileRunner(str(a, 0), a[1] as string[]),
    cases: [
      { args: ['/bin/echo', ['hi']] },
      { args: ['/bin/echo', []], note: 'no arguments' },
      { args: ['/bin/echo', ['a  b', '\u00fcn\u00ef\u{1F600}', '$HOME', '*']], note: 'no shell' },
      { args: ['/bin/sh', ['-c', 'printf "a\\377b\\303"']], note: 'bytes that are no UTF-8' },
      {
        args: ['/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']],
        note: 'a failure with stderr',
      },
      { args: ['/bin/sh', ['-c', 'exit 1']], note: 'a failure with no output' },
      { args: ['/bin/sh', ['-c', 'kill -9 $$']], note: 'killed by a signal' },
      { args: ['$DIR/none', ['x']], note: 'no such program' },
      {
        args: ['$DIR/plain.txt', []],
        files: { 'plain.txt': 'text' },
        note: 'a file that cannot run',
      },
      { args: ['/bin/cat', ['$DIR/in.txt']], files: { 'in.txt': 'read \u00e9' } },
      { args: ['/bin/cat', ['$DIR/none.txt']], note: 'a failure whose stderr names a path' },
    ],
  },
  'default-app.macAppBundlePath': {
    ts: (a) => macAppBundlePath(str(a, 0)),
    cases: [
      MAC_EXE,
      '/Applications/SeuOffice.app/Contents/MacOS/SeuOffice Helper',
      '/Applications/SeuOffice.app',
      '/Applications/SeuOffice.app/',
      '/A.app/B.app/Contents/MacOS/x',
      '/Applications/SeuOffice.app/Contents/Frameworks/X.framework/Versions/A/Helpers/x',
      '/Applications/SeuOffice.app/a/b/c/d/e/f/x',
      '/Applications/SeuOffice.app/a/b/c/d/e/x',
      '/usr/bin/seuoffice',
      '/',
      '',
      '.',
      'SeuOffice.app/Contents/MacOS/x',
      'x.app',
      '/x/.app/y',
      '/x/y.App/z',
      '/x/y.app2/z',
      'C:\\Program Files\\SeuOffice.app\\x.exe',
      '/\u00fcn\u00ef \u{1F600}.app/Contents/MacOS/x',
      '//a.app//b//c',
    ].map((p): Case => ({ args: [p] })),
  },
  'default-app.parseMacStatus': {
    ts: (a) => parseMacStatus(str(a, 0)),
    cases: [
      ...MAC_STATUS_JSON.map((value): Case => ({ args: [JSON.stringify(value)] })),
      {
        args: ['{"me":"a","types":[{"id":"b","name":"B"}],"types":[{"id":"a"}]}'],
        note: 'a key twice',
      },
      { args: ['{"me":"a","types":[{"id":"\\u00e9","name":"\\ud83d\\ude00"}]}'] },
    ],
  },
  'default-app.parseLinuxStatus': {
    ts: (a) => parseLinuxStatus(a[0] as string[]),
    cases: [
      [],
      [LINUX_ID],
      [`${LINUX_ID}\n`, ` ${LINUX_ID} `],
      [LINUX_ID, 'other.desktop'],
      ['other.desktop', 'other.desktop', 'x.desktop'],
      ['', LINUX_ID],
      ['', ' ', '\n'],
      ['\ufeff', '\u00a0', '\u2028', '\u0085', '\u180e'],
      ['\ufeff' + LINUX_ID, LINUX_ID + '\u00a0'],
      ['SeuOffice.desktop', 'seuoffice.desktop.bak'],
      ['\u00fcn\u00ef\u{1F600}.desktop', '\u0131.desktop', '\u017F.desktop', '\u212A.desktop'],
    ].map((outputs): Case => ({ args: [outputs] })),
  },
  'default-app.parseRegValue': {
    ts: (a) => parseRegValue(str(a, 0)),
    cases: REG_OUTPUTS.map((output): Case => ({ args: [output] })),
  },
  'default-app.createDefaultAppService': {
    ts: (a, cx) => runDefaultApp(a[0] as AppCfg, a[1] as string[], cx),
    cases: defaultAppCases,
  },
}

// ---------------------------------------------------------------------------
// diagram-open-gate, document-password-prompt
// ---------------------------------------------------------------------------

interface GateCfg {
  /** `refusal(path)` answers; a path that is not here opens */
  refusals?: Record<string, string | null>
  refusalThrows?: string[]
  openThrows?: boolean
  warnThrows?: boolean
}

interface GateOp {
  open?: string
  /** answers the visio check that was started in this order */
  settle?: number
  value?: string | null
  reject?: string
  rejectValue?: string
  checking?: string
}

async function runGate(
  cfg: GateCfg,
  ops: GateOp[],
  cx: { log: (...line: unknown[]) => void },
  last?: string,
): Promise<unknown> {
  let muted = false
  const log = (...line: unknown[]) => {
    if (!muted) cx.log(...line)
  }
  const checks: Array<{ resolve: (v: string | null) => void; reject: (e: unknown) => void }> = []
  const deps = {
    refusal: (path: string) => {
      log('refusal', path)
      if (cfg.refusalThrows?.includes(path)) throw new Error('refusal boom')
      return cfg.refusals?.[path] ?? null
    },
    visioRefusal: (path: string) => {
      log('visioRefusal', path)
      return new Promise<string | null>((resolve, reject) => checks.push({ resolve, reject }))
    },
    open: (path: string) => {
      log('open', path)
      if (cfg.openThrows) throw new Error('open boom')
    },
    warn: (message: string, path: string) => {
      log('warn', message, path)
      if (cfg.warnThrows) throw new Error('warn boom')
    },
  }
  return withWarnings(log, async () => {
    try {
      const out: unknown[] = []
      for (const op of ops) {
        if (op.open !== undefined) {
          try {
            out.push(openDiagramChecked(op.open, deps))
          } catch (error) {
            out.push({ error: (error as Error).message })
          }
        } else if (op.settle !== undefined) {
          const check = checks[op.settle]
          if (op.reject !== undefined) check.reject(new Error(op.reject))
          else if (op.rejectValue !== undefined) check.reject(op.rejectValue)
          else check.resolve(op.value ?? null)
        } else if (op.checking !== undefined) out.push(diagramOpenChecking(op.checking))
        await flush()
      }
      return last === undefined ? out : diagramOpenChecking(last)
    } finally {
      muted = true
      for (const check of checks) check.resolve(null)
      await flush()
    }
  })
}

const gateCases = (finalPath: boolean): Case[] =>
  (
    [
      [{}, [{ open: '/g/a.drawio' }]],
      [
        { refusals: { '/g/b.drawio.svg': 'no diagram inside' } },
        [{ open: '/g/b.drawio.svg' }, { open: '/g/a.dio' }],
      ],
      [
        {},
        [
          { open: '/g/a.vsdx' },
          { checking: '/g/a.vsdx' },
          { settle: 0, value: null },
          { checking: '/g/a.vsdx' },
        ],
      ],
      [
        {},
        [
          { open: '/g/a.vsdx' },
          { settle: 0, value: 'not a Visio drawing' },
          { checking: '/g/a.vsdx' },
        ],
      ],
      [
        {},
        [
          { open: '/g/a.vsdx' },
          { open: '/g/a.vsdx' },
          { open: '/g/b.vsdx' },
          { settle: 0, value: null },
          { open: '/g/a.vsdx' },
          { settle: 1, value: null },
          { settle: 2, value: 'x' },
        ],
      ],
      [
        {},
        [
          { open: '/g/a.vsdx' },
          { settle: 0, reject: 'archive broken' },
          { open: '/g/a.vsdx' },
          { settle: 1, rejectValue: 'plain text' },
        ],
      ],
      [
        {},
        [
          { open: '/g/A.VSDX' },
          { open: '/g/a.vsdx' },
          { checking: '/g/a.Vsdx' },
          { settle: 0, value: null },
        ],
      ],
      [
        { refusals: { '/g/a.vsdx\n': 'refused', '/g/a.v\u017Fdx': 'refused too' } },
        [{ open: '/g/a.vsdx\n' }, { open: '/g/a.v\u017Fdx' }],
      ],
      [
        { openThrows: true },
        [
          { open: '/g/a.drawio' },
          { open: '/g/c.vsdx' },
          { settle: 0, value: null },
          { checking: '/g/c.vsdx' },
        ],
      ],
      [
        { warnThrows: true, refusals: { '/g/x.drawio': 'bad' } },
        [
          { open: '/g/x.drawio' },
          { open: '/g/d.vsdx' },
          { settle: 0, value: 'bad' },
          { checking: '/g/d.vsdx' },
        ],
      ],
      [{ refusalThrows: ['/g/y.drawio'] }, [{ open: '/g/y.drawio' }, { open: '/g/z.drawio' }]],
      [{}, [{ open: 'rel/dir/../a.vsdx' }, { checking: 'rel/a.vsdx' }, { checking: 'rel/b.vsdx' }]],
      [
        {},
        [
          { open: '/g/\u00fcn\u00ef \u{1F600}.vsdx' },
          { settle: 0, value: '\u00e9' },
          { open: '/g/\u00fcn\u00ef.drawio' },
        ],
      ],
      [{}, [{ open: '/g/pending.vsdx' }]],
      [{ refusals: { '/g/e.drawio': '' } }, [{ open: '/g/e.drawio' }]],
    ] as Array<[GateCfg, GateOp[]]>
  ).map(([cfg, ops]): Case => ({
    args: finalPath ? [cfg, ops, '/g/a.vsdx'] : [cfg, ops],
  }))

const diagramGateGroup: Group = {
  'diagram-open-gate.openDiagramChecked': {
    ts: (a, cx) => runGate(a[0] as GateCfg, a[1] as GateOp[], cx),
    cases: gateCases(false),
  },
  'diagram-open-gate.diagramOpenChecking': {
    ts: (a, cx) => runGate(a[0] as GateCfg, a[1] as GateOp[], cx, a[2] as string),
    cases: gateCases(true),
  },
}

interface PromptOp {
  create?: string
  ask?: number
  retry?: boolean
  close?: number
}

async function runPrompts(
  answers: Array<string | null>,
  ops: PromptOp[],
  cx: { log: (...line: unknown[]) => void },
): Promise<unknown> {
  const queue = [...answers]
  let muted = false
  const log = (...line: unknown[]) => {
    if (!muted) cx.log(...line)
  }
  const window = {
    prompt: async (fileName: string, retry: boolean) => {
      log('prompt', fileName, retry)
      return queue.length > 0 ? queue.shift()! : null
    },
    close: () => log('close'),
  }
  const prompts: DocumentPasswordPrompt[] = []
  const settled: unknown[] = []
  const asked = new Set<number>()
  const done = new Set<number>()
  try {
    for (const op of ops) {
      if (op.create !== undefined) prompts.push(createDocumentPasswordPrompt(window, op.create))
      else if (op.ask !== undefined) {
        const seq = asked.size
        asked.add(seq)
        void prompts[op.ask].ask(op.retry ?? false).then((value) => {
          done.add(seq)
          settled.push([seq, value])
        })
      } else if (op.close !== undefined) prompts[op.close].close()
      await flush()
    }
    return { settled, pending: [...asked].filter((seq) => !done.has(seq)) }
  } finally {
    muted = true
    for (const prompt of prompts) prompt.close()
    await flush()
  }
}

const P = (...ops: PromptOp[]): PromptOp[] => ops
const promptCases: Case[] = (
  [
    [['pw1'], P({ create: 'a.xlsx' }, { ask: 0 }, { close: 0 })],
    [['pw1', 'pw2'], P({ create: 'a.xlsx' }, { ask: 0 }, { ask: 0, retry: true }, { close: 0 })],
    [[null], P({ create: 'a.xlsx' }, { ask: 0 }, { close: 0 })],
    [[], P({ create: 'a.xlsx' }, { ask: 0 })],
    [
      ['x', 'y'],
      P(
        { create: 'a.xlsx' },
        { create: 'b.pptx' },
        { ask: 0 },
        { ask: 1 },
        { close: 0 },
        { close: 1 },
      ),
    ],
    [
      ['x', 'y'],
      P(
        { create: 'a.xlsx' },
        { create: 'b.pptx' },
        { ask: 1 },
        { ask: 0 },
        { close: 0 },
        { ask: 1, retry: true },
        { close: 1 },
      ),
    ],
    [['x'], P({ create: 'a.xlsx' }, { create: 'b.pptx' }, { ask: 1 }, { close: 1 }, { close: 0 })],
    [
      ['x'],
      P(
        { create: 'a.xlsx' },
        { create: 'b.pptx' },
        { create: 'c.docx' },
        { ask: 2 },
        { close: 1 },
        { ask: 1 },
        { close: 0 },
      ),
    ],
    [
      ['x', 'y', 'z'],
      P(
        { create: 'a.xlsx' },
        { create: 'b.pptx' },
        { create: 'c.docx' },
        { ask: 0 },
        { ask: 1 },
        { ask: 2 },
        { close: 1 },
        { close: 0 },
        { close: 2 },
      ),
    ],
    [['x'], P({ create: 'a.xlsx' }, { close: 0 }, { ask: 0 }, { close: 0 })],
    [['x'], P({ create: 'a.xlsx' }, { close: 0 }, { close: 0 })],
    [['x', 'y'], P({ create: 'a.xlsx' }, { ask: 0 }, { close: 0 }, { close: 0 }, { ask: 0 })],
    [
      ['x'],
      P(
        { create: 'a.xlsx' },
        { create: 'b.pptx' },
        { ask: 1 },
        { ask: 1, retry: true },
        { ask: 1 },
        { close: 0 },
      ),
    ],
    [
      ['\u00fcn\u00ef\u{1F600}'],
      P({ create: '\u00fcn\u00ef \u{1F600}.xlsx' }, { ask: 0 }, { close: 0 }),
    ],
    [['x'], P({ create: '' }, { ask: 0, retry: true }, { close: 0 })],
  ] as Array<[Array<string | null>, PromptOp[]]>
).map(([answers, ops]): Case => ({ args: [answers, ops] }))

const passwordGroup: Group = {
  'document-password-prompt.createDocumentPasswordPrompt': {
    ts: (a, cx) => runPrompts(a[0] as Array<string | null>, a[1] as PromptOp[], cx),
    cases: promptCases,
  },
}

// ---------------------------------------------------------------------------
// pdf-convert-ui-handlers, pdf-note-tabs
// ---------------------------------------------------------------------------

interface ConvertCfg {
  /** `[viewId, path]` pairs `ownsSource` accepts */
  owns?: Array<[number, string]>
  exists?: string[]
  /** the Markdown tab of each path */
  tabs?: Record<string, string>
  closeFails?: boolean
  /** closing a tab leaves it open (the user kept it) */
  keepOpen?: boolean
  openOk?: boolean
}

async function runConvert(
  cfg: ConvertCfg,
  steps: Array<[string, number, unknown]>,
  cx: { log: (...line: unknown[]) => void },
): Promise<unknown[]> {
  const tabs = new Map(Object.entries(cfg.tabs ?? {}))
  const handlers = createPdfConvertUiHandlers({
    ownsSource: (viewId, path) => {
      cx.log('ownsSource', viewId, path)
      return (cfg.owns ?? []).some(([v, p]) => v === viewId && p === path)
    },
    exists: (path) => {
      cx.log('exists', path)
      return (cfg.exists ?? []).includes(path)
    },
    showInFolder: (path) => cx.log('showInFolder', path),
    findMarkdownTab: (path) => {
      cx.log('findMarkdownTab', path)
      return tabs.get(path)
    },
    closeTab: async (tabId) => {
      cx.log('closeTab', tabId)
      if (cfg.closeFails) throw new Error('close refused')
      if (!cfg.keepOpen) for (const [path, id] of tabs) if (id === tabId) tabs.delete(path)
    },
    activateView: (viewId) => cx.log('activateView', viewId),
    openDocument: (path) => {
      cx.log('openDocument', path)
      return cfg.openOk ?? true
    },
  })
  const out: unknown[] = []
  for (const [method, viewId, req] of steps) {
    try {
      out.push(
        await handlers[method as 'releaseTarget' | 'openResult' | 'revealResult'](viewId, req),
      )
    } catch (error) {
      out.push({ error: (error as Error).message })
    }
  }
  return out
}

const SRC = '/pdf/a.pdf'
const OWNED: ConvertCfg = {
  owns: [[7, SRC]],
  exists: ['/o/a.md', '/o/a.epub', '/o/a.PNG', '/o/a.pdf', '/o/a.docx', '/o/b.MD'],
}
const req = (path: unknown, source: unknown = SRC) => ({ source, path })
const convertCase = (
  cfg: ConvertCfg,
  steps: Array<[string, number, unknown]>,
  note: string,
): Case => ({
  args: [cfg, steps],
  note,
})
const ALL_METHODS = ['releaseTarget', 'openResult', 'revealResult']

const convertCases: Case[] = [
  ...ALL_METHODS.map((m) =>
    convertCase(
      OWNED,
      [
        [m, 7, req('/o/a.md')],
        [m, 7, req('/o/a.epub')],
        [m, 7, req('/o/a.PNG')],
        [m, 7, req('/o/a.pdf')],
        [m, 7, req('/o/a.docx')],
        [m, 7, req('/o/b.MD')],
      ],
      `${m}: the kinds of file`,
    ),
  ),
  ...ALL_METHODS.map((m) =>
    convertCase(
      OWNED,
      [
        [m, 8, req('/o/a.md')],
        [m, 7, req('/o/a.md', '/pdf/other.pdf')],
        [m, 7, req('/o/a.md', 5)],
        [m, 7, req(5)],
        [m, 7, { source: SRC }],
        [m, 7, { path: '/o/a.md' }],
      ],
      `${m}: a view that was not given the PDF, and bad fields`,
    ),
  ),
  ...ALL_METHODS.map((m) =>
    convertCase(
      OWNED,
      [
        [m, 7, null],
        [m, 7, undefined],
        [m, 7, 5],
        [m, 7, 'text'],
        [m, 7, true],
        [m, 7, [SRC, '/o/a.md']],
        [m, 7, []],
        [m, 7, {}],
        [m, 7, req('')],
      ],
      `${m}: a request that is no request`,
    ),
  ),
  ...ALL_METHODS.map((m) => {
    const paths = [
      `/o/${'x'.repeat(4090)}.md`,
      `/o/${'x'.repeat(4091)}.md`,
      `/o/${'\u{1F600}'.repeat(2045)}.md`,
      `/o/${'\u{1F600}'.repeat(2046)}.md`,
    ]
    return convertCase(
      { owns: [[7, SRC]], exists: paths },
      paths.map((path): [string, number, unknown] => [m, 7, req(path)]),
      `${m}: the longest path (4096 UTF-16 code units)`,
    )
  }),
  convertCase(
    { ...OWNED, tabs: { '/o/a.md': 'tab1' } },
    [
      ['releaseTarget', 7, req('/o/a.md')],
      ['releaseTarget', 7, req('/o/a.md')],
    ],
    'releaseTarget: a tab that closes',
  ),
  convertCase(
    { ...OWNED, tabs: { '/o/a.md': 'tab1' }, keepOpen: true },
    [['releaseTarget', 7, req('/o/a.md')]],
    'releaseTarget: the user keeps the tab',
  ),
  convertCase(
    { ...OWNED, tabs: { '/o/a.md': 'tab1' }, closeFails: true },
    [
      ['releaseTarget', 7, req('/o/a.md')],
      ['releaseTarget', 7, req('/o/a.epub')],
    ],
    'releaseTarget: closing fails',
  ),
  convertCase(
    { ...OWNED, openOk: false },
    [
      ['openResult', 7, req('/o/a.md')],
      ['openResult', 7, req('/o/missing.md')],
    ],
    'openResult: the file does not open, and does not exist',
  ),
  convertCase(
    {
      owns: [
        [1.5, SRC],
        [-1, SRC],
      ],
      exists: ['/o/a.md'],
    },
    [
      ['openResult', 1.5, req('/o/a.md')],
      ['openResult', -1, req('/o/a.md')],
      ['openResult', 1, req('/o/a.md')],
    ],
    'view ids that are fractions and negative',
  ),
  convertCase(
    { owns: [[7, '/pdf/\u00fcn\u00ef \u{1F600}.pdf']], exists: ['/o/\u00fcn\u00ef.md'] },
    [['revealResult', 7, req('/o/\u00fcn\u00ef.md', '/pdf/\u00fcn\u00ef \u{1F600}.pdf')]],
    'non-ASCII paths',
  ),
  convertCase(
    OWNED,
    [
      ['revealResult', 7, req('/o/a.md\n')],
      ['revealResult', 7, req('/o/a.m\u0064')],
      ['revealResult', 7, req('/o/a.p\u017Fd')],
    ],
    'a path that does not end its text with the extension',
  ),
]

interface NoteCtxCfg {
  name: string
  destroyed?: boolean
}
interface NoteHostCfg {
  focus?: NoteCtxCfg | null
  open?: NoteCtxCfg | null
}

function noteHost(cfg: NoteHostCfg, log: (...line: unknown[]) => void) {
  const contents = (c: NoteCtxCfg | null | undefined) =>
    c
      ? { name: c.name, destroyed: c.destroyed === true, isDestroyed: () => c.destroyed === true }
      : undefined
  return {
    focusExisting: (path: string) => {
      log('focusExisting', path)
      return contents(cfg.focus) as never
    },
    openNew: (path: string) => {
      log('openNew', path)
      return contents(cfg.open) as never
    },
  }
}

const NOTE_FILES: Record<string, FileSpec> = {
  'a.md': 'note',
  'A.MD': 'note',
  'dir.md': { dir: true },
  'a.txt': 'x',
  'b.md\n': 'x',
  '\u00fcn\u00ef \u{1F600}.md': 'x',
}
const NOTE_PATHS: unknown[] = [
  '$DIR/a.md',
  '$DIR/A.MD',
  '$DIR/dir.md',
  '$DIR/a.txt',
  '$DIR/none.md',
  '$DIR/b.md\n',
  '$DIR/\u00fcn\u00ef \u{1F600}.md',
  'a.md',
  '',
  '$DIR/a.m\u0064',
  '$DIR/a.\u212Ad',
  5,
  null,
  { path: '$DIR/a.md' },
  ['$DIR/a.md'],
  true,
]

const A_CTX = { name: 'tab-a' }
const noteCases = (withText: boolean): Case[] => {
  const hosts: NoteHostCfg[] = [
    {},
    { focus: A_CTX },
    { open: { name: 'tab-new' } },
    { focus: A_CTX, open: { name: 'tab-new' } },
    { focus: { name: 'gone', destroyed: true } },
    { open: { name: 'gone-new', destroyed: true } },
  ]
  const texts: unknown[] = withText
    ? ['text', '  ', '\ufeff\u00a0', '\u0085x', 5, null, '\u00fcn\u00ef\u{1F600}']
    : [undefined]
  const paths = withText
    ? ['$DIR/a.md', '$DIR/none.md']
    : ['$DIR/a.md', '$DIR/none.md', 'a.md', '$DIR/a.txt']
  const cases: Case[] = []
  for (const host of hosts)
    for (const path of paths)
      for (const text of texts)
        cases.push({ args: withText ? [path, host, text] : [path, host], files: NOTE_FILES })
  return cases
}

const pdfGroup: Group = {
  'pdf-convert-ui-handlers.createPdfConvertUiHandlers': {
    ts: (a, cx) => runConvert(a[0] as ConvertCfg, a[1] as Array<[string, number, unknown]>, cx),
    cases: convertCases,
  },
}

const noteTabsGroup: Group = {
  'pdf-note-tabs.isNoteFile': {
    ts: (a) => isNoteFile(a[0]),
    cases: NOTE_PATHS.map((path): Case => ({ args: [path], files: NOTE_FILES })),
  },
  'pdf-note-tabs.openNoteTab': {
    ts: (a, cx) => openNoteTab(noteHost(a[1] as NoteHostCfg, cx.log), str(a, 0)),
    cases: noteCases(false),
  },
  'pdf-note-tabs.insertIntoNoteTab': {
    ts: (a, cx) =>
      insertIntoNoteTab(
        noteHost(a[1] as NoteHostCfg, cx.log),
        str(a, 0),
        a[2] as string,
        (contents, path, text) =>
          cx.log('queue', (contents as unknown as NoteCtxCfg).name, path, text),
      ),
    cases: noteCases(true),
  },
}

// ---------------------------------------------------------------------------
// document-links, document-links-menu
// ---------------------------------------------------------------------------

const CREATED = '2026-01-01T00:00:00.000Z'
const link = (
  derived: unknown,
  sources: unknown,
  createdAt: unknown = CREATED,
  via: unknown = 'ai',
): Record<string, unknown> => ({ derived, sources, createdAt, via })
const textOf = (links: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, links, ...extra })

const LINK_PATHS = [
  '/a/b.docx',
  '/a/./b.docx',
  '/a/../a/b.docx',
  '/a//b.docx',
  '/a/b.docx/',
  '/a/B.docx',
  'rel/b.docx',
  './rel/../rel/b.docx',
  '',
  '.',
  '..',
  '/',
  '//',
  '/a/b/..',
  '/..',
  '/\u00fcn\u00ef \u{1F600}/\ud55c.docx',
  '/a/\u0131.docx',
  '/a/\u017F.docx',
  '/a/\u212A.docx',
  'C:\\a\\b.docx',
  '/a/b\n.docx',
]

const PARSE_TEXTS: string[] = [
  textOf([link('/a/x.docx', ['/s/1.pdf', '/s/2.pdf'])]),
  textOf([]),
  JSON.stringify({ version: 1 }),
  JSON.stringify({ links: {} }),
  JSON.stringify({ links: 'x' }),
  JSON.stringify({ links: null }),
  textOf([link('/a/x', ['/s1']), link('/a/y', ['/s2']), link('/a/x', ['/s3'], 't2', 'convert')]),
  textOf([
    link('/a/x', ['/s1']),
    link('/a/./x', ['/s2']),
    link('/b/../a/x', ['/s3'], 't3', 'convert'),
  ]),
  textOf([
    link('/a/x', ['/s1']),
    link('/a/y', ['/s2']),
    link('/a/z', ['/s3']),
    link('/a/y', ['/s4']),
  ]),
  textOf([null, 5, 'str', [], {}, true, [link('/a', ['/s'])], link('/ok', ['/s'])]),
  textOf([
    link('', ['/s']),
    link('/a', []),
    link('/b', ['']),
    link('/c', ['/s', '']),
    link('/d', ['/s', 5]),
  ]),
  textOf([link('/a', '/s'), link('/b', null), link('/c', { 0: '/s', length: 1 })]),
  textOf([link(5, ['/s']), link(null, ['/s']), link(['/a'], ['/s']), link({ a: 1 }, ['/s'])]),
  textOf([
    link('/a', ['/s'], 5),
    link('/b', ['/s'], null),
    link('/c', ['/s'], ''),
    link('/d', ['/s'], ['x']),
  ]),
  textOf([
    link('/a', ['/s'], CREATED, 'x'),
    link('/b', ['/s'], CREATED, 'AI'),
    link('/c', ['/s'], CREATED, 'convert'),
    link('/d', ['/s'], CREATED, ['ai']),
    link('/e', ['/s'], CREATED, null),
  ]),
  textOf([
    { via: 'ai', extra: [1], sources: ['/s'], 2: 'x', createdAt: 't', derived: '/d', 10: 'y' },
  ]),
  textOf([
    { derived: '/d', sources: ['/s'], createdAt: 't' },
    { derived: '/e', sources: ['/s'], via: 'ai' },
  ]),
  textOf([
    link('rel/x.docx', ['rel/s.pdf']),
    link('./rel/x.docx', ['/s']),
    link('/a/B', ['/s']),
    link('/a/b', ['/t']),
  ]),
  textOf([link('/\u00fcn\u00ef \u{1F600}.docx', ['/\u00e9/\ud55c.pdf', '/\u{1F600}'], '\u00e9')]),
  textOf([
    link('/a/\u0131', ['/s']),
    link('/a/I', ['/t']),
    link('/a/\u017F', ['/u']),
    link('/a/s', ['/v']),
  ]),
  '{"links":[{"derived":"/a","sources":["/s"],"createdAt":"t","via":"ai"}],"links":[{"derived":"/b","sources":["/s"],"createdAt":"t","via":"convert"}]}',
  '{"__proto__":{"links":[]},"links":[{"__proto__":{"x":1},"derived":"/a","sources":["/s"],"createdAt":"t","via":"ai"}]}',
  '{"links":[{"derived":"/a","derived":"/b","sources":["/s"],"createdAt":"t","via":"ai"}]}',
  '[]',
  '[{"links":[]}]',
  'null',
  'true',
  '5',
  '"links"',
  '',
  ' ',
  '{',
  '{"links":[',
  '{"links":[]}}',
  '\ufeff' + textOf([link('/a', ['/s'])]),
  '  \n' + textOf([link('/a', ['/s'])]) + '\r\n',
  "{'links':[]}",
  textOf([link('/a', ['/s'])]).replace('"/a"', '"/\\u00e9\\ud83d\\ude00"'),
]

const FILE_LINKS_OK = textOf([link('/a/x.docx', ['/s/1.pdf'])])
const READ_FILES: Record<string, FileSpec> = {
  'ok.json': FILE_LINKS_OK,
  'bom.json': '\ufeff' + FILE_LINKS_OK,
  'bad.json': '{"links":',
  'dir.json': { dir: true },
  'empty.json': '',
  'array.json': '[]',
  'lossy.json': {
    hex: Buffer.concat([
      Buffer.from(FILE_LINKS_OK.replace('/a/x.docx', '/a/x'), 'utf8').subarray(0, 0),
      Buffer.from(FILE_LINKS_OK.slice(0, FILE_LINKS_OK.indexOf('/a/x.docx') + '/a/x'.length)),
      Buffer.from([0xff]),
      Buffer.from(FILE_LINKS_OK.slice(FILE_LINKS_OK.indexOf('/a/x.docx') + '/a/x'.length)),
    ]).toString('hex'),
  },
  'dups.json': textOf([link('/a', ['/1']), link('/b', ['/2']), link('/a/.', ['/3'])]),
}

/** the events `handoffStoreEvents` reads, seeded into the real hand-off store */
interface Seed {
  runs?: Array<{ webContentsId: number; handedOver: string[]; at: number }>
  converted?: Array<{ webContentsId: number; sources: string[]; at: number }>
}

function seedStore(seed: Seed): void {
  resetGenerateHandoffsForTest()
  ;(seed.runs ?? []).forEach((run, i) => {
    queueGenerateHandoff(run.webContentsId, {
      id: `h${i}`,
      mode: 'ai',
      target: 'slides',
      materials: run.handedOver.map((path) => ({ path, name: basename(path) })),
      text: 't',
      defaultText: false,
      createdAt: 0,
    })
    takeGenerateHandoff('slides', run.webContentsId)
    withClock(run.at, () => reportGenerateRunStarted('slides', run.webContentsId, run.handedOver))
  })
  ;(seed.converted ?? []).forEach((made, i) =>
    withClock(made.at, () =>
      recordGenerateConverted({
        webContentsId: made.webContentsId,
        target: 'markdown',
        kind: 'mindmap-to-markdown',
        sources: made.sources,
        conversionId: `c${i}`,
      }),
    ),
  )
}

const SEEDS: Seed[] = [
  {},
  { runs: [{ webContentsId: 1, handedOver: ['/s/a.pdf'], at: 1000 }] },
  { runs: [{ webContentsId: 1, handedOver: ['/s/a.pdf', '/s/b.pdf', '/s/c.docx'], at: 1000 }] },
  { converted: [{ webContentsId: 2, sources: ['/s/m.xmind'], at: 2000 }] },
  { converted: [{ webContentsId: 2, sources: [], at: 2000 }] },
  {
    runs: [
      { webContentsId: 3, handedOver: ['/s/a.pdf'], at: 3000 },
      { webContentsId: 1, handedOver: ['/s/b.pdf', '/s/c.pdf'], at: 500 },
      { webContentsId: 3, handedOver: ['/s/d.pdf'], at: 4000 },
    ],
    converted: [
      { webContentsId: 5, sources: ['/s/x.xmind'], at: 1500 },
      { webContentsId: 1, sources: ['/s/y.xmind'], at: 100 },
    ],
  },
  {
    runs: [
      {
        webContentsId: 10,
        handedOver: ['/\u00fcn\u00ef/\ud55c.pdf', '/s/\u{1F600}.pdf'],
        at: 1.5e12,
      },
    ],
    converted: [{ webContentsId: 2, sources: ['/\u00e9.xmind'], at: 1.7e12 }],
  },
]

async function runWatch(
  tabs: Record<string, string>,
  ops: Array<{ record: number } | 'flush'>,
  cx: { log: (...line: unknown[]) => void },
): Promise<unknown[]> {
  resetGenerateHandoffsForTest()
  watchMakeEvents(
    (id) => {
      cx.log('tabIdFor', id)
      return tabs[String(id)]
    },
    () => cx.log('onEvent'),
  )
  try {
    const tabIds: unknown[] = []
    for (const op of ops) {
      if (op === 'flush') await flush()
      else {
        const made = recordGenerateConverted({
          webContentsId: op.record,
          target: 'markdown',
          kind: 'mindmap-to-markdown',
          sources: [],
          conversionId: 'c',
        })
        tabIds.push(made.tabId ?? null)
      }
    }
    await flush()
    return tabIds
  } finally {
    setGenerateTabIdResolver(null)
    resetGenerateHandoffsForTest()
  }
}

type StatCfg = { birthtimeMs: number; mtimeMs: number } | { throws: true } | null

function statFor(cfg: StatCfg | undefined, log: (...line: unknown[]) => void) {
  if (cfg === null || cfg === undefined) return undefined
  return (path: string) => {
    log('stat', path)
    if ('throws' in cfg) throw new Error('ENOENT')
    return cfg
  }
}

interface LinksCfg {
  links?: unknown[]
  events?: Array<{ webContentsId: number; mode: string; sources: unknown[]; at: number }>
  now?: number
  saveThrows?: boolean
}

interface LinkOp {
  note?: [number, string, unknown?]
  sync?: boolean
  moved?: [string, string]
  sourcesOf?: string
  derivedFrom?: string
  paths?: boolean
  links?: boolean
  version?: boolean
  destroy?: number
  listen?: string
  unlisten?: string
  setEvents?: LinksCfg['events']
  setNow?: number
}

/** the ops both link specs run against a `DocumentLinks` */
async function runLinkOps(
  links: DocumentLinks,
  ops: LinkOp[],
  cx: { log: (...line: unknown[]) => void },
  state?: { events: NonNullable<LinksCfg['events']>; now: number },
): Promise<unknown[]> {
  const destroyed = new Map<number, () => void>()
  const unsubscribe = new Map<string, () => void>()
  const out: unknown[] = []
  for (const op of ops) {
    try {
      if (op.note) {
        const [id, path, options] = op.note
        links.noteTabPath(
          {
            id,
            once: (event: 'destroyed', listener: () => void) => {
              cx.log('once', id, event)
              destroyed.set(id, listener)
            },
          },
          path,
          options as never,
        )
        out.push(null)
      } else if (op.sync) out.push(links.sync())
      else if (op.moved) {
        links.fileMoved(op.moved[0], op.moved[1])
        out.push(null)
      } else if (op.sourcesOf !== undefined) out.push(links.sourcesOf(op.sourcesOf))
      else if (op.derivedFrom !== undefined) out.push(links.derivedFrom(op.derivedFrom))
      else if (op.paths) out.push(links.paths())
      else if (op.links) out.push(links.links())
      else if (op.version) out.push(links.version)
      else if (op.destroy !== undefined) {
        destroyed.get(op.destroy)?.()
        destroyed.delete(op.destroy)
        out.push(null)
      } else if (op.listen !== undefined) {
        const name = op.listen
        unsubscribe.set(
          name,
          links.onChange(() => cx.log('change', name)),
        )
        out.push(null)
      } else if (op.unlisten !== undefined) {
        unsubscribe.get(op.unlisten)?.()
        out.push(null)
      } else if (op.setEvents && state) {
        state.events = op.setEvents
        out.push(null)
      } else if (op.setNow !== undefined && state) {
        state.now = op.setNow
        out.push(null)
      }
    } catch (error) {
      out.push({ error: (error as Error).message })
    }
  }
  return out
}

async function runLinks(
  cfg: LinksCfg,
  ops: LinkOp[],
  cx: { now: number; log: (...line: unknown[]) => void },
): Promise<unknown[]> {
  const state = { events: cfg.events ?? [], now: cfg.now ?? cx.now }
  const links = new DocumentLinks({
    load: () => {
      cx.log('load')
      return clone(cfg.links ?? []) as DocumentLink[]
    },
    save: (file) => {
      cx.log('save', file)
      if (cfg.saveThrows) throw new Error('disk full')
    },
    events: () => {
      cx.log('events')
      return clone(state.events) as never
    },
    now: () => {
      cx.log('now')
      return new Date(state.now)
    },
  })
  return withWarnings(cx.log, () => runLinkOps(links, ops, cx, state))
}

async function runLinksAt(
  path: string,
  seed: Seed,
  ops: LinkOp[],
  cx: { now: number; log: (...line: unknown[]) => void },
): Promise<unknown[]> {
  seedStore(seed)
  try {
    return await withWarnings(cx.log, () =>
      withClockAsync(cx.now, () => runLinkOps(documentLinksAt(path), ops, cx)),
    )
  } finally {
    resetGenerateHandoffsForTest()
  }
}

const note = (id: number, path: string, options?: unknown): LinkOp => ({
  note: options === undefined ? [id, path] : [id, path, options],
})
const ev = (webContentsId: number, sources: unknown[], at: number, mode = 'ai') => ({
  webContentsId,
  mode,
  sources,
  at,
})
const L1 = link('/w/old.docx', ['/s/o1.pdf', '/s/o2.pdf'], 't0', 'convert')
const L2 = link('/w/other.docx', ['/w/old.docx'], 't1')

const linkCases: Array<[LinksCfg, LinkOp[]]> = [
  [
    { events: [ev(1, ['/s/a.pdf', '/s/b.pdf'], 100)] },
    [note(1, '/w/out.docx'), { links: true }, { version: true }],
  ],
  [
    {},
    [
      note(1, '/w/out.docx'),
      { setEvents: [ev(1, ['/s/a.pdf'], 5, 'convert')] },
      { sync: true },
      { sync: true },
      { links: true },
    ],
  ],
  [
    { events: [ev(1, ['/s/a.pdf'], 100)] },
    [note(1, '/w/x.docx', { fresh: false }), { sync: true }, { paths: true }, { links: true }],
  ],
  [
    { events: [ev(1, ['/s/a.pdf'], 100)] },
    [note(1, '/w/a.docx'), note(1, '/w/b.docx'), { links: true }, { paths: true }],
  ],
  [
    {
      events: [
        ev(1, ['/s/a', '', 5, null, '/s/a', '/s/./a', '/w/out.docx', '/s/b', '/s/B', ['/x']], 7),
      ],
    },
    [note(1, '/w/out.docx'), { links: true }],
  ],
  [
    { events: [ev(1, ['/w/out.docx', '/w/./out.docx', ''], 7)] },
    [note(1, '/w/out.docx'), { sync: true }, { links: true }, { version: true }],
  ],
  [
    {
      events: [
        ev(1, ['/s/late'], 900),
        ev(1, ['/s/early'], 100, 'convert'),
        ev(1, ['/s/tie'], 100),
        ev(2, ['/s/two'], 50),
      ],
    },
    [
      note(1, '/w/one.docx'),
      note(2, '/w/two.docx'),
      note(3, '/w/three.docx'),
      { links: true },
      { paths: true },
    ],
  ],
  [
    { links: [L1, L2], events: [ev(1, ['/s/new.pdf'], 100)] },
    [
      note(1, '/w/old.docx'),
      { links: true },
      { sourcesOf: '/w/old.docx' },
      { derivedFrom: '/s/new.pdf' },
      { derivedFrom: '/s/o1.pdf' },
    ],
  ],
  [
    { links: [L1, L2] },
    [
      { moved: ['/w/old.docx', '/w/renamed.docx'] },
      { links: true },
      { version: true },
      { sourcesOf: '/w/renamed.docx' },
      { derivedFrom: '/w/renamed.docx' },
    ],
  ],
  [
    { links: [L1, L2] },
    [
      { moved: ['/s/o1.pdf', '/s/moved.pdf'] },
      { links: true },
      { moved: ['/nowhere', '/else'] },
      { version: true },
    ],
  ],
  [
    { links: [L1, L2] },
    [{ moved: ['/w/old.docx', '/w/other.docx'] }, { links: true }, { paths: true }],
  ],
  [
    { links: [link('/w/a', ['/s/x']), link('/w/b', ['/s/x']), link('/w/c', ['/w/a', '/w/a'])] },
    [{ moved: ['/w/a', '/w/b'] }, { links: true }, { moved: ['/w/b', '/w/b'] }, { version: true }],
  ],
  [
    { events: [ev(1, ['/s/a.pdf'], 100)] },
    [
      { listen: 'first' },
      note(1, '/w/new.docx'),
      { moved: ['/w/new.docx', '/w/moved.docx'] },
      { paths: true },
      { moved: ['/s/a.pdf', '/s/b.pdf'] },
      { paths: true },
    ],
  ],
  [
    {},
    [
      note(1, '/w/a.docx'),
      note(1, '/w/ignored.docx'),
      { paths: true },
      { moved: ['/w/a.docx', '/w/b.docx'] },
      { paths: true },
      { destroy: 1 },
      { paths: true },
      note(1, '/w/c.docx'),
      { paths: true },
    ],
  ],
  [
    { events: [ev(1, ['/s/a'], 1)] },
    [note(1, '/w/a.docx'), { destroy: 1 }, note(1, '/w/a.docx'), { sync: true }, { version: true }],
  ],
  [
    { saveThrows: true, events: [ev(1, ['/s/a'], 1)] },
    [{ listen: 'x' }, note(1, '/w/a.docx'), { version: true }, { links: true }],
  ],
  [
    { events: [ev(1, ['/s/a'], 1), ev(2, ['/s/b'], 2)] },
    [
      { listen: 'a' },
      { listen: 'b' },
      note(1, '/w/1.docx'),
      { unlisten: 'a' },
      note(2, '/w/2.docx'),
      { unlisten: 'b' },
      { moved: ['/w/1.docx', '/w/3.docx'] },
      { links: true },
    ],
  ],
  [
    { now: 8.64e15 + 1, events: [ev(1, ['/s/a'], 1)] },
    [note(1, '/w/a.docx'), { sync: true }, { links: true }, { paths: true }],
  ],
  [{ now: -1, events: [ev(1, ['/s/a'], 1)] }, [note(1, '/w/a.docx'), { links: true }]],
  [{ now: 253402300800000, events: [ev(1, ['/s/a'], 1)] }, [note(1, '/w/a.docx'), { links: true }]],
  [
    {
      events: [
        ev(1, ['/s/a'], 1),
        ev(2, ['/s/b'], 1),
        ev(3, ['/s/c'], 1),
        ev(4, ['/s/d'], 1),
        ev(5, ['/s/e'], 1),
      ],
    },
    [
      note(1, '/w/1', { fresh: true }),
      note(2, '/w/2', { fresh: 0 }),
      note(3, '/w/3', { fresh: null }),
      note(4, '/w/4', null),
      note(5, '/w/5', {}),
      { links: true },
    ],
  ],
  [
    { events: [ev(0, ['/s/a'], 1), ev(-1, ['/s/b'], 1), ev(1.5, ['/s/c'], 1)] },
    [note(0, '/w/0'), note(-1, '/w/m'), note(1.5, '/w/f'), { links: true }],
  ],
  [
    { events: [ev(1, ['rel/s.pdf', './rel/../s2.pdf'], 1)] },
    [
      note(1, 'rel/out.docx'),
      { links: true },
      { sourcesOf: './rel/out.docx' },
      { derivedFrom: 'rel/s.pdf' },
    ],
  ],
  [
    { links: [link('/w/a.docx', ['/s/A.pdf']), link('/w/A.docx', ['/s/a.pdf'])] },
    [
      { sourcesOf: '/w/A.docx' },
      { sourcesOf: '/w/a.docx/' },
      { derivedFrom: '/s/a.pdf' },
      { derivedFrom: '/s/./A.pdf' },
      { paths: true },
    ],
  ],
  [
    { events: [ev(1, ['/s/\u00fcn\u00ef \u{1F600}.pdf'], 1, 'convert')] },
    [
      note(1, '/w/\ud55c\uae00 \u{1F600}.docx'),
      { links: true },
      { derivedFrom: '/s/\u00fcn\u00ef \u{1F600}.pdf' },
    ],
  ],
  [
    {},
    [
      { sourcesOf: '/none' },
      { derivedFrom: '/none' },
      { paths: true },
      { links: true },
      { version: true },
      { sync: true },
    ],
  ],
]

const AT_FILE = '$DIR/document-links.json'
const linksAtCases: Array<[Seed, LinkOp[], Record<string, FileSpec> | undefined, string?]> = [
  [SEEDS[1], [note(1, '/w/out.docx'), { links: true }], undefined],
  [
    SEEDS[1],
    [note(1, '/w/out.docx'), { links: true }],
    { 'document-links.json': textOf([L1, L2]) },
  ],
  [
    SEEDS[1],
    [note(1, '/w/old.docx'), { links: true }],
    { 'document-links.json': textOf([L1, L2]) },
  ],
  [
    SEEDS[0],
    [note(1, '/w/out.docx'), { sync: true }, { links: true }],
    { 'document-links.json': 'not json' },
  ],
  [
    SEEDS[5],
    [
      note(1, '/w/one.docx'),
      note(3, '/w/three.docx'),
      note(5, '/w/five.docx', { fresh: false }),
      { links: true },
    ],
    undefined,
  ],
  [
    SEEDS[6],
    [note(10, '/w/\u00fcn\u00ef.docx'), note(2, '/w/\u00e9.md'), { links: true }],
    undefined,
  ],
  [
    SEEDS[3],
    [
      note(2, '/w/c.md'),
      { moved: ['/w/c.md', '/w/d.md'] },
      { moved: ['/s/m.xmind', '/s/n.xmind'] },
      { links: true },
      { version: true },
    ],
    undefined,
  ],
  [SEEDS[1], [note(1, '/w/out.docx'), { links: true }], { 'document-links.json': { dir: true } }],
  [
    SEEDS[1],
    [note(1, '/w/out.docx'), { links: true }],
    { f: 'a file' },
    '$DIR/f/document-links.json',
  ],
]

const MENU_MODELS = [
  { sources: [], derived: [] },
  { sources: [{ path: '/s/a.pdf', name: 'a.pdf', missing: false }], derived: [] },
  { sources: [], derived: [{ path: '/w/b.docx', name: 'b.docx', missing: true }] },
  {
    sources: [
      { path: '/s/a.pdf', name: 'a.pdf', missing: false },
      {
        path: '/s/\u00fcn\u00ef \u{1F600}.pdf',
        name: '\u00fcn\u00ef \u{1F600}.pdf',
        missing: true,
      },
    ],
    derived: [{ path: '/w/b.docx', name: 'b.docx', missing: false }],
  },
]
const MENU_LABELS = [
  { make: 'Make another', sources: 'View Sources', derived: 'Documents Made from This' },
  { make: '\u00e9', sources: '', derived: '\u{1F600}' },
]

const linksGroup: Group = {
  'document-links.DOCUMENT_LINKS_FILE': constant(DOCUMENT_LINKS_FILE),
  'document-links.linkPathKey': {
    ts: (a) => linkPathKey(str(a, 0)),
    cases: LINK_PATHS.map((p): Case => ({ args: [p] })),
  },
  'document-links.parseDocumentLinks': {
    ts: (a) => parseDocumentLinks(str(a, 0)),
    cases: PARSE_TEXTS.map((text): Case => ({ args: [text] })),
  },
  'document-links.readDocumentLinksFile': {
    ts: (a) => readDocumentLinksFile(str(a, 0)),
    cases: [...Object.keys(READ_FILES), 'missing.json'].map((name): Case => ({
      args: [`$DIR/${name}`],
      files: READ_FILES,
    })),
  },
  'document-links.handoffStoreEvents': {
    ts: async (a) => {
      seedStore(a[0] as Seed)
      try {
        return handoffStoreEvents()
      } finally {
        resetGenerateHandoffsForTest()
      }
    },
    cases: SEEDS.map((seed): Case => ({ args: [seed] })),
  },
  'document-links.watchMakeEvents': {
    ts: (a, cx) =>
      runWatch(a[0] as Record<string, string>, a[1] as Array<{ record: number } | 'flush'>, cx),
    cases: (
      [
        [{ 1: 'tab-1' }, [{ record: 1 }]],
        [{ 1: 'tab-1' }, [{ record: 2 }, { record: 1 }, 'flush', { record: 1 }]],
        [
          { 1: '', 2: 'tab-2' },
          [{ record: 1 }, 'flush', { record: 2 }, { record: 2 }, 'flush', 'flush'],
        ],
        [{}, []],
        [{ 3: '\u00fcn\u00ef\u{1F600}' }, [{ record: 3 }, { record: 0 }, { record: -1 }]],
      ] as Array<[Record<string, string>, Array<{ record: number } | 'flush'>]>
    ).map(([tabs, ops]): Case => ({ args: [tabs, ops] })),
  },
  'document-links.isFreshlySavedPath': {
    ts: (a, cx) =>
      isFreshlySavedPath(str(a, 0), a[1] as number, statFor(a[2] as StatCfg | undefined, cx.log)),
    cases: [
      { args: ['/x', 20_000, { birthtimeMs: 10_000, mtimeMs: 0 }] },
      { args: ['/x', 20_000, { birthtimeMs: 9_999.9, mtimeMs: 15_000 }] },
      { args: ['/x', 20_000, { birthtimeMs: 0, mtimeMs: 10_000 }] },
      { args: ['/x', 20_000, { birthtimeMs: 0, mtimeMs: 9_999 }] },
      { args: ['/x', 20_000, { birthtimeMs: null, mtimeMs: 19_000 }] },
      { args: ['/x', 20_000, { birthtimeMs: -5, mtimeMs: 19_000 }] },
      { args: ['/x', 5_000, { birthtimeMs: 0, mtimeMs: 0 }] },
      { args: ['/x', 20_000, { throws: true }] },
      { args: ['/\u00fcn\u00ef \u{1F600}', -1e300, { birthtimeMs: 1, mtimeMs: 1 }] },
      {
        args: ['$DIR/a.docx', 1e12],
        files: { 'a.docx': { text: 'x', mtimeMs: 1_700_000_000_123 } },
        note: 'the real stat of a file born now',
      },
      {
        args: ['$DIR/a.docx', 4e12],
        files: { 'a.docx': { text: 'x', mtimeMs: 1_700_000_000_123 } },
        note: 'a clock far ahead',
      },
      { args: ['$DIR/none.docx', 4e12], note: 'not on disk' },
    ],
  },
  'document-links.DocumentLinks': {
    ts: (a, cx) => runLinks(a[0] as LinksCfg, a[1] as LinkOp[], cx),
    cases: linkCases.map(([cfg, ops]): Case => ({ args: [cfg, ops] })),
  },
  'document-links.documentLinksAt': {
    ts: (a, cx) => runLinksAt(str(a, 0), a[1] as Seed, a[2] as LinkOp[], cx),
    cases: linksAtCases.map(([seed, ops, files, path]): Case => ({
      args: [path ?? AT_FILE, seed, ops],
      ...(files ? { files } : {}),
    })),
  },
  'document-links.documentLinkMenuModel': {
    ts: (a, cx) => {
      const lookup = a[1] as {
        sources?: Record<string, string[]>
        derived?: Record<string, string[]>
      }
      return documentLinkMenuModel(
        (a[0] ?? undefined) as string | undefined,
        {
          sourcesOf: (path) => {
            cx.log('sourcesOf', path)
            return lookup.sources?.[path] ?? []
          },
          derivedFrom: (path) => {
            cx.log('derivedFrom', path)
            return lookup.derived?.[path] ?? []
          },
        },
        (path) => {
          cx.log('exists', path)
          return (a[2] as string[]).includes(path)
        },
      )
    },
    cases: [
      { args: [null, {}, []] },
      { args: ['', { sources: { '': ['/s'] } }, ['/s']] },
      { args: ['/w/b.docx', {}, []] },
      {
        args: ['/w/b.docx', { sources: { '/w/b.docx': ['/s/a.pdf', '/s/b/c.pdf'] } }, ['/s/a.pdf']],
      },
      {
        args: [
          '/s/a.pdf',
          { derived: { '/s/a.pdf': ['/w/b.docx', '/w/c.docx'] } },
          ['/w/b.docx', '/w/c.docx'],
        ],
      },
      {
        args: [
          '/m/x.docx',
          {
            sources: {
              '/m/x.docx': [
                '/s/\u00fcn\u00ef \u{1F600}.pdf',
                'C:\\a\\b.pdf',
                '/s/trailing/',
                '/s/.hidden',
                'rel.pdf',
              ],
            },
            derived: { '/m/x.docx': ['/d/\u00e9.docx'] },
          },
          ['/d/\u00e9.docx'],
        ],
      },
      {
        args: [
          '/m/x.docx',
          { sources: { '/m/x.docx': ['/a'] }, derived: { '/m/x.docx': ['/a'] } },
          ['/a'],
        ],
      },
      { args: ['/', { sources: { '/': ['/'] } }, []] },
    ],
  },
  'document-links-menu.documentLinkMenuItems': {
    ts: (a, cx) => {
      const items = documentLinkMenuItems({
        model: a[0] as never,
        labels: a[1] as never,
        isMac: a[2] as boolean,
        onMake: () => cx.log('make'),
        onOpen: (path) => cx.log('open', path),
      })
      const run = (list: Array<{ click?: unknown; submenu?: unknown }>): void => {
        for (const item of list) {
          ;(item.click as (() => void) | undefined)?.()
          if (Array.isArray(item.submenu)) run(item.submenu)
        }
      }
      run(items)
      return items
    },
    cases: MENU_MODELS.flatMap((model) =>
      MENU_LABELS.flatMap((labels) =>
        [false, true].map((isMac): Case => ({ args: [model, labels, isMac] })),
      ),
    ),
  },
}

export const group: Group = {
  ...commonGroup,
  ...controlGroup,
  ...controlHandlerGroup,
  ...defaultAppGroup,
  ...diagramGateGroup,
  ...passwordGroup,
  ...pdfGroup,
  ...noteTabsGroup,
  ...linksGroup,
}
