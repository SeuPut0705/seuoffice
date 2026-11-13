/**
 * Group `b5-mcp`, slice `tools-apps` (Rust: crates/main-core/src/calls/b5_mcp/tools_apps.rs):
 * the slides / sheets / diagram tool sets, `pptx-outline`, and the bridges
 * (sheets, diagram, slides, open-documents) and `app-mcp` of
 * apps/shell/src/main/mcp.
 *
 * - `<file>.tools` lists what a factory registers, as the SDK lists it (see
 *   tools-docs.ts); `<file>.call` builds the tools over fakes the case
 *   describes, calls one handler with `args` and answers its value or what it
 *   threw. Each call of a fake is a log line. The fakes:
 *   - a value (`Val`) is `{ value }`, `{ undef: true }` or `{ throws }`;
 *   - slides control `{ open, txn, read, save }` (`open` a number or `{ throws }`,
 *     `txn` / `read` a `Val`, `save` `{ path?, throws? }`); sheets control
 *     `{ open, run }`; the CLI is a list of outcomes (see `scriptedCli` of
 *     mcp-pure.ts); `resolve` is `{ answer }` or `{ throws }`;
 *   - diagram control `{ list, detached, read, apply }`: `list` is a list of tabs
 *     or `{ throws }`, `detached` a list of tab ids (the method is absent
 *     without it), `read` / `apply` a `Val`.
 * - `sheets-bridge.scenario` is the docs-bridge scenario of mcp-pure.ts over
 *   the sheets channels: every case loads its own copy of the module; the steps
 *   are `install`, `open`, `run`, `ready`, `result`, `destroy`, `vanish`, `fire`.
 * - `diagram-bridge.scenario`, `open-documents-bridge.scenario`: a script of
 *   steps over fakes, each step answering `{ ok }` or `{ error }`, with the
 *   calls of the fakes as log lines (`console.warn` is a log line too).
 * - `slides-bridge.scenario`: the slides main process (`sessions`,
 *   `applySessionTxn`, `saveSessionDeckTo`, `attachedIds`) and `pptx-engine`
 *   are replaced, for slides-bridge.ts alone, by stubs that read the case's
 *   world: the sessions a step `session` puts into the map, each
 *   `{ deck, comments, attached, txn, saveThrows }`. The clock and the timers
 *   are fakes the steps drive (`at`, `fire`).
 * - `app-mcp.scenario`: `McpServerService` is replaced, for app-mcp.ts alone,
 *   by a fake that logs `listen <port>` and `close`.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { useElectron } from '../../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'
import './tools-docs.ts'
import { scriptedCli } from './mcp-pure.ts'

const WORLD = Symbol.for('main-diff.apps-world')
const SERVICE = Symbol.for('main-diff.apps-service')
const SLIDES_MAIN_URL = 'main-diff:slides-main'
const SESSION_STATE_URL = 'main-diff:session-state'
const PPTX_ENGINE_URL = 'main-diff:pptx-engine'
const MCP_SERVER_URL = 'main-diff:mcp-server'
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.endsWith('/mcp/slides-bridge.ts')) {
      if (specifier.endsWith('/slides/src/main/slides-main')) {
        return { url: SLIDES_MAIN_URL, shortCircuit: true }
      }
      if (specifier.endsWith('/slides/src/main/session-state')) {
        return { url: SESSION_STATE_URL, shortCircuit: true }
      }
      if (specifier === '@seuoffice/pptx-engine') {
        return { url: PPTX_ENGINE_URL, shortCircuit: true }
      }
    }
    if (parent.includes('/mcp/app-mcp.ts') && specifier === './mcp-server') {
      return { url: MCP_SERVER_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const world = `globalThis[Symbol.for('main-diff.apps-world')]`
    if (url === SLIDES_MAIN_URL) {
      const source = [
        `export const applySessionTxn = (...a) => ${world}.applySessionTxn(...a)`,
        `export const saveSessionDeckTo = (...a) => ${world}.saveSessionDeckTo(...a)`,
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    }
    if (url === SESSION_STATE_URL) {
      const source = [
        `export const sessions = ${world}.sessions`,
        `export const attachedIds = (...a) => ${world}.attachedIds(...a)`,
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    }
    if (url === PPTX_ENGINE_URL) {
      const source = [
        `export const elementDurableId = (...a) => ${world}.elementDurableId(...a)`,
        `export const slideDurableId = (...a) => ${world}.slideDurableId(...a)`,
        `export const getSlideComments = (...a) => ${world}.getSlideComments(...a)`,
        `export const getSlideHidden = (...a) => ${world}.getSlideHidden(...a)`,
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    }
    if (url === MCP_SERVER_URL) {
      const source = [
        `export const DEFAULT_MCP_PORT = 3093`,
        `export class McpServerService { constructor(...a) { return new globalThis[Symbol.for('main-diff.apps-service')](...a) } }`,
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, context)
  },
})
const worldBox = globalThis as Record<symbol, unknown>
worldBox[WORLD] = { sessions: new Map() }

const formats = await import('../../../../apps/shell/src/main/mcp/tools/formats.ts')
const sessionTools = await import('../../../../apps/shell/src/main/mcp/tools/session-tools.ts')
const pptxOutline = await import('../../../../apps/shell/src/main/mcp/pptx-outline.ts')
const slidesTools = await import('../../../../apps/shell/src/main/mcp/tools/slides-tools.ts')
const sheetsTools = await import('../../../../apps/shell/src/main/mcp/tools/sheets-tools.ts')
const diagramTools = await import('../../../../apps/shell/src/main/mcp/tools/diagram-tools.ts')
const diagramBridge = await import('../../../../apps/shell/src/main/mcp/diagram-bridge.ts')
const openBridge = await import('../../../../apps/shell/src/main/mcp/open-documents-bridge.ts')
const slidesBridge = await import('../../../../apps/shell/src/main/mcp/slides-bridge.ts')
const appMcp = await import('../../../../apps/shell/src/main/mcp/app-mcp.ts')
void formats

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
const realImmediate = setImmediate
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => realImmediate(resolve))
}

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

/** a `JSON.parse(JSON.stringify(value))`: what the Rust side logs of a value with `undefined` keys */
const plain = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value))

// ---------------------------------------------------------------------------
// pptx-outline
// ---------------------------------------------------------------------------

const MARKDOWN_OUTLINES: [string, string][] = [
  ['# One\n- a\n- b\n\n# Two\n1. x\n2) y', 'two slides, bullets and numbers'],
  ['', 'nothing at all'],
  ['   \n\n', 'blank lines only'],
  ['plain first line\n# T\nplain', 'text before any heading'],
  ['## Orphan bold\n# T\n## Bold\n### Deeper', 'headings of other depths'],
  ['# \n- a', 'a heading without text'],
  ['#Title\n# Real\n####### seven', 'no space after #, seven hashes'],
  [
    '# T\n- a\n  - b\n    - c\n      - d\n        - e\n          - f',
    'indented bullets cap at level 4',
  ],
  ['# T\n * star\n\t- tab\n   * odd indent', 'stars, tabs and odd indents'],
  ['# T\r\n- a\r\n- b\r\n', 'windows line ends'],
  ['# T\r- a', 'a lone carriage return'],
  ['# T\u2028- a\n- b\u2029c', 'line separators stay in the line'],
  ['# T\n1.no space\n1.  spaced\n12) twelve\n1 . x', 'numbered forms'],
  ['# T\n-\n- \n*\n--', 'bullet markers without text'],
  ['# Title ending   \n   padded plain   ', 'trimmed text'],
  ['# T\n\u3000- ideographic space indent\n\u00a0- nbsp', 'unicode spaces'],
  ['# T\n- caf\u00e9 \ud83d\ude00', 'non-ASCII text'],
  ['# Only title', 'one title'],
  ['# A\n# B\n# C', 'titles only'],
  ['# T\n## Bold one\n## ', 'an empty bold line'],
]
const JSON_OUTLINES: [string, string][] = [
  [JSON.stringify({ slides: [{ title: 'T', bullets: ['a', 'b'] }] }), 'bullets as strings'],
  [JSON.stringify([{ title: 'T', paragraphs: ['a', 'b'] }]), 'paragraphs as strings'],
  [JSON.stringify(['one', 'two']), 'strings as slides'],
  [
    JSON.stringify({
      slides: [
        {
          title: '  T  ',
          bullets: [
            { text: 'a', level: 1 },
            { text: 'b', bullet: 'number' },
            { text: 'c', bullet: 'char', bold: true },
            { text: 'd', bullet: 'dash', level: 2 },
            { text: 'e', level: 0 },
            { text: 'f', level: 1.5 },
            { text: 'g', level: -1 },
            { text: 'h', level: '2', bold: 'yes' },
            { text: '' },
          ],
        },
      ],
    }),
    'objects as bullets',
  ],
  [
    JSON.stringify({
      slides: [
        {
          paragraphs: [
            { text: 'p', bullet: 'number', level: 3 },
            { text: 'q', bold: true },
            { text: 'r', bullet: 'x' },
          ],
        },
      ],
    }),
    'objects as paragraphs',
  ],
  [JSON.stringify({ slides: [{ title: '   ', bullets: [] }] }), 'a blank title'],
  [JSON.stringify({ slides: [{ title: 5 }] }), 'a title that is no string'],
  [JSON.stringify({ slides: [{ bullets: ['a'], paragraphs: ['b'] }] }), 'bullets win'],
  [JSON.stringify({ slides: [{ bullets: 'a', paragraphs: ['b'] }] }), 'bullets that are no array'],
  [JSON.stringify({ slides: [{ bullets: 'a', paragraphs: 'b' }] }), 'neither is an array'],
  [JSON.stringify({ slides: [[]] }), 'an array entry'],
  [JSON.stringify({ slides: [{}] }), 'an empty entry'],
  [JSON.stringify({ slides: [] }), 'no slides'],
  ['{"slides": [', 'broken JSON'],
  ['', 'empty JSON'],
  ['not json', 'a word'],
  ['null', 'null'],
  ['7', 'a number'],
  ['"text"', 'a string'],
  ['true', 'a boolean'],
  ['{"slides": 3}', 'slides that is no array'],
  ['{"other": []}', 'no slides key'],
  ['[1]', 'a number as a slide'],
  ['[null]', 'null as a slide'],
  ['[true, "ok"]', 'a boolean as a slide'],
  [JSON.stringify({ slides: [{ bullets: [5] }] }), 'a number as a bullet'],
  [JSON.stringify({ slides: [{ bullets: [null] }] }), 'null as a bullet'],
  [JSON.stringify({ slides: [{ bullets: [{ text: 4 }] }] }), 'a bullet whose text is no string'],
  [JSON.stringify({ slides: [{ bullets: [[]] }] }), 'an array as a bullet'],
  ['{"slides": [{"bullets": ["a"]}],}', 'a trailing comma'],
  ['\ufeff[]', 'a byte order mark'],
]
const outlineCases: Case[] = [
  ...MARKDOWN_OUTLINES.map(([content, note]): Case => ({ args: ['markdown', content], note })),
  ...JSON_OUTLINES.map(([content, note]): Case => ({ args: ['json', content], note })),
  { args: ['markdown', '{"slides":[]}'], note: 'JSON read as markdown' },
]

const slide = (extra: Spec = {}): Spec => ({ paragraphs: [], ...extra })
const manySlides = (n: number): Spec[] =>
  Array.from({ length: n }, (_, i) => slide({ title: `s${i}` }))
const opsCases: Case[] = [
  ...cases(
    [[slide({ title: 'T' })]],
    [[slide({ title: 'A', paragraphs: [{ text: 'x' }] }), slide({ title: 'B' }), slide()]],
    [
      [
        slide({
          title: 'Mixed',
          paragraphs: [
            { text: 'plain' },
            { text: 'bold', bold: true },
            { text: 'dot', bullet: 'char' },
            { text: 'dot2', bullet: 'char', level: 2 },
            { text: 'num', bullet: 'number', level: 1 },
            { text: 'boldbullet', bullet: 'char', bold: true },
            { text: 'other', bullet: 'dash', level: 0 },
            { text: 'frac', bullet: 'char', level: 1.5 },
            { text: 'emptybullet', bullet: '' },
          ],
        }),
      ],
    ],
    [[slide({ title: '', paragraphs: [{ text: 'x' }] })]],
    [[slide({ paragraphs: [{ text: 'only body' }] })]],
    [[]],
  ),
  { args: [manySlides(100)], note: 'the limit' },
  { args: [manySlides(101)], note: 'over the limit' },
]

// ---------------------------------------------------------------------------
// the fakes of the tool sets
// ---------------------------------------------------------------------------

interface ToolDeps {
  saveDir?: string
  background?: boolean | null
  slides?: { open?: number | { throws: string }; txn?: Spec; read?: Spec; save?: Spec }
  sheets?: { open?: number | { throws: string }; run?: Spec }
  cli?: Spec | Spec[]
  resolve?: { answer?: number; throws?: string }
}

function fakeToolDeps(
  d: ToolDeps,
  cx: TsContext,
): { deps: Spec; scratch: () => string | undefined } {
  const deps: Spec = { defaultSaveDir: () => d.saveDir ?? '/save' }
  if (d.background !== undefined && d.background !== null) deps.background = d.background
  if (d.slides) {
    const slides = d.slides
    deps.slides = {
      openBlankTab: async () => {
        cx.log('slides.open')
        if (typeof slides.open === 'object') throw new Error(slides.open.throws)
        return slides.open ?? 1
      },
      runTxn: async (wcId: number, req: unknown) => {
        cx.log('slides.txn', wcId, plain(req))
        return answer(slides.txn)
      },
      readDeck: async (wcId: number, options?: unknown) => {
        cx.log('slides.read', wcId, options ?? null)
        return answer(slides.read)
      },
      saveDeck: async (wcId: number, path: string, overwrite: boolean) => {
        cx.log('slides.save', wcId, path, overwrite)
        if (slides.save?.throws !== undefined) throw new Error(slides.save.throws)
        return { path: slides.save?.path ?? path }
      },
    }
  }
  if (d.sheets) {
    const sheets = d.sheets
    deps.sheets = {
      openBlankTab: async () => {
        cx.log('sheets.open')
        if (typeof sheets.open === 'object') throw new Error(sheets.open.throws)
        return sheets.open ?? 1
      },
      runCommand: async (wcId: number, command: string, payload: unknown) => {
        cx.log('sheets.run', wcId, command, payload)
        return answer(sheets.run)
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

interface ToolCall {
  deps?: ToolDeps
  session?: { family: string; wcId: number } | null
  tool: string
  args?: unknown
}

type Factory = (deps: never, host: never) => unknown[]

async function toolCall(factory: Factory, spec: ToolCall, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  if (spec.session) host.begin(spec.session.family as never, spec.session.wcId)
  const { deps, scratch } = fakeToolDeps(spec.deps ?? {}, cx)
  const tools = factory(deps as never, host as never)
  try {
    return await callTool(tools as Spec[], spec.tool, spec.args)
  } finally {
    const dir = scratch()
    if (dir !== undefined) cx.log('scratch folder removed', !existsSync(dir))
  }
}

async function toolsList(factory: Factory, spec: Spec, cx: TsContext): Promise<unknown> {
  const host = sessionTools.createSessionHost()
  const { deps } = fakeToolDeps(
    {
      cli: { ok: true, code: 0 },
      background: spec.background,
      ...(spec.control ? { [spec.control]: {} } : {}),
    },
    cx,
  )
  return listed(factory(deps as never, host as never) as Spec[])
}

async function driverCall(
  make: (control: never) => Spec,
  control: 'slides' | 'sheets',
  a: unknown[],
  cx: TsContext,
): Promise<unknown> {
  const [world, op, wcId, path, overwrite] = a as [Spec, string, number, string, boolean]
  const { deps } = fakeToolDeps({ [control]: world }, cx)
  const driver = make(deps[control] as never)
  if (op === 'open') return { family: driver.family, wcId: await driver.openBlankTab() }
  return { family: driver.family, saved: await driver.save(wcId, path, overwrite) }
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
const FILES = {
  'deck.pptx': 'x',
  'book.xlsx': 'x',
  'BOOK2.XLSX': 'x',
  'note.txt': 'x',
  'save/Taken.pptx': 'x',
  'save/Taken-2.pptx': 'x',
  'save/Taken.xlsx': 'x',
  'out.pptx': 'x',
  'out.xlsx': 'x',
}
const DEPS = (extra: ToolDeps = {}): ToolDeps => ({ saveDir: '$DIR/save', cli: OK_CLI, ...extra })
const toolCase = (spec: ToolCall, note: string, files?: Case['files']): Case => ({
  args: [spec],
  ...(files ? { files } : {}),
  note,
})

// ---------------------------------------------------------------------------
// slides-tools
// ---------------------------------------------------------------------------

const SLIDES: ToolDeps['slides'] = {
  open: 21,
  txn: { value: { applied: true, results: [1] } },
  read: { value: { slides: [] } },
  save: { path: '/saved/deck.pptx' },
}
const SESSION = { family: 'pptx', wcId: 7 }
const slidesCase = (tool: string, args: unknown, extra: Partial<ToolCall> = {}, note = ''): Case =>
  toolCase(
    {
      deps: DEPS({ slides: SLIDES, resolve: { answer: 55 } }),
      session: SESSION,
      tool,
      args,
      ...extra,
    },
    note,
    FILES,
  )
const txn = (value: unknown): ToolDeps => DEPS({ slides: { ...SLIDES, txn: { value } } })

const slidesCases: Case[] = [
  // create_pptx
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'Deck', outline: '# One\n- a' } },
    'markdown into the default folder',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'Taken', outline: '# One' } },
    'a taken default name',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: { title: ' T ', outline: '{"slides":[{"title":"A","bullets":["x"]}]}', format: 'json' },
    },
    'a JSON outline, a trimmed title',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '# a', format: 'markdown' } },
    'markdown named',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '# a', format: 'rtf' } },
    'another format is markdown',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '{', format: 'json' } },
    'broken JSON',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '' } },
    'an outline with no slides',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: {
        title: 'T',
        outline: JSON.stringify(manySlides(101)),
        format: 'json',
      },
    },
    'too many slides',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '# a', path: '$DIR/new' } },
    'a path without an extension',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a', path: '$DIR/out.pptx' },
    },
    'an existing file is refused',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a', path: '$DIR/out.pptx', overwrite: true },
    },
    'overwrite passes --force',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a', path: '$DIR/out.pptx', overwrite: 'yes' },
    },
    'overwrite must be true itself',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a', path: '$DIR/d.xlsx' },
    },
    'a different extension',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: '# a', path: 'rel.pptx' } },
    'a relative path',
    FILES,
  ),
  toolCase({ deps: DEPS(), tool: 'create_pptx', args: { outline: '# a' } }, 'no title'),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: '  ', outline: '# a' } },
    'a blank title',
  ),
  toolCase({ deps: DEPS(), tool: 'create_pptx', args: { title: 'T' } }, 'no outline'),
  toolCase(
    { deps: DEPS(), tool: 'create_pptx', args: { title: 'T', outline: ['# a'] } },
    'an outline that is an array',
  ),
  toolCase(
    { deps: DEPS({ cli: undefined }), tool: 'create_pptx', args: { title: 'T', outline: '# a' } },
    'no CLI',
  ),
  toolCase(
    { deps: DEPS({ cli: FAILED_CLI }), tool: 'create_pptx', args: { title: 'T', outline: '# a' } },
    'the CLI fails',
  ),
  toolCase(
    {
      deps: DEPS({ cli: cli({ output_path: undefined, summary: undefined }) }),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a' },
    },
    'the CLI names no output and no summary',
  ),
  toolCase(
    {
      deps: DEPS({ background: false }),
      tool: 'create_pptx',
      args: { title: 'T', outline: '# a' },
    },
    'background off: no such tool',
  ),
  toolCase(
    { deps: DEPS({ background: true }), tool: 'create_pptx', args: { title: 'T', outline: '# a' } },
    'background on',
  ),
  // read_deck
  slidesCase('read_deck', {}, {}, 'the session deck'),
  slidesCase('read_deck', { document: 'tab-3' }, {}, 'a named document'),
  slidesCase('read_deck', { document: '' }, {}, 'an empty document is the session'),
  slidesCase('read_deck', {}, { session: null }, 'no session'),
  slidesCase(
    'read_deck',
    {},
    { session: { family: 'docx', wcId: 2 } },
    'a session of another family',
  ),
  slidesCase(
    'read_deck',
    { document: 'x' },
    { deps: DEPS({ slides: SLIDES }) },
    'a named document with no resolver',
  ),
  slidesCase(
    'read_deck',
    { document: 'x' },
    { deps: DEPS({ slides: SLIDES, resolve: { throws: 'no such tab' } }) },
    'the resolver fails',
  ),
  slidesCase(
    'read_deck',
    {},
    { deps: DEPS({ slides: { ...SLIDES, read: { throws: 'session gone' } } }) },
    'the read fails',
  ),
  slidesCase(
    'read_deck',
    {},
    { deps: DEPS({ slides: { ...SLIDES, read: { undef: true } } }) },
    'the read answers nothing',
  ),
  slidesCase('read_deck', {}, { deps: DEPS() }, 'no control: no such tool'),
  // apply_slide_ops
  slidesCase('apply_slide_ops', { ops: [{ op: 'setText' }] }, {}, 'one op'),
  slidesCase('apply_slide_ops', { ops: [1, 2], isolation: 'per_op' }, {}, 'per_op'),
  slidesCase(
    'apply_slide_ops',
    { ops: [], isolation: 'atomic', dryRun: true },
    {},
    'atomic dry run',
  ),
  slidesCase('apply_slide_ops', { ops: [], isolation: 'serial' }, {}, 'an unknown isolation'),
  slidesCase('apply_slide_ops', { ops: [], dryRun: 'yes' }, {}, 'dryRun must be true itself'),
  slidesCase('apply_slide_ops', { ops: 'x' }, {}, 'ops that is no array'),
  slidesCase('apply_slide_ops', {}, {}, 'no ops'),
  slidesCase('apply_slide_ops', { ops: [], document: 'tab-9' }, {}, 'a named document is focused'),
  slidesCase('apply_slide_ops', { ops: [] }, { session: null }, 'no session'),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    {
      deps: txn({
        applied: false,
        failures: [
          { index: 0, error: 'bad op' },
          { index: 3, error: 'worse' },
        ],
      }),
    },
    'a rejected transaction lists its failures',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [], dryRun: true },
    { deps: txn({ applied: false, failures: [{ index: 0, error: 'bad op' }] }) },
    'a rejected dry run is a normal answer',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: false }) },
    'rejected, no failures',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: false, failures: [] }) },
    'rejected, an empty list',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: false, failures: null }) },
    'rejected, failures null',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    {
      deps: txn({
        applied: false,
        failures: [{ index: 1 }, {}, { error: 'e' }, { index: 'a', error: 5 }],
      }),
    },
    'failures with missing parts',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: false, failures: [null] }) },
    'a null failure',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: false, failures: 5 }) },
    'failures that is no list',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: txn({ applied: 0 }) },
    'applied must be false itself',
  ),
  slidesCase('apply_slide_ops', { ops: [] }, { deps: txn(null) }, 'a null result'),
  slidesCase('apply_slide_ops', { ops: [] }, { deps: txn('done') }, 'a string result'),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: DEPS({ slides: { ...SLIDES, txn: { undef: true } } }) },
    'no result',
  ),
  slidesCase(
    'apply_slide_ops',
    { ops: [] },
    { deps: DEPS({ slides: { ...SLIDES, txn: { throws: 'boom' } } }) },
    'the transaction throws',
  ),
]

const slidesToolsCases: Case[] = [
  { args: [{ control: 'slides' }], note: 'with a control' },
  { args: [{ control: 'slides', background: false }], note: 'with a control, background off' },
  { args: [{}], note: 'no control' },
  { args: [{ background: true }], note: 'background on' },
]

const slidesDriverCases: Case[] = cases(
  [{ open: 12 }, 'open'],
  [{ open: { throws: 'no tab' } }, 'open'],
  [{ save: { path: '/a.pptx' } }, 'save', 5, '/a', false],
  [{}, 'save', 6, '/b.pptx', true],
  [{ save: { throws: 'file exists' } }, 'save', 7, '/c.pptx', false],
)

// ---------------------------------------------------------------------------
// sheets-tools
// ---------------------------------------------------------------------------

const SHEETS: ToolDeps['sheets'] = { open: 31, run: { value: { sheets: ['Sheet1'] } } }
const sheetsCase = (tool: string, args: unknown, extra: Partial<ToolCall> = {}, note = ''): Case =>
  toolCase(
    {
      deps: DEPS({ sheets: SHEETS, resolve: { answer: 66 } }),
      session: { family: 'xlsx', wcId: 8 },
      tool,
      args,
      ...extra,
    },
    note,
    FILES,
  )
const run = (value: unknown): ToolDeps => DEPS({ sheets: { ...SHEETS, run: { value } } })
const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `A${i + 1}`)

const sheetsCases: Case[] = [
  // create_xlsx
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_xlsx',
      args: {
        title: 'Book',
        data: [
          [1, 'a'],
          [2, 'b'],
        ],
      },
    },
    'rows into the default folder',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'Taken', data: [] } },
    'a taken name, no rows',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_xlsx',
      args: {
        title: 'T',
        data: [
          [1.5, -0, 1e21, true, false, null, 'x', '=A1+1', '', [1, 2], { a: 1 }],
          [],
          ['\u00e9\ud83d\ude00'],
        ],
      },
    },
    'cells of every kind',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], sheetName: '  Data  ' } },
    'a trimmed sheet name',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], sheetName: '   ' } },
    'a blank sheet name',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], sheetName: 5 } },
    'a sheet name that is no string',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], path: '$DIR/new' } },
    'a path without an extension',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], path: '$DIR/out.xlsx' } },
    'an existing file is refused',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'create_xlsx',
      args: { title: 'T', data: [[1]], path: '$DIR/out.xlsx', overwrite: true },
    },
    'overwrite',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1]], path: '$DIR/x.csv' } },
    'a different extension',
    FILES,
  ),
  toolCase({ deps: DEPS(), tool: 'create_xlsx', args: { data: [[1]] } }, 'no title'),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: ' ', data: [[1]] } },
    'a blank title',
  ),
  toolCase({ deps: DEPS(), tool: 'create_xlsx', args: { title: 'T' } }, 'no data'),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: 'rows' } },
    'data that is no array',
  ),
  toolCase(
    { deps: DEPS(), tool: 'create_xlsx', args: { title: 'T', data: [[1], 'row'] } },
    'a row that is no array',
  ),
  toolCase(
    { deps: DEPS({ cli: undefined }), tool: 'create_xlsx', args: { title: 'T', data: [[1]] } },
    'no CLI',
  ),
  toolCase(
    { deps: DEPS({ cli: FAILED_CLI }), tool: 'create_xlsx', args: { title: 'T', data: [[1]] } },
    'the CLI fails',
  ),
  toolCase(
    { deps: DEPS({ background: false }), tool: 'create_xlsx', args: { title: 'T', data: [[1]] } },
    'background off: no such tool',
  ),
  // sheet_links
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx' } },
    'list the links',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS({ cli: cli({ detail: { links: [{ index: 1 }], path: 'p', n: 2 } }) }),
      tool: 'sheet_links',
      args: { path: '$DIR/BOOK2.XLSX' },
    },
    'the detail is spread over the answer',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS({ cli: cli({ summary: undefined, detail: { name: 'n' } }) }),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx' },
    },
    'no summary, a detail key that overrides',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx', update: true } },
    'update',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx', update: 'yes' } },
    'update must be true itself',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx', break: [2, 1] } },
    'break',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx', break: [] } },
    'break nothing',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/book.xlsx', break: 'all' } },
    'break that is no list',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, break: [1] },
    },
    'update and break',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS({ background: false }),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true },
    },
    'update with background off',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS({ background: false }),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', break: [1] },
    },
    'break with background off',
    FILES,
  ),
  toolCase(
    { deps: DEPS({ background: false }), tool: 'sheet_links', args: { path: '$DIR/book.xlsx' } },
    'list with background off',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, out: '$DIR/copy' },
    },
    'an out path without an extension',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, out: '$DIR/out.xlsx' },
    },
    'an existing out file is refused',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', break: [1], out: '$DIR/out.xlsx', overwrite: true },
    },
    'overwrite the out file',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, out: 'rel.xlsx' },
    },
    'a relative out path',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, out: '$DIR/x.csv' },
    },
    'an out path of another type',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', out: '$DIR/ignored.csv', overwrite: true },
    },
    'out is ignored without a write',
    FILES,
  ),
  toolCase(
    {
      deps: DEPS(),
      tool: 'sheet_links',
      args: { path: '$DIR/book.xlsx', update: true, out: '' },
    },
    'an empty out path',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: 'rel/book.xlsx' } },
    'a relative path',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/note.txt' } },
    'not a workbook',
    FILES,
  ),
  toolCase(
    { deps: DEPS(), tool: 'sheet_links', args: { path: '$DIR/missing.xlsx' } },
    'no such file',
    FILES,
  ),
  toolCase({ deps: DEPS(), tool: 'sheet_links', args: {} }, 'no path'),
  toolCase(
    { deps: DEPS({ cli: undefined }), tool: 'sheet_links', args: { path: '$DIR/book.xlsx' } },
    'no CLI',
    FILES,
  ),
  toolCase(
    { deps: DEPS({ cli: FAILED_CLI }), tool: 'sheet_links', args: { path: '$DIR/book.xlsx' } },
    'the CLI fails',
    FILES,
  ),
  // read_sheet
  sheetsCase('read_sheet', {}, {}, 'the overview'),
  sheetsCase(
    'read_sheet',
    { addresses: ['A1', 'B2'], sheet: 'Data', sheetId: 'sid-1' },
    {},
    'addresses on a sheet',
  ),
  sheetsCase('read_sheet', { addresses: [] }, {}, 'an empty address list'),
  sheetsCase('read_sheet', { addresses: rows(100) }, {}, 'the address limit'),
  sheetsCase('read_sheet', { addresses: rows(101) }, {}, 'over the address limit'),
  sheetsCase(
    'read_sheet',
    { addresses: [1, null, true, ['x', 'y'], { a: 1 }] },
    {},
    'addresses of any kind',
  ),
  sheetsCase(
    'read_sheet',
    { addresses: 'A1', sheet: 5, sheetId: null },
    {},
    'values of the wrong kind',
  ),
  sheetsCase('read_sheet', { document: 'tab-4' }, {}, 'a named document'),
  sheetsCase('read_sheet', {}, { session: null }, 'no session'),
  sheetsCase('read_sheet', { addresses: rows(101) }, { session: null }, 'the target comes first'),
  sheetsCase(
    'read_sheet',
    { document: 'x' },
    { deps: DEPS({ sheets: SHEETS, resolve: { throws: 'no tab' } }) },
    'the resolver fails',
  ),
  sheetsCase(
    'read_sheet',
    {},
    { deps: DEPS({ sheets: { ...SHEETS, run: { throws: 'renderer gone' } } }) },
    'the command fails',
  ),
  sheetsCase(
    'read_sheet',
    {},
    { deps: DEPS({ sheets: { ...SHEETS, run: { undef: true } } }) },
    'no answer',
  ),
  sheetsCase('read_sheet', {}, { deps: DEPS() }, 'no control: no such tool'),
  // apply_sheet_ops
  sheetsCase('apply_sheet_ops', { ops: [{ op: 'set_cell' }] }, {}, 'one op'),
  sheetsCase('apply_sheet_ops', { ops: [], dryRun: true }, {}, 'a dry run'),
  sheetsCase('apply_sheet_ops', { ops: [], dryRun: 1 }, {}, 'dryRun must be true itself'),
  sheetsCase('apply_sheet_ops', { ops: 'x' }, {}, 'ops that is no array'),
  sheetsCase('apply_sheet_ops', {}, {}, 'no ops'),
  sheetsCase('apply_sheet_ops', { ops: [], document: 'tab-2' }, {}, 'a named document is focused'),
  sheetsCase('apply_sheet_ops', { ops: [] }, { session: null }, 'no session'),
  sheetsCase('apply_sheet_ops', { ops: 'x' }, { session: null }, 'the target comes first'),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: false, reason: 'unknown sheet' }) },
    'a rejected batch',
  ),
  sheetsCase('apply_sheet_ops', { ops: [] }, { deps: run({ ok: false }) }, 'rejected, no reason'),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: false, reason: null }) },
    'rejected, a null reason',
  ),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: false, reason: 7 }) },
    'a reason that is a number',
  ),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: false, reason: '' }) },
    'an empty reason',
  ),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: 0, reason: 'x' }) },
    'ok must be false itself',
  ),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: run({ ok: true, changed: 2 }) },
    'an applied batch',
  ),
  sheetsCase('apply_sheet_ops', { ops: [] }, { deps: run(null) }, 'a null answer'),
  sheetsCase('apply_sheet_ops', { ops: [] }, { deps: run('done') }, 'a string answer'),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: DEPS({ sheets: { ...SHEETS, run: { undef: true } } }) },
    'no answer',
  ),
  sheetsCase(
    'apply_sheet_ops',
    { ops: [] },
    { deps: DEPS({ sheets: { ...SHEETS, run: { throws: 'renderer gone' } } }) },
    'the command fails',
  ),
]

const sheetsDriverCases: Case[] = cases(
  [{ open: 12 }, 'open'],
  [{ open: { throws: 'no tab' } }, 'open'],
  [{ run: { value: { ok: true } } }, 'save', 5, '/a.xlsx', false],
  [{ run: { value: { ok: false, reason: 'full' } } }, 'save', 6, '/b', true],
  [{ run: { undef: true } }, 'save', 6, '/b.xlsx', true],
  [{ run: { throws: 'file exists' } }, 'save', 7, '/c.xlsx', false],
)

// ---------------------------------------------------------------------------
// diagram-tools
// ---------------------------------------------------------------------------

const tab = (id: string, extra: Spec = {}): Spec => ({
  id,
  kind: 'diagram',
  title: `Title ${id}`,
  filePath: `/work/${id}.drawio`,
  active: false,
  dirty: false,
  ...extra,
})

interface DiagramWorld {
  list?: Spec[] | { throws: string }
  detached?: string[]
  read?: Spec
  apply?: Spec
}

function fakeDiagram(spec: DiagramWorld, cx: TsContext): Spec {
  const control: Spec = {
    list: async () => {
      cx.log('diagram.list')
      if (spec.list && !Array.isArray(spec.list)) throw new Error(spec.list.throws)
      return spec.list ?? []
    },
    read: async (target: Spec, page?: string) => {
      cx.log('diagram.read', target.id, page ?? null)
      return answer(spec.read)
    },
    apply: async (target: Spec, ops: unknown) => {
      cx.log('diagram.apply', target.id, ops)
      return answer(spec.apply)
    },
  }
  if (spec.detached) {
    const detached = spec.detached
    control.isDetached = (id: string) => {
      cx.log('diagram.isDetached', id)
      return detached.includes(id)
    }
  }
  return control
}

interface DiagramCall {
  control?: DiagramWorld | null
  tool: string
  args?: unknown
}

async function diagramCall(spec: DiagramCall, cx: TsContext): Promise<unknown> {
  const tools = diagramTools.createDiagramTools({
    ...(spec.control ? { control: fakeDiagram(spec.control, cx) as never } : {}),
  })
  return callTool(tools as Spec[], spec.tool, spec.args)
}

const READ_OK = {
  value: {
    text: 'id|label',
    pages: [{ id: 'p1', name: 'Page-1', current: true }],
    page: { id: 'p1', name: 'Page-1', shapes: [], edges: [] },
  },
}
const diagramCase = (
  tool: string,
  args: unknown,
  control: DiagramWorld | null,
  note: string,
): Case => ({
  args: [{ control, tool, args }],
  note,
})
const OPEN: Spec[] = [
  tab('d1', { active: true }),
  tab('d2'),
  { ...tab('t1', { kind: 'docs' }), filePath: '/work/a.docx' },
]
const world = (extra: DiagramWorld = {}): DiagramWorld => ({
  list: OPEN,
  read: READ_OK,
  apply: {
    value: {
      status: 'ok',
      changed: true,
      results: [{ index: 0, op: 'add_shape', status: 'ok', created: ['s1'] }],
      created: ['s1'],
      plan: { internal: 1 },
    },
  },
  ...extra,
})
const applied = (value: unknown, list: Spec[] = OPEN): DiagramWorld => ({ list, apply: { value } })

const diagramCases: Case[] = [
  // read_diagram
  diagramCase('read_diagram', {}, world(), 'the diagram in front'),
  diagramCase('read_diagram', { document: 'd2' }, world(), 'a named diagram'),
  diagramCase('read_diagram', { document: '  d2  ' }, world(), 'a name with spaces'),
  diagramCase('read_diagram', { document: '/work/d2.drawio' }, world(), 'a diagram by its path'),
  diagramCase('read_diagram', { document: '   ' }, world(), 'a blank document is the front one'),
  diagramCase('read_diagram', { document: 5 }, world(), 'a document that is no string'),
  diagramCase('read_diagram', { document: 't1' }, world(), 'a document of another kind'),
  diagramCase('read_diagram', { document: 'zzz' }, world(), 'no such document'),
  diagramCase('read_diagram', { page: ' Page-2 ' }, world(), 'a page is trimmed'),
  diagramCase('read_diagram', { page: '  ' }, world(), 'a blank page'),
  diagramCase('read_diagram', { page: 3 }, world(), 'a page that is no string'),
  diagramCase('read_diagram', {}, world({ list: [tab('d1'), tab('d2')] }), 'no diagram in front'),
  diagramCase(
    'read_diagram',
    {},
    world({ list: [tab('d1'), tab('d2', { filePath: undefined, title: 'Unsaved' })] }),
    'no diagram in front, one never saved',
  ),
  diagramCase('read_diagram', {}, world({ list: [OPEN[2]!] }), 'no diagram open'),
  diagramCase('read_diagram', {}, world({ list: [] }), 'nothing open'),
  diagramCase(
    'read_diagram',
    {},
    world({ list: [tab('d1', { active: true }), tab('d2', { active: true })] }),
    'two in front, no detached method',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ list: [tab('d1', { active: true }), tab('d2', { active: true })], detached: ['d2'] }),
    'two in front, the detached one wins',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ list: [tab('d1', { active: true }), tab('d2', { active: true })], detached: [] }),
    'two in front, none detached',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({
      list: [tab('d1', { active: true }), tab('d2', { active: true }), tab('d3', { active: true })],
      detached: ['d3', 'd2'],
    }),
    'three in front: the first detached',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ read: { value: { text: 'only text' } } }),
    'a read with text only',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ read: { value: { text: 't', pages: [] } } }),
    'a read with pages only',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ read: { value: { text: 't', page: { id: 'p' } } } }),
    'a read with a page only',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ read: { value: { text: 't', pages: 0, page: { id: 'p' } } } }),
    'pages that are falsy',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ read: { value: { text: 't', pages: [], page: '' } } }),
    'a page that is falsy',
  ),
  diagramCase(
    'read_diagram',
    {},
    world({ list: [tab('d1', { active: true, dirty: true })] }),
    'a dirty diagram',
  ),
  diagramCase('read_diagram', {}, world({ read: { throws: 'editor gone' } }), 'the read fails'),
  diagramCase('read_diagram', {}, world({ list: { throws: 'no tab manager' } }), 'the list fails'),
  diagramCase('read_diagram', {}, null, 'no control'),
  // apply_diagram_ops
  diagramCase('apply_diagram_ops', { ops: [{ op: 'add_shape', id: 's1' }] }, world(), 'one op'),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'add_shape' }], document: 'd2' },
    world(),
    'a named diagram',
  ),
  diagramCase('apply_diagram_ops', {}, world(), 'no ops'),
  diagramCase('apply_diagram_ops', { ops: [] }, world(), 'an empty list'),
  diagramCase('apply_diagram_ops', { ops: 'x' }, world(), 'ops that is no list'),
  diagramCase('apply_diagram_ops', { ops: [] }, null, 'no control comes first'),
  diagramCase('apply_diagram_ops', { ops: [{ op: 'x' }] }, world({ list: [] }), 'nothing open'),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }], document: 'nope' },
    world(),
    'no such document',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    world({ list: { throws: 'down' } }),
    'the list fails',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    world({ apply: { throws: 'executor gone' } }),
    'the apply fails',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied(undefined),
    'no answer: rejected',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ value: 1 }),
    'no answer: rejected',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    { list: OPEN, apply: { undef: true } },
    'an undefined answer',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    { list: OPEN, apply: { value: null } },
    'a null answer',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    { list: OPEN, apply: { value: 'ok' } },
    'a string answer',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'ok' }),
    'ok with nothing else',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'ok', changed: 'yes', results: 'x', created: 'y' }),
    'fields of the wrong kind',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({
      status: 'ok',
      changed: true,
      created: ['a', 'b'],
      results: [
        { index: 0, op: 'add_shape', status: 'ok', created: ['a'], extra: 1 },
        { index: 1, op: 'add_edge', status: 'ok', created: [] },
        { index: 2, op: 'read', status: 'ok', read: { text: 't' }, created: 'xy' },
        { index: 3, op: 'update', status: 'ok', error: { code: 'E', message: 'm', more: 1 } },
        { index: 4, op: '', status: 'ok', read: 0, created: 5, error: null },
        { index: 5, status: 'skipped' },
        {},
      ],
    }),
    'a report of every shape',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'ok', results: [null] }),
    'a null result',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'rejected', results: [null] }),
    'a null result of a refused call',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'ok', results: ['text', 7, [1]] }),
    'results that are no objects',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({
      status: 'rejected',
      changed: false,
      results: [
        { index: 0, op: 'add_shape', status: 'ok' },
        {
          index: 1,
          op: 'add_edge',
          status: 'failed',
          error: { code: 'unknown_id', message: 'no such shape' },
        },
        { index: 2, op: 'delete', status: 'skipped' },
        { index: 3, op: '', status: 'failed' },
        { index: 4, op: 'update', status: 'failed', error: { code: null, message: null } },
        { index: 5, op: 'update', status: 'failed', error: { code: 7, message: 'm' } },
        { status: 'failed', op: 'x', error: { message: 'no code' } },
        { index: 7, op: 7, status: 'weird' },
        { index: { a: 1 }, op: ['p', 'q'], status: 'failed', error: { code: 'c', message: ['m'] } },
      ],
    }),
    'a refused call lists every op',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({
      results: [{ index: 0, op: 'a', status: 'failed', error: { code: 'x', message: 'y' } }],
    }),
    'no status: rejected',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 'partial', results: [] }),
    'another status',
  ),
  diagramCase(
    'apply_diagram_ops',
    { ops: [{ op: 'x' }] },
    applied({ status: 7, results: [] }),
    'a status that is no string',
  ),
]

const diagramSchemaOps = (defs: Spec[]): Spec[] =>
  defs.map((d) => ({
    name: d.name,
    description: d.description ?? `does ${d.name}`,
    changes: true,
    input: { properties: d.props, required: d.required ?? [] },
  }))
const str = (description: string, extra: Spec = {}): Spec => ({
  type: 'string',
  description,
  ...extra,
})
const num = (description: string): Spec => ({ type: 'number', description })
const arr = (description: string): Spec => ({
  type: 'array',
  items: { type: 'string' },
  description,
})
const schemaCase = (defs: Spec[] | null, note: string): Case => ({ args: [defs], note })
const schemaCases: Case[] = [
  schemaCase(null, 'the ops of the app'),
  schemaCase([{ name: 'a', props: { x: str('the x') } }], 'one op, one property'),
  schemaCase(
    [
      { name: 'a', props: { x: str('the x'), n: num('count') } },
      { name: 'b', props: { x: str('the x'), items: arr('ids') }, required: ['x'] },
    ],
    'a property two ops describe alike',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x of a') } },
      { name: 'b', props: { x: str('x of b') } },
      { name: 'c', props: { x: str('x of a') } },
    ],
    'a property described three ways',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x', { enum: ['p', 'q'] }) } },
      { name: 'b', props: { x: str('x', { enum: ['p', 'q'] }) } },
    ],
    'the same enum is enforced',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x', { enum: ['p', 'q'] }) } },
      { name: 'b', props: { x: str('x', { enum: ['q', 'p'] }) } },
    ],
    'enums in another order are not enforced',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x', { enum: ['p'] }) } },
      { name: 'b', props: { x: str('x') } },
    ],
    'an enum one op lacks is not enforced',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x') } },
      { name: 'b', props: { x: str('x', { enum: ['p'] }) } },
    ],
    'the first op has no enum',
  ),
  schemaCase([{ name: 'a', props: { x: str('x', { enum: [] }) } }], 'an empty enum'),
  schemaCase(
    [{ name: 'a', props: { x: { ...num('n'), enum: ['1'] } } }],
    'an enum on a number is ignored',
  ),
  schemaCase(
    [{ name: 'a', props: { x: { ...arr('l'), enum: ['1'] } } }],
    'an enum on an array is ignored',
  ),
  schemaCase(
    [
      { name: 'a', props: { x: str('x') } },
      { name: 'b', props: { x: num('x') } },
    ],
    'two types: string, number',
  ),
  schemaCase(
    [
      { name: 'a', props: { y: arr('y') } },
      { name: 'b', props: { y: str('y') } },
    ],
    'two types: array, string',
  ),
  schemaCase([], 'no ops'),
  schemaCase([{ name: 'a', props: {} }], 'an op without properties'),
  schemaCase([{ name: 'a', props: { op: str('shadows the op key') } }], 'a property named op'),
]

const frontCases: Case[] = [
  { args: [[], null], note: 'nothing open' },
  { args: [[tab('a', { active: true })], null], note: 'one active' },
  { args: [[tab('a'), tab('b', { active: true })], null], note: 'the active one' },
  {
    args: [[tab('a', { active: true, kind: 'docs' })], null],
    note: 'an active document of another kind',
  },
  {
    args: [[tab('a', { active: true }), tab('b', { active: true })], null],
    note: 'two active, no method',
  },
  {
    args: [[tab('a', { active: true }), tab('b', { active: true })], ['b']],
    note: 'the detached one',
  },
  { args: [[tab('a', { active: true }), tab('b', { active: true })], []], note: 'none detached' },
  {
    args: [
      [tab('a', { active: true }), tab('b', { active: true }), tab('c', { active: true })],
      ['c', 'b'],
    ],
    note: 'the first detached',
  },
  {
    args: [[tab('a', { active: true }), tab('b'), tab('c', { active: true })], ['b']],
    note: 'a detached tab that is not in front',
  },
]

// ---------------------------------------------------------------------------
// sheets-bridge
// ---------------------------------------------------------------------------

/** the timers of a scenario: they log, and a step fires one by its number */
function fakeTimers(cx: TsContext): { fire: (id: number) => void; restore: () => void } {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const armed = new Map<number, () => void>()
  let next = 1
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = next++
    armed.set(id, fn)
    cx.log('setTimeout', ms)
    return id
  }) as never
  globalThis.clearTimeout = ((id: number) => {
    cx.log('clearTimeout', id)
    armed.delete(id)
  }) as never
  return {
    fire: (id) => {
      const fn = armed.get(id)
      if (fn) {
        armed.delete(id)
        fn()
      }
    },
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}

/** a promise's outcome as the case records it: `{ ok }` or `{ error }` */
function track(outcomes: Record<string, unknown>, label: string, promise: Promise<unknown>): void {
  outcomes[label] = 'pending'
  promise.then(
    (value) => {
      outcomes[label] = { ok: value }
    },
    (error: Error) => {
      outcomes[label] = { error: error.message }
    },
  )
}

/** `console.warn` of a scenario: a log line with the message of the error */
function fakeWarn(cx: TsContext): () => void {
  const real = console.warn
  console.warn = (...a: unknown[]) => cx.log('console.warn', a[0], (a[1] as Error)?.message ?? a[1])
  return () => {
    console.warn = real
  }
}

let sheetsSerial = 0

interface BridgeScenario {
  /** webContents by id: `alive` or `destroyed` */
  wcs: Record<string, 'alive' | 'destroyed'>
  /** what `deps.openBlankTab()` answers, in turn: an id or `{ throws }` */
  blank?: (number | { throws: string })[]
  /** `deps.abandonBlankTab` exists */
  abandon?: boolean
  steps: Spec[]
}

async function runSheetsBridge(spec: BridgeScenario, cx: TsContext): Promise<unknown> {
  sheetsSerial += 1
  const timers = fakeTimers(cx)
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const wcs = new Map<number, Spec>()
  for (const [id, state] of Object.entries(spec.wcs)) {
    const wc: Spec = {
      destroyed: state === 'destroyed',
      listeners: [] as (() => void)[],
      isDestroyed: () => wc.destroyed,
      once: (event: string, fn: () => void) => {
        cx.log('wc.once', Number(id), event)
        wc.listeners.push(fn)
      },
      send: (channel: string, payload: unknown) => cx.log('wc.send', Number(id), channel, payload),
    }
    wcs.set(Number(id), wc)
  }
  useElectron({
    ipcMain: {
      on: (channel: string, fn: (...args: unknown[]) => void) => {
        cx.log('ipcMain.on', channel)
        handlers[channel] = fn
      },
      handle() {},
      removeHandler() {},
    },
    webContents: { fromId: (id: number) => wcs.get(id) },
  })
  try {
    const bridge = await import(
      `../../../../apps/shell/src/main/mcp/sheets-bridge.ts?case=${sheetsSerial}`
    )
    const blank = [...(spec.blank ?? [])]
    const control = bridge.createSheetsControl({
      openBlankTab: async () => {
        const next = blank.shift() as number | { throws: string }
        if (typeof next === 'object') {
          cx.log('deps.openBlankTab', 'rejects')
          throw new Error(next.throws)
        }
        cx.log('deps.openBlankTab', next)
        return next
      },
      authorizeSave: (wcId: number, path: string) => cx.log('deps.authorizeSave', wcId, path),
      ...(spec.abandon
        ? { abandonBlankTab: (wcId: number) => cx.log('deps.abandonBlankTab', wcId) }
        : {}),
    })
    const outcomes: Record<string, unknown> = {}
    const send = (channel: string, id: number, ...rest: unknown[]): void => {
      const handler = handlers[channel]
      if (handler) handler({ sender: { id } }, ...rest)
      else cx.log('no listener', channel)
    }
    for (const step of spec.steps) {
      if (step.install) bridge.installSheetsBridge()
      else if (step.open !== undefined) track(outcomes, step.open, control.openBlankTab())
      else if (step.run !== undefined) {
        track(outcomes, step.run, control.runCommand(step.wc, step.command, step.payload))
      } else if (step.ready !== undefined) send('sheets:mcp-ready', step.ready)
      else if (step.result !== undefined) send('sheets:mcp-result', step.result, step.payload)
      else if (step.destroy !== undefined) {
        const wc = wcs.get(step.destroy)!
        wc.destroyed = true
        const listeners = wc.listeners.splice(0)
        for (const fn of listeners) fn()
      } else if (step.vanish !== undefined) wcs.delete(step.vanish)
      else if (step.fire !== undefined) timers.fire(step.fire)
      await tick()
    }
    return { outcomes }
  } finally {
    timers.restore()
  }
}

/** a case installs the bridge first unless it is `bare`; the folder holds `old.xlsx` */
const sheetsBridgeCase = (
  spec: Partial<BridgeScenario> & { bare?: boolean },
  note: string,
): Case => {
  const { bare, steps = [], ...rest } = spec
  return {
    args: [
      {
        wcs: { '3': 'alive', '4': 'alive' },
        ...rest,
        steps: bare ? steps : [{ install: true }, ...steps],
      },
    ],
    files: { 'old.xlsx': 'x', 'Upper.XLSX': 'x', plain: 'x' },
    note,
  }
}

const SHEET_UNSEEN = { requestId: 'mcp-1', ok: true, result: 'r' }
const readSheet = { run: 'r', wc: 3, command: 'read_sheet', payload: {} }
const sheetsBridgeCases: Case[] = [
  sheetsBridgeCase(
    { bare: true, blank: [3], steps: [{ install: true }, { install: true }] },
    'install registers the two channels once',
  ),
  sheetsBridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { ready: 3 }] },
    'a blank tab that becomes ready',
  ),
  sheetsBridgeCase(
    { blank: [3], steps: [{ ready: 3 }, { open: 'o' }, { ready: 3 }] },
    'ready before the open: resolved at once; the hook is attached once',
  ),
  sheetsBridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { fire: 1 }] },
    'the tab never gets ready: abandoned (no dep)',
  ),
  sheetsBridgeCase(
    { blank: [3], abandon: true, steps: [{ open: 'o' }, { fire: 1 }, { fire: 1 }] },
    'the tab never gets ready: abandoned',
  ),
  sheetsBridgeCase(
    { blank: [3], abandon: true, steps: [{ open: 'o' }, { destroy: 3 }] },
    'the tab is closed while it is awaited',
  ),
  sheetsBridgeCase(
    { blank: [9], abandon: true, steps: [{ open: 'o' }] },
    'the blank tab is not a webContents',
  ),
  sheetsBridgeCase(
    { blank: [6], wcs: { '6': 'destroyed' }, abandon: true, steps: [{ open: 'o' }] },
    'the blank tab is destroyed',
  ),
  sheetsBridgeCase(
    { blank: [{ throws: 'no file' }], abandon: true, steps: [{ open: 'o' }] },
    'the dep rejects: nothing to abandon',
  ),
  sheetsBridgeCase(
    {
      blank: [3, { throws: 'second fails' }, 4],
      abandon: true,
      steps: [{ open: 'a' }, { open: 'b' }, { open: 'c' }, { ready: 3 }, { ready: 4 }],
    },
    'three opens, the second rejects',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: { sheets: [] } } },
      ],
    },
    'a command answered',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { run: 'r', wc: 3, command: 'apply_ops', payload: { ops: [] } },
        { ready: 3 },
        { result: 3, payload: SHEET_UNSEEN },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: 'later' } },
      ],
    },
    'a command waits for the tab; a second reply to the same request is ignored',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 'a', wc: 3, command: 'read_sheet' },
        { run: 'b', wc: 3, command: 'apply_ops', payload: { ops: [] } },
        { result: 3, payload: { requestId: 'mcp-2', ok: true } },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: null } },
      ],
    },
    'two commands answered out of order; no payload is a missing key',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 4, payload: SHEET_UNSEEN },
        { result: 3, payload: SHEET_UNSEEN },
      ],
    },
    'a reply from another tab is ignored',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 3 },
        { result: 3, payload: null },
        { result: 3, payload: 'mcp-1' },
        { result: 3, payload: [1] },
        { result: 3, payload: { ok: true } },
        { result: 3, payload: { requestId: 1, ok: true } },
        { result: 3, payload: { requestId: 'mcp-9', ok: true } },
      ],
    },
    'replies that name no pending request leave it pending',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 3, payload: { requestId: 'mcp-1', ok: false, error: 'it broke' } },
      ],
    },
    'a reply with ok false: its error',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 3, payload: { requestId: 'mcp-1', ok: false, error: 5 } },
      ],
    },
    'an error that is no string',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        readSheet,
        { result: 3, payload: { requestId: 'mcp-1', ok: 'true', result: 1 } },
      ],
    },
    'ok must be true itself',
  ),
  sheetsBridgeCase(
    { steps: [{ ready: 3 }, readSheet, { result: 3, payload: { requestId: 'mcp-1', ok: true } }] },
    'ok without a result',
  ),
  sheetsBridgeCase({ steps: [{ ready: 3 }, readSheet, { fire: 1 }] }, 'a command nobody answers'),
  sheetsBridgeCase({ steps: [readSheet, { fire: 1 }] }, 'a command whose tab never gets ready'),
  sheetsBridgeCase(
    { steps: [{ run: 'r', wc: 9, command: 'read_sheet', payload: {} }] },
    'a command for no webContents',
  ),
  sheetsBridgeCase(
    { wcs: { '3': 'destroyed' }, steps: [readSheet] },
    'a command for a destroyed webContents',
  ),
  sheetsBridgeCase(
    { steps: [{ ready: 3 }, { destroy: 3 }, readSheet] },
    'a tab that was ready and went',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { run: 'a', wc: 3, command: 'read_sheet', payload: {} },
        { vanish: 3 },
        { run: 'b', wc: 3, command: 'read_sheet', payload: {} },
      ],
    },
    'a webContents that vanished',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 'a', wc: 3, command: 'read_sheet', payload: {} },
        { run: 'b', wc: 4, command: 'read_sheet', payload: {} },
        { ready: 4 },
        { run: 'c', wc: 4, command: 'read_sheet', payload: {} },
        { destroy: 3 },
        { result: 4, payload: { requestId: 'mcp-3', ok: true, result: 'c' } },
        { fire: 3 },
      ],
    },
    'a tab closed with a command in flight; the other tab goes on',
  ),
  sheetsBridgeCase(
    {
      blank: [3],
      abandon: true,
      steps: [
        { open: 'o' },
        { run: 'a', wc: 3, command: 'read_sheet', payload: {} },
        { run: 'b', wc: 4, command: 'read_sheet', payload: {} },
        { destroy: 3 },
        { ready: 4 },
      ],
    },
    'a tab closed with waiters of two kinds',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { run: 'a', wc: 3, command: 'read_sheet', payload: {} },
        { run: 'b', wc: 3, command: 'apply_ops', payload: { ops: [] } },
        { fire: 2 },
        { ready: 3 },
      ],
    },
    'one of two waiters times out; the other is resumed',
  ),
  sheetsBridgeCase(
    { steps: [{ ready: 7 }, { ready: 3 }, { ready: 3 }] },
    'a tab that is no webContents announces itself',
  ),
  sheetsBridgeCase({ bare: true, steps: [{ ready: 3 }] }, 'ready with the channels not registered'),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/new.xlsx' } },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: { ok: true } } },
      ],
    },
    'a save to a new file is authorized',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/new' } },
      ],
    },
    'a path without the extension gets it',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/new.XLSX' } },
      ],
    },
    'the extension in capitals is kept',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/new.xlsx.bak' } },
      ],
    },
    'another extension gets .xlsx',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/old.xlsx' } },
      ],
    },
    'a save over a file without overwrite is refused',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/old' } },
      ],
    },
    'the extension is added before the file is looked up',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/Upper.XLSX' } },
      ],
    },
    'a file with the extension in capitals exists',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        {
          run: 's',
          wc: 3,
          command: 'save_sheet',
          payload: { path: '$DIR/old.xlsx', overwrite: true },
        },
      ],
    },
    'a save over a file with overwrite',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        {
          run: 's',
          wc: 3,
          command: 'save_sheet',
          payload: { path: '$DIR/old.xlsx', overwrite: 'yes' },
        },
      ],
    },
    'overwrite must be true itself',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_sheet', payload: { overwrite: true } },
        { run: 't', wc: 3, command: 'save_sheet', payload: { path: 5 } },
        { run: 'u', wc: 3, command: 'save_sheet' },
        { run: 'v', wc: 3, command: 'save_sheet', payload: null },
        { run: 'w', wc: 3, command: 'save_sheet', payload: 'x' },
      ],
    },
    'a save without a path',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { run: 's', wc: 3, command: 'save_sheet', payload: { path: '$DIR/old.xlsx' } },
        { ready: 3 },
        { fire: 1 },
      ],
    },
    'a save that waits for the tab and is refused when it is ready',
  ),
  sheetsBridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 'p', wc: 3, command: 'apply_ops' },
        { run: 'q', wc: 3, command: 'apply_ops', payload: [1, 'two'] },
      ],
    },
    'payloads of any shape are sent',
  ),
]

// ---------------------------------------------------------------------------
// diagram-bridge
// ---------------------------------------------------------------------------

interface TabsWorld {
  tabs: Spec[]
  /** by tab id: `{ id, destroyed? }` (a webContents), `{ throws }`, or missing (undefined) */
  contents?: Record<string, Spec>
  /** `webContentsFor` answers a promise */
  lazy?: boolean
  /** `activate` / `revealWindow` exist: `ok` or `throws` */
  activate?: 'ok' | 'throws'
  reveal?: 'ok' | 'throws'
  detached?: string[]
  steps: Spec[]
}

/** the deps the three bridges share, as a case describes them */
function tabsDeps(spec: TabsWorld, cx: TsContext): Spec {
  const deps: Spec = {
    list: async () => {
      cx.log('deps.list')
      return spec.tabs
    },
    webContentsFor: (tabId: string) => {
      cx.log('deps.webContentsFor', tabId)
      const entry = spec.contents?.[tabId]
      const go = (): unknown => {
        if (entry?.throws !== undefined) throw new Error(entry.throws)
        return entry ? { id: entry.id, isDestroyed: () => entry.destroyed === true } : undefined
      }
      return spec.lazy ? Promise.resolve().then(go) : go()
    },
  }
  if (spec.activate) {
    deps.activate = (tabId: string) => {
      cx.log('deps.activate', tabId)
      if (spec.activate === 'throws') throw new Error('no switch')
    }
  }
  if (spec.reveal) {
    deps.revealWindow = (tabId: string) => {
      cx.log('deps.revealWindow', tabId)
      if (spec.reveal === 'throws') throw new Error('no window')
    }
  }
  return deps
}

/** one step's answer: `{ ok }` or `{ error }` */
async function settle(step: () => unknown): Promise<unknown> {
  try {
    return { ok: await step() }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

interface DiagramBridgeWorld extends TabsWorld {
  read?: Spec
  apply?: Spec
}

async function runDiagramBridge(spec: DiagramBridgeWorld, cx: TsContext): Promise<unknown> {
  const restore = fakeWarn(cx)
  try {
    const deps = tabsDeps(spec, cx)
    if (spec.detached) {
      deps.isDetached = (id: string) => {
        cx.log('deps.isDetached', id)
        return spec.detached!.includes(id)
      }
    }
    deps.readPage = async (contents: Spec, page?: string) => {
      cx.log('deps.readPage', contents.id, page ?? null)
      return answer(spec.read)
    }
    deps.applyOps = async (contents: Spec, ops: unknown) => {
      cx.log('deps.applyOps', contents.id, ops)
      return answer(spec.apply)
    }
    const control = diagramBridge.createDiagramControl(deps as never)
    const tabOf = (step: Spec): Spec => step.tab ?? spec.tabs.find((t) => t.id === step.id)!
    const answers: unknown[] = []
    for (const step of spec.steps) {
      if (step.list) answers.push(await settle(() => control.list()))
      else if (step.isDetached !== undefined) {
        answers.push(await settle(() => control.isDetached?.(step.isDetached) ?? null))
      } else if (step.read !== undefined) {
        answers.push(
          await settle(() =>
            control.read(tabOf({ id: step.read, tab: step.tab }) as never, step.page),
          ),
        )
      } else if (step.apply !== undefined) {
        answers.push(
          await settle(() =>
            control.apply(tabOf({ id: step.apply, tab: step.tab }) as never, step.ops),
          ),
        )
      }
    }
    return answers
  } finally {
    restore()
  }
}

const diagramBridgeCase = (spec: Partial<DiagramBridgeWorld>, note: string): Case => ({
  args: [
    {
      tabs: [tab('d1', { active: true }), tab('d2')],
      contents: { d1: { id: 11 }, d2: { id: 12 } },
      read: { value: { text: 'table', pages: [{ id: 'p' }], page: { id: 'p' } } },
      apply: { value: { status: 'ok' } },
      steps: [],
      ...spec,
    },
  ],
  note,
})

const diagramBridgeCases: Case[] = [
  diagramBridgeCase({ steps: [{ list: true }] }, 'the list is the deps'),
  diagramBridgeCase({ steps: [{ isDetached: 'd1' }, { isDetached: 'd2' }] }, 'no isDetached dep'),
  diagramBridgeCase(
    { detached: ['d2'], steps: [{ isDetached: 'd1' }, { isDetached: 'd2' }] },
    'the isDetached dep is passed on',
  ),
  diagramBridgeCase({ steps: [{ read: 'd1' }, { read: 'd2', page: 'Page-2' }] }, 'a page read'),
  diagramBridgeCase({ lazy: true, steps: [{ read: 'd1' }] }, 'contents that arrive late'),
  diagramBridgeCase({ read: { throws: 'editor gone' }, steps: [{ read: 'd1' }] }, 'the read fails'),
  diagramBridgeCase(
    { read: { value: { text: 'only text' } }, steps: [{ read: 'd1' }] },
    'a read without values',
  ),
  diagramBridgeCase({ contents: {}, steps: [{ read: 'd1' }] }, 'no webContents'),
  diagramBridgeCase(
    { contents: { d1: { id: 11, destroyed: true } }, steps: [{ read: 'd1' }] },
    'a destroyed webContents',
  ),
  diagramBridgeCase(
    {
      contents: { d1: { throws: 'recovery pending' } },
      steps: [{ read: 'd1' }, { apply: 'd1', ops: [] }],
    },
    'a document waiting on its recovery answer',
  ),
  diagramBridgeCase({ steps: [{ read: 'x', tab: tab('x') }] }, 'a tab the manager does not know'),
  diagramBridgeCase(
    { steps: [{ apply: 'd1', ops: [{ op: 'add_shape' }] }] },
    'an apply on the active tab',
  ),
  diagramBridgeCase(
    { steps: [{ apply: 'd2', ops: [{ op: 'add_shape' }] }] },
    'an apply on a background tab, no way to show it',
  ),
  diagramBridgeCase(
    {
      activate: 'ok',
      reveal: 'ok',
      steps: [
        { apply: 'd2', ops: [1] },
        { apply: 'd1', ops: [2] },
      ],
    },
    'the tab is shown before the change, only when it is not active',
  ),
  diagramBridgeCase(
    { activate: 'ok', steps: [{ apply: 'd2', ops: [1] }] },
    'activate without reveal',
  ),
  diagramBridgeCase(
    { reveal: 'ok', steps: [{ apply: 'd2', ops: [1] }] },
    'reveal without activate',
  ),
  diagramBridgeCase(
    { activate: 'throws', reveal: 'ok', steps: [{ apply: 'd2', ops: [1] }] },
    'activate fails: warned, reveal skipped, the change goes on',
  ),
  diagramBridgeCase(
    { activate: 'ok', reveal: 'throws', steps: [{ apply: 'd2', ops: [1] }] },
    'reveal fails: warned, the change goes on',
  ),
  diagramBridgeCase(
    { activate: 'ok', contents: {}, steps: [{ apply: 'd2', ops: [1] }] },
    'no webContents: nothing is shown',
  ),
  diagramBridgeCase(
    { apply: { throws: 'executor gone' }, steps: [{ apply: 'd1', ops: [] }] },
    'the apply fails',
  ),
  diagramBridgeCase(
    { apply: { undef: true }, steps: [{ apply: 'd1', ops: [] }] },
    'the apply answers nothing',
  ),
  diagramBridgeCase(
    {
      apply: { value: { status: 'rejected', results: [] } },
      steps: [{ apply: 'd1', ops: [1, 2] }],
    },
    'a refused plan is the answer',
  ),
]

// ---------------------------------------------------------------------------
// open-documents-bridge
// ---------------------------------------------------------------------------

interface OpenWorld extends TabsWorld {
  saveDir?: string
  docs?: Spec
  sheets?: Spec
  slides?: Spec
  /** the editors with their own protocol: `{ read, save, discard }` of `Val`s */
  markdown?: Spec
  html?: Spec
  mindmap?: Spec
  hwp?: Spec
  epub?: Spec
  diagram?: Spec
  /** `slidesDiscard` / `recoveryDiscard` exist: `ok` or `throws` */
  slidesDiscard?: 'ok' | 'throws'
  recoveryDiscard?: 'ok' | 'throws'
  /** `isUnloaded` exists and answers true for these ids */
  unloaded?: string[]
  closeFails?: string[]
}

/** a protocol of a case: each call logs `<name>.<call> <wc> ..` and answers the case's `Val` */
function fakeEditor(name: string, spec: Spec, cx: TsContext): Spec {
  return {
    read: async (contents: Spec) => {
      cx.log(`${name}.read`, contents.id)
      return answer(spec.read)
    },
    save: async (contents: Spec, path: string) => {
      cx.log(`${name}.save`, contents.id, path)
      answer(spec.save)
    },
    discard: async (contents: Spec) => {
      cx.log(`${name}.discard`, contents.id)
      answer(spec.discard)
    },
  }
}

async function runOpenBridge(
  spec: OpenWorld & { resolver?: boolean },
  cx: TsContext,
): Promise<unknown> {
  const restore = fakeWarn(cx)
  try {
    const deps = tabsDeps(spec, cx)
    const resolver = openBridge.createOpenTargetResolver(deps as never)
    const base: Spec = {
      ...deps,
      closeTab: (tabId: string) => {
        cx.log('deps.closeTab', tabId)
        return !spec.closeFails?.includes(tabId)
      },
      defaultSaveDir: () => {
        cx.log('deps.defaultSaveDir')
        return spec.saveDir
      },
    }
    if (spec.unloaded) {
      base.isUnloaded = (tabId: string) => {
        cx.log('deps.isUnloaded', tabId)
        return spec.unloaded!.includes(tabId)
      }
    }
    if (spec.recoveryDiscard) {
      base.recoveryDiscard = (target: Spec, contents: Spec) => {
        cx.log('deps.recoveryDiscard', target.id, contents.id)
        if (spec.recoveryDiscard === 'throws') throw new Error('recovery locked')
      }
    }
    if (spec.slidesDiscard) {
      base.slidesDiscard = (contents: Spec) => {
        cx.log('deps.slidesDiscard', contents.id)
        if (spec.slidesDiscard === 'throws') throw new Error('slides locked')
      }
    }
    if (spec.docs) {
      base.docs = {
        runCommand: async (wcId: number, command: string, payload: unknown) => {
          cx.log('docs.run', wcId, command, payload)
          return answer(spec.docs!.run)
        },
      }
    }
    if (spec.sheets) {
      base.sheets = {
        runCommand: async (wcId: number, command: string, payload: unknown) => {
          cx.log('sheets.run', wcId, command, payload)
          return answer(spec.sheets!.run)
        },
      }
    }
    if (spec.slides) {
      base.slides = {
        readDeck: async (wcId: number, options?: unknown) => {
          cx.log('slides.read', wcId, options ?? null)
          return answer(spec.slides!.read)
        },
        saveDeck: async (wcId: number, path: string, overwrite: boolean) => {
          cx.log('slides.save', wcId, path, overwrite)
          if (spec.slides!.save?.throws !== undefined) throw new Error(spec.slides!.save.throws)
          return { path }
        },
      }
    }
    for (const name of ['markdown', 'html', 'mindmap', 'epub', 'diagram'] as const) {
      if (spec[name]) base[name] = fakeEditor(name, spec[name]!, cx)
    }
    if (spec.hwp) {
      base.hwp = {
        read: async (contents: Spec) => {
          cx.log('hwp.read', contents.id)
          return answer(spec.hwp!.read)
        },
      }
    }
    const control = openBridge.createOpenDocumentsControl(base as never)
    const tabOf = (step: Spec, key: string): Spec =>
      step.as ?? spec.tabs.find((t) => t.id === step[key]) ?? tab(step[key])
    const answers: unknown[] = []
    for (const step of spec.steps) {
      if (step.resolve) {
        const r = step.resolve
        answers.push(await settle(() => resolver(r.target, r.family, r.options)))
      } else if (step.list) answers.push(await settle(() => control.list()))
      else if (step.read !== undefined) {
        answers.push(await settle(() => control.read(tabOf(step, 'read') as never)))
      } else if (step.save !== undefined) {
        answers.push(await settle(() => control.save(tabOf(step, 'save') as never)))
      } else if (step.close !== undefined) {
        answers.push(
          await settle(() =>
            control.close(tabOf(step, 'close') as never, { unsaved: step.unsaved }),
          ),
        )
      }
    }
    return answers
  } finally {
    restore()
  }
}

const KINDS = [
  'docs',
  'sheets',
  'slides',
  'markdown',
  'html',
  'mindmap',
  'hwp',
  'epub',
  'diagram',
  'pdf',
  'home',
  'help',
]
const kindTabs = KINDS.map((kind) =>
  tab(`k-${kind}`, { kind, filePath: `/work/f.${kind}`, dirty: true }),
)
const EDITORS: Spec = { read: { value: 'text' }, save: { value: 1 }, discard: { value: 1 } }
const openCase = (spec: Partial<OpenWorld>, note: string, files?: Case['files']): Case => ({
  args: [
    {
      tabs: kindTabs,
      saveDir: '$DIR/save',
      contents: Object.fromEntries(kindTabs.map((t, i) => [t.id, { id: 100 + i }])),
      steps: [],
      ...spec,
    },
  ],
  ...(files ? { files } : {}),
  note,
})
const ALL: Partial<OpenWorld> = {
  docs: { run: { value: 'docs-answer' } },
  sheets: { run: { value: { rows: 1 } } },
  slides: { read: { value: { slides: [] } } },
  markdown: EDITORS,
  html: EDITORS,
  mindmap: EDITORS,
  hwp: { read: { value: 'hwp text' } },
  epub: EDITORS,
  diagram: EDITORS,
}
const SAVE_FILES = { 'save/Untitled-doc.docx': 'x' }

const openBridgeCases: Case[] = [
  // the target resolver
  openCase(
    {
      steps: [
        { resolve: { target: 'k-docs', family: 'docx' } },
        { resolve: { target: '/work/f.sheets', family: 'xlsx', options: {} } },
        { resolve: { target: 'k-slides', family: 'pptx', options: { focus: true } } },
        { resolve: { target: 'k-markdown', family: 'md', options: { focus: false } } },
      ],
    },
    'a target resolved by id and by path',
  ),
  openCase(
    {
      steps: [
        { resolve: { target: 'k-docs', family: 'xlsx' } },
        { resolve: { target: 'nope', family: 'docx' } },
      ],
    },
    'the wrong family, no such document',
  ),
  openCase(
    { tabs: [], steps: [{ resolve: { target: 'k-docs', family: 'docx' } }] },
    'nothing open',
  ),
  openCase(
    { contents: {}, steps: [{ resolve: { target: 'k-docs', family: 'docx' } }] },
    'no webContents',
  ),
  openCase(
    {
      contents: { 'k-docs': { id: 5, destroyed: true } },
      steps: [{ resolve: { target: 'k-docs', family: 'docx' } }],
    },
    'a destroyed webContents',
  ),
  openCase(
    {
      contents: { 'k-docs': { throws: 'recovery pending' } },
      steps: [{ resolve: { target: 'k-docs', family: 'docx' } }],
    },
    'a document waiting on its recovery answer',
  ),
  openCase(
    {
      lazy: true,
      steps: [{ resolve: { target: 'k-docs', family: 'docx', options: { focus: true } } }],
    },
    'contents that arrive late',
  ),
  openCase(
    {
      activate: 'ok',
      reveal: 'ok',
      tabs: [tab('a', { kind: 'docs' }), tab('b', { kind: 'docs', active: true })],
      contents: { a: { id: 1 }, b: { id: 2 } },
      steps: [
        { resolve: { target: 'a', family: 'docx', options: { focus: true } } },
        { resolve: { target: 'b', family: 'docx', options: { focus: true } } },
        { resolve: { target: 'a', family: 'docx', options: {} } },
        { resolve: { target: 'a', family: 'docx' } },
      ],
    },
    'focus shows a tab that is not active',
  ),
  openCase(
    {
      activate: 'throws',
      reveal: 'ok',
      tabs: [tab('a', { kind: 'docs' })],
      contents: { a: { id: 1 } },
      steps: [{ resolve: { target: 'a', family: 'docx', options: { focus: true } } }],
    },
    'activate fails: warned, the target is still answered',
  ),
  openCase(
    {
      activate: 'ok',
      reveal: 'throws',
      tabs: [tab('a', { kind: 'docs' })],
      contents: { a: { id: 1 } },
      steps: [{ resolve: { target: 'a', family: 'docx', options: { focus: true } } }],
    },
    'reveal fails: warned',
  ),
  openCase(
    {
      tabs: [tab('a', { kind: 'docs' })],
      contents: { a: { id: 1 } },
      steps: [{ resolve: { target: 'a', family: 'docx', options: { focus: true } } }],
    },
    'focus with no way to show the tab',
  ),
  // list and read
  openCase({ steps: [{ list: true }] }, 'the list'),
  openCase({ ...ALL, steps: KINDS.map((kind) => ({ read: `k-${kind}` })) }, 'every kind is read'),
  openCase({ steps: KINDS.map((kind) => ({ read: `k-${kind}` })) }, 'no editor wired: unavailable'),
  openCase(
    { ...ALL, steps: [{ read: 'k-docs', as: undefined }], contents: {} },
    'a read of a tab with no webContents',
  ),
  openCase(
    {
      ...ALL,
      docs: { run: { throws: 'docs gone' } },
      markdown: { read: { throws: 'md gone' } },
      steps: [{ read: 'k-docs' }, { read: 'k-markdown' }],
    },
    'a read fails',
  ),
  openCase(
    { ...ALL, docs: { run: { undef: true } }, steps: [{ read: 'k-docs' }] },
    'a read answers nothing',
  ),
  // save
  openCase(
    { ...ALL, steps: KINDS.map((kind) => ({ save: `k-${kind}` })) },
    'every kind is saved to its own file',
  ),
  openCase({ steps: KINDS.map((kind) => ({ save: `k-${kind}` })) }, 'no editor wired: unavailable'),
  openCase(
    {
      ...ALL,
      tabs: [tab('n1', { kind: 'docs', title: 'Untitled doc', filePath: undefined, dirty: true })],
      contents: { n1: { id: 1 } },
      steps: [{ save: 'n1' }],
    },
    'an unsaved document goes to a unique name in the default folder',
    SAVE_FILES,
  ),
  openCase(
    {
      ...ALL,
      tabs: [tab('n1', { kind: 'html', title: 'New page', filePath: undefined })],
      contents: { n1: { id: 1 } },
      steps: [{ save: 'n1' }],
    },
    'an unsaved page goes to the default folder',
  ),
  openCase(
    { ...ALL, steps: [{ save: 'gone', as: tab('gone') }] },
    'a snapshot of a document that is closed',
  ),
  openCase(
    { ...ALL, docs: { run: { throws: 'disk full' } }, steps: [{ save: 'k-docs' }] },
    'the save fails',
  ),
  openCase(
    {
      ...ALL,
      markdown: { ...EDITORS, save: { throws: 'md refuses' } },
      steps: [{ save: 'k-markdown' }],
    },
    'an editor save fails',
  ),
  openCase(
    {
      ...ALL,
      slides: { ...ALL.slides, save: { throws: 'deck refuses' } },
      steps: [{ save: 'k-slides' }],
    },
    'the deck save fails',
  ),
  openCase({ ...ALL, contents: {}, steps: [{ save: 'k-docs' }] }, 'a document with no webContents'),
  // close
  openCase(
    { ...ALL, steps: KINDS.map((kind) => ({ close: `k-${kind}`, unsaved: 'save' })) },
    'every kind is closed with a save',
  ),
  openCase(
    {
      ...ALL,
      tabs: kindTabs.map((t) => ({ ...t, dirty: false })),
      steps: KINDS.map((kind) => ({ close: `k-${kind}`, unsaved: 'save' })),
    },
    'clean documents are closed without a save',
  ),
  openCase(
    { ...ALL, steps: KINDS.map((kind) => ({ close: `k-${kind}`, unsaved: 'discard' })) },
    'every kind is closed with a discard, no hooks',
  ),
  openCase(
    {
      ...ALL,
      recoveryDiscard: 'ok',
      slidesDiscard: 'ok',
      steps: KINDS.map((kind) => ({ close: `k-${kind}`, unsaved: 'discard' })),
    },
    'every kind is closed with a discard, the hooks run',
  ),
  openCase(
    {
      recoveryDiscard: 'ok',
      slidesDiscard: 'ok',
      steps: KINDS.map((kind) => ({ close: `k-${kind}`, unsaved: 'discard' })),
    },
    'a discard with no markdown, html or slides wiring: the recovery hook',
  ),
  openCase(
    {
      recoveryDiscard: 'ok',
      steps: [
        { close: 'k-slides', unsaved: 'discard' },
        { close: 'k-docs', unsaved: 'discard' },
      ],
    },
    'slides without its hook falls to the recovery hook',
  ),
  openCase(
    {
      ...ALL,
      recoveryDiscard: 'ok',
      unloaded: ['k-docs'],
      steps: [
        { close: 'k-docs', unsaved: 'discard' },
        { close: 'k-sheets', unsaved: 'discard' },
      ],
    },
    'a tab that never loaded keeps its copy',
  ),
  openCase(
    {
      ...ALL,
      recoveryDiscard: 'throws',
      slidesDiscard: 'throws',
      steps: [
        { close: 'k-docs', unsaved: 'discard' },
        { close: 'k-slides', unsaved: 'discard' },
      ],
    },
    'a hook that throws fails the close',
  ),
  openCase(
    {
      ...ALL,
      markdown: { ...EDITORS, discard: { throws: 'assets locked' } },
      html: { ...EDITORS },
      contents: { 'k-html': { throws: 'recovery pending' } },
      steps: [
        { close: 'k-markdown', unsaved: 'discard' },
        { close: 'k-html', unsaved: 'discard' },
      ],
    },
    'a failed cleanup is warned, the tab closes',
  ),
  openCase(
    {
      ...ALL,
      closeFails: ['k-docs'],
      steps: [
        { close: 'k-docs', unsaved: 'save' },
        { close: 'k-sheets', unsaved: 'save' },
      ],
    },
    'a tab that cannot be closed',
  ),
  openCase(
    { ...ALL, steps: [{ close: 'gone', unsaved: 'save', as: tab('gone') }] },
    'a snapshot of a document that is already closed',
  ),
  openCase(
    {
      ...ALL,
      docs: { run: { throws: 'disk full' } },
      steps: [{ close: 'k-docs', unsaved: 'save' }],
    },
    'a save that fails keeps the tab',
  ),
  openCase(
    {
      ...ALL,
      tabs: [tab('n1', { kind: 'docs', title: 'Untitled doc', filePath: undefined, dirty: true })],
      contents: { n1: { id: 1 } },
      steps: [{ close: 'n1', unsaved: 'save' }],
    },
    'an unsaved document is saved into the default folder first',
    SAVE_FILES,
  ),
  openCase(
    {
      ...ALL,
      tabs: [tab('p1', { kind: 'pdf', dirty: true }), tab('p2', { kind: 'pdf' })],
      contents: { p1: { id: 1 }, p2: { id: 2 } },
      steps: [
        { close: 'p1', unsaved: 'save' },
        { close: 'p2', unsaved: 'save' },
        { close: 'p1', unsaved: 'discard' },
      ],
    },
    'a pdf cannot be save-closed when dirty',
  ),
]

// ---------------------------------------------------------------------------
// slides-bridge
// ---------------------------------------------------------------------------

interface SlidesWorld {
  wcs: Record<string, 'alive' | 'destroyed'>
  blank?: (number | { throws: string })[]
  abandon?: boolean
  steps: Spec[]
}

async function runSlidesBridge(spec: SlidesWorld, cx: TsContext): Promise<unknown> {
  const timers = fakeTimers(cx)
  const world = worldBox[WORLD] as Spec
  const sessions = world.sessions as Map<number, Spec>
  sessions.clear()
  let clock = 0
  const realNow = Date.now
  Date.now = () => clock
  world.applySessionTxn = (session: Spec, req: unknown) => {
    cx.log('applySessionTxn', session.wc, plain(req))
    return session.txn === undefined ? null : session.txn
  }
  world.saveSessionDeckTo = async (session: Spec, path: string) => {
    cx.log('saveSessionDeckTo', session.wc, path)
    if (session.saveThrows !== undefined) throw new Error(session.saveThrows)
  }
  world.attachedIds = (session: Spec) => session.attached ?? [session.wc]
  world.elementDurableId = (el: Spec) => el.durable ?? null
  world.slideDurableId = (slide: Spec) => {
    const m = /slide(\d+)\.xml$/.exec(slide.path)
    return m ? `s_${m[1]}` : `s_${slide.path.replace(/[^a-zA-Z0-9]/g, '_')}`
  }
  world.getSlideComments = (archive: Spec, path: string) => archive.comments?.[path] ?? []
  world.getSlideHidden = (slide: Spec) => slide.hidden === true
  const wcs = new Map<number, Spec>()
  for (const [id, state] of Object.entries(spec.wcs)) {
    const wc: Spec = {
      destroyed: state === 'destroyed',
      isDestroyed: () => wc.destroyed,
      send: (channel: string, payload: unknown) => cx.log('wc.send', Number(id), channel, payload),
    }
    wcs.set(Number(id), wc)
  }
  useElectron({ webContents: { fromId: (id: number) => wcs.get(id) } })
  try {
    const blank = [...(spec.blank ?? [])]
    const control = slidesBridge.createSlidesControl({
      openBlankTab: () => {
        const next = blank.shift() as number | { throws: string }
        if (typeof next === 'object') {
          cx.log('deps.openBlankTab', 'rejects')
          throw new Error(next.throws)
        }
        cx.log('deps.openBlankTab', next)
        return next
      },
      ...(spec.abandon
        ? { abandonBlankTab: (wcId: number) => cx.log('deps.abandonBlankTab', wcId) }
        : {}),
    })
    const outcomes: Record<string, unknown> = {}
    const answers: unknown[] = []
    for (const step of spec.steps) {
      if (step.open !== undefined) track(outcomes, step.open, control.openBlankTab())
      else if (step.session !== undefined) {
        if (step.gone) sessions.delete(step.session)
        else {
          sessions.set(step.session, {
            wc: step.session,
            opened: {
              deck: step.deck ?? { size: { cx: 0, cy: 0 }, slides: [] },
              archive: { comments: step.comments ?? {} },
            },
            ...(step.attached ? { attached: step.attached } : {}),
            ...(step.txn !== undefined ? { txn: step.txn } : {}),
            ...(step.saveThrows !== undefined ? { saveThrows: step.saveThrows } : {}),
          })
        }
      } else if (step.fire !== undefined) timers.fire(step.fire)
      else if (step.at !== undefined) clock = step.at
      else if (step.destroy !== undefined) wcs.get(step.destroy)!.destroyed = true
      else if (step.vanish !== undefined) wcs.delete(step.vanish)
      else if (step.txn !== undefined)
        answers.push(await settle(() => control.runTxn(step.txn, step.req)))
      else if (step.read !== undefined) {
        answers.push(await settle(() => control.readDeck(step.read, step.options)))
      } else if (step.withholds !== undefined) {
        answers.push(await settle(() => control.deckWithholds!(step.withholds)))
      } else if (step.save !== undefined) {
        answers.push(await settle(() => control.saveDeck(step.save, step.path, step.overwrite)))
      }
      await tick()
    }
    return { outcomes, answers }
  } finally {
    sessions.clear()
    Date.now = realNow
    timers.restore()
  }
}

const slidesBridgeCase = (
  spec: Partial<SlidesWorld>,
  note: string,
  files?: Case['files'],
): Case => ({
  args: [{ wcs: { '3': 'alive', '4': 'alive' }, steps: [], ...spec }],
  ...(files ? { files } : {}),
  note,
})

const para = (...runs: (string | [string, string])[]): Spec => ({
  runs: runs.map((r) => (typeof r === 'string' ? { text: r } : { text: r[0], redact: r[1] })),
})
const textEl = (extra: Spec = {}): Spec => ({
  id: 'raw1',
  type: 'text',
  transform: { offset: { x: 1, y: 2, cx: 3, cy: 4 } },
  text: { paragraphs: [para('Hello ', ['secret', 'name']), para('second')] },
  ...extra,
})
const cellOf = (...paragraphs: Spec[]): Spec => ({ text: { paragraphs } })
const DECK: Spec = {
  size: { cx: 12192000, cy: 6858000 },
  slides: [
    {
      path: 'ppt/slides/slide1.xml',
      elements: [
        textEl({ durable: 'e_aaaa' }),
        textEl({
          id: 'raw2',
          type: 'shape',
          redact: 'client',
          text: { paragraphs: [para('Acme Corp')] },
        }),
        textEl({ id: 'raw3', text: { paragraphs: [] } }),
        textEl({ id: 'raw4', text: undefined }),
        textEl({ id: 'raw5', transform: undefined }),
        textEl({ id: 'raw6', transform: { offset: null } }),
        textEl({ id: 'raw7', transform: { offset: { x: 5 } } }),
        textEl({ id: 'raw8', text: { paragraphs: [para('x'.repeat(300))] } }),
        textEl({ id: 'raw9', text: { paragraphs: [para('x'.repeat(301))] } }),
        textEl({ id: 'raw10', text: { paragraphs: [para('\u00e9\ud83d\ude00'.repeat(200))] } }),
        { id: 'pic1', type: 'picture', transform: { offset: { x: 0, y: 0, cx: 10, cy: 20 } } },
        {
          id: 'tbl1',
          type: 'table',
          transform: { offset: { x: 1, y: 1, cx: 1, cy: 1 } },
          rows: [
            [cellOf(para('a')), cellOf(para('b', ['c', 'amount']))],
            [cellOf(para('d'), para('e')), { text: undefined }],
            [cellOf(para('f'))],
          ],
        },
        {
          id: 'tbl2',
          type: 'table',
          redact: 'whole',
          rows: [
            [cellOf(para('1'))],
            [cellOf(para('2'))],
            [cellOf(para('3'))],
            [cellOf(para('4'))],
            [cellOf(para('5'))],
          ],
        },
        { id: 'tbl3', type: 'table', rows: [] },
        {
          id: 'grp1',
          type: 'group',
          durable: 'e_group',
          transform: { offset: { x: 9, y: 9, cx: 90, cy: 90 } },
          children: [
            textEl({ id: 'c1' }),
            {
              id: 'g2',
              type: 'group',
              transform: { offset: { x: 1, y: 1, cx: 5, cy: 5 } },
              children: [textEl({ id: 'c2', durable: 'e_deep' })],
            },
          ],
        },
        { id: 'odd1', type: 'chart' },
        { type: 'text', text: { paragraphs: [para('no id')] } },
      ],
    },
    {
      path: 'ppt/slides/slide12.xml',
      hidden: true,
      elements: [],
    },
    {
      path: 'ppt/weird path/s.xml',
      elements: [textEl({ id: 'w1' })],
    },
  ],
}
const COMMENTS = {
  'ppt/slides/slide12.xml': [
    { authorId: 0, idx: 1, author: 'Ann', dt: '2025-01-01', text: 'looks good', extra: 'dropped' },
    { authorId: 1, idx: 2, author: '   ', dt: '2025-01-02', text: 'who?' },
    { authorId: 2, idx: 3, dt: null, text: '' },
  ],
}
const WITHHOLDING_DECK: Spec = {
  size: { cx: 9144000, cy: 5143500 },
  slides: [
    { path: 'ppt/slides/slide1.xml', elements: [textEl({ text: { paragraphs: [para('a')] } })] },
  ],
}

const slidesBridgeCases: Case[] = [
  slidesBridgeCase(
    { blank: [3], steps: [{ session: 3 }, { open: 'o' }] },
    'a session that is already there',
  ),
  slidesBridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { session: 3 }, { fire: 1 }] },
    'the session appears after a poll',
  ),
  slidesBridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { fire: 1 }, { fire: 2 }, { session: 3 }, { fire: 3 }] },
    'the session appears after two polls',
  ),
  slidesBridgeCase(
    { blank: [3], abandon: true, steps: [{ open: 'o' }, { destroy: 3 }, { fire: 1 }] },
    'the tab is closed while it is awaited',
  ),
  slidesBridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { destroy: 3 }, { fire: 1 }] },
    'the tab is closed while it is awaited (no dep)',
  ),
  slidesBridgeCase(
    { blank: [3], abandon: true, steps: [{ open: 'o' }, { vanish: 3 }, { fire: 1 }] },
    'the webContents vanished',
  ),
  slidesBridgeCase(
    {
      blank: [3],
      abandon: true,
      steps: [{ open: 'o' }, { at: 20000 }, { fire: 1 }, { at: 20001 }, { fire: 2 }],
    },
    'the deadline is passed, not reached',
  ),
  slidesBridgeCase(
    {
      blank: [3],
      abandon: true,
      steps: [{ at: 5 }, { open: 'o' }, { at: 20005 }, { fire: 1 }, { at: 20006 }, { fire: 2 }],
    },
    'the deadline counts from the open',
  ),
  slidesBridgeCase(
    {
      blank: [3],
      abandon: true,
      steps: [{ open: 'o' }, { at: 30000 }, { session: 3 }, { fire: 1 }],
    },
    'a session that appears late is still found',
  ),
  slidesBridgeCase(
    { blank: [9], abandon: true, steps: [{ open: 'o' }] },
    'the blank tab is not a webContents',
  ),
  slidesBridgeCase(
    {
      blank: [3, { throws: 'no tab' }],
      abandon: true,
      steps: [{ open: 'a' }, { open: 'b' }, { session: 3 }, { fire: 1 }],
    },
    'the dep rejects: nothing to abandon',
  ),
  slidesBridgeCase(
    {
      blank: [3, 4],
      steps: [
        { open: 'a' },
        { open: 'b' },
        { fire: 2 },
        { session: 4 },
        { fire: 3 },
        { session: 3 },
        { fire: 1 },
      ],
    },
    'two opens at once; timers fired out of order',
  ),
  slidesBridgeCase({ steps: [{ fire: 5 }] }, 'a timer nobody armed'),
  // run_txn
  slidesBridgeCase({ steps: [{ txn: 3, req: { ops: [] } }] }, 'a transaction with no session'),
  slidesBridgeCase(
    { steps: [{ session: 3 }, { txn: 3, req: { ops: [1], isolation: 'per_op', dryRun: true } }] },
    'the session is gone while it applies',
  ),
  slidesBridgeCase(
    {
      steps: [
        {
          session: 3,
          deck: DECK,
          txn: { applied: true, slides: [{ id: 'r' }], results: [{ ok: 1 }], journal: 7 },
        },
        { txn: 3, req: { ops: [{ op: 'setText' }] } },
      ],
    },
    'applied: the tab is pushed the render, the outcome has no render tree',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, attached: [3, 4], txn: { applied: true, slides: [{ id: 'r' }] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'two windows attached: the scheduled broadcast does it',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, attached: [], txn: { applied: true, slides: [{ id: 'r' }] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'no window attached',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, attached: [99], txn: { applied: true, slides: [{ id: 'r' }] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'the attached window is no webContents',
  ),
  slidesBridgeCase(
    {
      wcs: { '3': 'alive', '4': 'alive', '5': 'alive' },
      steps: [
        { session: 3, deck: DECK, attached: [4], txn: { applied: true, slides: [] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'an empty render list is still a list',
  ),
  slidesBridgeCase(
    {
      steps: [
        {
          session: 3,
          deck: DECK,
          txn: { applied: false, slides: [{ id: 'r' }], failures: [{ index: 0, error: 'bad' }] },
        },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'a rejected transaction pushes nothing',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, txn: { applied: true } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'applied with no render tree',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, txn: { applied: true, slides: 0, plan: [1] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'applied with a falsy render tree',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, txn: { slides: [1], applied: 1, a: 1 } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'a truthy applied pushes; the key order of the outcome is kept',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, txn: 'text' },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'an outcome that is a string',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: { slides: [] }, txn: { applied: true, slides: [1] } },
        { txn: 3, req: { ops: [] } },
      ],
    },
    'a deck with no size: the push has none',
  ),
  // read_deck
  slidesBridgeCase(
    {
      steps: [
        { read: 3 },
        { session: 3, deck: DECK, comments: COMMENTS },
        { read: 3 },
        { read: 3, options: { withhold: false } },
        { read: 3, options: { withhold: true } },
        { read: 3, options: { withhold: 'yes' } },
        { read: 3, options: {} },
      ],
    },
    'the model readout, with and without withholding',
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: { size: { cx: 9525 * 10.5, cy: 9525 * 7.4999 }, slides: [] } },
        { read: 3 },
        { session: 3, deck: { size: { cx: -9525 * 10.5, cy: 1 }, slides: [] } },
        { read: 3 },
        { session: 3, deck: { slides: [] } },
        { read: 3 },
      ],
    },
    'the size in pixels is rounded',
  ),
  // deck_withholds
  slidesBridgeCase(
    {
      steps: [
        { withholds: 3 },
        { session: 3, deck: DECK },
        { withholds: 3 },
        { session: 3, deck: WITHHOLDING_DECK },
        { withholds: 3 },
        { session: 3, deck: { size: {}, slides: [] } },
        { withholds: 3 },
      ],
    },
    'a deck that carries a withholding mark',
  ),
  // save_deck
  slidesBridgeCase(
    {
      steps: [
        { save: 3, path: '$DIR/new.pptx', overwrite: false },
        { session: 3, deck: DECK },
        { save: 3, path: '$DIR/new.pptx', overwrite: false },
        { save: 3, path: '$DIR/new', overwrite: false },
        { save: 3, path: '$DIR/NEW.PPTX', overwrite: false },
        { save: 3, path: '$DIR/new.ppt', overwrite: false },
        { save: 3, path: '$DIR/new.', overwrite: false },
        { save: 3, path: 'rel/new.pptx', overwrite: false },
        { save: 3, path: '$DIR/dir.d/new', overwrite: false },
        { save: 3, path: '$DIR/.pptx', overwrite: false },
      ],
    },
    'the path rules',
    { 'dir.d/keep': 'x' },
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK },
        { save: 3, path: '$DIR/old.pptx', overwrite: false },
        { save: 3, path: '$DIR/old', overwrite: false },
        { save: 3, path: '$DIR/old.pptx', overwrite: true },
        { save: 3, path: '$DIR/OLD2.PPTX', overwrite: false },
        { save: 3, path: '$DIR/OLD2.PPTX', overwrite: true },
      ],
    },
    'an existing file is refused without overwrite',
    { 'old.pptx': 'x', 'OLD2.PPTX': 'x' },
  ),
  slidesBridgeCase(
    {
      steps: [
        { save: 4, path: '$DIR/old.pptx', overwrite: false },
        { save: 4, path: '$DIR/fresh.pptx', overwrite: false },
      ],
    },
    'the file check comes before the session check',
    { 'old.pptx': 'x' },
  ),
  slidesBridgeCase(
    {
      steps: [
        { session: 3, deck: DECK, saveThrows: 'disk full' },
        { save: 3, path: '$DIR/new.pptx', overwrite: false },
      ],
    },
    'the save fails',
  ),
]

/** the elements `elementWithholds` is asked about */
const withholdCases: Case[] = cases(
  [{ type: 'text', text: { paragraphs: [para('a')] } }],
  [{ type: 'text', text: { paragraphs: [para('a', ['b', 'x'])] } }],
  [{ type: 'text', redact: 'whole', text: { paragraphs: [] } }],
  [{ type: 'text', redact: '' }],
  [{ type: 'shape', text: { paragraphs: [para(['b', 'x'])] } }],
  [{ type: 'shape' }],
  [{ type: 'text', text: { paragraphs: [{ runs: [] }, para('a', ['', ''])] } }],
  [{ type: 'picture', text: { paragraphs: [para(['b', 'x'])] } }],
  [{ type: 'picture', redact: true }],
  [{ type: 'table', rows: [[cellOf(para('a')), cellOf(para('b'))], [cellOf(para('c'))]] }],
  [{ type: 'table', rows: [[cellOf(para('a')), cellOf(para(['b', 'x']))]] }],
  [{ type: 'table', rows: [[{}]] }],
  [{ type: 'table', rows: [], redact: 'r' }],
  [{ type: 'group', children: [{ type: 'text', text: { paragraphs: [para('a')] } }] }],
  [{ type: 'group', children: [{ type: 'group', children: [{ type: 'text', redact: 'deep' }] }] }],
  [{ type: 'group', children: [] }],
  [{ type: 'group', redact: 'g', children: [] }],
  [{}],
  [{ type: 'chart' }],
)

// ---------------------------------------------------------------------------
// app-mcp
// ---------------------------------------------------------------------------

let appSerial = 0

/** what the settings pane reads: each line without its time stamp */
const untimed = (lines: string[]): string[] => lines.map((line) => line.replace(/^\[[^\]]*\] /, ''))

/** the app scenario under the case's clock, in UTC (the log lines carry a time stamp) */
async function runApp(spec: { steps: Spec[] }, cx: TsContext): Promise<unknown> {
  const RealDate = Date
  const realZone = process.env.TZ
  process.env.TZ = 'UTC'
  globalThis.Date = class extends RealDate {
    constructor(...given: unknown[]) {
      super(...((given.length === 0 ? [cx.now] : given) as [number]))
    }
  } as never
  try {
    return await runAppScript(spec, cx)
  } finally {
    globalThis.Date = RealDate
    if (realZone === undefined) delete process.env.TZ
    else process.env.TZ = realZone
  }
}

async function runAppScript(spec: { steps: Spec[] }, cx: TsContext): Promise<unknown> {
  appSerial += 1
  const services: Spec[] = []
  class FakeService {
    options: Spec
    port: number
    running = false
    constructor(options: Spec) {
      this.options = options
      this.port = options.port
      cx.log('new service')
      services.push(this)
    }
    isRunning(): boolean {
      return this.running
    }
    getUrl(): string {
      return `http://127.0.0.1:${this.port}`
    }
    async start(port = this.port): Promise<void> {
      if (this.running) return
      this.port = port
      this.running = true
      cx.log('listen', port)
      this.options.logger(`[mcp] listening on ${this.getUrl()} (streamable /mcp, legacy /sse)`)
    }
    async stop(): Promise<void> {
      if (!this.running) return
      this.running = false
      cx.log('close')
      this.options.logger('[mcp] stopped')
    }
    stopSync(): void {
      void this.stop()
    }
  }
  worldBox[SERVICE] = FakeService
  const app = await import(`../../../../apps/shell/src/main/mcp/app-mcp.ts?case=${appSerial}`)
  const outcomes: Record<string, unknown> = {}
  const answers: unknown[] = []
  const latest = (): Spec | undefined => services[services.length - 1]
  for (const step of spec.steps) {
    if (step.configure) {
      const c = step.configure as Spec
      const control = (family: string, extra: Spec = {}): Spec => ({ family, ...extra })
      app.configureMcpRuntime({
        version: c.version ?? '1.2.3',
        defaultSaveDir: () => c.saveDir ?? '/save',
        openPath: (path: string) => {
          cx.log('openPath', path)
          return c.openPath !== false
        },
        ...(c.docs ? { docsControl: control('docs') } : {}),
        ...(c.slides ? { slidesControl: control('slides') } : {}),
        ...(c.sheets ? { sheetsControl: control('sheets') } : {}),
        ...(c.cli
          ? { cliRunner: { run: async () => ({ ok: false, code: 1, stdout: '', stderr: '' }) } }
          : {}),
        ...(c.openDocs ? { openDocumentsControl: { list: async () => [] } } : {}),
        ...(c.resolve ? { resolveTarget: async () => 1 } : {}),
        ...(c.diagram ? { diagramControl: { list: async () => [] } } : {}),
        ...(c.logFile !== undefined && c.logFile !== null ? { logFilePath: c.logFile } : {}),
      })
    } else if (step.start !== undefined) {
      track(
        outcomes,
        step.label,
        app.startMcpFromSettings(step.start === 'undefined' ? undefined : step.start),
      )
    } else if (step.apply !== undefined) {
      track(
        outcomes,
        step.label,
        app.applyMcpSettings(step.apply === 'undefined' ? undefined : step.apply),
      )
    } else if (step.stop) track(outcomes, step.stop, app.stopMcp())
    else if (step.stopSync) app.stopMcpSync()
    else if (step.status) answers.push(app.mcpStatus())
    else if (step.tools) {
      const service = latest()
      answers.push(service ? service.options.toolsFactory().map((t: Spec) => t.name) : 'no service')
    } else if (step.call) {
      const service = latest()
      if (!service) answers.push('no service')
      else
        answers.push(
          await settle(() => callTool(service.options.toolsFactory(), step.call, step.args)),
        )
    } else if (step.log !== undefined) {
      const service = latest()
      if (service) service.options.logger(step.log)
    } else if (step.logs) answers.push(untimed(app.getMcpRecentLogs()))
    else if (step.clearLogs) app.clearMcpLogs()
    else if (step.reveal) app.revealMcpLogFile()
    else if (step.logPath) answers.push(app.mcpLogFilePath())
    else if (step.deps)
      answers.push(
        app.currentMcpRuntimeDeps() === null ? null : app.currentMcpRuntimeDeps().version,
      )
    else {
      throw new Error(`unknown step ${JSON.stringify(step)}`)
    }
    await tick()
  }
  return { outcomes, answers }
}

const CONFIG = {
  docs: true,
  slides: true,
  sheets: true,
  cli: true,
  openDocs: true,
  resolve: true,
  diagram: true,
  logFile: '$DIR/mcp.log',
}
const appCase = (steps: Spec[], note: string): Case => ({ args: [{ steps }], note })
const on = (extra: Spec = {}): Spec => ({
  enabled: true,
  port: 4001,
  background: false,
  logging: false,
  ...extra,
})

const appCases: Case[] = [
  appCase(
    [
      { status: true },
      { stop: 's' },
      { stopSync: true },
      { logPath: true },
      { deps: true },
      { logs: true },
    ],
    'nothing configured',
  ),
  appCase(
    [{ configure: CONFIG }, { status: true }, { logPath: true }, { deps: true }],
    'configured, never started',
  ),
  appCase(
    [{ configure: { ...CONFIG, slides: false, sheets: false } }, { status: true }],
    'the capabilities of a build without slides and sheets',
  ),
  appCase(
    [{ configure: { ...CONFIG, slides: false } }, { status: true }],
    'a build without slides',
  ),
  appCase(
    [{ configure: { ...CONFIG, sheets: false } }, { status: true }],
    'a build without sheets',
  ),
  appCase(
    [{ configure: CONFIG }, { start: on(), label: 's' }, { status: true }],
    'start from settings that enable it',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: { enabled: false, port: 4001 }, label: 's' },
      { status: true },
    ],
    'start from settings that disable it',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ port: 0 }), label: 'a' },
      { status: true },
      { stop: 'x' },
      { start: on({ port: 70000 }), label: 'b' },
      { status: true },
    ],
    'a port out of range is the default',
  ),
  appCase(
    [{ configure: CONFIG }, { start: on({ port: 4001.5 }), label: 'a' }, { status: true }],
    'a port that is no integer',
  ),
  appCase(
    [{ configure: CONFIG }, { start: on({ port: '4001' }), label: 'a' }, { status: true }],
    'a port that is a string',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: { enabled: 'yes', port: 4001, background: 1, logging: 'true' }, label: 'a' },
      { status: true },
    ],
    'flags must be true themselves',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ port: 65535 }), label: 'a' },
      { status: true },
      { stop: 'x' },
      { status: true },
    ],
    'the largest port, then a stop',
  ),
  appCase(
    [{ configure: CONFIG }, { start: 'undefined', label: 'a' }, { status: true }],
    'settings that are undefined',
  ),
  appCase(
    [{ configure: CONFIG }, { start: null, label: 'a' }, { status: true }],
    'settings that are null',
  ),
  appCase(
    [{ configure: CONFIG }, { start: 5, label: 'a' }, { status: true }],
    'settings that are a number',
  ),
  appCase(
    [{ start: on(), label: 'a' }, { status: true }],
    'start before the runtime is configured',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on(), label: 'a' },
      { start: on(), label: 'b' },
      { status: true },
    ],
    'a start twice is one listener',
  ),
  appCase(
    [{ configure: CONFIG }, { apply: on(), label: 'a' }, { status: true }],
    'apply starts a server that is not running',
  ),
  appCase(
    [{ configure: CONFIG }, { apply: on({ enabled: false }), label: 'a' }, { status: true }],
    'apply with the server off and no service',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on(), label: 'a' },
      { apply: on({ enabled: false }), label: 'b' },
      { status: true },
    ],
    'apply stops a running server',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on(), label: 'a' },
      { apply: on(), label: 'b' },
      { status: true },
    ],
    'apply with nothing changed',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on(), label: 'a' },
      { apply: on({ port: 4002 }), label: 'b' },
      { status: true },
      { tools: true },
    ],
    'a port change restarts with a fresh service',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on(), label: 'a' },
      { tools: true },
      { apply: on({ background: true }), label: 'b' },
      { status: true },
      { tools: true },
    ],
    'a background flip restarts and changes the tool list',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on({ logging: false }), label: 'a' },
      { apply: on({ logging: true }), label: 'b' },
      { status: true },
    ],
    'a logging flip is no restart',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on({ enabled: false, port: 4005 }), label: 'a' },
      { apply: on({ port: 4005 }), label: 'b' },
      { status: true },
    ],
    'the port of settings that disable it is remembered',
  ),
  appCase(
    [
      { configure: CONFIG },
      { apply: on(), label: 'a' },
      { apply: on({ enabled: false }), label: 'b' },
      { apply: on({ port: 4009 }), label: 'c' },
      { status: true },
    ],
    'a server stopped and started again keeps its service',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ enabled: false }), label: 'a' },
      { apply: on({ enabled: false }), label: 'b' },
      { status: true },
    ],
    'two settings that disable it',
  ),
  appCase(
    [{ configure: CONFIG }, { apply: null, label: 'a' }, { status: true }],
    'apply with null settings',
  ),
  appCase(
    [{ configure: CONFIG }, { apply: 'undefined', label: 'a' }, { status: true }],
    'apply with no settings',
  ),
  appCase(
    [{ apply: on(), label: 'a' }, { status: true }],
    'apply before the runtime is configured',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on(), label: 'a' },
      { stopSync: true },
      { status: true },
      { stop: 'b' },
    ],
    'a synchronous stop',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on(), label: 'a' },
      { stop: 'b' },
      { stop: 'c' },
      { status: true },
    ],
    'a stop twice',
  ),
  appCase([{ configure: CONFIG }, { stop: 'a' }, { stopSync: true }], 'a stop with no service'),
  // the tool set
  appCase(
    [{ configure: CONFIG }, { start: on(), label: 'a' }, { tools: true }],
    'the tool set of a full build',
  ),
  appCase(
    [{ configure: CONFIG }, { start: on({ background: true }), label: 'a' }, { tools: true }],
    'the tool set with background generation',
  ),
  appCase(
    [
      { configure: { version: '0.0.1' } },
      { start: on({ background: true }), label: 'a' },
      { tools: true },
      { call: 'get_app_info' },
    ],
    'the tool set of a headless build',
  ),
  appCase(
    [
      { configure: { ...CONFIG, saveDir: '/x/y' } },
      { start: on(), label: 'a' },
      { call: 'get_app_info' },
    ],
    'get_app_info lists the formats of the families wired',
  ),
  appCase(
    [
      { configure: { ...CONFIG, slides: false } },
      { start: on({ background: true }), label: 'a' },
      { call: 'get_app_info' },
    ],
    'get_app_info without slides',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on(), label: 'a' },
      { call: 'open_in_seuoffice', args: { path: '/work/a.docx' } },
    ],
    'a file that routes to a tab',
  ),
  appCase(
    [
      { configure: { ...CONFIG, openPath: false } },
      { start: on(), label: 'a' },
      { call: 'open_in_seuoffice', args: { path: '/work/a.docx' } },
    ],
    'a file that cannot be routed',
  ),
  appCase(
    [
      { configure: { ...CONFIG, docs: false, slides: false, sheets: false } },
      { start: on(), label: 'a' },
      { tools: true },
      { call: 'create_session', args: { family: 'docx' } },
    ],
    'no session tools without a family',
  ),
  appCase(
    [
      { configure: { ...CONFIG, diagram: false, openDocs: false } },
      { start: on(), label: 'a' },
      { call: 'read_diagram' },
      { call: 'open_documents', args: { action: 'list' } },
    ],
    'the diagram and open-document tools without their controls',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on(), label: 'a' },
      { call: 'open_documents', args: { action: 'list' } },
      { call: 'read_diagram' },
    ],
    'the open-document and diagram controls are passed on',
  ),
  appCase(
    [
      { configure: CONFIG },
      { configure: { ...CONFIG, slides: false, version: '2.0.0' } },
      { deps: true },
      { status: true },
    ],
    'a runtime configured twice',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ background: true }), label: 'a' },
      { configure: { ...CONFIG, slides: false } },
      { tools: true },
      { status: true },
    ],
    'the tools factory reads the deps of the moment',
  ),
  // the logger
  appCase(
    [
      { configure: CONFIG },
      { start: on({ logging: true }), label: 'a' },
      { log: 'first' },
      { log: 'second' },
      { logs: true },
      { clearLogs: true },
      { logs: true },
    ],
    'logging on: the lines are kept, then cleared',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ logging: false }), label: 'a' },
      { log: 'dropped' },
      { logs: true },
    ],
    'logging off: no lines',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ logging: true }), label: 'a' },
      { log: 'kept' },
      { apply: on({ logging: false }), label: 'b' },
      { log: 'dropped' },
      { logs: true },
    ],
    'logging turned off',
  ),
  appCase(
    [
      { configure: { ...CONFIG, logFile: undefined } },
      { start: on({ logging: true }), label: 'a' },
      { log: 'x' },
      { logs: true },
      { clearLogs: true },
      { reveal: true },
      { logPath: true },
    ],
    'logging on with no log file',
  ),
  appCase(
    [
      { configure: { ...CONFIG, logFile: '' } },
      { start: on({ logging: true }), label: 'a' },
      { log: 'x' },
      { logs: true },
      { logPath: true },
    ],
    'an empty log file path',
  ),
  appCase(
    [
      { configure: CONFIG },
      { start: on({ logging: true }), label: 'a' },
      { log: 'x' },
      { reveal: true },
      { clearLogs: true },
      { reveal: true },
      { logs: true },
    ],
    'reveal keeps what is there',
  ),
]

// ---------------------------------------------------------------------------

export const group: Group = {
  'pptx-outline.MAX_OUTLINE_SLIDES': constant(pptxOutline.MAX_OUTLINE_SLIDES, 'a constant'),
  'pptx-outline.parsePptxOutline': {
    ts: (a) => pptxOutline.parsePptxOutline(a[0] as never, a[1] as string),
    cases: outlineCases,
  },
  'pptx-outline.outlineToOps': {
    ts: (a) => pptxOutline.outlineToOps(a[0] as never),
    cases: opsCases,
  },

  'slides-tools.slidesDriver': {
    ts: (a, cx) => driverCall((c) => slidesTools.slidesDriver(c) as Spec, 'slides', a, cx),
    cases: slidesDriverCases,
  },

  'slides-tools.tools': {
    ts: (a, cx) => toolsList(slidesTools.createSlidesTools as Factory, a[0] as Spec, cx),
    cases: slidesToolsCases,
  },
  'slides-tools.call': {
    ts: (a, cx) => toolCall(slidesTools.createSlidesTools as Factory, a[0] as ToolCall, cx),
    cases: slidesCases,
  },
  'sheets-tools.sheetsDriver': {
    ts: (a, cx) => driverCall((c) => sheetsTools.sheetsDriver(c) as Spec, 'sheets', a, cx),
    cases: sheetsDriverCases,
  },
  'sheets-tools.tools': {
    ts: (a, cx) => toolsList(sheetsTools.createSheetsTools as Factory, a[0] as Spec, cx),
    cases: slidesToolsCases.map((c) => ({
      ...c,
      args: [
        { ...(c.args[0] as Spec), control: (c.args[0] as Spec).control ? 'sheets' : undefined },
      ],
    })),
  },
  'sheets-tools.call': {
    ts: (a, cx) => toolCall(sheetsTools.createSheetsTools as Factory, a[0] as ToolCall, cx),
    cases: sheetsCases,
  },

  'diagram-tools.DIAGRAM_MCP_TOOL_NAMES': constant(
    diagramTools.DIAGRAM_MCP_TOOL_NAMES,
    'a constant',
  ),
  'diagram-tools.diagramOpItemSchema': {
    ts: async (a) =>
      listed([
        {
          name: 'item',
          description: 'one op',
          inputSchema: {
            item: diagramTools.diagramOpItemSchema(
              a[0] === null ? undefined : (diagramSchemaOps(a[0] as Spec[]) as never),
            ),
          },
        },
      ]),
    cases: schemaCases,
  },
  'diagram-tools.frontDiagram': {
    ts: (a) => {
      const detached = a[1] as string[] | null
      return (
        diagramTools.frontDiagram(
          a[0] as never,
          detached ? (id) => detached.includes(id) : undefined,
        ) ?? null
      )
    },
    cases: frontCases,
  },
  'diagram-tools.tools': {
    ts: async (_a, cx) =>
      listed(diagramTools.createDiagramTools({ control: fakeDiagram({}, cx) as never }) as Spec[]),
    cases: [{ args: [{}] }],
    single: 'the tools do not depend on any option',
  },
  'diagram-tools.call': {
    ts: (a, cx) => diagramCall(a[0] as DiagramCall, cx),
    cases: diagramCases,
  },

  'sheets-bridge.scenario': {
    ts: (a, cx) => runSheetsBridge(a[0] as BridgeScenario, cx),
    cases: sheetsBridgeCases,
  },
  'diagram-bridge.scenario': {
    ts: (a, cx) => runDiagramBridge(a[0] as DiagramBridgeWorld, cx),
    cases: diagramBridgeCases,
  },
  'open-documents-bridge.scenario': {
    ts: (a, cx) => runOpenBridge(a[0] as OpenWorld, cx),
    cases: openBridgeCases,
  },
  'slides-bridge.elementWithholds': {
    ts: (a) => slidesBridge.elementWithholds(a[0] as never),
    cases: withholdCases,
  },
  'slides-bridge.scenario': {
    ts: (a, cx) => runSlidesBridge(a[0] as SlidesWorld, cx),
    cases: slidesBridgeCases,
  },
  'app-mcp.scenario': { ts: (a, cx) => runApp(a[0] as { steps: Spec[] }, cx), cases: appCases },
}
