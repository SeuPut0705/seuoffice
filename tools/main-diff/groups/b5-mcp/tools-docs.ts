/**
 * Group `b5-mcp`, slice `tools-docs` (Rust: crates/main-core/src/calls/b5_mcp/tools_docs.rs):
 * the registry and the docx / session / open-documents / pdf / hwp tool sets of
 * apps/shell/src/main/mcp/tools.
 *
 * - `<file>.tools` lists what a factory registers, as the SDK lists it: the
 *   tools are registered on a real `McpServer` as mcp-server.ts registers
 *   them, and its `tools/list` handler answers `{ name, description,
 *   inputSchema }` for each (an empty shape, as mcp.js does, where the tool has
 *   none).
 * - `<file>.call` builds the tools over fakes the case describes, calls one
 *   handler with `args` and answers its value or what it threw. Each call of a
 *   fake is a log line. The fakes:
 *   - a value (`Val`) is `{ value }`, `{ undef: true }` (answers `undefined`)
 *     or `{ throws: message }`;
 *   - docs control `{ open, run }`: `open` is a number or `{ throws }`, `run`
 *     a `Val`; logs `docs.open`, `docs.run <wc> <command> <payload>`;
 *   - the CLI is a list of outcomes (see `scriptedCli` of mcp-pure.ts);
 *   - `resolve` is `{ answer }` or `{ throws }`: logs `resolveTarget`;
 *   - the open-documents control `{ list, read, close, save }`: `list` is a
 *     list of tabs or `{ throws }`, the others a `Val`, and each logs itself;
 *   - the PDF text reader is a world `{ pageCount, info, pages, truncated,
 *     failProbe, failRead }`, behind `readPdfText` (replaced for pdf-tools.ts
 *     alone); `hwpToText` (replaced for hwp-tools.ts alone) answers `text`.
 * - the helpers of the files (`sanitizeFileBase`, `uniquePathIn`,
 *   `resolveOutputPath`, `parsePageList`, `hwpTextWindow`, ...) are called
 *   as they are, on files of the case's folder (`$DIR`) where they look.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'
import { scriptedCli } from './mcp-pure.ts'

const PDF_BOX = Symbol.for('main-diff.pdf-text')
const HWP_BOX = Symbol.for('main-diff.hwp-text')
const PDF_URL = 'main-diff:pdf-read-text'
const HWP_URL = 'main-diff:hwp-to-text'
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (
      parent.endsWith('/mcp/tools/pdf-tools.ts') &&
      specifier.endsWith('/pdf/src/main/read-text')
    ) {
      return { url: PDF_URL, shortCircuit: true }
    }
    if (parent.endsWith('/mcp/tools/hwp-tools.ts') && specifier === '@seuoffice/file-parse') {
      return { url: HWP_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === PDF_URL) {
      const source = `export const readPdfText = (...a) => globalThis[Symbol.for('main-diff.pdf-text')](...a)`
      return { format: 'module', source, shortCircuit: true }
    }
    if (url === HWP_URL) {
      const source = `export const hwpToText = (...a) => globalThis[Symbol.for('main-diff.hwp-text')](...a)`
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, context)
  },
})

const formats = await import('../../../../apps/shell/src/main/mcp/tools/formats.ts')
const sessionTools = await import('../../../../apps/shell/src/main/mcp/tools/session-tools.ts')
const documentTools = await import('../../../../apps/shell/src/main/mcp/tools/document-tools.ts')
const openTools = await import('../../../../apps/shell/src/main/mcp/tools/open-documents-tools.ts')
const pdfTools = await import('../../../../apps/shell/src/main/mcp/tools/pdf-tools.ts')
const hwpTools = await import('../../../../apps/shell/src/main/mcp/tools/hwp-tools.ts')

// any: the cases describe fakes and answers of every shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Spec = Record<string, Any>

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const constant = (value: unknown, why: string): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: why,
})

/** a scripted answer: `{ value }`, `{ undef: true }` or `{ throws }` */
function answer(val: Spec | undefined): unknown {
  if (val?.throws !== undefined) throw new Error(val.throws)
  return val?.undef ? undefined : val?.value
}

/** what the SDK lists of tools registered as mcp-server.ts registers them */
async function listed(tools: Spec[]): Promise<unknown> {
  const server = new McpServer({ name: 'main-diff', version: '1' })
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      },
      (async () => ({ content: [] })) as never,
    )
  }
  const handlers = (server.server as Any)._requestHandlers as Map<string, Any>
  const out = await handlers.get('tools/list')({ method: 'tools/list' }, {})
  return out.tools.map((t: Spec) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

async function callTool(tools: Spec[], name: string, args: unknown): Promise<unknown> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return await tool.handler(args ?? {})
}

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

const FAMILY_NAMES = ['docx', 'xlsx', 'pptx', 'md', 'html', 'pdf', 'xmind', 'hwp', 'epub', 'drawio']
const familyCases = cases(...FAMILY_NAMES.map((f) => [f]), ['zip'], ['DOCX'], ['constructor'], [''])

const saveExtensionCases = cases(
  ['docx', '/a/report'],
  ['docx', '/a/report.docx'],
  ['docx', '/a/REPORT.DOCX'],
  ['docx', '/a/report.pdf'],
  ['docx', '/a/report.odt'],
  ['docx', '/a/report.ODT'],
  ['docx', '/a/report.'],
  ['docx', '/a.dir/report'],
  ['docx', 'report.tar.gz'],
  ['docx', '/a/rep ort.docx '],
  ['docx', ''],
  ['xlsx', '/a/book'],
  ['xlsx', '/a/book.xlsx'],
  ['xlsx', '/a/book.xls'],
  ['xlsx', '/a/book.csv'],
  ['xlsx', '/a/book.odt'],
  ['pptx', '/a/deck'],
  ['pptx', '/a/deck.pptx'],
  ['pptx', '/a/deck.odp'],
  ['pptx', '/a/deck.\u212Aey'],
  ['pptx', '/a/deck.p\u00e9ptx'],
)

const capabilityCases = cases(
  [null],
  [{}],
  [{ generating: true }],
  [{ generating: false }],
  [{ generating: 'no' }],
  [{ generating: 0 }],
  [{ generating: null }],
)

// ---------------------------------------------------------------------------
// session-tools
// ---------------------------------------------------------------------------

/** the fake drivers of a case: `{ family, open, save }` */
function fakeDrivers(list: Spec[], cx: TsContext): Spec[] {
  return list.map((d) => ({
    family: d.family,
    openBlankTab: async () => {
      cx.log('driver.open', d.family)
      if (d.open?.throws !== undefined) throw new Error(d.open.throws)
      return d.open
    },
    save: async (wcId: number, path: string, overwrite: boolean) => {
      cx.log('driver.save', d.family, wcId, path, overwrite)
      return answer(d.save)
    },
  }))
}

async function sessionCall(spec: Spec, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  if (spec.session) host.begin(spec.session.family, spec.session.wcId)
  const tools = sessionTools.createSessionTools(fakeDrivers(spec.drivers, cx) as never, host)
  try {
    return await callTool(tools as Spec[], spec.tool, spec.args)
  } finally {
    cx.log('session', host.current())
  }
}

const DRIVERS: Spec[] = [
  { family: 'docx', open: 11, save: { value: { ok: true, path: '/x/a.docx' } } },
  { family: 'pptx', open: 12, save: { value: { path: '/x/a.pptx' } } },
  { family: 'xlsx', open: 13, save: { value: { ok: false, reason: 'disk full' } } },
]
const sessionCase = (spec: Spec, note: string): Case => ({
  args: [{ drivers: DRIVERS, ...spec }],
  note,
})
const withSave = (save: Spec, extra: Spec = {}): Spec => ({
  drivers: [{ family: 'docx', open: 5, save }],
  session: { family: 'docx', wcId: 5 },
  tool: 'save_session',
  args: { path: '/x/out.docx' },
  ...extra,
})

const sessionCases: Case[] = [
  sessionCase({ tool: 'create_session', args: { family: 'docx' } }, 'a session opens'),
  sessionCase(
    { tool: 'create_session', args: { family: 'xlsx' }, session: { family: 'docx', wcId: 1 } },
    'a new session replaces the old one',
  ),
  sessionCase({ tool: 'create_session', args: { family: 'pdf' } }, 'a family without a driver'),
  sessionCase({ tool: 'create_session', args: {} }, 'no family'),
  sessionCase({ tool: 'create_session', args: { family: 7 } }, 'a family that is a number'),
  sessionCase({ tool: 'create_session', args: { family: { a: 1 } } }, 'a family that is an object'),
  sessionCase({ tool: 'create_session', args: { family: ['docx'] } }, 'a family that is an array'),
  sessionCase({ tool: 'create_session', args: { family: null } }, 'a family that is null'),
  sessionCase(
    { tool: 'create_session', args: { family: { toString: 1 } } },
    'a family that cannot be converted',
  ),
  {
    args: [
      {
        drivers: [{ family: 'docx', open: { throws: 'no tab' } }],
        tool: 'create_session',
        args: { family: 'docx' },
        session: { family: 'pptx', wcId: 2 },
      },
    ],
    note: 'the driver fails to open: the old session stays',
  },
  {
    args: [
      {
        drivers: [
          { family: 'docx', open: 3 },
          { family: 'docx', open: 4 },
        ],
        tool: 'create_session',
        args: { family: 'docx' },
      },
    ],
    note: 'two drivers of a family: the last wins',
  },
  {
    args: [{ drivers: [], tool: 'create_session', args: { family: 'docx' } }],
    note: 'no drivers, no tool',
  },
  sessionCase({ tool: 'save_session', args: { path: '/x/a.docx' } }, 'save with no session'),
  sessionCase(
    { tool: 'save_session', args: { path: '/x/a' }, session: { family: 'docx', wcId: 9 } },
    'the extension is appended; the session ends',
  ),
  sessionCase(
    {
      tool: 'save_session',
      args: { path: '/x/a.docx', overwrite: true },
      session: { family: 'docx', wcId: 9 },
    },
    'overwrite is passed on',
  ),
  sessionCase(
    {
      tool: 'save_session',
      args: { path: '/x/a.docx', overwrite: 'yes' },
      session: { family: 'docx', wcId: 9 },
    },
    'overwrite must be true itself',
  ),
  sessionCase(
    { tool: 'save_session', args: { path: 'rel/a.docx' }, session: { family: 'docx', wcId: 9 } },
    'a relative path',
  ),
  sessionCase({ tool: 'save_session', args: {}, session: { family: 'docx', wcId: 9 } }, 'no path'),
  sessionCase(
    { tool: 'save_session', args: { path: 5 }, session: { family: 'docx', wcId: 9 } },
    'a path that is a number',
  ),
  sessionCase(
    { tool: 'save_session', args: { path: '/x/a.pdf' }, session: { family: 'docx', wcId: 9 } },
    'a different extension',
  ),
  sessionCase(
    { tool: 'save_session', args: { path: '/x/a.odt' }, session: { family: 'docx', wcId: 9 } },
    'odt gets the conversion hint',
  ),
  sessionCase(
    { tool: 'save_session', args: { path: '/x/a.pptx' }, session: { family: 'pptx', wcId: 9 } },
    'a slides save answers the path only',
  ),
  sessionCase(
    { tool: 'save_session', args: { path: '/x/a.xlsx' }, session: { family: 'xlsx', wcId: 9 } },
    'a failed save reported as data keeps the session',
  ),
  sessionCase(
    {
      tool: 'save_session',
      args: { path: '/x/a.docx' },
      session: { family: 'docx', wcId: 9 },
      drivers: [{ family: 'xlsx', open: 1 }],
    },
    'no driver for the active session',
  ),
  { args: [withSave({ throws: 'write refused' })], note: 'the driver throws: the session stays' },
  { args: [withSave({ value: { ok: false, error: 'bad disk' } })], note: 'ok false with an error' },
  {
    args: [withSave({ value: { ok: false, reason: '', error: 'ignored' } })],
    note: 'an empty reason is no detail',
  },
  {
    args: [withSave({ value: { ok: false, reason: 5, error: 'from error' } })],
    note: 'a reason that is no string: the error',
  },
  { args: [withSave({ value: { ok: false } })], note: 'ok false, nothing more' },
  { args: [withSave({ value: { ok: false, reason: 5, error: 6 } })], note: 'neither is a string' },
  { args: [withSave({ value: { ok: 0, reason: 'x' } })], note: 'ok must be false itself' },
  {
    args: [withSave({ value: { path: '/x/out.docx', ok: true, extra: 1 } })],
    note: 'a key order of its own',
  },
  { args: [withSave({ value: 'saved' })], note: 'a string answer' },
  { args: [withSave({ value: 0 })], note: 'a zero answer' },
  { args: [withSave({ value: null })], note: 'a null answer' },
  { args: [withSave({ undef: true })], note: 'no answer' },
  { args: [withSave({ value: [1, 'b'] })], note: 'an array is spread' },
  { args: [withSave({ value: [] })], note: 'an empty array' },
  {
    args: [withSave({ value: { ok: 'maybe', a: 1, 5: 'five', 2: 'two' } })],
    note: 'index keys come first',
  },
  {
    args: [
      withSave({ value: { ok: false, reason: 'ø' } }, { session: { family: 'docx', wcId: 5 } }),
    ],
    note: 'a reason with a non-ASCII letter',
  },
]

const sessionToolsCases: Case[] = [
  { args: [{ families: ['docx'] }], note: 'one driver' },
  { args: [{ families: ['docx', 'pptx', 'xlsx'] }], note: 'all three' },
  { args: [{ families: ['xlsx', 'pptx'] }], note: 'in the order given' },
  { args: [{ families: ['docx', 'docx'] }], note: 'a family twice' },
  { args: [{ families: [] }], note: 'none' },
]

const hostCases: Case[] = cases(
  [[{ require: 'docx' }, { current: true }]],
  [
    [
      { begin: ['docx', 4] },
      { current: true },
      { require: 'docx' },
      { end: true },
      { current: true },
      { require: 'docx' },
    ],
  ],
  [[{ begin: ['pptx', 5] }, { require: 'docx' }, { require: 'xlsx' }, { require: 'pptx' }]],
  [
    [
      { begin: ['xlsx', 1] },
      { begin: ['docx', 2] },
      { current: true },
      { end: true },
      { end: true },
      { current: true },
    ],
  ],
)

interface TargetSpec {
  session?: { family: string; wcId: number } | null
  resolver?: { answer?: number; throws?: string } | null
  family: string
  calls: { document?: unknown; options?: unknown }[]
}

async function targetCalls(spec: TargetSpec, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  if (spec.session) host.begin(spec.session.family as never, spec.session.wcId)
  const resolver = spec.resolver
    ? async (target: string, family: string, options?: unknown) => {
        cx.log('resolveTarget', target, family, options ?? null)
        if (spec.resolver?.throws !== undefined) throw new Error(spec.resolver.throws)
        return spec.resolver?.answer as number
      }
    : undefined
  const target = sessionTools.contentTarget(host, resolver as never, spec.family as never)
  const answers: unknown[] = []
  for (const call of spec.calls) {
    try {
      answers.push({ ok: await target(call.document, call.options as never) })
    } catch (error) {
      answers.push({ error: (error as Error).message })
    }
  }
  return answers
}

const targetCase = (spec: Partial<TargetSpec> & Pick<TargetSpec, 'calls'>, note: string): Case => ({
  args: [{ family: 'docx', ...spec }],
  note,
})
const targetCases: Case[] = [
  targetCase(
    {
      session: { family: 'docx', wcId: 7 },
      calls: [{}, { document: '' }, { document: null }, { document: 5 }, { document: false }],
    },
    'no document: the session answers',
  ),
  targetCase({ calls: [{}, { document: '' }] }, 'no document and no session'),
  targetCase({ session: { family: 'pptx', wcId: 7 }, calls: [{}] }, 'a session of another family'),
  targetCase(
    {
      session: { family: 'docx', wcId: 7 },
      resolver: { answer: 21 },
      calls: [
        { document: 'tab-1' },
        { document: 'tab-2', options: { focus: true } },
        { document: '/a/b.docx', options: {} },
        { document: 'x', options: { focus: false } },
      ],
    },
    'a named document is resolved, not the session',
  ),
  targetCase(
    { resolver: { throws: 'no such tab' }, calls: [{ document: 'tab-9' }] },
    'the resolver fails',
  ),
  targetCase(
    { calls: [{ document: 'tab-1' }, { document: ' ' }] },
    'no resolver: a named document is refused',
  ),
  targetCase(
    {
      family: 'xlsx',
      session: { family: 'xlsx', wcId: 3 },
      resolver: { answer: 5 },
      calls: [{ document: 'doc' }, {}],
    },
    'the family is passed on',
  ),
]

// ---------------------------------------------------------------------------
// document-tools
// ---------------------------------------------------------------------------

interface DepsSpec {
  version?: string
  saveDir?: string
  background?: boolean | null
  extraFormats?: string[]
  openInTab?: 'ok' | 'throws' | 'none'
  docs?: { open?: number | { throws: string }; run?: Spec }
  cli?: Spec | Spec[]
  resolve?: { answer?: number; throws?: string }
}

function fakeDeps(d: DepsSpec, cx: TsContext): { deps: Spec; scratch: () => string | undefined } {
  const deps: Spec = { version: d.version ?? '9.9.9', defaultSaveDir: () => d.saveDir ?? '/save' }
  if (d.background !== undefined && d.background !== null) deps.background = d.background
  if (d.extraFormats) deps.extraFormats = d.extraFormats
  if (d.openInTab && d.openInTab !== 'none') {
    deps.openInTab = async (path: string) => {
      cx.log('openInTab', path)
      if (d.openInTab === 'throws') throw new Error('cannot open')
    }
  }
  if (d.docs) {
    const docs = d.docs
    deps.docs = {
      openBlankTab: async () => {
        cx.log('docs.open')
        if (typeof docs.open === 'object') throw new Error(docs.open.throws)
        return docs.open ?? 1
      },
      runCommand: async (wcId: number, command: string, payload: unknown) => {
        cx.log('docs.run', wcId, command, payload)
        return answer(docs.run)
      },
    }
  }
  let scratch: () => string | undefined = () => undefined
  if (d.cli) {
    const cli = scriptedCli(d.cli, cx)
    deps.cli = cli.runner
    scratch = cli.scratch
  }
  if (d.resolve) {
    const resolve = d.resolve
    deps.resolveTarget = async (target: string, family: string, options?: unknown) => {
      cx.log('resolveTarget', target, family, options ?? null)
      if (resolve.throws !== undefined) throw new Error(resolve.throws)
      return resolve.answer as number
    }
  }
  return { deps, scratch }
}

interface DocCall {
  deps?: DepsSpec
  session?: { family: string; wcId: number } | null
  tool: string
  args?: unknown
}

async function documentCall(spec: DocCall, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  if (spec.session) host.begin(spec.session.family as never, spec.session.wcId)
  const { deps, scratch } = fakeDeps(spec.deps ?? {}, cx)
  const tools = documentTools.createDocumentTools(deps as never, host)
  try {
    return await callTool(tools as Spec[], spec.tool, spec.args)
  } finally {
    const dir = scratch()
    if (dir !== undefined) cx.log('scratch folder removed', !existsSync(dir))
  }
}

const OK_CLI: Spec = {
  ok: true,
  code: 0,
  json: { status: 'ok', command: 'c', summary: 'done', output_path: '/real/out' },
}
const cli = (json: Spec, extra: Spec = {}): Spec => ({
  ok: true,
  code: 0,
  json: { status: 'ok', command: 'c', summary: 'done', ...json },
  ...extra,
})
const FAILED_CLI: Spec = {
  ok: false,
  code: 2,
  json: { status: 'error', command: 'c', code: 2, message: 'CLI says no' },
}

const docCase = (spec: DocCall, note: string, files?: Case['files']): Case => ({
  args: [spec],
  ...(files ? { files } : {}),
  note,
})
const FILES = {
  'a.docx': 'x',
  'b.odt': 'x',
  'c.txt': 'x',
  'deck.pptx': 'x',
  'sheet.xlsx': 'x',
  'save/Taken.docx': 'x',
  'save/Taken-2.docx': 'x',
  'out.docx': 'x',
}
const DEPS = (extra: DepsSpec = {}): DepsSpec => ({ saveDir: '$DIR/save', cli: OK_CLI, ...extra })

const documentCases: Case[] = [
  // create_docx
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'Quarterly report', content: '# Hi' } },
    'markdown into the default folder',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'Taken', content: 'x' } },
    'a default name that is taken gets -3',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'create_docx',
      args: { title: '  Quarterly  ', content: '<p>x</p>', format: 'html' },
    },
    'html content, a trimmed title',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', format: 'markdown' } },
    'markdown named',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', format: 'rtf' } },
    'another format is markdown',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', path: '$DIR/new' } },
    'a path without an extension',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'create_docx',
      args: { title: 'T', content: 'x', path: '$DIR/new.DOCX' },
    },
    'the extension in capitals',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'create_docx',
      args: { title: 'T', content: 'x', path: '$DIR/out.docx' },
    },
    'an existing file is refused',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'create_docx',
      args: { title: 'T', content: 'x', path: '$DIR/out.docx', overwrite: true },
    },
    'overwrite passes --force',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'create_docx',
      args: { title: 'T', content: 'x', path: '$DIR/out.docx', overwrite: 'yes' },
    },
    'overwrite must be true itself',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', path: 'rel.docx' } },
    'a relative path',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', path: '$DIR/r.pdf' } },
    'a different extension',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', path: '' } },
    'an empty path is the default folder',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: 'x', path: 5 } },
    'a path that is no string is the default folder',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: '   ', content: 'x' } },
    'a blank title',
  ),
  docCase({ deps: DEPS(), tool: 'create_docx', args: { content: 'x' } }, 'no title'),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 7, content: 'x' } },
    'a number as title',
  ),
  docCase({ deps: DEPS(), tool: 'create_docx', args: { title: 'T' } }, 'no content'),
  docCase(
    { deps: DEPS(), tool: 'create_docx', args: { title: 'T', content: ['a', 'b'] } },
    'content that is an array',
  ),
  docCase(
    { deps: DEPS({ cli: undefined }), tool: 'create_docx', args: { title: 'T', content: 'x' } },
    'no CLI',
  ),
  docCase(
    { deps: DEPS({ cli: FAILED_CLI }), tool: 'create_docx', args: { title: 'T', content: 'x' } },
    'the CLI fails',
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ output_path: undefined }) }),
      tool: 'create_docx',
      args: { title: 'T', content: 'x' },
    },
    'the CLI names no output',
  ),
  docCase(
    { deps: DEPS({ background: false }), tool: 'create_docx', args: { title: 'T', content: 'x' } },
    'background off: no such tool',
  ),
  // fill_template
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { filled: 3, missing: ['x'] } }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: { name: 'Ann' } },
    },
    'a template filled into the default folder',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({
        cli: cli({ detail: { path: '/from/detail', summary: 'detail summary', n: 1 } }),
      }),
      tool: 'fill_template',
      args: {
        template: '$DIR/a.docx',
        data: {},
        path: '$DIR/filled.docx',
        overwrite: true,
        strict: true,
      },
    },
    'detail keys override',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ summary: undefined, detail: { summary: 'late', other: 1 } }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'an undefined summary holds its place',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: ['a', 'b'] }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'a detail that is an array',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: 'xy' }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'a detail that is a string',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: null }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'a null detail',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: 7 }) }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'a detail that is a number',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'fill_template',
      args: { template: '$DIR/deck.pptx', data: {}, path: '$DIR/x' },
    },
    'a pptx template, a path with no extension',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'fill_template',
      args: { template: '$DIR/sheet.xlsx', data: {}, path: '$DIR/x.docx' },
    },
    'an output of another type',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'fill_template', args: { template: 'a.docx', data: {} } },
    'a relative template',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'fill_template', args: { template: '$DIR/c.txt', data: {} } },
    'a template of another type',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'fill_template', args: { template: '$DIR/missing.docx', data: {} } },
    'a missing template',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: undefined }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'no CLI',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: FAILED_CLI }),
      tool: 'fill_template',
      args: { template: '$DIR/a.docx', data: {} },
    },
    'the CLI fails',
    FILES,
  ),
  // convert_document
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { engine: 'x', supported: ['a'] } }) }),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'pdf' },
    },
    'a conversion into the default folder',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'convert_document',
      args: {
        path: '$DIR/a.docx',
        to: '  MD ',
        out: '$DIR/o.md',
        overwrite: true,
        password: 'pw',
        sheet: 'S1',
      },
    },
    'every option',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md', out: '   ', password: '', sheet: '' },
    },
    'blank out, empty password and sheet are left out',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md', password: 5, sheet: null, out: 5 },
    },
    'options that are no strings',
    FILES,
  ),
  docCase(
    {
      deps: DEPS(),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md', out: '$DIR/out.docx' },
    },
    'an output of another extension',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'convert_document', args: { path: '$DIR/a.docx', to: 'docx' } },
    'the same type, a taken name',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'convert_document', args: { path: 'a.docx', to: 'md' } },
    'a relative source',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'convert_document', args: { path: '$DIR/a.docx', to: 'tar.gz' } },
    'a format that is no extension',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'convert_document', args: { path: '$DIR/a.docx', to: '' } },
    'no format',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'convert_document', args: { path: '$DIR/missing.docx', to: 'md' } },
    'a missing source',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: undefined }),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md' },
    },
    'no CLI',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: FAILED_CLI }),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md' },
    },
    'the CLI fails',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ output_path: '/engine/choice.md' }) }),
      tool: 'convert_document',
      args: { path: '$DIR/a.docx', to: 'md' },
    },
    'the CLI chooses the output',
    FILES,
  ),
  // check_document
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { issues: [], clean: true } }) }),
      tool: 'check_document',
      args: { path: '$DIR/a.docx' },
    },
    'a clean document',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { summary: 'from detail' } }) }),
      tool: 'check_document',
      args: { path: '$DIR/b.odt' },
    },
    'an odt, a detail key over the summary',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ summary: undefined, detail: { a: 1 } }) }),
      tool: 'check_document',
      args: { path: '$DIR/b.odt' },
    },
    'no summary',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'check_document', args: { path: '$DIR/c.txt' } },
    'a text file',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'check_document', args: { path: 'a.docx' } },
    'a relative path',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'check_document', args: { path: '$DIR/gone.docx' } },
    'a missing file',
    FILES,
  ),
  docCase(
    { deps: DEPS({ cli: undefined }), tool: 'check_document', args: { path: '$DIR/a.docx' } },
    'no CLI',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: FAILED_CLI, background: false }),
      tool: 'check_document',
      args: { path: '$DIR/a.docx' },
    },
    'always registered; the CLI fails',
    FILES,
  ),
  docCase({ deps: DEPS(), tool: 'check_document', args: {} }, 'no path'),
  // read_docx
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { items: [{ text: 'one' }, { text: 'two' }] } }) }),
      tool: 'read_docx',
      args: { path: '$DIR/a.docx' },
    },
    'two paragraphs',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { items: [] } }) }),
      tool: 'read_docx',
      args: { path: '$DIR/b.odt' },
    },
    'an odt, no text',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { items: 5 } }) }),
      tool: 'read_docx',
      args: { path: '$DIR/a.docx' },
    },
    'items that are no list',
    FILES,
  ),
  docCase({ deps: DEPS(), tool: 'read_docx', args: { path: '$DIR/c.txt' } }, 'a text file', FILES),
  docCase({ deps: DEPS(), tool: 'read_docx', args: { path: '/nowhere/x.docx' } }, 'a missing file'),
  docCase({ deps: DEPS(), tool: 'read_docx', args: { path: 'x.docx' } }, 'a relative path'),
  docCase(
    { deps: DEPS({ cli: undefined }), tool: 'read_docx', args: { path: '$DIR/a.docx' } },
    'no CLI',
    FILES,
  ),
  docCase(
    { deps: DEPS({ cli: FAILED_CLI }), tool: 'read_docx', args: { path: '$DIR/a.docx' } },
    'the CLI fails',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: { ok: false, code: 5, stderr: 'boom' } }),
      tool: 'read_docx',
      args: { path: '$DIR/a.docx' },
    },
    'the CLI prints no JSON',
    FILES,
  ),
  // read_docx_properties
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: { properties: { title: 'T' } } }) }),
      tool: 'read_docx_properties',
      args: { path: '$DIR/a.docx' },
    },
    'properties',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ cli: cli({ detail: {} }) }),
      tool: 'read_docx_properties',
      args: { path: '$DIR/a.docx' },
    },
    'no properties',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'read_docx_properties', args: { path: '$DIR/b.odt' } },
    'an odt is refused',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'read_docx_properties', args: { path: '$DIR/A.DOCX' } },
    'the extension in capitals, no such file',
  ),
  docCase(
    { deps: DEPS({ cli: undefined }), tool: 'read_docx_properties', args: { path: '$DIR/a.docx' } },
    'no CLI',
    FILES,
  ),
  // open_in_seuoffice
  docCase(
    { deps: DEPS({ openInTab: 'ok' }), tool: 'open_in_seuoffice', args: { path: '$DIR/a.docx' } },
    'a file opens',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ openInTab: 'throws' }),
      tool: 'open_in_seuoffice',
      args: { path: '$DIR/a.docx' },
    },
    'opening fails',
    FILES,
  ),
  docCase(
    { deps: DEPS(), tool: 'open_in_seuoffice', args: { path: '$DIR/a.docx' } },
    'no way to open',
    FILES,
  ),
  docCase(
    {
      deps: DEPS({ openInTab: 'ok' }),
      tool: 'open_in_seuoffice',
      args: { path: '$DIR/gone.docx' },
    },
    'a missing file',
    FILES,
  ),
  docCase(
    { deps: DEPS({ openInTab: 'ok' }), tool: 'open_in_seuoffice', args: { path: 'a.docx' } },
    'a relative path',
    FILES,
  ),
  // get_app_info
  docCase(
    { deps: { version: '1.2.3', saveDir: '/home/u/Documents' }, tool: 'get_app_info', args: {} },
    'the default report',
  ),
  docCase(
    {
      deps: { version: '1.2.3', saveDir: '/d', extraFormats: ['pptx', 'xlsx'], background: true },
      tool: 'get_app_info',
      args: {},
    },
    'extra formats',
  ),
  docCase(
    {
      deps: { version: '1.2.3', saveDir: '/d', extraFormats: ['pptx'], background: false },
      tool: 'get_app_info',
      args: {},
    },
    'background off: no formats, no generate',
  ),
  docCase(
    { deps: { version: '', saveDir: '' }, tool: 'get_app_info', args: { ignored: 1 } },
    'empty strings',
  ),
  // content tools
  docCase(
    {
      deps: DEPS({ docs: { run: { value: { inserted: 1 } } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'insert_content',
      args: { html: '<p>x</p>', afterBlockIndex: 2 },
    },
    'insert into the session tab',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'ok' } }, resolve: { answer: 31 } }),
      tool: 'insert_content',
      args: { html: '<p>x</p>', document: 'tab-4' },
    },
    'insert into a named document',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { undef: true } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'insert_content',
      args: { html: 'x' },
    },
    'the editor answers nothing',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { throws: 'editor refused' } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'insert_content',
      args: { html: 'x' },
    },
    'the editor refuses',
  ),
  docCase({ deps: DEPS({ docs: {} }), tool: 'insert_content', args: { html: 'x' } }, 'no session'),
  docCase(
    {
      deps: DEPS({ docs: {} }),
      session: { family: 'xlsx', wcId: 2 },
      tool: 'insert_content',
      args: { html: 'x' },
    },
    'the session is a spreadsheet',
  ),
  docCase(
    { deps: DEPS({ docs: {} }), tool: 'insert_content', args: { html: 'x', document: 'tab-4' } },
    'a named document and no resolver',
  ),
  docCase(
    {
      deps: DEPS({ docs: {}, resolve: { throws: 'not a Word document' } }),
      tool: 'insert_content',
      args: { html: 'x', document: 'tab-4' },
    },
    'the resolver refuses',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 1 } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'replace_blocks',
      args: { startBlockIndex: 1, endBlockIndex: 2, html: '<p>y</p>' },
    },
    'replace blocks',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 1 } }, resolve: { answer: 4 } }),
      tool: 'replace_blocks',
      args: { startBlockIndex: 0, endBlockIndex: 0, html: 'z', document: '$DIR/a.docx' },
    },
    'replace blocks of a named document',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: [1, 2] } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'apply_ops',
      args: { ops: [{ op: 'bold' }], dryRun: true },
    },
    'dry run',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'x' } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'apply_ops',
      args: { ops: [], dryRun: 'yes', document: '' },
    },
    'dryRun must be true itself; an empty document is the session',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'x' } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'apply_ops',
      args: {},
    },
    'no ops: the key is left out',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'x' }, open: 1 }, resolve: { answer: 6 } }),
      tool: 'apply_ops',
      args: { ops: [1], document: 'tab-2' },
    },
    'ops on a named document',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'p' } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'insert_picture',
      args: { url: 'https://x/y.png', width: '2cm', float: { anchor: 'page', x: 1 } },
    },
    'a floating picture',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'p' } }, resolve: { answer: 2 } }),
      tool: 'insert_picture',
      args: { url: 'https://x/y.png', document: 'tab-3' },
    },
    'a picture into a named document',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'text' } } }),
      session: { family: 'docx', wcId: 8 },
      tool: 'read_document',
      args: {},
    },
    'read the session tab',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'text' } }, resolve: { answer: 2 } }),
      tool: 'read_document',
      args: { document: 'tab-3' },
    },
    'read a named document: no focus',
  ),
  docCase(
    {
      deps: DEPS({ docs: { run: { value: 'text' } }, resolve: { answer: 2 } }),
      tool: 'read_document',
      args: { document: 'tab-3', extra: 1 },
    },
    'extra arguments are not passed on',
  ),
  docCase(
    { deps: DEPS(), tool: 'insert_content', args: { html: 'x' } },
    'no docs control: the tool is not registered',
  ),
]

const documentToolsCases: Case[] = [
  { args: [{ background: null, docs: true }], note: 'the default: generation on, docs control' },
  { args: [{ background: false, docs: true }], note: 'background off' },
  { args: [{ background: true, docs: false }], note: 'no docs control' },
  { args: [{ background: false, docs: false }], note: 'background off, no docs control' },
]

async function documentToolsList(spec: Spec, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  const { deps } = fakeDeps(
    { cli: OK_CLI, docs: spec.docs ? {} : undefined, background: spec.background },
    cx,
  )
  return listed(documentTools.createDocumentTools(deps as never, host) as Spec[])
}

const outputCases: Case[] = [
  { args: [{ title: 'Report', ext: 'docx' }], files: FILES, note: 'the default folder' },
  { args: [{ title: 'Taken', ext: '.docx' }], files: FILES, note: 'a taken name: -3' },
  { args: [{ title: 'a/b:c*d', ext: 'pdf' }], files: FILES, note: 'a title that is sanitized' },
  { args: [{ title: '', ext: 'md' }], files: FILES, note: 'an empty title' },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/x' }],
    files: FILES,
    note: 'no extension: appended',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/x.Docx' }],
    files: FILES,
    note: 'the extension in another case',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/x.pdf' }],
    files: FILES,
    note: 'another extension',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/x.' }],
    files: FILES,
    note: 'a bare dot',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: 'x.docx' }],
    files: FILES,
    note: 'a relative path',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '' }],
    files: FILES,
    note: 'an empty path: the default folder',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/out.docx' }],
    files: FILES,
    note: 'a file that exists',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/out.docx', overwrite: true }],
    files: FILES,
    note: 'a file that exists, overwrite',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/out', overwrite: false }],
    files: FILES,
    note: 'the appended name exists',
  },
  {
    args: [{ title: 'T', ext: 'docx', requestedPath: '$DIR/dir.docx' }],
    files: { 'dir.docx': { dir: true } },
    note: 'a folder of that name exists',
  },
]

// ---------------------------------------------------------------------------
// open-documents-tools
// ---------------------------------------------------------------------------

const tab = (
  id: string,
  kind: string,
  title: string,
  filePath?: string,
  dirty = false,
  active = false,
): Spec => ({
  id,
  kind,
  title,
  ...(filePath === undefined ? {} : { filePath }),
  active,
  dirty,
})
const TABS: Spec[] = [
  tab('t1', 'docs', 'Report', '$DIR/a.docx', true, true),
  tab('t2', 'sheets', 'Budget', '$DIR/budget.xlsx'),
  tab('t3', 'slides', 'Untitled deck'),
  tab('t4', 'pdf', 'Paper', '$DIR/paper.pdf', true),
  tab('t5', 'markdown', 'Notes', '$DIR/notes.md'),
  tab('t6', 'html', 'Page'),
  tab('t7', 'mindmap', 'Map', '$DIR/map.mm'),
  tab('t8', 'hwp', 'Hangul', '$DIR/doc.hwpx'),
  tab('t9', 'epub', 'Book', '$DIR/book.epub'),
  tab('t10', 'diagram', 'Chart', '$DIR/chart.drawio.svg'),
]

interface OpenCall {
  control?: Spec | null
  tool?: string
  args: unknown
}

function openControl(c: Spec, cx: TsContext): Spec {
  return {
    list: async () => {
      cx.log('control.list')
      if (!Array.isArray(c.list)) throw new Error(c.list.throws)
      return c.list
    },
    read: async (tab: Spec) => {
      cx.log('control.read', tab.id)
      return answer(c.read)
    },
    close: async (tab: Spec, options: Spec) => {
      cx.log('control.close', tab.id, options)
      return answer(c.close)
    },
    save: async (tab: Spec) => {
      cx.log('control.save', tab.id)
      return answer(c.save)
    },
  }
}

async function openCall(spec: OpenCall, cx: TsContext): Promise<unknown> {
  const tools = openTools.createOpenDocumentTools({
    control: spec.control ? (openControl(spec.control, cx) as never) : undefined,
    defaultSaveDir: () => '/unused',
  })
  return callTool(tools as Spec[], 'open_documents', spec.args)
}

const openCase = (
  control: Spec | null,
  args: unknown,
  note: string,
  files?: Case['files'],
): Case => ({
  args: [{ control, args }],
  ...(files ? { files } : {}),
  note,
})
const CONTROL = (extra: Spec = {}): Spec => ({
  list: TABS,
  read: { value: { text: 'live' } },
  close: { value: {} },
  save: { value: { savedPath: '/saved/here' } },
  ...extra,
})
const OPEN_FILES = { 'a.docx': 'x', 'paper.pdf': 'x' }

const openCases: Case[] = [
  openCase(CONTROL(), { action: 'list' }, 'every kind is listed', OPEN_FILES),
  openCase(CONTROL({ list: [] }), { action: 'list' }, 'nothing is open'),
  openCase(
    CONTROL({
      list: [
        tab('x1', 'docs', 'Odt', '$DIR/x.ODT'),
        tab('x2', 'epub', 'x', ''),
        tab('x3', 'diagram', 'Q', '/a/b.png'),
        tab('x4', 'docs', 'Empty', ''),
      ],
    }),
    { action: 'list' },
    'formats by extension; an empty path is saved',
  ),
  openCase(
    CONTROL({ list: [tab('h1', 'help', 'Help')] }),
    { action: 'list' },
    'a help tab has no family',
  ),
  openCase(CONTROL({ list: { throws: 'tabs unreachable' } }), { action: 'list' }, 'listing fails'),
  openCase(null, { action: 'list' }, 'no control'),
  openCase(CONTROL(), { action: 'read' }, 'read needs a target'),
  openCase(CONTROL(), { action: 'read', target: '   ' }, 'a blank target'),
  openCase(CONTROL(), { action: 'read', target: 5 }, 'a target that is a number'),
  openCase(CONTROL(), { action: 'nothing', target: 't1' }, 'an unknown action'),
  openCase(CONTROL(), {}, 'no action'),
  openCase(CONTROL(), { action: 5, target: 't1' }, 'an action that is a number'),
  openCase(CONTROL(), { action: 'read', target: 't1' }, 'read by id', OPEN_FILES),
  openCase(
    CONTROL(),
    { action: 'read', target: ' $DIR/a.docx ' },
    'read by path, trimmed',
    OPEN_FILES,
  ),
  openCase(
    CONTROL(),
    { action: 'read', target: '$DIR/./sub/../a.docx' },
    'read by a path that needs resolving',
    OPEN_FILES,
  ),
  openCase(
    CONTROL({ read: { undef: true } }),
    { action: 'read', target: 't2' },
    'the content is undefined',
  ),
  openCase(
    CONTROL({ read: { throws: 'cannot read' } }),
    { action: 'read', target: 't5' },
    'reading fails',
  ),
  openCase(CONTROL(), { action: 'read', target: 't4' }, 'a PDF is not readable'),
  openCase(CONTROL(), { action: 'read', target: 't3' }, 'an unsaved deck: null path'),
  openCase(CONTROL(), { action: 'read', target: 't9' }, 'an epub'),
  openCase(
    CONTROL({ list: [tab('h1', 'help', 'Help')] }),
    { action: 'read', target: 'h1' },
    'a help tab is not readable',
  ),
  openCase(
    CONTROL(),
    { action: 'read', target: 'nope' },
    'no document matches: the listing',
    OPEN_FILES,
  ),
  openCase(
    CONTROL({ list: [] }),
    { action: 'read', target: 'nope' },
    'no document matches, none open',
  ),
  openCase(
    CONTROL({ list: [tab('h1', 'help', 'Help')] }),
    { action: 'read', target: 'nope' },
    'no match, and a tab without a family',
  ),
  openCase(
    CONTROL(),
    { action: 'save', target: 't1' },
    'save writes through the control',
    OPEN_FILES,
  ),
  openCase(CONTROL(), { action: 'save', target: 't3' }, 'save of a never-saved tab'),
  openCase(CONTROL(), { action: 'save', target: 't4' }, 'a PDF has nothing to save'),
  openCase(
    CONTROL({ save: { throws: 'disk full' } }),
    { action: 'save', target: 't1' },
    'saving fails',
    OPEN_FILES,
  ),
  openCase(CONTROL(), { action: 'close', target: 't1' }, 'close saves by default', OPEN_FILES),
  openCase(
    CONTROL({ close: { value: { savedPath: '/s/t.docx' } } }),
    { action: 'close', target: 't1' },
    'close that saved somewhere',
    OPEN_FILES,
  ),
  openCase(
    CONTROL({ close: { value: { savedPath: '' } } }),
    { action: 'close', target: 't1' },
    'an empty saved path is left out',
    OPEN_FILES,
  ),
  openCase(
    CONTROL(),
    { action: 'close', target: 't1', unsaved: 'discard' },
    'discard a dirty document',
    OPEN_FILES,
  ),
  openCase(
    CONTROL(),
    { action: 'close', target: 't2', unsaved: 'discard' },
    'discard a clean document',
  ),
  openCase(
    CONTROL(),
    { action: 'close', target: 't2', unsaved: 'whatever' },
    'another value saves',
  ),
  openCase(
    CONTROL({ close: { throws: 'unsaved edits' } }),
    { action: 'close', target: 't8' },
    'closing fails',
  ),
  openCase(
    CONTROL(),
    { action: 'close', target: 't4', unsaved: 'discard' },
    'a dirty PDF discarded',
    OPEN_FILES,
  ),
  openCase(CONTROL(), { action: 'close', target: 'ghost' }, 'closing what is not open'),
  openCase(
    CONTROL({ save: { undef: true } }),
    { action: 'save', target: 't1' },
    'save answered with nothing: destructuring undefined throws',
    OPEN_FILES,
  ),
  openCase(
    CONTROL({ close: { value: null } }),
    { action: 'close', target: 't1' },
    'close answered with null: destructuring null throws',
    OPEN_FILES,
  ),
  openCase(
    CONTROL({ save: { value: 5 } }),
    { action: 'save', target: 't1' },
    'save answered with a number: no savedPath, so savedTo is left out',
    OPEN_FILES,
  ),
]

const toolsOnlyCases: Case[] = [
  { args: [{}], note: 'the tool does not depend on any option' },
  { args: [{ control: true }], note: 'with a control' },
]

const tabsCases: Case[] = [
  [TABS, 't2'],
  [TABS, '$DIR/a.docx'],
  [TABS, '$DIR/missing.docx'],
  [TABS, 't1'],
  [TABS, ''],
  [TABS, '$DIR/budget.xlsx'],
  [[], 'x'],
  [[tab('p1', 'docs', 'P', ''), tab('p2', 'docs', 'Q', '$DIR/a.docx')], ''],
  [[tab('p1', 'docs', 'P', '$DIR/a.docx')], 'a.docx'],
  [[tab('t1', 'docs', 'by id'), tab('t2', 'docs', 'by path', 't1')], 't1'],
].map(([documents, target]) => ({ args: [documents, target], files: OPEN_FILES }))

const OF_FAMILY: Case[] = [
  [TABS, 't1', 'docx'],
  [TABS, 't2', 'docx'],
  [TABS, 't2', 'xlsx'],
  [TABS, '$DIR/paper.pdf', 'pdf'],
  [TABS, '$DIR/a.docx', 'pptx'],
  [TABS, 'nope', 'docx'],
  [[], 'nope', 'docx'],
  [[tab('h1', 'help', 'Help')], 'h1', 'docx'],
  [[tab('h1', 'home', 'Home')], 'nope', 'docx'],
  [TABS, 't8', 'hwp'],
  [TABS, 't10', 'drawio'],
].map(([documents, target, family]) => ({ args: [documents, target, family], files: OPEN_FILES }))

const FORMAT_TABS: Spec[] = [
  tab('f1', 'docs', 'A', '$DIR/a.docx'),
  tab('f2', 'docs', 'A', '$DIR/b.ODT'),
  tab('f3', 'docs', 'A'),
  tab('f4', 'diagram', 'D', '$DIR/chart.DRAWIO.SVG'),
  tab('f5', 'diagram', 'D', '$DIR/chart.drawio.png'),
  tab('f6', 'diagram', 'D', '$DIR/chart.svg'),
  tab('f7', 'diagram', 'D', '$DIR/chart'),
  tab('f8', 'diagram', 'D', '$DIR/chart.dio'),
  tab('f9', 'diagram', 'D'),
  tab('f10', 'sheets', 'S', '$DIR/data.xlsm'),
  tab('f11', 'sheets', 'S', '$DIR/data.tar.gz'),
  tab('f12', 'markdown', 'M', ''),
  tab('f13', 'markdown', 'M', '$DIR/noext.'),
  tab('f14', 'pdf', 'P'),
  tab('f15', 'help', 'H'),
  tab('f16', 'help', 'H', '$DIR/h.txt'),
  tab('f17', 'epub', 'E', '$DIR/b.epub'),
  tab('f18', 'html', 'H', '$DIR/p.drawio.svg'),
  tab('f19', 'mindmap', 'M', '$DIR/m.XMIND'),
  tab('f20', 'slides', 'S'),
]
const formatCases: Case[] = FORMAT_TABS.map((t) => ({
  args: [t],
  note: `${t.kind} ${t.filePath ?? '(none)'}`,
}))

const closeSaveCases: Case[] = [
  [tab('c1', 'docs', 'Report', '$DIR/a.docx'), '$DIR/save'],
  [tab('c2', 'docs', 'Report'), '$DIR/save'],
  [tab('c3', 'docs', 'Taken'), '$DIR/save'],
  [tab('c4', 'sheets', 'a/b?c'), '$DIR/save'],
  [tab('c5', 'markdown', ''), '$DIR/save'],
  [tab('c6', 'diagram', 'Chart'), '$DIR/save'],
  [tab('c7', 'html', 'Page', ''), '$DIR/save'],
  [tab('c8', 'help', 'Help'), '$DIR/save'],
  [tab('c9', 'pdf', 'Doc'), '$DIR/save'],
  [tab('c10', 'epub', 'Book'), '$DIR/save'],
  [tab('c11', 'hwp', 'Doc'), '$DIR/save'],
  [tab('c12', 'mindmap', 'Map'), '$DIR/save'],
  [tab('c13', 'slides', 'Deck'), '$DIR/save'],
].map((args) => ({ args, files: { 'save/Taken.docx': 'x', 'save/Taken-2.docx': 'x' } }))

// ---------------------------------------------------------------------------
// pdf-tools and hwp-tools
// ---------------------------------------------------------------------------

const pagesOf = (n: number): Spec[] =>
  Array.from({ length: n }, (_, i) => ({
    page: i + 1,
    widthPt: 595,
    heightPt: 842,
    chars: i === 1 ? 0 : 5 + i,
    text: i === 1 ? '' : `page ${i + 1}`,
    hasTextLayer: i !== 1,
  }))

interface PdfCall {
  reader: Spec
  args: Spec
}

async function pdfCall(spec: PdfCall, cx: TsContext): Promise<unknown> {
  const world = spec.reader
  const box = globalThis as Record<symbol, unknown>
  box[PDF_BOX] = async (bytes: Uint8Array, options: Spec) => {
    cx.log('readPdfText', Buffer.from(bytes).toString('utf8'), options)
    if (options.charBudget === 0) {
      if (world.failProbe !== undefined) throw new Error(world.failProbe)
      return { pageCount: world.pageCount, info: {}, pages: [], truncated: false }
    }
    if (world.failRead !== undefined) throw new Error(world.failRead)
    const pages = options.pages
      ? world.pages.filter((p: Spec) => (options.pages as number[]).includes(p.page))
      : world.pages
    return {
      pageCount: world.pageCount,
      info: world.info ?? {},
      pages,
      truncated: world.truncated ?? false,
    }
  }
  try {
    return await callTool(pdfTools.createPdfTools() as Spec[], 'read_pdf', spec.args)
  } finally {
    delete box[PDF_BOX]
  }
}

const READER: Spec = {
  pageCount: 3,
  info: { title: 'The Paper', author: 'A. Author' },
  pages: pagesOf(3),
}
const pdfCase = (reader: Spec, args: Spec, note: string, files?: Case['files']): Case => ({
  args: [{ reader, args }],
  ...(files ? { files } : {}),
  note,
})
const PDF_FILES: NonNullable<Case['files']> = {
  'doc.pdf': 'PDFBYTES',
  'Doc.PDF': 'upper',
  'note.txt': 'x',
  'folder.pdf': { dir: true },
}

const pdfCases: Case[] = [
  pdfCase(READER, { path: '$DIR/doc.pdf' }, 'the whole document', PDF_FILES),
  pdfCase(
    READER,
    { path: '$DIR/Doc.PDF', pages: '' },
    'the extension in capitals; empty pages',
    PDF_FILES,
  ),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: ' 3 ' }, 'one page, trimmed', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '1-2, 3' }, 'a range and a page', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '3,1,1' }, 'unsorted, repeated', PDF_FILES),
  pdfCase(
    READER,
    { path: '$DIR/doc.pdf', pages: 2 },
    'pages that is no string: the whole document',
    PDF_FILES,
  ),
  pdfCase({ ...READER, truncated: true }, { path: '$DIR/doc.pdf' }, 'truncated', PDF_FILES),
  pdfCase(
    { pageCount: 0, pages: [] },
    { path: '$DIR/doc.pdf' },
    'no pages, no metadata',
    PDF_FILES,
  ),
  pdfCase(
    { ...READER, info: { title: 'Only title' } },
    { path: '$DIR/doc.pdf' },
    'a title only',
    PDF_FILES,
  ),
  pdfCase(
    { ...READER, info: { author: 'Only author' } },
    { path: '$DIR/doc.pdf' },
    'an author only',
    PDF_FILES,
  ),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '9' }, 'a page out of range', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '0' }, 'page zero', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '3-1' }, 'a backwards range', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: 'a' }, 'not a page', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: ' , ' }, 'only commas', PDF_FILES),
  pdfCase(
    READER,
    { path: '$DIR/doc.pdf', pages: '   ' },
    'pages of blanks is the whole document',
    PDF_FILES,
  ),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '1-' }, 'an open range', PDF_FILES),
  pdfCase(READER, { path: '$DIR/doc.pdf', pages: '1 - 2' }, 'spaces around the dash', PDF_FILES),
  pdfCase(
    { ...READER, failProbe: 'password required' },
    { path: '$DIR/doc.pdf' },
    'the probe fails: one clean message',
    PDF_FILES,
  ),
  pdfCase(
    { ...READER, failRead: 'worker died' },
    { path: '$DIR/doc.pdf' },
    'the read fails: its own message',
    PDF_FILES,
  ),
  pdfCase(READER, { path: '$DIR/note.txt' }, 'a text file', PDF_FILES),
  pdfCase(READER, { path: '$DIR/none.pdf' }, 'a missing file', PDF_FILES),
  pdfCase(READER, { path: 'doc.pdf' }, 'a relative path', PDF_FILES),
  pdfCase(READER, {}, 'no path'),
]

const pageListCases: Case[] = cases(
  ['3', 5],
  ['1-5,8', 9],
  ['8,1-3,2', 9],
  [' 2 , 4 ', 5],
  ['1-1', 1],
  ['007', 9],
  ['1 -\t3', 5],
  ['', 5],
  [',', 5],
  ['a', 5],
  ['1-2-3', 5],
  ['-3', 5],
  ['3-1', 5],
  ['0', 5],
  ['6', 5],
  ['1-6', 5],
  ['1,6', 5],
  ['١', 5],
  ['2', 0],
  ['99999999999999999999999999', 5],
  ['1-99999999999', 5],
  ['3,\uFEFF4', 5],
)

interface HwpCall {
  world: Spec
  args: Spec
}

async function hwpCall(spec: HwpCall, cx: TsContext): Promise<unknown> {
  const box = globalThis as Record<symbol, unknown>
  box[HWP_BOX] = async (bytes: Uint8Array) => {
    cx.log('hwpToText', Buffer.from(bytes).toString('utf8'))
    if (spec.world.throws !== undefined) throw new Error(spec.world.throws)
    return spec.world.text
  }
  try {
    return await callTool(hwpTools.createHwpTools() as Spec[], 'read_hwp', spec.args)
  } finally {
    delete box[HWP_BOX]
  }
}

const LONG = 'a'.repeat(79_998) + '\u{1F600}' + 'b'.repeat(100_000)
const HWP_FILES: NonNullable<Case['files']> = {
  'a.hwp': 'HWPBYTES',
  'B.HWPX': 'x',
  'c.doc': 'x',
  'dir.hwp': { dir: true },
}
const hwpCase = (world: Spec, args: Spec, note: string, files = HWP_FILES): Case => ({
  args: [{ world, args }],
  files,
  note,
})
const hwpCases: Case[] = [
  hwpCase({ text: 'one\ntwo' }, { path: '$DIR/a.hwp' }, 'a short document'),
  hwpCase({ text: 'x' }, { path: '$DIR/B.HWPX' }, 'hwpx, in capitals'),
  hwpCase({ text: 'x'.repeat(100) }, { path: '$DIR/a.hwp', offset: 40 }, 'an offset'),
  hwpCase({ text: 'x'.repeat(100) }, { path: '$DIR/a.hwp', offset: 400 }, 'an offset past the end'),
  hwpCase(
    { text: 'x'.repeat(100) },
    { path: '$DIR/a.hwp', offset: '5' },
    'an offset that is no number',
  ),
  hwpCase({ text: 'x'.repeat(100) }, { path: '$DIR/a.hwp', offset: 2.9 }, 'a fractional offset'),
  hwpCase({ text: LONG }, { path: '$DIR/a.hwp' }, 'a long document: the first window'),
  hwpCase({ text: LONG }, { path: '$DIR/a.hwp', offset: 80_000 }, 'the next window'),
  hwpCase({ text: '' }, { path: '$DIR/a.hwp' }, 'an empty document'),
  hwpCase(
    { text: 'ハングル\u{1F600}' },
    { path: '$DIR/a.hwp', offset: 4 },
    'an offset in UTF-16 units',
  ),
  hwpCase({ throws: 'password protected' }, { path: '$DIR/a.hwp' }, 'the engine fails'),
  hwpCase({ text: 'x' }, { path: '$DIR/c.doc' }, 'another type'),
  hwpCase({ text: 'x' }, { path: '$DIR/none.hwp' }, 'a missing file'),
  hwpCase({ text: 'x' }, { path: 'a.hwp' }, 'a relative path'),
  hwpCase({ text: 'x' }, {}, 'no path'),
]

const windowText = (n: number, tail = ''): string => 'a'.repeat(n) + tail
const windowCases: Case[] = [
  ['hello', 0],
  ['hello', 2],
  ['hello', 99],
  ['hello', -3],
  ['hello', 1.9],
  ['hello', -0.5],
  ['hello', 'NaN'],
  ['hello', 'Infinity'],
  ['hello', '-Infinity'],
  ['hello', null],
  ['', 0],
  [windowText(80_000), 0],
  [windowText(80_001), 0],
  [windowText(80_001), 1],
  [windowText(80_001), 80_000],
  [windowText(160_000, 'z'), 80_000],
  [windowText(79_998, '\u{1F600}xyz'), 0],
  [windowText(79_998, '\u{1F600}xyz'), 79_998],
  [windowText(79_998, '\u{1F600}\u{1F600}'), 0],
  ['\u{1F600}\u{1F600}\u{1F600}', 2],
  ['ハングル', 2],
].map(([text, offset]) => ({ args: [text, offset] }))

const readHwpCases: Case[] = [
  { args: ['$DIR/a.hwp', { text: 'one' }], files: HWP_FILES, note: 'a document' },
  { args: ['$DIR/a.hwp', { text: '' }], files: HWP_FILES, note: 'an empty one' },
  { args: ['$DIR/a.hwp', { throws: 'bad file' }], files: HWP_FILES, note: 'the engine fails' },
  { args: ['$DIR/none.hwp', { text: 'x' }], files: HWP_FILES, note: 'no such file' },
  { args: ['$DIR/dir.hwp', { text: 'x' }], files: HWP_FILES, note: 'a folder' },
]

// ---------------------------------------------------------------------------

export const group: Group = {
  'formats.FORMAT_FAMILIES': constant(formats.FORMAT_FAMILIES, 'the registry is a constant'),
  'formats.formatFamily': { ts: (a) => formats.formatFamily(a[0] as never), cases: familyCases },
  'formats.familyLabel': { ts: (a) => formats.familyLabel(a[0] as never), cases: familyCases },
  'formats.generateExtension': {
    ts: (a) => formats.generateExtension(a[0] as never),
    cases: cases(['docx'], ['xlsx'], ['pptx']),
  },
  'formats.withSaveExtension': {
    ts: (a) => formats.withSaveExtension(a[0] as never, a[1] as string),
    cases: saveExtensionCases,
  },
  'formats.capabilityReport': {
    ts: (a) => formats.capabilityReport((a[0] as Spec | null) ?? undefined),
    cases: capabilityCases,
  },

  'session-tools.createSessionHost': {
    ts: (a) => {
      const host = sessionTools.createSessionHost()
      return (a[0] as Spec[]).map((step) => {
        try {
          if (step.begin) return host.begin(step.begin[0], step.begin[1]) ?? null
          if (step.current) return host.current()
          if (step.require) return { wcId: host.require(step.require) }
          host.end()
          return null
        } catch (error) {
          return { error: (error as Error).message }
        }
      })
    },
    cases: hostCases,
  },
  'session-tools.contentTarget': {
    ts: (a, cx) => targetCalls(a[0] as TargetSpec, cx),
    cases: targetCases,
  },
  'session-tools.tools': {
    ts: (a) =>
      listed(
        sessionTools.createSessionTools(
          (a[0] as Spec).families.map((family: string) => ({
            family,
            openBlankTab: async () => 1,
            save: async () => ({}),
          })),
          sessionTools.createSessionHost(),
        ) as Spec[],
      ),
    cases: sessionToolsCases,
  },
  'session-tools.call': { ts: (a, cx) => sessionCall(a[0] as Spec, cx), cases: sessionCases },

  'document-tools.sanitizeFileBase': {
    ts: (a) => documentTools.sanitizeFileBase(a[0] as string),
    cases: cases(
      ['Quarterly report'],
      ['  spaced  '],
      ['a/b\\c:d*e?f"g<h>i|j'],
      ['tab\there\u0001\u001f'],
      ['...dots...'],
      ['. . .'],
      ['.'],
      ['..'],
      [''],
      ['   '],
      ['/'],
      ['x'.repeat(100)],
      ['  ' + 'y'.repeat(79) + ' tail'],
      ['z'.repeat(78) + '\u{1F600}\u{1F600}'],
      ['\u00e9\u00e8'.repeat(50)],
      ['a.b.'],
      ['.hidden'],
      ['\uFEFF bom \uFEFF'],
      ['\u3000wide\u3000'],
      ['ハングル 문서'],
    ),
  },
  'document-tools.uniquePathIn': {
    ts: (a) => documentTools.uniquePathIn(a[0] as string, a[1] as string),
    cases: [
      { args: ['$DIR', 'a.docx'], files: {}, note: 'a free name' },
      { args: ['$DIR', 'a.docx'], files: { 'a.docx': 'x' }, note: 'taken: -2' },
      {
        args: ['$DIR', 'a.docx'],
        files: { 'a.docx': 'x', 'a-2.docx': 'x', 'a-3.docx': 'x' },
        note: 'taken three times',
      },
      {
        args: ['$DIR', 'a.docx'],
        files: { 'a.docx': 'x', 'a-3.docx': 'x' },
        note: 'a gap is the first free name',
      },
      { args: ['$DIR', 'noext'], files: { noext: 'x' }, note: 'no extension' },
      { args: ['$DIR', '.hidden'], files: { '.hidden': 'x' }, note: 'a dot file has no extension' },
      { args: ['$DIR', 'a.tar.gz'], files: { 'a.tar.gz': 'x' }, note: 'the last extension' },
      {
        args: ['$DIR', 'folder.docx'],
        files: { 'folder.docx': { dir: true } },
        note: 'a folder of that name',
      },
      {
        args: ['$DIR/sub/', 'a.docx'],
        files: { 'sub/a.docx': 'x' },
        note: 'a folder with a trailing slash',
      },
      { args: ['$DIR/missing', 'a.docx'], files: {}, note: 'a folder that is not there' },
      { args: ['$DIR', 'é😀.docx'], files: { 'é😀.docx': 'x' }, note: 'non-ASCII names' },
      { args: ['$DIR', 'a.'], files: { 'a.': 'x' }, note: 'a trailing dot' },
    ],
  },
  'document-tools.resolveOutputPath': {
    ts: (a) => {
      const o = a[0] as Spec
      return documentTools.resolveOutputPath({
        defaultSaveDir: () => `${o.dir}/save`,
        ext: o.ext,
        title: o.title,
        requestedPath: o.requestedPath,
        overwrite: o.overwrite,
      })
    },
    cases: outputCases.map((c) => ({
      ...c,
      args: [{ ...(c.args[0] as Spec), dir: '$DIR' }],
    })),
  },
  'document-tools.resolveTargetPath': {
    ts: (a) => {
      const [dir, title, requested, overwrite] = a as [
        string,
        string,
        string | null,
        boolean | null,
      ]
      return documentTools.__internal.resolveTargetPath(
        { defaultSaveDir: () => `${dir}/save` } as never,
        title,
        requested ?? undefined,
        overwrite ?? undefined,
      )
    },
    cases: [
      { args: ['$DIR', 'Report', null, null], files: FILES, note: 'the default folder' },
      { args: ['$DIR', 'Taken', null, null], files: FILES, note: 'a taken name' },
      { args: ['$DIR', 'T', '$DIR/x', null], files: FILES, note: 'a path without an extension' },
      { args: ['$DIR', 'T', '$DIR/out.docx', null], files: FILES, note: 'a file that exists' },
      {
        args: ['$DIR', 'T', '$DIR/out.docx', true],
        files: FILES,
        note: 'a file that exists, overwrite',
      },
      { args: ['$DIR', 'T', '$DIR/x.odt', null], files: FILES, note: 'another extension' },
      { args: ['$DIR', 'T', 'rel', null], files: FILES, note: 'a relative path' },
    ],
  },
  'document-tools.documentDriver': {
    ts: async (a, cx) => {
      const [world, op, wcId, path, overwrite] = a as [Spec, string, number, string, boolean]
      const { deps } = fakeDeps({ docs: world }, cx)
      const driver = documentTools.documentDriver(deps.docs)
      if (op === 'open') return { family: driver.family, wcId: await driver.openBlankTab() }
      return { family: driver.family, saved: await driver.save(wcId, path, overwrite) }
    },
    cases: cases(
      [{ open: 12 }, 'open'],
      [{ open: { throws: 'no tab' } }, 'open'],
      [{ run: { value: { ok: true, path: '/a.docx' } } }, 'save', 5, '/a.docx', false],
      [{ run: { value: 'done' } }, 'save', 6, '/b.docx', true],
      [{ run: { undef: true } }, 'save', 6, '/b.docx', true],
      [{ run: { throws: 'file exists' } }, 'save', 7, '/c.docx', false],
    ),
  },
  'document-tools.tools': {
    ts: (a, cx) => documentToolsList(a[0] as Spec, cx),
    cases: documentToolsCases,
  },
  'document-tools.call': { ts: (a, cx) => documentCall(a[0] as DocCall, cx), cases: documentCases },

  'open-documents-tools.resolveOpenDocument': {
    ts: (a) => openTools.resolveOpenDocument(a[0] as never, a[1] as string) ?? null,
    cases: tabsCases,
  },
  'open-documents-tools.resolveOpenDocumentOfFamily': {
    ts: (a) => openTools.resolveOpenDocumentOfFamily(a[0] as never, a[1] as string, a[2] as never),
    cases: OF_FAMILY,
  },
  'open-documents-tools.documentFormat': {
    ts: (a) => openTools.documentFormat(a[0] as never),
    cases: formatCases,
  },
  'open-documents-tools.closeSavePath': {
    ts: (a) => openTools.closeSavePath(a[0] as never, () => a[1] as string),
    cases: closeSaveCases,
  },
  'open-documents-tools.tools': {
    ts: () => listed(openTools.createOpenDocumentTools({ defaultSaveDir: () => '/x' }) as Spec[]),
    cases: toolsOnlyCases,
    single: 'the tool does not depend on any option',
  },
  'open-documents-tools.call': { ts: (a, cx) => openCall(a[0] as OpenCall, cx), cases: openCases },

  'pdf-tools.parsePageList': {
    ts: (a) => pdfTools.parsePageList(a[0] as string, a[1] as number),
    cases: pageListCases,
  },
  'pdf-tools.tools': {
    ts: () => listed(pdfTools.createPdfTools() as Spec[]),
    cases: toolsOnlyCases,
    single: 'the tool does not depend on any option',
  },
  'pdf-tools.call': { ts: (a, cx) => pdfCall(a[0] as PdfCall, cx), cases: pdfCases },

  'hwp-tools.HWP_MAX_CHARS': constant(hwpTools.HWP_MAX_CHARS, 'a constant'),
  'hwp-tools.hwpTextWindow': {
    ts: (a) => {
      const offset =
        a[1] === 'NaN'
          ? NaN
          : a[1] === 'Infinity'
            ? Infinity
            : a[1] === '-Infinity'
              ? -Infinity
              : a[1]
      return hwpTools.hwpTextWindow(a[0] as string, offset as number)
    },
    cases: windowCases,
  },
  'hwp-tools.readHwpFile': {
    ts: async (a, cx) => {
      const world = a[1] as Spec
      const box = globalThis as Record<symbol, unknown>
      box[HWP_BOX] = async (bytes: Uint8Array) => {
        cx.log('hwpToText', Buffer.from(bytes).toString('utf8'))
        if (world.throws !== undefined) throw new Error(world.throws)
        return world.text
      }
      try {
        return await hwpTools.readHwpFile(a[0] as string)
      } finally {
        delete box[HWP_BOX]
      }
    },
    cases: readHwpCases,
  },
  'hwp-tools.tools': {
    ts: () => listed(hwpTools.createHwpTools() as Spec[]),
    cases: toolsOnlyCases,
    single: 'the tool does not depend on any option',
  },
  'hwp-tools.call': { ts: (a, cx) => hwpCall(a[0] as HwpCall, cx), cases: hwpCases },
}
