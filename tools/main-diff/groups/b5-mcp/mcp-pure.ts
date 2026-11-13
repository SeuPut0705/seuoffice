/**
 * Group `b5-mcp`, slice `mcp-pure` (Rust: crates/main-core/src/calls/b5_mcp/mcp_pure.rs):
 * cli-runner, headless-cli, mcp-logger and docs-bridge of apps/shell/src/main/mcp.
 *
 * - cli-runner: `cliErrorMessage` is called on an outcome. `createCliRunner`
 *   runs as a scenario: `node:child_process` is replaced (for cli-runner.ts
 *   alone) by a fake child whose steps are the case's (`out`, `outHex`,
 *   `outFill`, `err`, `errHex`, `errFill`, `timer`, `error`, `close`), and the
 *   global timers by ones that log `setTimeout <ms>` / `clearTimeout <id>`.
 *   Long output is answered as its length and ends.
 * - headless-cli: each function runs over a runner that logs its argv (the
 *   scratch folder as `<tmp>`), what the staged files held and answers the
 *   case's outcome; the last log line says whether the scratch folder is gone.
 * - mcp-logger: the clock is the case's (`new Date()` is replaced by a date
 *   that reads it) and so is the zone (`TZ`, with the offset the Rust side is
 *   told). Steps: `at`, `append`, `recent`, `clear`, `ensure`, `write`,
 *   `writeLines`, `remove`.
 * - docs-bridge: every case loads its own copy of the module (`?case=`), as
 *   it keeps its state at module level. `ipcMain`, `webContents` and the timers
 *   are fakes whose calls are log lines; the steps are `install`, `open`,
 *   `run`, `ready`, `result`, `destroy`, `vanish` and `fire`. A promise's outcome
 *   is recorded under the label of the step that made it, so the order two
 *   promises settle in does not show.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname } from 'node:path'
import { useElectron } from '../../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'

// the child process of cli-runner.ts alone is the case's
const SPAWN_BOX = Symbol.for('main-diff.cli-spawn')
const SPAWN_URL = 'main-diff:cli-child-process'
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'node:child_process' &&
      context.parentURL?.endsWith('/apps/shell/src/main/mcp/cli-runner.ts')
    ) {
      return { url: SPAWN_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url !== SPAWN_URL) return next(url, context)
    const source = `export const spawn = (...args) => globalThis[Symbol.for('main-diff.cli-spawn')](...args)`
    return { format: 'module', source, shortCircuit: true }
  },
})

const cliRunner = await import('../../../../apps/shell/src/main/mcp/cli-runner.ts')
const headless = await import('../../../../apps/shell/src/main/mcp/headless-cli.ts')
const mcpLogger = await import('../../../../apps/shell/src/main/mcp/mcp-logger.ts')

// any: the cases describe fakes and answers of every shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Spec = Record<string, Any>

const realImmediate = globalThis.setImmediate
/** lets every promise chain that can finish without the outside world finish */
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => realImmediate(resolve))
}

/** a number the JSON cannot carry: the strings `NaN`, `Infinity`, `-Infinity` */
function num(value: unknown): number {
  if (value === 'NaN') return NaN
  if (value === 'Infinity') return Infinity
  if (value === '-Infinity') return -Infinity
  return value as number
}

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

// ---------------------------------------------------------------------------
// cli-runner
// ---------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value)
const okJson = (extra: Record<string, unknown> = {}): string =>
  json({ status: 'ok', command: 'x', summary: 'done', ...extra })
const errJson = (extra: Record<string, unknown> = {}): string =>
  json({ status: 'error', command: 'x', code: 2, message: 'it failed', ...extra })

const outcome = (spec: Spec = {}): Spec => ({
  ok: false,
  code: 1,
  stdout: '',
  stderr: '',
  ...spec,
})

const errorMessageCases: Case[] = [
  [outcome({ json: JSON.parse(errJson()) })],
  [outcome({ json: JSON.parse(errJson({ message: undefined })), stderr: 'ignored' })],
  [outcome({ json: { status: 'error', message: 42 } })],
  [outcome({ json: { status: 'error', message: { a: 1 } } })],
  [outcome({ json: { status: 'error', message: '' }, stderr: 'ignored' })],
  [outcome({ json: JSON.parse(okJson()), stderr: '  boom  \n', stdout: 'out' })],
  [outcome({ stderr: '', stdout: '  only stdout \n' })],
  [outcome({ stderr: ' \n ', stdout: '\t', code: 3 })],
  [outcome({ code: -1 })],
  [outcome({ code: 137, json: { status: 'weird' } })],
].map((args) => ({ args }))

const outHex = (text: string): string => Buffer.from(text).toString('hex')

interface RunScenario {
  paths: { executable: string; entry: string; env?: [string, string | null][] }
  args: string[]
  options?: Spec
  steps: Spec[]
}

const summarize = (out: Spec): Spec => {
  const clip = (text: string): unknown =>
    text.length > 300
      ? { length: text.length, head: text.slice(0, 40), tail: text.slice(-40) }
      : text
  return {
    ok: out.ok,
    code: out.code,
    json: out.json,
    stdout: clip(out.stdout),
    stderr: clip(out.stderr),
  }
}

async function runCli(spec: RunScenario, cx: TsContext): Promise<unknown> {
  const timers = fakeTimers(cx)
  const box = globalThis as Record<symbol, unknown>
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      end: (...given: unknown[]) => cx.log('stdin.end', ...given),
    },
    kill: () => cx.log('kill'),
  })
  box[SPAWN_BOX] = (executable: string, argv: string[], options: Spec) => {
    const keys = ['ELECTRON_RUN_AS_NODE', ...(spec.paths.env ?? []).map(([key]) => key)]
    const env: Spec = {}
    for (const key of keys) env[key] = options.env[key]
    cx.log('spawn', executable, argv, env, options.windowsHide)
    return child
  }
  let settled: Spec | undefined
  try {
    const paths: Spec = { executable: spec.paths.executable, entry: spec.paths.entry }
    if (spec.paths.env) {
      paths.env = Object.fromEntries(
        spec.paths.env.map(([key, value]) => [key, value ?? undefined]),
      )
    }
    const runner = cliRunner.createCliRunner(paths as never)
    void runner.run(spec.args, spec.options as never).then((out: Spec) => {
      settled = out
    })
    for (const step of spec.steps) {
      if (step.out !== undefined) child.stdout.emit('data', Buffer.from(step.out))
      else if (step.outHex !== undefined) child.stdout.emit('data', Buffer.from(step.outHex, 'hex'))
      else if (step.outFill !== undefined)
        child.stdout.emit('data', Buffer.alloc(step.outFill, 0x61))
      else if (step.err !== undefined) child.stderr.emit('data', Buffer.from(step.err))
      else if (step.errHex !== undefined) child.stderr.emit('data', Buffer.from(step.errHex, 'hex'))
      else if (step.errFill !== undefined)
        child.stderr.emit('data', Buffer.alloc(step.errFill, 0x62))
      else if (step.timer) timers.fire(1)
      else if (step.error !== undefined) child.emit('error', new Error(step.error))
      else if (step.close !== undefined) child.emit('close', step.close)
    }
    await tick()
    return settled ? summarize(settled) : 'pending'
  } finally {
    timers.restore()
    delete box[SPAWN_BOX]
  }
}

const runCase = (spec: Partial<RunScenario> & { steps: Spec[] }, note: string): Case => ({
  args: [
    {
      paths: { executable: '/bin/node', entry: '/app/seuoffice.cjs' },
      args: ['docs', 'read', '/a/b.docx'],
      ...spec,
    },
  ],
  note,
})

const FILL = 67_108_864
const runCases: Case[] = [
  runCase({ steps: [{ out: okJson() + '\n' }, { close: 0 }] }, 'ok: the json of the last line'),
  runCase(
    {
      steps: [{ out: 'warning: x\n' + okJson({ output_path: '/o.docx' }) + '\n\n' }, { close: 0 }],
    },
    'a stray warning before the json, blank lines after it',
  ),
  runCase({ steps: [{ out: okJson() }, { close: 1 }] }, 'an ok payload but exit 1: not ok'),
  runCase({ steps: [{ out: errJson() }, { err: 'trace' }, { close: 2 }] }, 'an error payload'),
  runCase({ steps: [{ out: errJson() }, { close: 0 }] }, 'exit 0 with an error payload: not ok'),
  runCase({ steps: [{ out: '{"status":"weird"}' }, { close: 0 }] }, 'status is not "ok"'),
  runCase({ steps: [{ out: '[{"status":"ok"}]' }, { close: 0 }] }, 'an array has no status'),
  runCase({ steps: [{ out: '{"a":1}' }, { close: 0 }] }, 'an object without status'),
  runCase({ steps: [{ out: 'null' }, { close: 0 }] }, 'null'),
  runCase({ steps: [{ out: 'plain text' }, { close: 0 }] }, 'not json'),
  runCase({ steps: [{ out: '   \n' }, { close: 0 }] }, 'blank output'),
  runCase({ steps: [{ out: okJson() }, { close: null }] }, 'a signal ends the child: code -1'),
  runCase(
    { steps: [{ outHex: 'e282' }, { outHex: 'ac' }, { out: '\n' + okJson() }, { close: 0 }] },
    'a character split across two chunks decodes as two replacements, chunk by chunk',
  ),
  runCase({ steps: [{ out: okJson() }, { err: 'warn' }, { close: 0 }] }, 'stderr is kept'),
  runCase({ steps: [{ out: 'half' }, { timer: true }] }, 'the watchdog fires: killed, timed out'),
  runCase(
    { steps: [{ err: 'e' }, { timer: true }, { close: 0 }] },
    'a close after the watchdog changes nothing',
  ),
  runCase({ steps: [{ error: 'spawn x ENOENT' }] }, 'the process never started'),
  runCase({ steps: [{ out: 'x' }, { error: 'boom' }, { close: 1 }] }, 'error, then close'),
  runCase({ options: { input: 'ops text' }, steps: [{ close: 0 }] }, 'input is piped to stdin'),
  runCase({ options: { input: '' }, steps: [{ close: 0 }] }, 'an empty input is still input'),
  runCase(
    { options: { timeoutMs: 5 }, steps: [{ timer: true }] },
    'timeout under a second is a second',
  ),
  runCase({ options: { timeoutMs: 1500.9 }, steps: [{ close: 0 }] }, 'the floor of the timeout'),
  runCase(
    { options: { timeoutMs: 700000 }, steps: [{ close: 0 }] },
    'timeout over ten minutes is ten minutes',
  ),
  runCase(
    { options: { timeoutMs: '5000' }, steps: [{ close: 0 }] },
    'a string is not a finite number',
  ),
  runCase({ options: { timeoutMs: null }, steps: [{ close: 0 }] }, 'null is not a finite number'),
  runCase({ options: { timeoutMs: -50 }, steps: [{ close: 0 }] }, 'a negative timeout is a second'),
  runCase(
    {
      paths: {
        executable: '/e',
        entry: '/s.cjs',
        env: [
          ['A', '1'],
          ['ELECTRON_RUN_AS_NODE', '0'],
          ['B', null],
        ],
      },
      steps: [{ close: 0 }],
    },
    'extra environment overrides, an undefined value included',
  ),
  runCase({ steps: [{ close: 0 }] }, 'nothing printed'),
  runCase({ steps: [{ out: okJson() }] }, 'the run is still pending'),
  runCase(
    { steps: [{ errFill: 5000 }, { outFill: FILL - 5000 }, { out: 'x' }] },
    'stdout and stderr together pass the budget: truncated, killed',
  ),
  runCase({ steps: [{ outFill: FILL + 1 }, { close: 0 }] }, 'stdout alone passes the budget'),
  runCase({ steps: [{ outFill: FILL }, { close: 0 }] }, 'exactly the budget is allowed'),
  runCase(
    { steps: [{ timer: true }, { outFill: FILL + 1 }] },
    'a chunk that crosses the budget after the run settled kills the child once more',
  ),
]

// ---------------------------------------------------------------------------
// headless-cli
// ---------------------------------------------------------------------------

/** the scratch folder of a path, as `<tmp>` */
const hide = (text: string): string => text.replace(/^.*seuoffice-mcp-[A-Za-z0-9]{6}/, '<tmp>')

/**
 * A runner that logs its argv (the scratch folder as `<tmp>`) and what the
 * files it was pointed at held, and answers the outcomes in turn (the last one
 * again once they run out). `scratch()` is the folder it was pointed at.
 */
export function scriptedCli(
  outcomes: Spec | Spec[] | undefined,
  cx: TsContext,
): { runner: Spec; scratch: () => string | undefined } {
  let scratch: string | undefined
  const list = Array.isArray(outcomes) ? outcomes : [outcomes ?? {}]
  let turn = 0
  const runner = {
    run: async (args: string[]) => {
      cx.log('run', args.map(hide))
      args.forEach((arg, i) => {
        const flag = args[i - 1]
        if (i > 0 && ['--from', '--ops', '--data'].includes(flag!)) {
          scratch = dirname(arg)
          const content = existsSync(arg) ? readFileSync(arg, 'utf8') : null
          cx.log('staged', flag, basename(arg), content)
        }
      })
      const o = list[Math.min(turn++, list.length - 1)] ?? {}
      return {
        ok: o.ok ?? false,
        code: o.code ?? 1,
        json: o.json,
        stdout: o.stdout ?? '',
        stderr: o.stderr ?? '',
      }
    },
  }
  return { runner, scratch: () => scratch }
}

async function headlessRun(
  spec: Spec,
  cx: TsContext,
  call: (runner: Spec) => Promise<unknown>,
): Promise<unknown> {
  const { runner, scratch } = scriptedCli(spec.outcome, cx)
  try {
    return await call(runner)
  } catch (error) {
    // the scratch folder's random suffix shows in a Node error's message
    if (error instanceof Error) {
      error.message = error.message.replace(/[^\s']*seuoffice-mcp-[A-Za-z0-9]{6}/g, '<tmp>')
    }
    throw error
  } finally {
    const dir = scratch()
    cx.log('scratch folder removed', dir === undefined ? null : !existsSync(dir))
  }
}

const okOut = (extra: Record<string, unknown> = {}): Spec => ({
  ok: true,
  code: 0,
  json: { status: 'ok', command: 'c', summary: 'all done', ...extra },
  stdout: '{}',
})
const failOut = (message?: unknown): Spec => ({
  ok: false,
  code: 2,
  json: { status: 'error', command: 'c', code: 2, message },
})
const OUTCOMES: [Spec, string][] = [
  [okOut(), 'ok'],
  [okOut({ output_path: '/real/out.docx' }), 'ok with its own output path'],
  [okOut({ output_path: null }), 'a null output path falls back'],
  [okOut({ output_path: 5, summary: { a: 1 } }), 'values that are not strings are passed on'],
  [{ ...okOut(), json: { status: 'ok', command: 'c' } }, 'ok without summary'],
  [failOut('the CLI said no'), 'an error payload'],
  [failOut(), 'an error payload without a message'],
  [failOut(7), 'an error payload with a number as message'],
  [{ ok: true, code: 0, stdout: 'x' }, 'ok flag but no json'],
  [{ ok: true, code: 0, json: { status: 'error', message: 'late' } }, 'ok flag, error json'],
  [{ ok: false, code: 0, json: { status: 'ok', command: 'c', summary: 's' } }, 'not ok, ok json'],
  [{ ok: false, code: 4, stderr: '  stack trace  ' }, 'plain stderr'],
  [{ ok: false, code: 4, stdout: 'out text' }, 'plain stdout'],
  [{ ok: false, code: -1 }, 'nothing at all'],
]

const withOutcomes = (base: Spec): Case[] =>
  OUTCOMES.map(([outcome, note]) => ({ args: [{ ...base, outcome }], note }))

const createFileCases: Case[] = [
  ...withOutcomes({
    opts: {
      type: 'docx',
      input: { name: 'content.md', content: '# Title\n\nbody' },
      out: '/o/a.docx',
    },
  }),
  {
    args: [
      {
        outcome: okOut(),
        opts: {
          type: 'xlsx',
          input: { name: 'table.json', content: '[["a","b"]]' },
          out: '/o/a.xlsx',
          overwrite: true,
        },
      },
    ],
    note: 'overwrite adds --force',
  },
  {
    args: [
      {
        outcome: okOut(),
        opts: {
          type: 'docx',
          input: { name: 'c.html', content: '<p>é😀</p>' },
          out: '/o/é.docx',
          overwrite: false,
        },
      },
    ],
    note: 'non-ASCII content is staged as UTF-8',
  },
  {
    args: [
      {
        outcome: okOut(),
        opts: { type: 'docx', input: { name: 'no/such/dir.md', content: 'x' }, out: '/o/a.docx' },
      },
    ],
    note: 'the staging fails: the folder is still removed',
  },
]

const createPptxCases: Case[] = [
  ...withOutcomes({ opts: { ops: [{ op: 'add_slide', title: 'T' }, 5, null], out: '/o/a.pptx' } }),
  {
    args: [{ outcome: okOut(), opts: { ops: [], out: '/o/a.pptx', overwrite: true } }],
    note: 'no ops, overwrite',
  },
]

const readTextCases: Case[] = [
  {
    args: [
      {
        outcome: okOut({ detail: { items: [{ text: 'one' }, { text: 'two' }] } }),
        path: '/a.docx',
      },
    ],
    note: 'one paragraph per line',
  },
  {
    args: [
      {
        outcome: okOut({
          detail: { items: [{ text: 'a' }, {}, { text: 'b\n\n' }, { text: '' }, { text: '\n' }] },
        }),
        path: '/a.docx',
      },
    ],
    note: 'a missing text is empty; trailing newlines go',
  },
  {
    args: [
      {
        outcome: okOut({
          detail: {
            items: [
              { text: 1 },
              { text: [1, null, 'x'] },
              { text: { a: 1 } },
              { text: null },
              { text: false },
            ],
          },
        }),
        path: '/a.docx',
      },
    ],
    note: 'String() of what the text is',
  },
  {
    args: [{ outcome: okOut({ detail: { items: [] } }), path: '/a.docx' }],
    note: 'no items',
  },
  { args: [{ outcome: okOut(), path: '/a.docx' }], note: 'no detail' },
  { args: [{ outcome: okOut({ detail: null }), path: '/a.docx' }], note: 'a null detail' },
  { args: [{ outcome: okOut({ detail: 'abc' }), path: '/a.docx' }], note: 'a string detail' },
  { args: [{ outcome: okOut({ detail: { items: null } }), path: '/a.docx' }], note: 'null items' },
  {
    args: [{ outcome: okOut({ detail: { items: { 0: { text: 'x' } } } }), path: '/a.docx' }],
    note: 'items that are no array',
  },
  {
    args: [{ outcome: okOut({ detail: { items: 'abc' } }), path: '/a.docx' }],
    note: 'items that are a string',
  },
  {
    args: [{ outcome: okOut({ detail: { items: [{ text: 'a' }, null] } }), path: '/a.docx' }],
    note: 'a null item',
  },
  {
    args: [
      { outcome: okOut({ detail: { items: [5, 'x', [1], { text: 't' }] } }), path: '/a.docx' },
    ],
    note: 'items that are not objects have no text',
  },
  { args: [{ outcome: failOut('no such file'), path: '/missing.docx' }], note: 'the CLI failed' },
  { args: [{ outcome: { ok: false, code: 9, stderr: 'bad' }, path: '/x.docx' }], note: 'no json' },
]

const propertiesCases: Case[] = [
  {
    args: [
      {
        outcome: okOut({ detail: { properties: { title: 'T', custom: { a: 1 } } } }),
        path: '/a.docx',
      },
    ],
    note: 'the properties',
  },
  {
    args: [{ outcome: okOut({ detail: { properties: [] } }), path: '/a.docx' }],
    note: 'an array is an object',
  },
  {
    args: [{ outcome: okOut({ detail: { properties: null } }), path: '/a.docx' }],
    note: 'null properties',
  },
  {
    args: [{ outcome: okOut({ detail: { properties: 'x' } }), path: '/a.docx' }],
    note: 'a string',
  },
  { args: [{ outcome: okOut({ detail: {} }), path: '/a.docx' }], note: 'no properties' },
  { args: [{ outcome: okOut(), path: '/a.docx' }], note: 'no detail' },
  { args: [{ outcome: failOut('nope'), path: '/a.docx' }], note: 'the CLI failed' },
]

const mergeCases: Case[] = [
  {
    args: [
      {
        outcome: okOut({ output_path: '/o/m.docx', detail: { filled: 2 } }),
        opts: {
          templatePath: '/t.docx',
          data: { a: 'é', b: { c: [1, 2.5, 1e21] } },
          out: '/o/m.docx',
        },
      },
    ],
    note: 'data is staged as JSON',
  },
  {
    args: [
      {
        outcome: okOut(),
        opts: {
          templatePath: '/t.docx',
          data: {},
          out: '/o/m.docx',
          overwrite: true,
          strict: true,
        },
      },
    ],
    note: 'overwrite and strict',
  },
  {
    args: [
      {
        outcome: okOut(),
        opts: { templatePath: '/t.docx', data: {}, out: '/o/m.docx', strict: true },
      },
    ],
    note: 'strict alone',
  },
  {
    args: [{ outcome: okOut(), opts: { templatePath: '/t.docx', data: null, out: '/o/m.docx' } }],
    note: 'null data stages "null"',
  },
  {
    args: [
      { outcome: failOut('bad template'), opts: { templatePath: '/t.docx', data: {}, out: '/o' } },
    ],
    note: 'the CLI failed',
  },
]

const linksCases: Case[] = [
  { args: [{ outcome: okOut(), opts: { path: '/b.xlsx' } }], note: 'list' },
  { args: [{ outcome: okOut(), opts: { path: '/b.xlsx', update: true } }], note: 'update' },
  { args: [{ outcome: okOut(), opts: { path: '/b.xlsx', break: [1, 3, 10] } }], note: 'break' },
  {
    args: [{ outcome: okOut(), opts: { path: '/b.xlsx', break: [], update: true } }],
    note: 'an empty break list wins over update',
  },
  {
    args: [{ outcome: okOut(), opts: { path: '/b.xlsx', break: [2.5, 1e21] } }],
    note: 'numbers print as numbers',
  },
  {
    args: [{ outcome: okOut(), opts: { path: '/b.xlsx', update: true, out: '/o.xlsx' } }],
    note: 'out without force',
  },
  {
    args: [
      {
        outcome: okOut(),
        opts: { path: '/b.xlsx', update: true, out: '/o.xlsx', overwrite: true },
      },
    ],
    note: 'out with force',
  },
  {
    args: [{ outcome: okOut(), opts: { path: '/b.xlsx', overwrite: true } }],
    note: 'force alone is dropped',
  },
  { args: [{ outcome: failOut('no links'), opts: { path: '/b.xlsx' } }], note: 'the CLI failed' },
]

const convertCases: Case[] = [
  { args: [{ outcome: okOut(), opts: { path: '/a.pdf', to: 'docx' } }], note: 'path and format' },
  {
    args: [
      {
        outcome: okOut({ output_path: '/o.csv' }),
        opts: {
          path: '/a.xlsx',
          to: 'csv',
          out: '/o.csv',
          overwrite: true,
          password: 'pw',
          sheet: 'Data',
        },
      },
    ],
    note: 'every option',
  },
  {
    args: [{ outcome: okOut(), opts: { path: '/a.pdf', to: 'md', password: '' } }],
    note: 'an empty password is passed',
  },
  {
    args: [{ outcome: okOut(), opts: { path: '/a.xlsx', to: 'csv', sheet: '', out: '' } }],
    note: 'empty sheet and out are passed',
  },
  {
    args: [{ outcome: failOut('unsupported pair'), opts: { path: '/a.docx', to: 'xyz' } }],
    note: 'the CLI failed',
  },
]

const checkCases: Case[] = [
  { args: [{ outcome: okOut({ detail: { findings: [] } }), path: '/a.docx' }], note: 'ok' },
  { args: [{ outcome: failOut('cannot open'), path: '/a.docx' }], note: 'the CLI failed' },
  { args: [{ outcome: { ok: false, code: 3, stderr: 'oops' }, path: '/a.docx' }], note: 'no json' },
]

// ---------------------------------------------------------------------------
// mcp-logger
// ---------------------------------------------------------------------------

const RealDate = Date

function withClockAndZone<T>(zone: string | undefined, now: { ms: number }, run: () => T): T {
  const realZone = process.env.TZ
  const dateOf = class extends RealDate {
    constructor(...given: unknown[]) {
      super(...((given.length === 0 ? [now.ms] : given) as [number]))
    }
  }
  if (zone !== undefined) process.env.TZ = zone
  globalThis.Date = dateOf as never
  try {
    return run()
  } finally {
    globalThis.Date = RealDate
    if (realZone === undefined) delete process.env.TZ
    else process.env.TZ = realZone
  }
}

/** the zone's offset east of UTC at `ms`, as the Rust side is told it */
const offsetAt = (ms: number): number => -new RealDate(ms).getTimezoneOffset() * 60_000

function stamp(args: unknown[]): unknown {
  const [ms, zone, offsetMs] = args as [unknown, string, number]
  const at = ms === 'invalid' ? NaN : (ms as number)
  return withClockAndZone(zone, { ms: 0 }, () => {
    const there = offsetAt(at)
    if (!Number.isNaN(there) && there !== offsetMs)
      throw new Error(`the case is wrong: ${zone} is ${there} then`)
    return mcpLogger.localTimestamp(new Date(at))
  })
}

const T0 = 1_794_452_400_000
const stampCases: Case[] = [
  [0, 'UTC', 0],
  [T0, 'UTC', 0],
  [T0, 'Asia/Seoul', 32_400_000],
  [T0 + 7, 'Asia/Seoul', 32_400_000],
  [T0, 'Asia/Kolkata', 19_800_000],
  [T0, 'Asia/Kathmandu', 20_700_000],
  [T0, 'America/New_York', -18_000_000],
  [1_783_000_000_000, 'America/New_York', -14_400_000],
  [1_783_000_000_000, 'Etc/GMT+5', -18_000_000],
  [Date.UTC(2026, 11, 31, 23, 59, 59, 999), 'UTC', 0],
  [Date.UTC(2026, 11, 31, 23, 59, 59, 999), 'Asia/Seoul', 32_400_000],
  [Date.UTC(2024, 1, 29, 15, 30, 0, 5), 'Asia/Seoul', 32_400_000],
  [-1, 'UTC', 0],
  [-62_135_596_800_000, 'UTC', 0],
  [-62_198_755_200_000, 'UTC', 0],
  [253_402_300_800_000, 'UTC', 0],
  [8.64e15, 'UTC', 0],
  [8.64e15 + 1, 'UTC', 0],
  ['invalid', 'UTC', 0],
  [1.9, 'UTC', 0],
  [-1.9, 'UTC', 0],
].map((args) => ({ args }))

interface LoggerScenario {
  file: string
  zone: string
  offsetMs: number
  start?: number
  steps: Spec[]
}

function loggerSteps(spec: LoggerScenario, cx: TsContext): unknown {
  const now = { ms: spec.start ?? cx.now }
  return withClockAndZone(spec.zone, now, () => {
    if (offsetAt(now.ms) !== spec.offsetMs) throw new Error(`the case is wrong: ${spec.zone}`)
    const logger = new mcpLogger.McpLogger(spec.file)
    const answers: unknown[] = []
    for (const step of spec.steps) {
      if (step.at !== undefined) now.ms = step.at
      else if (step.append !== undefined) logger.append(step.append)
      else if (step.recent !== undefined) {
        const limit = step.recent.limit
        answers.push(['recent', logger.recent(limit === undefined ? undefined : num(limit))])
      } else if (step.clear) logger.clear()
      else if (step.ensure) logger.ensureFile()
      else if (step.write !== undefined) writeFileSync(spec.file, step.write)
      else if (step.writeLines) {
        const { count, width, prefix } = step.writeLines
        let text = ''
        for (let i = 0; i < count; i++) text += `${prefix}${i} ${'x'.repeat(width)}\n`
        writeFileSync(spec.file, text)
      } else if (step.remove) rmSync(spec.file, { force: true })
      else if (step.readLog)
        answers.push(['file', existsSync(spec.file) ? readFileSync(spec.file, 'utf8') : null])
    }
    answers.push(['path', logger.filePath === spec.file])
    return answers
  })
}

const logCase = (spec: Partial<LoggerScenario>, note: string, files?: Case['files']): Case => ({
  args: [{ file: '$DIR/mcp.log', zone: 'UTC', offsetMs: 0, steps: [], ...spec }],
  ...(files ? { files } : {}),
  note,
})

const appends = (count: number, prefix = 'm'): Spec[] =>
  Array.from({ length: count }, (_, i) => ({ append: `${prefix}${i}` }))

const loggerCases: Case[] = [
  logCase({ steps: [{ append: 'hello' }, { recent: {} }] }, 'a line with the local time'),
  logCase(
    {
      zone: 'Asia/Seoul',
      offsetMs: 32_400_000,
      steps: [{ append: 'seoul' }, { at: 1_794_492_000_000 }, { append: 'later' }, { recent: {} }],
    },
    'the time moves with the zone and the clock',
  ),
  logCase(
    {
      steps: [
        ...appends(5),
        { recent: { limit: 2 } },
        { recent: { limit: 0 } },
        { recent: { limit: -2 } },
        { recent: { limit: 2.7 } },
        { recent: { limit: 'NaN' } },
        { recent: { limit: 'Infinity' } },
        { recent: { limit: '-Infinity' } },
        { recent: { limit: 99 } },
      ],
    },
    'limits as slice(-limit) reads them',
  ),
  logCase(
    {
      steps: [
        { append: 'a' },
        { clear: true },
        { recent: {} },
        { readLog: true },
        { append: 'b' },
        { recent: {} },
      ],
    },
    'clear empties the ring and the file',
  ),
  logCase(
    { steps: [{ remove: true }, { ensure: true }, { readLog: true }, { ensure: true }] },
    'ensureFile creates the file when it is missing',
  ),
  logCase(
    {
      steps: [
        { remove: true },
        { clear: true },
        { append: 'x' },
        { readLog: true },
        { recent: {} },
      ],
    },
    'clear with no file; append recreates it',
  ),
  logCase(
    { steps: [{ write: 'old\n\nlines\n' }, { recent: {} }] },
    'the file is read back, blank lines left out',
  ),
  logCase({ steps: [{ write: 'a\r\nb\n' }, { recent: {} }] }, 'carriage returns stay'),
  logCase(
    { steps: [{ write: '' }, { append: 'only in ring?' }, { remove: true }, { recent: {} }] },
    'no file: the ring answers',
  ),
  logCase(
    { steps: [{ write: '\n\n' }, { append: 'ring' }, { write: '\n' }, { recent: {} }] },
    'an empty file falls back to the ring',
  ),
  logCase(
    { steps: [...appends(505), { remove: true }, { recent: { limit: 1000 } }] },
    'the ring keeps 500 lines',
  ),
  logCase(
    {
      steps: [
        ...appends(3),
        { write: 'x'.repeat(300_000) + '\nlast one\ntail\n' },
        { recent: { limit: 2 } },
        { recent: {} },
      ],
    },
    'a file over 256 KiB: a bounded suffix, its partial first line dropped',
  ),
  logCase(
    {
      steps: [
        { writeLines: { count: 800, width: 120, prefix: 'mid' } },
        { recent: { limit: 700 } },
      ],
    },
    'a file under 256 KiB is read whole',
  ),
  logCase(
    {
      steps: [
        { writeLines: { count: 4000, width: 120, prefix: 'row' } },
        { recent: { limit: 3 } },
        { recent: { limit: 0 } },
      ],
    },
    'a big file: limit 0 is every line of the suffix',
  ),
  logCase(
    { steps: [{ write: '€'.repeat(100_000) + '\nz\n' }, { recent: { limit: 5 } }] },
    'the window may start inside a character',
  ),
  logCase(
    {
      steps: [{ write: 'ab\n' }, { append: 'é😀 x' }, { readLog: true }, { recent: { limit: 5 } }],
    },
    'appended text is UTF-8',
  ),
  logCase(
    {
      file: '$DIR/missing/mcp.log',
      steps: [
        { append: 'one' },
        { append: 'two' },
        { recent: { limit: 1 } },
        { ensure: true },
        { clear: true },
        { recent: {} },
      ],
    },
    'a log target that cannot be written: the ring serves',
  ),
  logCase(
    { steps: [{ readLog: true }, { append: 'fresh' }, { readLog: true }] },
    'a new logger resets the file',
    { 'mcp.log': 'stale from the last launch\n' },
  ),
  logCase(
    { zone: 'Asia/Kathmandu', offsetMs: 20_700_000, steps: [{ append: 'x' }, { recent: {} }] },
    'a zone with 45 minutes',
  ),
  logCase(
    {
      start: 1_751_328_000_000 - 1,
      steps: [
        { append: 'new year of 2025' },
        { at: Date.UTC(2025, 6, 1, 0, 0, 0, 0) },
        { append: 'jul' },
        { recent: {} },
      ],
    },
    'a date change',
  ),
]

// ---------------------------------------------------------------------------
// docs-bridge
// ---------------------------------------------------------------------------

let bridgeSerial = 0

interface BridgeScenario {
  /** webContents by id: `alive` or `destroyed` */
  wcs: Record<string, 'alive' | 'destroyed'>
  /** the ids `deps.openBlankTab()` answers, in turn */
  blank?: number[]
  /** `deps.abandonBlankTab` exists */
  abandon?: boolean
  steps: Spec[]
}

async function runBridge(spec: BridgeScenario, cx: TsContext): Promise<unknown> {
  bridgeSerial += 1
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
      `../../../../apps/shell/src/main/mcp/docs-bridge.ts?case=${bridgeSerial}`
    )
    const blank = [...(spec.blank ?? [])]
    const control = bridge.createDocsControl({
      openBlankTab: () => {
        const id = blank.shift() as number
        cx.log('deps.openBlankTab', id)
        return id
      },
      authorizeSave: (wcId: number, path: string) => cx.log('deps.authorizeSave', wcId, path),
      ...(spec.abandon
        ? { abandonBlankTab: (wcId: number) => cx.log('deps.abandonBlankTab', wcId) }
        : {}),
    })
    const outcomes: Record<string, unknown> = {}
    const track = (label: string, promise: Promise<unknown>): void => {
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
    const send = (channel: string, id: number, ...rest: unknown[]): void => {
      const handler = handlers[channel]
      if (handler) handler({ sender: { id } }, ...rest)
      else cx.log('no listener', channel)
    }
    for (const step of spec.steps) {
      if (step.install) bridge.installDocsBridge()
      else if (step.open !== undefined) track(step.open, control.openBlankTab())
      else if (step.run !== undefined) {
        track(step.run, control.runCommand(step.wc, step.command, step.payload))
      } else if (step.ready !== undefined) send('docs:mcp-ready', step.ready)
      else if (step.result !== undefined) send('docs:mcp-result', step.result, step.payload)
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

/** a case installs the bridge first unless it is `bare`; the folder holds `old.docx` */
const bridgeCase = (spec: Partial<BridgeScenario> & { bare?: boolean }, note: string): Case => {
  const { bare, steps = [], ...rest } = spec
  return {
    args: [
      {
        wcs: { '3': 'alive', '4': 'alive' },
        ...rest,
        steps: bare ? steps : [{ install: true }, ...steps],
      },
    ],
    files: { 'old.docx': 'x' },
    note,
  }
}

const UNSEEN = { requestId: 'mcp-1', ok: true, result: 'r' }
const bridgeCases: Case[] = [
  bridgeCase(
    { bare: true, blank: [3], steps: [{ install: true }, { install: true }] },
    'install registers the two channels once',
  ),
  bridgeCase(
    { blank: [3], steps: [{ install: true }, { open: 'o' }, { ready: 3 }] },
    'a blank tab that becomes ready',
  ),
  bridgeCase(
    { blank: [3], steps: [{ install: true }, { ready: 3 }, { open: 'o' }, { ready: 3 }] },
    'ready before the open: resolved at once; the hook is attached once',
  ),
  bridgeCase(
    { blank: [3], steps: [{ open: 'o' }, { fire: 1 }] },
    'the tab never gets ready: abandoned',
  ),
  bridgeCase(
    { blank: [3], abandon: true, steps: [{ open: 'o' }, { fire: 1 }, { fire: 1 }] },
    'the tab never gets ready: abandoned (the dep exists)',
  ),
  bridgeCase(
    { blank: [3], abandon: true, steps: [{ install: true }, { open: 'o' }, { destroy: 3 }] },
    'the tab is closed while it is awaited',
  ),
  bridgeCase(
    { blank: [9], abandon: true, steps: [{ open: 'o' }] },
    'the blank tab is not a webContents',
  ),
  bridgeCase(
    { blank: [9], steps: [{ open: 'o' }] },
    'the blank tab is not a webContents (no abandon dep)',
  ),
  bridgeCase(
    { blank: [6], wcs: { '6': 'destroyed' }, abandon: true, steps: [{ open: 'o' }] },
    'the blank tab is destroyed',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: { text: 'x' } } },
      ],
    },
    'a command answered',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { run: 'r', wc: 3, command: 'insert_content', payload: { html: '<p>x</p>' } },
        { ready: 3 },
        { result: 3, payload: UNSEEN },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: 'later' } },
      ],
    },
    'a command waits for the tab; a second reply to the same request is ignored',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'a', wc: 3, command: 'read_document' },
        { run: 'b', wc: 3, command: 'apply_ops', payload: { ops: [] } },
        { result: 3, payload: { requestId: 'mcp-2', ok: true } },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: null } },
      ],
    },
    'two commands, answered out of order; no payload is a missing key',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 4, payload: UNSEEN },
        { result: 3, payload: UNSEEN },
      ],
    },
    'a reply from another tab is ignored',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 4, payload: { requestId: 'mcp-1', ok: true, result: 'from tab 4' } },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: 'from tab 3' } },
      ],
    },
    'a reply from another tab does not answer the command; the right tab does',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
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
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 3, payload: { requestId: 'mcp-1', ok: false, error: 'it broke' } },
      ],
    },
    'a reply with ok false: its error',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 3, payload: { requestId: 'mcp-1', ok: false, error: 5 } },
      ],
    },
    'a reply with ok false and an error that is no string',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 3, payload: { requestId: 'mcp-1', ok: 'true', result: 1 } },
      ],
    },
    'ok must be true itself',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { result: 3, payload: { requestId: 'mcp-1', ok: true } },
      ],
    },
    'ok without a result',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
        { fire: 1 },
      ],
    },
    'a command nobody answers',
  ),
  bridgeCase(
    { steps: [{ run: 'r', wc: 3, command: 'read_document', payload: {} }, { fire: 1 }] },
    'a command whose tab never gets ready',
  ),
  bridgeCase(
    { steps: [{ run: 'r', wc: 9, command: 'read_document', payload: {} }] },
    'a command for no webContents',
  ),
  bridgeCase(
    {
      wcs: { '3': 'destroyed' },
      steps: [{ run: 'r', wc: 3, command: 'read_document', payload: {} }],
    },
    'a command for a destroyed webContents',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { destroy: 3 },
        { run: 'r', wc: 3, command: 'read_document', payload: {} },
      ],
    },
    'a tab that was ready and went',
  ),
  bridgeCase(
    {
      steps: [
        { run: 'a', wc: 3, command: 'read_document', payload: {} },
        { vanish: 3 },
        { run: 'b', wc: 3, command: 'read_document', payload: {} },
      ],
    },
    'a webContents that vanished',
  ),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 'a', wc: 3, command: 'read_document', payload: {} },
        { run: 'b', wc: 4, command: 'read_document', payload: {} },
        { ready: 4 },
        { run: 'c', wc: 4, command: 'read_document', payload: {} },
        { destroy: 3 },
        { result: 4, payload: { requestId: 'mcp-3', ok: true, result: 'c' } },
        { fire: 3 },
      ],
    },
    'a tab closed with a command in flight; the other tab goes on',
  ),
  bridgeCase(
    {
      blank: [3],
      abandon: true,
      steps: [
        { open: 'o' },
        { run: 'a', wc: 3, command: 'read_document', payload: {} },
        { run: 'b', wc: 4, command: 'read_document', payload: {} },
        { destroy: 3 },
        { ready: 4 },
      ],
    },
    'a tab closed with waiters of two kinds',
  ),
  bridgeCase(
    {
      steps: [
        { run: 'a', wc: 3, command: 'read_document', payload: {} },
        { run: 'b', wc: 3, command: 'insert_content', payload: { html: 'x' } },
        { fire: 2 },
        { ready: 3 },
      ],
    },
    'one of two waiters times out; the other is resumed',
  ),
  bridgeCase(
    {
      steps: [
        { run: 'a', wc: 3, command: 'read_document', payload: {} },
        { fire: 1 },
        { ready: 3 },
        { fire: 1 },
      ],
    },
    'a timer fires twice; the tab is ready after',
  ),
  bridgeCase(
    { steps: [{ ready: 7 }, { ready: 3 }, { ready: 3 }] },
    'a tab that is no webContents announces itself',
  ),
  bridgeCase(
    { blank: [3], abandon: true, steps: [{ ready: 3 }, { destroy: 3 }, { open: 'o' }] },
    'a tab that was ready and went is no longer ready',
  ),
  bridgeCase({ bare: true, steps: [{ ready: 3 }] }, 'ready with the channels not registered'),
  bridgeCase(
    {
      steps: [
        { install: true },
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_document', payload: { path: '$DIR/new.docx' } },
        { result: 3, payload: { requestId: 'mcp-1', ok: true, result: { ok: true } } },
      ],
    },
    'a save to a new file is authorized',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_document', payload: { path: '$DIR/old.docx' } },
      ],
    },
    'a save over a file without overwrite is refused',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        {
          run: 's',
          wc: 3,
          command: 'save_document',
          payload: { path: '$DIR/old.docx', overwrite: true },
        },
      ],
    },
    'a save over a file with overwrite',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        {
          run: 's',
          wc: 3,
          command: 'save_document',
          payload: { path: '$DIR/old.docx', overwrite: 'yes' },
        },
      ],
    },
    'overwrite must be true itself',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 's', wc: 3, command: 'save_document', payload: { overwrite: true } },
        { run: 't', wc: 3, command: 'save_document', payload: { path: 5 } },
        { run: 'u', wc: 3, command: 'save_document' },
        { run: 'v', wc: 3, command: 'save_document', payload: null },
        { run: 'w', wc: 3, command: 'save_document', payload: 'x' },
      ],
    },
    'a save without a path',
  ),
  bridgeCase(
    {
      steps: [
        { run: 's', wc: 3, command: 'save_document', payload: { path: '$DIR/old.docx' } },
        { ready: 3 },
        { fire: 1 },
      ],
    },
    'a save that waits for the tab and is refused when it is ready',
  ),
  bridgeCase(
    {
      steps: [
        { ready: 3 },
        { run: 'p', wc: 3, command: 'insert_picture' },
        { run: 'q', wc: 3, command: 'apply_ops', payload: [1, 'two'] },
      ],
    },
    'payloads of any shape are sent',
  ),
]

// ---------------------------------------------------------------------------

const constant = (value: unknown, why: string): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: why,
})

const headlessFn = (
  cases: Case[],
  call: (runner: Spec, spec: Spec) => Promise<unknown>,
): FnSpec => ({
  ts: (a, cx) => headlessRun(a[0] as Spec, cx, (runner) => call(runner, a[0] as Spec)),
  cases,
})

export const group: Group = {
  'cli-runner.MAX_CLI_OUTPUT_BYTES': constant(cliRunner.MAX_CLI_OUTPUT_BYTES, 'a constant'),
  'cli-runner.cliErrorMessage': {
    ts: (a) => cliRunner.cliErrorMessage(a[0] as never),
    cases: errorMessageCases,
  },
  'cli-runner.createCliRunner': { ts: (a, cx) => runCli(a[0] as RunScenario, cx), cases: runCases },
  'headless-cli.createFileViaCli': headlessFn(createFileCases, (runner, spec) =>
    headless.createFileViaCli(runner as never, spec.opts),
  ),
  'headless-cli.createPptxViaCli': headlessFn(createPptxCases, (runner, spec) =>
    headless.createPptxViaCli(runner as never, spec.opts),
  ),
  'headless-cli.readDocxTextViaCli': headlessFn(readTextCases, (runner, spec) =>
    headless.readDocxTextViaCli(runner as never, spec.path),
  ),
  'headless-cli.readDocxPropertiesViaCli': headlessFn(propertiesCases, (runner, spec) =>
    headless.readDocxPropertiesViaCli(runner as never, spec.path),
  ),
  'headless-cli.mergeTemplateViaCli': headlessFn(mergeCases, (runner, spec) =>
    headless.mergeTemplateViaCli(runner as never, spec.opts),
  ),
  'headless-cli.sheetLinksViaCli': headlessFn(linksCases, (runner, spec) =>
    headless.sheetLinksViaCli(runner as never, spec.opts),
  ),
  'headless-cli.convertViaCli': headlessFn(convertCases, (runner, spec) =>
    headless.convertViaCli(runner as never, spec.opts),
  ),
  'headless-cli.docsCheckViaCli': headlessFn(checkCases, (runner, spec) =>
    headless.docsCheckViaCli(runner as never, spec.path),
  ),
  'mcp-logger.MCP_LOG_TAIL': constant(mcpLogger.MCP_LOG_TAIL, 'a constant'),
  'mcp-logger.localTimestamp': { ts: (a) => stamp(a), cases: stampCases },
  'mcp-logger.scenario': {
    ts: (a, cx) => loggerSteps(a[0] as LoggerScenario, cx),
    cases: loggerCases,
  },
  'docs-bridge.scenario': {
    ts: (a, cx) => runBridge(a[0] as BridgeScenario, cx),
    cases: bridgeCases,
  },
}
