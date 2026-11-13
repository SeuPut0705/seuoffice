/**
 * Part `recovery` of group `b3b4-rest`: the editors' crash-recovery modules,
 * `apps/{html,markdown}/src/main/recovery.ts` (the same file twice, both
 * compared), `apps/docs/src/main/docs-recovery.ts`,
 * `apps/pdf/src/main/pdf-recovery.ts` and
 * `apps/sheets/src/main/recovery-policy.ts`. Their Rust is
 * crates/main-core/src/calls/b3b4_rest/recovery.rs.
 *
 * The recovery store is the real one over the case's `$DIR/ud`, so a copy that
 * a case writes, deletes or moves shows in the folder snapshot. The store's
 * process-wide state is seeded (a fixed run id), `Date.now` is the scenario's
 * clock and `crypto.randomUUID` answers `uuid-1`, `uuid-2`, ... as in the
 * group `b2-recovery`, and all three are put back afterwards. A file copy's
 * name is the SHA-1 of its original path, so the originals live at fixed
 * paths (`/doc/...`, or `ORIG` where a case needs the file to exist, written by
 * the `seed` step and removed at the start and the end of a scenario).
 *
 * A scenario is one call: a world and a list of steps, answering one entry per
 * step (`op`, then `ok` with the value, or `error`). The steps that name a
 * module's function call it on the object `create*Recovery` made; the steps
 * `seed`, `store*`, `shutdown` and `now` arrange and read the store itself.
 * Every call a fake receives is one log line, the Rust playing the adapter on
 * the same fakes: for the text editors `adoptFile`, `restoredFile`, `reload`,
 * `send`, `titleOf` and the dialog's boxes; `console.warn` is `warn`. Timers
 * are captured: `flush` starts `writeCopiesNow` and answers the delays asked,
 * `timeout` fires the one numbered `n`, `timers` lists each as `pending`,
 * `cleared` or `fired`, `flushDone` says whether round `n` has resolved.
 */
import '../../electron-fake.ts'
import crypto, { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RecoveryCopyInfo, RecoveryIdentity, RecoveryStore } from '@seuoffice/electron-utils'
import { fakeDialog, fakeParent } from '../../fakes.ts'
import type { Case, FileSpec, Group, TsContext } from '../../types.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// loaded after electron-fake.ts has registered its hooks
const utils = await import('@seuoffice/electron-utils')
// the apps are CommonJS, which `require` loads as a second instance of the
// package: the headless flag of both is set
const required = createRequire(import.meta.url)('@seuoffice/electron-utils') as typeof utils
const htmlRecovery = await import('../../../../apps/html/src/main/recovery.ts')
const markdownRecovery = await import('../../../../apps/markdown/src/main/recovery.ts')
const docsRecovery = await import('../../../../apps/docs/src/main/docs-recovery.ts')
const pdfRecovery = await import('../../../../apps/pdf/src/main/pdf-recovery.ts')
const policy = await import('../../../../apps/sheets/src/main/recovery-policy.ts')

const NOW = 1_700_000_000_000
const OLD = 946_684_800_000
const FUTURE = 4_102_444_800_000
const DAY = 24 * 60 * 60 * 1000
const RUN = '0123456789abcdef'
const ORIG = join(tmpdir(), 'main-diff-b3b4-recovery-orig')
const SHARED = Symbol.for('seuoffice.recovery-store.shared')
const holder = globalThis as unknown as Record<symbol, unknown>

const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

/** the `rm` calls a module makes without waiting (a working file that goes with its view) */
const pendingRm: Promise<unknown>[] = []

interface Step {
  op: string
  [key: string]: any
}

interface EnvOptions {
  userData: string
  orig?: string
  runId?: string
  now?: number
  headless?: boolean
}

interface Env {
  clock: { ms: number }
  store: RecoveryStore
}

/** the store's process-wide state, the clock, the random ids and the warnings of one scenario */
async function inEnv<T>(o: EnvOptions, cx: TsContext, run: (env: Env) => Promise<T>): Promise<T> {
  const clock = { ms: o.now ?? cx.now }
  let counter = 0
  holder[SHARED] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: o.runId ?? RUN,
    discarded: new Set(),
  }
  const realNow = Date.now
  const patched = crypto as unknown as { randomUUID: () => string }
  const realUuid = patched.randomUUID
  const realWarn = console.warn
  const realRm = fsPromises.rm
  const cleanOrig = (): void => {
    if (o.orig) rmSync(o.orig, { recursive: true, force: true })
  }
  cleanOrig()
  Date.now = () => clock.ms
  patched.randomUUID = () => `uuid-${++counter}`
  fsPromises.rm = ((...given: Parameters<typeof realRm>) => {
    const removing = realRm(...given)
    pendingRm.push(removing.catch(() => undefined))
    return removing
  }) as typeof realRm
  syncBuiltinESMExports()
  console.warn = (prefix: unknown, error: unknown) =>
    cx.log('warn', prefix, error instanceof Error ? maskTmp(error.message) : error)
  utils.setHeadlessMode(o.headless === true)
  required.setHeadlessMode(o.headless === true)
  try {
    const store = utils.createRecoveryStore({ userDataDir: () => o.userData })
    return await run({ clock, store })
  } finally {
    Date.now = realNow
    fsPromises.rm = realRm
    patched.randomUUID = realUuid
    syncBuiltinESMExports()
    console.warn = realWarn
    utils.setHeadlessMode(false)
    required.setHeadlessMode(false)
    delete holder[SHARED]
    cleanOrig()
  }
}

/** the copy's description as the scenarios print it */
function infoOut(info: RecoveryCopyInfo | null): unknown {
  if (!info) return null
  return {
    state: info.state,
    title: info.title,
    legacy: info.legacy,
    originalMissing: info.originalMissing,
    fileChangedAfterCopy: info.fileChangedAfterCopy,
    originalPath: info.originalPath,
  }
}

/** the steps every scenario shares: they arrange and read the store itself */
async function storeStep(
  step: Step,
  o: EnvOptions,
  env: Env,
): Promise<{ done: boolean; value?: unknown }> {
  const id = step.id as RecoveryIdentity
  switch (step.op) {
    case 'now':
      env.clock.ms = step.ms
      return { done: true }
    case 'seed': {
      const path = join(o.orig as string, step.name as string)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, step.text as string)
      utimesSync(path, step.mtimeMs / 1000, step.mtimeMs / 1000)
      return { done: true }
    }
    case 'storeWrite':
      return {
        done: true,
        value: await env.store.writeCopy(id, Buffer.from(step.text as string), {
          title: step.title ?? undefined,
          originalPath: step.originalPath ?? undefined,
        }),
      }
    case 'storeRead': {
      const bytes = await env.store.readCopy(id)
      return { done: true, value: bytes ? bytes.toString('utf8') : null }
    }
    case 'storeInfo':
      return { done: true, value: infoOut(env.store.copyInfo(id)) }
    case 'storeState':
      return { done: true, value: env.store.setCopyState(id, step.state) }
    case 'storeDelete':
      return { done: true, value: env.store.deleteCopy(id, step.reason) }
    case 'storeIsDiscarded':
      return { done: true, value: env.store.isDiscarded(id) }
    case 'shutdown':
      if (step.on) utils.markAppShuttingDown()
      else utils.resetAppShuttingDown()
      return { done: true }
    case 'ls':
      try {
        return { done: true, value: readdirSync(step.dir as string).sort() }
      } catch {
        return { done: true, value: null }
      }
    case 'touch': {
      // every file under `dir` gets the time `mtimeMs`: a copy's time is read
      // back (writtenAt), and the clock of the disk is not the scenario's
      const touch = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) touch(path)
          else utimesSync(path, step.mtimeMs / 1000, step.mtimeMs / 1000)
        }
      }
      touch(step.dir as string)
      return { done: true }
    }
    default:
      return { done: false }
  }
}

/** every step in order, one entry each, with the promises of the step let to settle */
async function playSteps(
  steps: Step[],
  o: EnvOptions,
  env: Env,
  handle: (step: Step) => Promise<unknown> | unknown,
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const step of steps) {
    const entry: Record<string, unknown> = { op: step.op }
    try {
      const stored = await storeStep(step, o, env)
      const value = stored.done ? stored.value : await handle(step)
      if (value !== undefined) entry.ok = value
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown }
      entry.error = {
        code: typeof e.code === 'string' ? e.code : null,
        message: maskTmp(typeof e.message === 'string' ? e.message : String(error)),
      }
    }
    out.push(entry)
    await Promise.all(pendingRm.splice(0))
    await tick()
  }
  return out
}

const doc = (name: string): string => `/doc/${name}`
const orig = (name: string): string => `${ORIG}/${name}`
const F = (kind: string, filePath: string) => ({ kind, filePath })
const U = (kind: string, untitledId: string, ext: string) => ({ kind, untitledId, ext })
const hash = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 16)
const seed = (name: string, mtimeMs: number, text = 'orig'): Step => ({
  op: 'seed',
  name,
  text,
  mtimeMs,
})
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex')

// ---------------------------------------------------------------------------
// html/recovery.ts and markdown/recovery.ts
// ---------------------------------------------------------------------------

interface ViewSpec {
  id: number
  savePath?: string
  openPath?: string
  dirty?: boolean
  destroyed?: boolean
  sendThrows?: boolean
  parent?: 'live' | 'destroyed'
}

interface TextScenario extends EnvOptions {
  kind: string
  untitledExt: string
  lang?: string
  response?: number | number[]
  fallbackTitle?: string
  noRestoredFile?: boolean
  views: Record<string, ViewSpec>
  steps: Step[]
}

async function runText(create: (host: never) => any, o: TextScenario, cx: TsContext) {
  return inEnv(o, cx, async (env) => {
    const views: Record<string, ViewSpec> = JSON.parse(JSON.stringify(o.views))
    const byId = (id: number): ViewSpec | undefined =>
      Object.values(views).find((view) => view.id === id)
    const listeners: { view: string; fire: () => void; fired: boolean }[] = []
    const contents: Record<string, any> = {}
    for (const [name, view] of Object.entries(views)) {
      contents[name] = {
        id: view.id,
        name,
        isDestroyed: () => views[name].destroyed === true,
        reload: () => cx.log('reload', name),
        send: (channel: string) => {
          cx.log('send', name, channel)
          if (views[name].sendThrows) throw new Error('send failed')
        },
        once: (_event: string, fire: () => void) => {
          listeners.push({ view: name, fire, fired: false })
        },
      }
    }
    const host: Record<string, unknown> = {
      kind: o.kind,
      untitledExt: o.untitledExt,
      userDataDir: () => o.userData,
      dialog: fakeDialog(o.response, cx.log),
      parentOf: (c: { name: string }) => fakeParent(views[c.name].parent),
      lang: () => o.lang ?? 'en',
      savePath: (id: number) => byId(id)?.savePath,
      openPath: (id: number) => byId(id)?.openPath,
      isDirty: (id: number) => byId(id)?.dirty ?? false,
      adoptFile: (c: { name: string }, filePath: string) => {
        cx.log('adoptFile', c.name, filePath)
        views[c.name].openPath = filePath
        views[c.name].savePath = filePath
      },
      untitledFallbackTitle: () => o.fallbackTitle ?? 'Untitled',
      flushChannel: 'flush-recovery',
    }
    if (!o.noRestoredFile) {
      host.restoredFile = (id: number, filePath: string) => cx.log('restoredFile', id, filePath)
    }
    const recovery = create(host as never)
    const kept: Record<string, unknown> = {}
    const timers: { ms: number; fn: () => void; fired: boolean; cleared: boolean }[] = []
    const rounds: { done: boolean }[] = []
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const timer = { ms, fn, fired: false, cleared: false }
      timers.push(timer)
      return timer
    }) as never
    globalThis.clearTimeout = ((timer: { cleared: boolean }) => {
      timer.cleared = true
    }) as never
    const idOf = (step: Step): number => views[step.view].id
    try {
      return await playSteps(o.steps, o, env, async (step) => {
        switch (step.op) {
          case 'track':
            return void recovery.track(contents[step.view])
          case 'crash':
            for (const l of listeners) {
              if (l.view === step.view && !l.fired) {
                l.fired = true
                l.fire()
              }
            }
            return undefined
          case 'write':
            return recovery.writeCopy(contents[step.view], step.text)
          case 'forget':
            return void recovery.forget(idOf(step))
          case 'identity': {
            const identity = recovery.identityOf(idOf(step))
            if (step.as) kept[step.as] = identity
            return identity
          }
          case 'saved': {
            const before = typeof step.before === 'string' ? kept[step.before] : step.before
            return void recovery.saved(idOf(step), before ?? null)
          }
          case 'dontSave':
            return void recovery.dontSave(idOf(step))
          case 'renamed':
            return void recovery.renamed(idOf(step), step.old)
          case 'saveToPathFailed':
            return void recovery.saveToPathFailed(idOf(step), step.path)
          case 'resolve':
            return recovery.resolveOpen(contents[step.view])
          case 'saveAsDefault':
            return recovery.saveAsDefaultPath(idOf(step))
          case 'setTitle':
            return void recovery.setTitle(idOf(step), step.title)
          case 'titleSource':
            return void recovery.setTitleSource(
              step.mode === null
                ? null
                : (c: { name: string }) => {
                    cx.log('titleOf', c.name)
                    if (step.mode === 'throws') throw new Error('title failed')
                    if (step.mode === 'undefined') return undefined
                    return step.text
                  },
            )
          case 'flush': {
            const before = timers.length
            const round = { done: false }
            rounds.push(round)
            void recovery.contract.writeCopiesNow().then(() => {
              round.done = true
            })
            return timers.slice(before).map((timer) => timer.ms)
          }
          case 'timeout':
            timers[step.n].fired = true
            timers[step.n].fn()
            return undefined
          case 'timers':
            return timers.map((t) => (t.fired ? 'fired' : t.cleared ? 'cleared' : 'pending'))
          case 'flushDone':
            return rounds[step.n].done
          case 'openFile':
            return void recovery.contract.openFileWithDecision(contents[step.view], {
              filePath: step.filePath,
              decision: step.decision,
            })
          case 'openUntitled':
            return void recovery.contract.openUntitledCopy(contents[step.view], {
              copy: step.copy,
              title: step.title,
              saveAsDefaultPath: step.saveAsDefaultPath,
            })
          case 'unprotectable':
            return recovery.contract.isUnprotectable(contents[step.view])
          case 'kind':
            return recovery.contract.kind
          case 'set': {
            const view = views[step.view]
            for (const key of ['dirty', 'destroyed', 'sendThrows'] as const) {
              if (key in step) view[key] = step[key]
            }
            for (const key of ['savePath', 'openPath'] as const) {
              if (key in step) {
                if (step[key] === null) delete view[key]
                else view[key] = step[key]
              }
            }
            return undefined
          }
          default:
            throw new Error(`no such step: ${step.op}`)
        }
      })
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })
}

const textWorld = (steps: Step[], extra: Partial<TextScenario> = {}): TextScenario => ({
  userData: '$DIR/ud',
  orig: ORIG,
  now: NOW,
  kind: 'html',
  untitledExt: '.html',
  views: { a: { id: 1, savePath: doc('a.html'), dirty: true } },
  ...extra,
  steps,
})
const tc = (
  steps: Step[],
  extra: Partial<TextScenario> = {},
  note?: string,
  files?: Record<string, FileSpec>,
): Case => ({ args: [textWorld(steps, extra)], files, note })

const HA = F('html', doc('a.html'))
const HB = F('html', doc('b.html'))
const HO = F('html', doc('old.html'))
const HN = F('html', doc('new.html'))
const MU = U('markdown', 'saved-id', '.md')
const step = (op: string, view: string, extra: Record<string, unknown> = {}): Step => ({
  op,
  view,
  ...extra,
})
const readCopy = (id: unknown): Step => ({ op: 'storeRead', id })
const infoOf = (id: unknown): Step => ({ op: 'storeInfo', id })
const write = (view: string, text: string | null): Step => step('write', view, { text })

const twoPanes: Record<string, ViewSpec> = {
  a: { id: 1, savePath: doc('a.html'), openPath: doc('a.html'), dirty: true },
  b: { id: 2, savePath: doc('a.html'), openPath: doc('a.html'), dirty: true },
}

const textCases: Case[] = [
  tc(
    [
      step('track', 'a'),
      write('a', 'one'),
      write('a', 'one'),
      write('a', 'two'),
      write('a', null),
      step('set', 'a', { dirty: false }),
      write('a', 'three'),
      step('set', 'a', { dirty: true }),
      readCopy(HA),
      infoOf(HA),
      step('identity', 'a', { as: 'before' }),
      step('saved', 'a', { before: 'before' }),
      readCopy(HA),
      write('a', 'two'),
      readCopy(HA),
    ],
    {},
    'write results: written, unchanged, skipped; a save deletes the copy and forgets the text',
  ),
  tc(
    [
      write('a', 'untracked'),
      step('identity', 'a'),
      step('saved', 'a', { before: null }),
      step('dontSave', 'a'),
      step('renamed', 'a', { old: doc('x.html') }),
      step('saveToPathFailed', 'a', { path: doc('x.html') }),
      step('setTitle', 'a', { title: 'x' }),
      step('forget', 'a'),
      step('saveAsDefault', 'a'),
    ],
    {},
    'a view the module does not track: nothing happens',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'one'),
      step('saved', 'a', { before: null }),
      write('a', 'one'),
      infoOf(HA),
    ],
    {},
    'a save with no identity forgets the text, so the same text writes again',
  ),
  tc(
    [
      step('track', 'u'),
      step('identity', 'u', { as: 'slot' }),
      write('u', '<p>x</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      step('setTitle', 'u', { title: 'My page' }),
      write('u', '<p>y</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      { op: 'titleSource', view: 'u', mode: 'text', text: 'Shell title' },
      write('u', '<p>z</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      { op: 'titleSource', view: 'u', mode: 'empty', text: '' },
      write('u', '<p>w</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      { op: 'titleSource', view: 'u', mode: 'throws' },
      write('u', '<p>v</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      { op: 'titleSource', view: 'u', mode: 'undefined' },
      step('setTitle', 'u', { title: '' }),
      write('u', '<p>u</p>'),
      infoOf(U('html', 'uuid-1', '.html')),
      { op: 'titleSource', view: 'u', mode: null },
      write('u', '<p>t</p>'),
      readCopy(U('html', 'uuid-1', '.html')),
    ],
    { views: { u: { id: 7, dirty: true } }, fallbackTitle: 'Untitled page' },
    'an untitled copy: its title from the shell, the editor, or the fallback',
  ),
  tc(
    [
      step('track', 'u'),
      step('identity', 'u', { as: 'slot' }),
      write('u', '# a'),
      step('set', 'u', { savePath: doc('named.md') }),
      step('saved', 'u', { before: 'slot' }),
      readCopy(U('markdown', 'uuid-1', '.md')),
      step('identity', 'u'),
      step('saveAsDefault', 'u'),
    ],
    {
      kind: 'markdown',
      untitledExt: '.md',
      views: { u: { id: 7, dirty: true } },
    },
    'untitled to a file: the saved copy goes and the document takes its path',
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      step('track', 'c'),
      step('track', 'd'),
      write('a', 'a1'),
      write('b', 'b1'),
      write('c', 'c1'),
      write('d', 'd1'),
      step('set', 'c', { dirty: false }),
      step('set', 'd', { dirty: false }),
      step('forget', 'a'),
      step('forget', 'b'),
      step('forget', 'c'),
      step('forget', 'd'),
      readCopy(F('html', doc('a.html'))),
      readCopy(F('html', doc('b.html'))),
      readCopy(F('html', doc('c.html'))),
      readCopy(F('html', doc('d.html'))),
    ],
    {
      views: {
        a: { id: 1, savePath: doc('a.html'), dirty: true },
        b: { id: 2, savePath: doc('b.html'), dirty: true },
        c: { id: 3, savePath: doc('c.html'), dirty: true },
        d: { id: 4, savePath: doc('d.html'), dirty: true },
      },
    },
    'closing: a dirty view keeps its copy, a clean one that wrote it deletes it',
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      write('a', 'a1'),
      write('b', 'b1'),
      step('crash', 'a'),
      step('crash', 'a'),
      write('a', 'a2'),
      step('set', 'a', { dirty: false }),
      step('set', 'b', { dirty: false }),
      step('forget', 'a'),
      { op: 'shutdown', on: true },
      step('forget', 'b'),
      readCopy(F('html', doc('a.html'))),
      readCopy(F('html', doc('b.html'))),
      { op: 'shutdown', on: false },
    ],
    {
      views: {
        a: { id: 1, savePath: doc('a.html'), dirty: true },
        b: { id: 2, savePath: doc('b.html'), dirty: true },
      },
    },
    'a crashed renderer keeps its copy, and the store refuses the clean-close delete at shutdown',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'one'),
      step('dontSave', 'a'),
      readCopy(HA),
      write('a', 'two'),
      readCopy(HA),
      { op: 'storeIsDiscarded', id: HA },
    ],
    {},
    "after Don't Save nothing is written until the close is cancelled",
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      write('a', 'one'),
      write('b', 'one'),
      step('dontSave', 'a'),
      { op: 'storeIsDiscarded', id: HA },
      write('b', 'two'),
      readCopy(HA),
      write('a', 'one'),
      readCopy(HA),
    ],
    { views: twoPanes },
    "panes on one file: another pane's edits were not thrown away, so its copies go on",
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      write('a', 'one'),
      write('b', 'one'),
      step('saved', 'a', { before: HA }),
      write('b', 'one'),
      readCopy(HA),
      write('a', 'one'),
      infoOf(HA),
    ],
    { views: twoPanes },
    'a save on one pane makes the other pane forget its last copy',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'old'),
      step('set', 'a', { savePath: doc('new.html') }),
      step('renamed', 'a', { old: doc('old.html') }),
      write('a', 'old'),
      readCopy(HO),
      readCopy(HN),
      step('renamed', 'a', { old: doc('new.html') }),
      step('set', 'a', { destroyed: true }),
      step('renamed', 'a', { old: doc('gone.html') }),
    ],
    { views: { a: { id: 1, savePath: doc('old.html'), dirty: true } } },
    'a rename: the renderer is asked for a copy, which lands under the new path and replaces the old',
  ),
  tc(
    [
      step('track', 'a'),
      step('renamed', 'a', { old: doc('old.html') }),
      write('a', 'one'),
      step('renamed', 'a', { old: doc('a.html') }),
      step('set', 'a', { sendThrows: true }),
      step('renamed', 'a', { old: doc('b.html') }),
      write('a', 'two'),
      step('renamed', 'a', { old: doc('c.html') }),
    ],
    {},
    'a rename needs a copy of this view first, and a renderer that cannot be told throws',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'one'),
      step('renamed', 'a', { old: '' }),
      write('a', 'one'),
      readCopy(HA),
    ],
    {},
    'the copy under the old path cannot be named: the delete is logged and ignored',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'x'),
      step('saveToPathFailed', 'a', { path: doc('a.html') }),
      readCopy(HA),
      step('set', 'a', { savePath: doc('other.html') }),
      write('a', 'y'),
      step('set', 'a', { savePath: doc('a.html') }),
      step('saveToPathFailed', 'a', { path: doc('other.html') }),
      readCopy(F('html', doc('other.html'))),
      { op: 'storeIsDiscarded', id: F('html', doc('other.html')) },
      write('a', 'x2'),
      step('saveToPathFailed', 'a', { path: doc('never.html') }),
      write('a', 'x2'),
    ],
    {},
    'a save to a given path that failed deletes the copy this view wrote there and lets the path take copies',
  ),
  tc(
    [
      step('track', 'u'),
      write('u', 'x'),
      write('u', 'y'),
      step('track', 'a'),
      write('a', 'one'),
      step('forget', 'a'),
      write('a', 'one'),
    ],
    {
      untitledExt: 'bad',
      views: { u: { id: 7, dirty: true }, a: { id: 1, savePath: doc('a.html'), dirty: true } },
    },
    'a copy that cannot be written rejects; a view that is gone answers skipped',
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      step('track', 'c'),
      step('track', 'd'),
      step('track', 'e'),
      step('flush', 'a'),
      step('timers', 'a'),
      step('flushDone', 'a', { n: 0 }),
      write('a', 'one'),
      step('timers', 'a'),
      step('flushDone', 'a', { n: 0 }),
      step('timeout', 'a', { n: 1 }),
      step('timers', 'a'),
      step('flushDone', 'a', { n: 0 }),
      step('timeout', 'a', { n: 2 }),
      step('timers', 'a'),
      step('flushDone', 'a', { n: 0 }),
    ],
    {
      views: {
        a: { id: 1, savePath: doc('a.html'), dirty: true },
        b: { id: 2, savePath: doc('b.html'), dirty: true },
        c: { id: 3, savePath: doc('c.html'), dirty: false },
        d: { id: 4, savePath: doc('d.html'), dirty: true, destroyed: true },
        e: { id: 5, savePath: doc('e.html'), dirty: true },
      },
    },
    'writeCopiesNow: only live dirty views are asked; one answers, one times out',
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      step('track', 'c'),
      step('crash', 'c'),
      step('flush', 'a'),
      step('flushDone', 'a', { n: 0 }),
      step('crash', 'a'),
      step('flushDone', 'a', { n: 0 }),
      step('forget', 'b'),
      step('flushDone', 'a', { n: 0 }),
      step('flush', 'a'),
      step('flushDone', 'a', { n: 1 }),
      step('timers', 'a'),
    ],
    {
      views: {
        a: { id: 1, savePath: doc('a.html'), dirty: true },
        b: { id: 2, savePath: doc('b.html'), dirty: true },
        c: { id: 3, savePath: doc('c.html'), dirty: true },
      },
    },
    'a crashed or forgotten renderer settles its wait; a crashed one is not asked again',
  ),
  tc(
    [
      step('track', 'a'),
      step('track', 'b'),
      step('flush', 'a'),
      step('flush', 'a'),
      step('flushDone', 'a', { n: 0 }),
      write('a', 'one'),
      step('flushDone', 'a', { n: 0 }),
      write('b', null),
      step('flushDone', 'a', { n: 0 }),
      step('flushDone', 'a', { n: 1 }),
      step('timers', 'a'),
    ],
    {
      views: {
        a: { id: 1, savePath: doc('a.html'), dirty: true },
        b: { id: 2, savePath: doc('b.html'), dirty: true, sendThrows: true },
      },
    },
    'a renderer that cannot be told settles at once; two rounds wait on the same view',
  ),
  tc(
    [step('flush', 'a'), step('flushDone', 'a', { n: 0 }), step('kind', 'a')],
    {},
    'nothing to ask: the round has resolved already',
  ),
  tc(
    [
      step('track', 'a'),
      step('flush', 'a'),
      write('a', null),
      step('flushDone', 'a', { n: 0 }),
      step('forget', 'a'),
      step('flush', 'a'),
      step('timeout', 'a', { n: 0 }),
      step('timers', 'a'),
    ],
    { kind: 'markdown', untitledExt: '.md' },
    'a null write only answers the flush request; a fired timer is not cleared later',
  ),
  tc(
    [
      step('track', 'u'),
      step('flush', 'u'),
      write('u', 'x'),
      step('flushDone', 'u', { n: 0 }),
      step('timers', 'u'),
    ],
    { untitledExt: 'bad', views: { u: { id: 7, dirty: true } } },
    'a write that rejects still settles the flush wait',
  ),
  tc(
    [step('resolve', 'a'), step('resolve', 'a')],
    { views: { a: { id: 1, dirty: false } } },
    'no open path and nothing to restore',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      { op: 'storeRead', id: HA },
    ],
    { headless: true, response: 0, views: { a: { id: 1, openPath: doc('a.html') } } },
    'a hidden export window never restores',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      step('write', 'a', { text: 'edited' }),
      infoOf(HA),
      step('resolve', 'a'),
    ],
    { response: 0, views: { a: { id: 1, openPath: doc('a.html'), dirty: true } } },
    'the per-file prompt: restore (its text opens, the copy is marked loaded, the tab owns it)',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      readCopy(HA),
    ],
    { response: 1, views: { a: { id: 1, openPath: doc('a.html') } } },
    'the per-file prompt: discard deletes the copy and opens the file',
  ),
  tc(
    [{ op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' }, step('resolve', 'a')],
    { response: Number.NaN, views: { a: { id: 1, openPath: doc('a.html'), parent: 'live' } } },
    'the prompt closed without an answer restores; a live parent hosts the box',
  ),
  tc(
    [
      seed('changed.html', FUTURE),
      seed('older.html', OLD),
      { op: 'storeWrite', id: F('html', orig('changed.html')), text: 'c', title: 'changed.html' },
      { op: 'storeWrite', id: F('html', orig('older.html')), text: 'o', title: 'older.html' },
      step('resolve', 'a'),
      step('resolve', 'b'),
    ],
    {
      lang: 'ko',
      response: [0, 1],
      views: {
        a: { id: 1, openPath: orig('changed.html'), parent: 'destroyed' },
        b: { id: 2, openPath: orig('older.html'), parent: 'live' },
      },
    },
    'the box says when the file changed after the copy, in the UI language, over a live parent only',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      { op: 'storeState', id: HA, state: 'restoreChosen' },
      step('track', 'a'),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'restore' }),
      step('resolve', 'a'),
      infoOf(HA),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'original' }),
      step('resolve', 'a'),
      step('resolve', 'a'),
      infoOf(HA),
    ],
    { views: { a: { id: 1 } } },
    'the shell decided: restore loads the copy without asking, original loads the file',
  ),
  tc(
    [
      step('openFile', 'a', { filePath: doc('none.html'), decision: 'restore' }),
      step('resolve', 'a'),
      step('resolve', 'a'),
    ],
    { noRestoredFile: true, views: { a: { id: 1 } } },
    'restore chosen but the copy is gone; a host without restoredFile',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'restore' }),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'restore' }),
      step('set', 'a', { destroyed: true }),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'restore' }),
    ],
    { response: 1, views: { a: { id: 1 } } },
    'a view that already asked is reloaded once for the shell decision, never when destroyed',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      step('resolve', 'b'),
    ],
    { response: 0, views: twoPanes },
    'a second pane on the same file does not ask again',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('resolve', 'a'),
      step('resolve', 'a'),
    ],
    { kind: 'bogus', response: 0, views: { a: { id: 1, openPath: doc('a.html') } } },
    'the store refuses the kind: the failure is logged and the file opens',
  ),
  tc(
    [
      { op: 'storeWrite', id: U('html', 'seeded', '.html'), text: '<p>seed</p>', title: 'Seeded' },
      { op: 'storeState', id: U('html', 'seeded', '.html'), state: 'later' },
      step('openUntitled', 'a', {
        copy: U('html', 'seeded', '.html'),
        title: 'Seeded',
      }),
      step('resolve', 'a'),
      step('resolve', 'a'),
      infoOf(U('html', 'seeded', '.html')),
      write('a', '<p>edited</p>'),
      step('saveAsDefault', 'a'),
      step('identity', 'a'),
      infoOf(U('html', 'seeded', '.html')),
    ],
    { views: { a: { id: 1, dirty: true } } },
    'an untitled copy opens as an untitled document and keeps its slot',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'missing original', title: 'a.html' },
      step('track', 'a'),
      step('resolve', 'a'),
      step('openUntitled', 'a', { copy: HA, title: 'a.html', saveAsDefaultPath: doc('a.html') }),
      step('resolve', 'a'),
      step('saveAsDefault', 'a'),
      step('saved', 'a', { before: null }),
      step('saveAsDefault', 'a'),
      step('set', 'a', { savePath: doc('saved.html') }),
      step('saved', 'a', { before: null }),
      step('saveAsDefault', 'a'),
    ],
    { response: 1, views: { a: { id: 1 } } },
    'a copy restored as untitled names its original; a save to a path ends that',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'missing original', title: 'a.html' },
      step('openUntitled', 'a', { copy: HA, title: 'a.html' }),
      step('saveAsDefault', 'a'),
      step('resolve', 'a'),
      step('openUntitled', 'a', { copy: HA, title: 'a.html', saveAsDefaultPath: '' }),
      step('resolve', 'a'),
      step('saveAsDefault', 'a'),
      { op: 'storeDelete', id: HA, reason: 'saved' },
      step('openUntitled', 'a', { copy: HA, title: 'a.html' }),
      step('resolve', 'a'),
    ],
    { views: { a: { id: 1 } } },
    'a restored missing original without a suggestion names its old path; a copy that is gone loads nothing',
  ),
  tc(
    [
      step('unprotectable', 'a'),
      step('kind', 'a'),
      step('saveAsDefault', 'a'),
      step('identity', 'a'),
    ],
    { kind: 'markdown', untitledExt: '.md', views: { a: { id: 1 } } },
    'the contract: password documents do not exist in these editors',
  ),
  tc(
    [
      step('track', 'u1'),
      step('track', 'u2'),
      write('u1', 'x'),
      write('u2', 'x'),
      step('identity', 'u1', { as: 'k1' }),
      step('saved', 'u1', { before: 'k1' }),
      write('u2', 'x'),
      readCopy(U('html', 'uuid-2', '.html')),
    ],
    { views: { u1: { id: 7, dirty: true }, u2: { id: 8, dirty: true } } },
    'two untitled panes: a save of one does not make the other forget its copy',
  ),
  tc(
    [{ op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' }, step('resolve', 'a')],
    {
      response: 0,
      views: {
        a: { id: 1, openPath: doc('a.html') },
        b: { id: 2, openPath: doc('a.html'), destroyed: true },
      },
    },
    'a destroyed pane on the same file does not stop the question',
  ),
  tc(
    [
      step('track', 'u'),
      step('identity', 'u'),
      write('u', 'x'),
      infoOf(U('html', 'uuid-1', '.html')),
    ],
    { views: { u: { id: 7, savePath: '', dirty: true } } },
    'an empty save path is no path: the document is untitled',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'copy of an earlier run', title: 'a.html' },
      step('track', 'a'),
      step('forget', 'a'),
      readCopy(HA),
    ],
    { views: { a: { id: 1, savePath: doc('a.html'), dirty: false } } },
    'a clean view that never wrote or loaded the copy leaves it alone when it closes',
  ),
  tc(
    [
      { op: 'storeWrite', id: HA, text: 'saved copy', title: 'a.html' },
      step('track', 'b'),
      step('resolve', 'a'),
    ],
    {
      response: 0,
      views: {
        a: { id: 1, openPath: doc('a.html') },
        b: { id: 2, openPath: doc('a.html'), destroyed: true },
      },
    },
    'a destroyed pane the module tracks does not count as a sibling that already asked',
  ),
  tc(
    [
      step('resolve', 'a'),
      step('set', 'a', { destroyed: true }),
      step('openFile', 'a', { filePath: doc('a.html'), decision: 'restore' }),
    ],
    { views: { a: { id: 1 } } },
    'a view that asked and was destroyed since is not reloaded for the shell decision',
  ),
  tc(
    [
      step('track', 'a'),
      write('a', 'one'),
      step('set', 'a', { destroyed: true }),
      step('renamed', 'a', { old: doc('old.html') }),
    ],
    {},
    'a rename of a destroyed view asks nothing of its renderer',
  ),
]

// ---------------------------------------------------------------------------
// docs-recovery.ts
// ---------------------------------------------------------------------------

interface DocsScenario extends EnvOptions {
  lang?: string
  response?: number | number[]
  parent?: 'live' | 'destroyed'
  steps: Step[]
}

async function runDocs(o: DocsScenario, cx: TsContext) {
  return inEnv(o, cx, async (env) => {
    const recovery = docsRecovery.createDocsRecovery(env.store)
    const dialog = fakeDialog(o.response, cx.log)
    const parent = fakeParent(o.parent)
    const prepared = (spec: Step): (() => Promise<Buffer | null>) => {
      return async () => {
        cx.log('prepare', spec.mode)
        if (spec.mode === 'throws') throw new Error('prepare failed')
        if (spec.mode === 'null') return null
        if (spec.during?.op === 'discard') {
          recovery.discard(spec.during.tab, spec.during.filePath ?? null)
        } else if (spec.during?.op === 'noteSaved') {
          recovery.noteSaved(spec.during.tab, spec.during.paths)
        }
        return Buffer.from(spec.text as string)
      }
    }
    return playSteps(o.steps, o, env, async (step) => {
      switch (step.op) {
        case 'write':
          return recovery.writeCopy(
            step.tab,
            step.target,
            prepared(step.prepare),
            step.title,
            step.originalPath,
          )
        case 'noteSaved':
          return void recovery.noteSaved(step.tab, step.paths)
        case 'noteCloseCheck':
          return void recovery.noteCloseCheck(step.tab, step.dirty)
        case 'discard':
          return void recovery.discard(step.tab, step.filePath ?? null)
        case 'noteClosedSaved':
          return void recovery.noteClosedSaved(step.tab)
        case 'abandon':
          return void recovery.abandon(step.tab, step.filePath ?? null)
        case 'noteStillOpen':
          return void recovery.noteStillOpen(step.tab)
        case 'restoreFailed':
          return void recovery.restoreFailed(step.filePath)
        case 'settle':
          return void recovery.settleClosedDocument(step.tab, step.crashed)
        case 'resolve': {
          const result = await recovery.resolveOpen({
            filePath: step.filePath,
            decision: step.decision ?? undefined,
            dialog: dialog as never,
            parent: parent as never,
            lang: o.lang ?? 'en',
          })
          return result.action === 'restore'
            ? { action: 'restore', text: result.bytes.toString('utf8'), copy: infoOut(result.copy) }
            : { action: 'original' }
        }
        case 'take': {
          const accept = {
            all: () => true,
            none: () => false,
            nonEmpty: (bytes: Buffer) => bytes.length > 0,
          }[step.accept as 'all' | 'none' | 'nonEmpty']
          const taken = await recovery.takeUntitledCopy(step.tab, step.copy, {
            title: step.title,
            ext: step.ext,
            accept,
          })
          return taken ? { text: taken.bytes.toString('utf8'), identity: taken.identity } : null
        }
        case 'untitledOf':
          return recovery.untitledOf(step.tab)
        case 'fileIdentity':
          return recovery.fileIdentity(step.filePath)
        default:
          throw new Error(`no such step: ${step.op}`)
      }
    })
  })
}

const docsWorld = (steps: Step[], extra: Partial<DocsScenario> = {}): DocsScenario => ({
  userData: '$DIR/ud',
  orig: ORIG,
  now: NOW,
  ...extra,
  steps,
})
const dc = (steps: Step[], extra: Partial<DocsScenario> = {}, note?: string): Case => ({
  args: [docsWorld(steps, extra)],
  note,
})

const DA = F('docs', doc('a.docx'))
const DB = F('docs', doc('b.docx'))
const DO = F('docs', doc('marked.odt'))
const DU = (id: string, ext = '.docx') => U('docs', id, ext)
const bytes = (text: string, extra: Record<string, unknown> = {}) => ({
  mode: 'bytes',
  text,
  ...extra,
})
const dwrite = (
  tab: number,
  target: unknown,
  prepare: unknown,
  title = 'Title',
  originalPath?: string,
): Step => ({ op: 'write', tab, target, prepare, title, originalPath })
const toFile = (name: string) => ({ filePath: doc(name) })
const toUntitled = (untitledExt: string) => ({ untitledExt })

const docsCases: Case[] = [
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('one')),
      { op: 'storeRead', id: DA },
      { op: 'storeInfo', id: DA },
      dwrite(1, toFile('a.docx'), { mode: 'null' }),
      dwrite(1, toFile('a.docx'), bytes('two'), 'Other'),
      { op: 'storeRead', id: DA },
      { op: 'storeInfo', id: DA },
    ],
    {},
    'a tab writes its file copy; prepare answering null skips the tick',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('one')),
      dwrite(2, toFile('a.docx'), { mode: 'throws' }),
      { op: 'storeRead', id: DA },
    ],
    {},
    'a prepare that throws rejects the write',
  ),
  dc(
    [dwrite(1, toFile('a.docx'), bytes('one')), { op: 'storeRead', id: DA }],
    { headless: true },
    'a headless export keeps no copy',
  ),
  dc(
    [
      dwrite(
        1,
        toFile('a.docx'),
        bytes('one', { during: { op: 'discard', tab: 1, filePath: doc('a.docx') } }),
      ),
      { op: 'storeRead', id: DA },
      dwrite(1, toFile('a.docx'), bytes('two')),
      { op: 'storeRead', id: DA },
    ],
    {},
    'a "Don\'t Save" that lands while the bytes are made wins, and holds',
  ),
  dc(
    [
      dwrite(
        1,
        toFile('a.docx'),
        bytes('one', { during: { op: 'noteSaved', tab: 1, paths: [doc('a.docx')] } }),
      ),
      { op: 'storeRead', id: DA },
      dwrite(1, toFile('a.docx'), bytes('two')),
      { op: 'storeRead', id: DA },
    ],
    {},
    'a save that lands while the bytes are made wins; the next write goes through',
  ),
  dc(
    [
      dwrite(1, toUntitled('.docx'), bytes('u1')),
      { op: 'untitledOf', tab: 1 },
      dwrite(1, toUntitled('.docx'), bytes('u2')),
      dwrite(1, toUntitled('.odt'), bytes('u3')),
      { op: 'untitledOf', tab: 1 },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'storeRead', id: DU('uuid-2', '.odt') },
      { op: 'untitledOf', tab: 2 },
    ],
    {},
    'an untitled copy keeps its slot until the format changes, which replaces the slot',
  ),
  dc(
    [
      dwrite(1, toFile('marked.odt'), bytes('odt')),
      dwrite(1, toUntitled('.docx'), bytes('docx of marked'), 'Marked', doc('marked.odt')),
      { op: 'storeRead', id: DO },
      { op: 'storeInfo', id: DU('uuid-1') },
      { op: 'settle', tab: 1, crashed: false },
      dwrite(1, toFile('marked.odt'), bytes('odt again')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DO },
    ],
    {},
    'a docx copy of a marked ODT tab replaces the ODT copy the tab wrote; the path is forgotten',
  ),
  dc(
    [
      dwrite(1, toUntitled('.docx'), bytes('docx of marked'), 'Marked', doc('marked.odt')),
      dwrite(1, toFile('marked.odt'), bytes('odt again')),
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'storeRead', id: DO },
      dwrite(1, toUntitled('.docx'), bytes('u2'), 'Plain', ''),
      dwrite(1, toFile('other.docx'), bytes('o')),
      { op: 'storeRead', id: DU('uuid-1') },
    ],
    {},
    "writing the file's own copy again drops the marked untitled copy that came from it",
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toFile('b.docx'), bytes('b')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'noteSaved', tab: 1, paths: [doc('a.docx')] },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DB },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'untitledOf', tab: 1 },
      { op: 'noteSaved', tab: 1, paths: [] },
    ],
    {},
    'a save deletes the paths it made stale and the untitled copy',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'discard', tab: 1, filePath: doc('a.docx') },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'untitledOf', tab: 1 },
      dwrite(1, toUntitled('.docx'), bytes('u again')),
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'discard', tab: 1, filePath: null },
      { op: 'discard', tab: 3, filePath: '' },
    ],
    {},
    '"Don\'t Save" deletes the file copy and keeps the untitled slot, which the store blocks',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'untitledOf', tab: 1 },
    ],
    {},
    'a clean close drops the copies the tab wrote and forgets the tab',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'noteClosedSaved', tab: 1 },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DU('uuid-1') },
    ],
    {},
    'a close whose Save went through deletes the copies as saved',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'discard', tab: 1, filePath: null },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'untitledOf', tab: 1 },
      { op: 'storeIsDiscarded', id: DA },
    ],
    {},
    'a discarding close deletes the file copies; the untitled slot is blocked, not reused',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      { op: 'settle', tab: 1, crashed: true },
      { op: 'storeRead', id: DA },
      dwrite(2, toFile('b.docx'), bytes('b')),
      { op: 'settle', tab: 2, crashed: false },
      { op: 'storeRead', id: DB },
    ],
    {},
    'a crashed tab, or one closed without a close check, keeps its copies',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      { op: 'noteCloseCheck', tab: 1, dirty: true },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
      dwrite(1, toFile('a.docx'), bytes('a2')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      dwrite(1, toFile('a.docx'), bytes('a3')),
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
    ],
    {},
    'a dirty answer, or a later copy, undoes an earlier clean answer',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'noteCloseCheck', tab: 1, dirty: false },
      { op: 'abandon', tab: 1, filePath: doc('loaded.docx') },
      { op: 'storeInfo', id: DA },
      { op: 'storeInfo', id: DU('uuid-1') },
      { op: 'storeWrite', id: F('docs', doc('loaded.docx')), text: 'loaded' },
      { op: 'abandon', tab: 1, filePath: doc('loaded.docx') },
      { op: 'storeInfo', id: F('docs', doc('loaded.docx')) },
      { op: 'abandon', tab: 9, filePath: null },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
    ],
    {},
    'a hung tab closed anyway sets its copies aside as later and keeps them',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      { op: 'discard', tab: 1, filePath: null },
      { op: 'noteStillOpen', tab: 1 },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'storeRead', id: DA },
      { op: 'discard', tab: 2, filePath: doc('b.docx') },
      { op: 'settle', tab: 2, crashed: false },
      { op: 'noteClosedSaved', tab: 3 },
      { op: 'noteStillOpen', tab: 3 },
      { op: 'settle', tab: 3, crashed: false },
    ],
    {},
    'a cancelled quit takes back a "Don\'t Save" answer only',
  ),
  dc(
    [
      { op: 'storeWrite', id: DA, text: 'copy' },
      { op: 'storeInfo', id: DA },
      { op: 'storeState', id: DA, state: 'later' },
      { op: 'storeInfo', id: DA },
      { op: 'storeState', id: DA, state: 'undecided' },
      { op: 'restoreFailed', filePath: doc('a.docx') },
      { op: 'storeInfo', id: DA },
      { op: 'restoreFailed', filePath: doc('none.docx') },
      { op: 'restoreFailed', filePath: '' },
    ],
    {},
    'a restored copy that could not be loaded waits as later',
  ),
  dc(
    [
      { op: 'resolve', filePath: doc('a.docx') },
      { op: 'storeWrite', id: DA, text: 'copy' },
      { op: 'storeState', id: DA, state: 'restoreChosen' },
      { op: 'resolve', filePath: doc('a.docx'), decision: 'original' },
      { op: 'resolve', filePath: doc('a.docx'), decision: 'restore' },
      { op: 'storeInfo', id: DA },
      { op: 'resolve', filePath: doc('none.docx'), decision: 'restore' },
    ],
    {},
    'the shell decided: original, restore (the copy and its description), restore without a copy',
  ),
  dc(
    [
      { op: 'storeWrite', id: DA, text: 'copy' },
      { op: 'resolve', filePath: doc('a.docx') },
      { op: 'storeInfo', id: DA },
      { op: 'resolve', filePath: doc('a.docx') },
      { op: 'storeRead', id: DA },
    ],
    { response: [0, 1] },
    'the per-file prompt: restore, then discard',
  ),
  dc(
    [
      seed('changed.docx', FUTURE),
      { op: 'storeWrite', id: F('docs', orig('changed.docx')), text: 'c' },
      { op: 'resolve', filePath: orig('changed.docx') },
    ],
    { lang: 'ko', response: Number.NaN, parent: 'live' },
    'the box names the file and says it changed after the copy',
  ),
  dc(
    [
      { op: 'storeWrite', id: DA, text: 'copy' },
      { op: 'resolve', filePath: doc('a.docx') },
      { op: 'storeRead', id: DA },
    ],
    { headless: true, response: 1 },
    'a headless export never asks and leaves the copy',
  ),
  dc(
    [
      { op: 'discard', tab: 1, filePath: doc('a.docx') },
      dwrite(1, toFile('a.docx'), bytes('blocked')),
      { op: 'storeRead', id: DA },
      { op: 'resolve', filePath: doc('a.docx'), decision: 'original' },
      dwrite(1, toFile('a.docx'), bytes('again')),
      { op: 'storeRead', id: DA },
    ],
    {},
    'opening the file lifts the block of an earlier "Don\'t Save"',
  ),
  dc(
    [
      { op: 'storeWrite', id: DU('seed-1'), text: 'untitled copy', title: 'Seed' },
      { op: 'storeState', id: DU('seed-1'), state: 'later' },
      { op: 'take', tab: 1, copy: DU('seed-1'), title: 'Seed', ext: '.docx', accept: 'all' },
      { op: 'untitledOf', tab: 1 },
      { op: 'storeInfo', id: DU('seed-1') },
      { op: 'take', tab: 1, copy: DU('seed-1'), title: 'Seed', ext: '.docx', accept: 'none' },
      { op: 'take', tab: 1, copy: DU('missing'), title: 'x', ext: '.docx', accept: 'all' },
    ],
    {},
    'an untitled copy keeps its slot; a copy the editor refuses, or one that is gone, loads nothing',
  ),
  dc(
    [
      { op: 'storeWrite', id: DA, text: 'orphan', title: 'a.docx' },
      { op: 'touch', dir: '$DIR/ud', mtimeMs: 1_700_000_000_000 },
      { op: 'take', tab: 1, copy: DA, title: 'a.docx', ext: '.docx', accept: 'nonEmpty' },
      { op: 'untitledOf', tab: 1 },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'storeInfo', id: DU('uuid-1') },
      { op: 'storeWrite', id: DB, text: '', title: 'b.docx' },
      { op: 'touch', dir: '$DIR/ud', mtimeMs: 1_700_000_000_000 },
      { op: 'take', tab: 2, copy: DB, title: 'b.docx', ext: '.odt', accept: 'nonEmpty' },
      { op: 'storeWrite', id: F('docs', doc('c.docx')), text: 'c', title: 'c.docx' },
      { op: 'touch', dir: '$DIR/ud', mtimeMs: 1_700_000_000_000 },
      {
        op: 'take',
        tab: 3,
        copy: F('docs', doc('c.docx')),
        title: 'c.docx',
        ext: '.odt',
        accept: 'all',
      },
      { op: 'storeInfo', id: DU('uuid-2', '.odt') },
    ],
    {},
    'a file copy whose original is missing moves into a new untitled slot, undecided',
  ),
  dc(
    [
      { op: 'storeWrite', id: DU('first'), text: 'one' },
      { op: 'storeWrite', id: DU('second'), text: 'two' },
      { op: 'take', tab: 1, copy: DU('first'), title: 'One', ext: '.docx', accept: 'all' },
      { op: 'take', tab: 1, copy: DU('first'), title: 'One', ext: '.docx', accept: 'all' },
      { op: 'take', tab: 1, copy: DU('second'), title: 'Two', ext: '.docx', accept: 'all' },
      { op: 'storeRead', id: DU('first') },
      { op: 'storeRead', id: DU('second') },
      { op: 'untitledOf', tab: 1 },
    ],
    {},
    'the tab takes another copy: the slot it had goes',
  ),
  dc(
    [
      dwrite(1, toFile(''), bytes('x')),
      { op: 'noteSaved', tab: 1, paths: [''] },
      { op: 'fileIdentity', filePath: doc('x.docx') },
      { op: 'fileIdentity', filePath: '' },
    ],
    {},
    'a path that cannot name a copy: the store refuses and the error reaches the caller',
  ),
  dc(
    [
      dwrite(1, toFile('a.docx'), bytes('a')),
      { op: 'noteClosedSaved', tab: 1 },
      dwrite(2, toFile('b.docx'), bytes('b')),
      { op: 'noteCloseCheck', tab: 2, dirty: false },
      { op: 'shutdown', on: true },
      { op: 'settle', tab: 1, crashed: false },
      { op: 'settle', tab: 2, crashed: false },
      { op: 'storeRead', id: DA },
      { op: 'storeRead', id: DB },
      { op: 'shutdown', on: false },
    ],
    {},
    'while the app ends only a save and "Don\'t Save" delete: a clean close keeps its copy',
  ),
  dc(
    [
      dwrite(1, toUntitled('.docx'), bytes('u')),
      { op: 'settle', tab: 1, crashed: true },
      { op: 'untitledOf', tab: 1 },
      { op: 'storeRead', id: DU('uuid-1') },
      dwrite(2, toFile('a.docx'), bytes('a')),
      { op: 'noteSaved', tab: 2, paths: [doc('a.docx')] },
      dwrite(2, toFile('a.docx'), bytes('a2')),
      { op: 'settle', tab: 2, crashed: false },
      { op: 'storeRead', id: DA },
    ],
    {},
    'a crashed tab is forgotten but keeps its copies',
  ),
  dc(
    [
      { op: 'storeWrite', id: DU('only'), text: 'one' },
      { op: 'take', tab: 1, copy: DU('only'), title: 'One', ext: '.docx', accept: 'all' },
      { op: 'take', tab: 1, copy: DU('only'), title: 'One', ext: '.docx', accept: 'all' },
      { op: 'storeRead', id: DU('only') },
      { op: 'untitledOf', tab: 1 },
    ],
    {},
    'taking the copy the tab already holds again does not delete it',
  ),
  dc(
    [
      { op: 'storeWrite', id: DA, text: 'orphan', title: 'a.docx' },
      // the adopted meta's writtenAt is the copy's mtime, which the disk sets
      { op: 'touch', dir: '$DIR/ud', mtimeMs: 1_700_000_000_000 },
      { op: 'take', tab: 1, copy: DA, title: 'a.docx', ext: '.docx', accept: 'all' },
      { op: 'storeRead', id: DU('uuid-1') },
      { op: 'storeRead', id: DA },
    ],
    {},
    'a file copy is adopted from the docs folder into the untitled slot',
  ),
]

// ---------------------------------------------------------------------------
// pdf-recovery.ts
// ---------------------------------------------------------------------------

interface PdfScenario extends EnvOptions {
  lang?: string
  response?: number | number[]
  parent?: 'live' | 'destroyed'
  storeMode?: 'ok' | 'none' | 'throws'
  untitledPrefix?: string
  workDir: string
  steps: Step[]
}

async function runPdf(o: PdfScenario, cx: TsContext) {
  return inEnv(o, cx, async (env) => {
    const prefix = o.untitledPrefix ?? '/skill-tmp/'
    const recovery = pdfRecovery.createPdfRecovery({
      store: () => {
        if (o.storeMode === 'throws') throw new Error('no store')
        return o.storeMode === 'none' ? null : env.store
      },
      dialog: fakeDialog(o.response, cx.log) as never,
      parentOf: () => fakeParent(o.parent) as never,
      lang: () => o.lang ?? 'en',
      isUntitledCopyPath: (path: string) => path.startsWith(prefix),
      workDir: () => o.workDir,
    })
    const text = (value: Uint8Array | null): string | null =>
      value ? Buffer.from(value).toString('utf8') : null
    const maker = (spec: Step): (() => Promise<Uint8Array | null>) => {
      return async () => {
        cx.log('make', spec.mode)
        if (spec.mode === 'throws') throw new Error('make failed')
        if (spec.mode === 'null') return null
        if (spec.during?.op === 'dontSave') recovery.dontSave(spec.during.id, spec.during.path)
        return new Uint8Array(Buffer.from(spec.text as string, 'latin1'))
      }
    }
    return playSteps(o.steps, o, env, async (step) => {
      switch (step.op) {
        case 'resolvedNow':
          return recovery.resolvedNow({ id: step.id }, step.path)
        case 'resolveOnOpen':
          return void (await recovery.resolveOnOpen({ id: step.id }, step.path))
        case 'markConsumed':
          return void recovery.markConsumed(step.id)
        case 'hasConsumed':
          return recovery.hasConsumed(step.id)
        case 'setDecision':
          return void recovery.setDecision(step.id, step.path, step.decision)
        case 'viewBytes':
          return text(recovery.viewBytes(step.id, step.path))
        case 'unsavedFromCopy':
          return recovery.unsavedFromCopy(step.id, step.path)
        case 'write':
          return recovery.writeCopy(step.id, step.path, maker(step.make))
        case 'savedInPlace':
          return void (await recovery.savedInPlace(step.id, step.path, async () => {
            cx.log('written', step.written.mode)
            if (step.written.mode === 'throws') throw new Error('read back failed')
            return new Uint8Array(Buffer.from(step.written.text as string, 'latin1'))
          }))
        case 'adopted':
          return void recovery.adopted(step.id, step.old, step.target)
        case 'movedToNewFile':
          return void recovery.movedToNewFile(step.id, step.old, step.target)
        case 'discardedForDisk':
          return void recovery.discardedForDisk(step.id, step.path)
        case 'saveAsDefaultPath':
          return recovery.saveAsDefaultPath(step.id, step.path)
        case 'dontSave':
          return void recovery.dontSave(step.id, step.path ?? undefined)
        case 'closeCancelled':
          return recovery.closeCancelled(step.id)
        case 'renamed':
          return void (await recovery.renamed(step.id, step.old, step.new))
        case 'openUntitled':
          return recovery.openUntitled(step.id, {
            copy: step.copy,
            title: step.title,
            ...(step.saveAsDefaultPath === undefined
              ? {}
              : { saveAsDefaultPath: step.saveAsDefaultPath }),
          })
        case 'reportUnprotectable':
          return recovery.reportUnprotectable(step.id, step.value)
        case 'isUnprotectable':
          return recovery.isUnprotectable(step.id)
        case 'untitledIdentity':
          return recovery.untitledIdentity(step.id)
        case 'markCrashed':
          return void recovery.markCrashed(step.id)
        case 'destroyed':
          return void recovery.destroyed(step.id, step.dirty)
        case 'sweep':
          return void (await recovery.sweepWorkFiles(step.maxAgeMs ?? undefined))
        default:
          throw new Error(`no such step: ${step.op}`)
      }
    })
  })
}

const pdfWorld = (steps: Step[], extra: Partial<PdfScenario> = {}): PdfScenario => ({
  userData: '$DIR/ud',
  orig: ORIG,
  now: NOW,
  workDir: '$DIR/work',
  ...extra,
  steps,
})
const pc = (
  steps: Step[],
  extra: Partial<PdfScenario> = {},
  note?: string,
  files?: Record<string, FileSpec>,
): Case => ({ args: [pdfWorld(steps, extra)], files, note })

const PA = F('pdf', doc('a.pdf'))
const PB = F('pdf', doc('b.pdf'))
const SKILL = '/skill-tmp/template.pdf'
const make = (text: string, extra: Record<string, unknown> = {}) => ({
  mode: 'bytes',
  text,
  ...extra,
})
const pwrite = (id: number, path: string, makeSpec: unknown): Step => ({
  op: 'write',
  id,
  path,
  make: makeSpec,
})
const resolveOpen = (id: number, path: string): Step => ({ op: 'resolveOnOpen', id, path })

const pdfCases: Case[] = [
  pc(
    [
      { op: 'resolvedNow', id: 1, path: doc('a.pdf') },
      { op: 'resolvedNow', id: 1, path: doc('a.pdf') },
      { op: 'resolvedNow', id: 1, path: SKILL },
      { op: 'storeWrite', id: PB, text: 'copy' },
      { op: 'resolvedNow', id: 1, path: doc('b.pdf') },
      { op: 'resolvedNow', id: 2, path: doc('b.pdf') },
      { op: 'setDecision', id: 3, path: doc('b.pdf'), decision: 'original' },
      { op: 'resolvedNow', id: 3, path: doc('b.pdf') },
      { op: 'resolvedNow', id: 3, path: doc('a.pdf') },
    ],
    {},
    'a path that needs no question is recorded; a copy, or a decision waiting, needs resolveOnOpen',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: 'copy' },
      { op: 'resolvedNow', id: 1, path: doc('a.pdf') },
      { op: 'resolvedNow', id: 1, path: SKILL },
      { op: 'resolvedNow', id: 1, path: doc('plain.pdf') },
    ],
    { storeMode: 'none' },
    'no store: the file opens as saved',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: 'copy' },
      { op: 'resolvedNow', id: 1, path: doc('a.pdf') },
      resolveOpen(1, doc('a.pdf')),
      { op: 'viewBytes', id: 1, path: doc('a.pdf') },
      pwrite(1, doc('a.pdf'), make('x')),
    ],
    { storeMode: 'throws' },
    'a store that throws is no store',
  ),
  pc(
    [
      { op: 'hasConsumed', id: 1 },
      { op: 'markConsumed', id: 1 },
      { op: 'hasConsumed', id: 1 },
      { op: 'storeWrite', id: PA, text: '%PDF copy' },
      resolveOpen(2, doc('a.pdf')),
      { op: 'hasConsumed', id: 2 },
      { op: 'viewBytes', id: 2, path: doc('a.pdf') },
      { op: 'viewBytes', id: 2, path: doc('other.pdf') },
      { op: 'unsavedFromCopy', id: 2, path: doc('a.pdf') },
      { op: 'unsavedFromCopy', id: 2, path: doc('other.pdf') },
      { op: 'unsavedFromCopy', id: 9, path: doc('a.pdf') },
      { op: 'viewBytes', id: 9, path: doc('a.pdf') },
      { op: 'storeInfo', id: PA },
      resolveOpen(2, doc('a.pdf')),
      { op: 'destroyed', id: 2, dirty: false },
      { op: 'storeRead', id: PA },
    ],
    { response: 0 },
    'the per-file prompt: restore keeps the copy in memory and marks the tab as unsaved',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: '%PDF copy' },
      resolveOpen(1, doc('a.pdf')),
      { op: 'viewBytes', id: 1, path: doc('a.pdf') },
      { op: 'storeRead', id: PA },
    ],
    { response: 1, parent: 'live', lang: 'ko' },
    'the per-file prompt: discard opens the file and deletes the copy',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: 'copy' },
      { op: 'storeWrite', id: PB, text: 'bcopy' },
      { op: 'storeState', id: PA, state: 'restoreChosen' },
      { op: 'setDecision', id: 1, path: doc('a.pdf'), decision: 'restore' },
      resolveOpen(1, doc('a.pdf')),
      { op: 'viewBytes', id: 1, path: doc('a.pdf') },
      { op: 'storeInfo', id: PA },
      { op: 'setDecision', id: 1, path: doc('a.pdf'), decision: 'original' },
      { op: 'viewBytes', id: 1, path: doc('a.pdf') },
      { op: 'unsavedFromCopy', id: 1, path: doc('a.pdf') },
      resolveOpen(1, doc('a.pdf')),
      { op: 'viewBytes', id: 1, path: doc('a.pdf') },
      { op: 'setDecision', id: 2, path: doc('none.pdf'), decision: 'restore' },
      resolveOpen(2, doc('none.pdf')),
      { op: 'viewBytes', id: 2, path: doc('none.pdf') },
      { op: 'setDecision', id: 3, path: doc('a.pdf'), decision: 'restore' },
      resolveOpen(3, doc('b.pdf')),
      { op: 'viewBytes', id: 3, path: doc('b.pdf') },
    ],
    { response: 1 },
    'the shell decided: restore loads the copy, original does not, restore without a copy loads nothing; a decision is for its own path',
  ),
  pc(
    [
      { op: 'storeWrite', id: F('pdf', SKILL), text: '%PDF stale' },
      resolveOpen(1, SKILL),
      { op: 'viewBytes', id: 1, path: SKILL },
      { op: 'resolvedNow', id: 1, path: SKILL },
      pwrite(1, SKILL, make('%PDF template')),
      { op: 'untitledIdentity', id: 1 },
      { op: 'storeInfo', id: U('pdf', 'uuid-1', '.pdf') },
      { op: 'unsavedFromCopy', id: 1, path: SKILL },
      { op: 'saveAsDefaultPath', id: 1, path: SKILL },
    ],
    { response: 0 },
    "a skill template's copy: an untitled document with its own slot, titled by its file name",
  ),
  pc(
    [
      pwrite(1, doc('a.pdf'), make('x')),
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'storeRead', id: PA },
      { op: 'storeInfo', id: PA },
      pwrite(1, doc('other.pdf'), make('y')),
      pwrite(1, doc('a.pdf'), make('%PDF two')),
      { op: 'storeRead', id: PA },
    ],
    {},
    'writing needs the path answered first; a path that is not the one answered is skipped',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), { mode: 'null' }),
      { op: 'isUnprotectable', id: 1 },
      pwrite(1, doc('a.pdf'), make('%PDF later')),
      { op: 'reportUnprotectable', id: 1, value: false },
      { op: 'reportUnprotectable', id: 1, value: false },
      { op: 'storeRead', id: PA },
    ],
    { lang: 'ko' },
    'a document found encrypted gets no copy, now or later, and one notice',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), { mode: 'throws' }),
      pwrite(1, doc('a.pdf'), make('%PDF ok')),
      { op: 'storeRead', id: PA },
    ],
    {},
    'a failed serialization is reported as failed and the next one goes through',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      { op: 'reportUnprotectable', id: 1, value: true },
      { op: 'reportUnprotectable', id: 1, value: true },
      { op: 'isUnprotectable', id: 1 },
      pwrite(1, doc('a.pdf'), make('%PDF x')),
      { op: 'reportUnprotectable', id: 1, value: false },
      { op: 'isUnprotectable', id: 1 },
      pwrite(1, doc('a.pdf'), make('%PDF y')),
      { op: 'isUnprotectable', id: 77 },
    ],
    { lang: 'en' },
    'the renderer reports a protected document: one notice, no copy until it says otherwise',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(
        1,
        doc('a.pdf'),
        make('%PDF one', { during: { op: 'dontSave', id: 1, path: doc('a.pdf') } }),
      ),
      { op: 'storeRead', id: PA },
      pwrite(1, doc('a.pdf'), make('%PDF two')),
      { op: 'closeCancelled', id: 1 },
      pwrite(1, doc('a.pdf'), make('%PDF three')),
      { op: 'storeRead', id: PA },
      { op: 'closeCancelled', id: 1 },
      { op: 'closeCancelled', id: 9 },
    ],
    {},
    '"Don\'t Save" while the bytes are made: superseded, nothing is written until the close is cancelled',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'dontSave', id: 1, path: doc('a.pdf') },
      { op: 'storeRead', id: PA },
      { op: 'destroyed', id: 1, dirty: true },
      { op: 'storeRead', id: PA },
      resolveOpen(2, doc('b.pdf')),
      pwrite(2, doc('b.pdf'), make('%PDF b')),
      { op: 'dontSave', id: 2, path: null },
      { op: 'storeRead', id: PB },
      { op: 'dontSave', id: 5, path: null },
    ],
    {},
    'after "Don\'t Save" the copy goes with the view whatever it wrote since',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'destroyed', id: 1, dirty: true },
      { op: 'storeRead', id: PA },
      resolveOpen(2, doc('b.pdf')),
      pwrite(2, doc('b.pdf'), make('%PDF b')),
      { op: 'markCrashed', id: 2 },
      { op: 'destroyed', id: 2, dirty: false },
      { op: 'storeRead', id: PB },
      resolveOpen(3, doc('c.pdf')),
      pwrite(3, doc('c.pdf'), make('%PDF c')),
      { op: 'destroyed', id: 3, dirty: false },
      { op: 'storeRead', id: F('pdf', doc('c.pdf')) },
      { op: 'destroyed', id: 3, dirty: false },
    ],
    {},
    'a dirty or crashed view keeps its copy; a clean one that wrote it deletes it',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      {
        op: 'savedInPlace',
        id: 1,
        path: doc('a.pdf'),
        written: { mode: 'bytes', text: '%PDF saved' },
      },
      { op: 'storeRead', id: PA },
      { op: 'unsavedFromCopy', id: 1, path: doc('a.pdf') },
      pwrite(1, doc('a.pdf'), make('%PDF two')),
      { op: 'destroyed', id: 1, dirty: false },
      { op: 'storeRead', id: PA },
    ],
    {},
    'a save in place deletes the copy and the view no longer owns one',
  ),
  pc(
    [
      pwrite(1, doc('x.pdf'), make('x')),
      resolveOpen(1, SKILL),
      pwrite(1, SKILL, make('%PDF template')),
      {
        op: 'savedInPlace',
        id: 1,
        path: SKILL,
        written: { mode: 'bytes', text: '%PDF refreshed' },
      },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
      {
        op: 'savedInPlace',
        id: 1,
        path: SKILL,
        written: { mode: 'bytes', text: '%PDF\n/Encrypt 4 0 R' },
      },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
      { op: 'savedInPlace', id: 1, path: SKILL, written: { mode: 'throws' } },
      { op: 'reportUnprotectable', id: 1, value: true },
      {
        op: 'savedInPlace',
        id: 1,
        path: SKILL,
        written: { mode: 'bytes', text: '%PDF unreachable' },
      },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
    ],
    {},
    'a save into an untitled working file refreshes its copy, unless it came out encrypted or protected',
  ),
  pc(
    [
      resolveOpen(1, SKILL),
      { op: 'savedInPlace', id: 1, path: SKILL, written: { mode: 'bytes', text: '%PDF x' } },
    ],
    { storeMode: 'none' },
    'no store: a save in place has nothing to refresh',
  ),
  pc(
    [
      resolveOpen(1, SKILL),
      pwrite(1, SKILL, make('%PDF template')),
      { op: 'adopted', id: 1, old: SKILL, target: doc('saved.pdf') },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
      { op: 'untitledIdentity', id: 1 },
      { op: 'unsavedFromCopy', id: 1, path: doc('saved.pdf') },
      { op: 'resolvedNow', id: 1, path: doc('saved.pdf') },
      { op: 'adopted', id: 2, old: doc('x.pdf'), target: doc('y.pdf') },
      { op: 'resolvedNow', id: 2, path: doc('y.pdf') },
    ],
    {},
    'an untitled document saved to a file: its copy goes and the file is the answered path',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'movedToNewFile', id: 1, old: doc('a.pdf'), target: doc('redacted.pdf') },
      { op: 'storeRead', id: PA },
      { op: 'resolvedNow', id: 1, path: doc('redacted.pdf') },
      resolveOpen(2, SKILL),
      pwrite(2, SKILL, make('%PDF template')),
      { op: 'movedToNewFile', id: 2, old: SKILL, target: doc('signed.pdf') },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
      { op: 'untitledIdentity', id: 2 },
      { op: 'movedToNewFile', id: 8, old: doc('x.pdf'), target: doc('y.pdf') },
    ],
    {},
    'a clean view that wrote a new file: the old copy is deleted, not moved onto the new file',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'movedToNewFile', id: 1, old: doc('other.pdf'), target: doc('n.pdf') },
      { op: 'storeRead', id: PA },
    ],
    {},
    'a move away from another path leaves the copy this view owns',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'discardedForDisk', id: 1, path: doc('a.pdf') },
      { op: 'storeRead', id: PA },
      { op: 'discardedForDisk', id: 1, path: doc('a.pdf') },
      resolveOpen(2, SKILL),
      pwrite(2, SKILL, make('%PDF template')),
      { op: 'discardedForDisk', id: 2, path: SKILL },
      { op: 'storeRead', id: U('pdf', 'uuid-1', '.pdf') },
      { op: 'discardedForDisk', id: 7, path: SKILL },
    ],
    {},
    'a reload from disk drops the copy of the dropped edits; untitled documents keep theirs',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: '%PDF copy' },
      resolveOpen(1, doc('a.pdf')),
      { op: 'renamed', id: 1, old: doc('a.pdf'), new: doc('b.pdf') },
      { op: 'storeRead', id: PA },
      { op: 'storeRead', id: PB },
      { op: 'viewBytes', id: 1, path: doc('b.pdf') },
      { op: 'resolvedNow', id: 1, path: doc('b.pdf') },
      { op: 'renamed', id: 1, old: doc('b.pdf'), new: doc('c.pdf') },
      { op: 'storeRead', id: F('pdf', doc('c.pdf')) },
      { op: 'renamed', id: 4, old: doc('x.pdf'), new: doc('y.pdf') },
    ],
    { response: 0 },
    'a rename: the restore and the copy follow the new path',
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      { op: 'renamed', id: 1, old: doc('a.pdf'), new: doc('b.pdf') },
      { op: 'resolvedNow', id: 1, path: doc('b.pdf') },
      pwrite(1, doc('b.pdf'), make('%PDF b')),
      { op: 'renamed', id: 1, old: doc('zzz.pdf'), new: doc('c.pdf') },
      { op: 'storeRead', id: PB },
      { op: 'storeDelete', id: PB, reason: 'saved' },
      { op: 'renamed', id: 1, old: doc('b.pdf'), new: doc('d.pdf') },
      { op: 'storeRead', id: F('pdf', doc('d.pdf')) },
    ],
    {},
    'a rename with no copy to move, or whose copy is gone, only follows the path',
  ),
  pc(
    [
      {
        op: 'storeWrite',
        id: U('pdf', 'seed-1', '.pdf'),
        text: '%PDF untitled',
        title: 'Untitled copy',
      },
      { op: 'storeState', id: U('pdf', 'seed-1', '.pdf'), state: 'later' },
      { op: 'openUntitled', id: 1, copy: U('pdf', 'seed-1', '.pdf'), title: 'Untitled copy' },
      { op: 'storeInfo', id: U('pdf', 'seed-1', '.pdf') },
      { op: 'untitledIdentity', id: 1 },
      { op: 'unsavedFromCopy', id: 1, path: '$DIR/work/uuid-1.pdf' },
      { op: 'resolvedNow', id: 1, path: '$DIR/work/uuid-1.pdf' },
      pwrite(1, '$DIR/work/uuid-1.pdf', make('%PDF edited')),
      { op: 'saveAsDefaultPath', id: 1, path: '$DIR/work/uuid-1.pdf' },
      { op: 'storeInfo', id: U('pdf', 'seed-1', '.pdf') },
      { op: 'adopted', id: 1, old: doc('zzz.pdf'), target: doc('t.pdf') },
      { op: 'ls', dir: '$DIR/work' },
      { op: 'openUntitled', id: 1, copy: U('pdf', 'seed-1', '.pdf'), title: 'Again' },
      { op: 'ls', dir: '$DIR/work' },
      { op: 'destroyed', id: 1, dirty: true },
      { op: 'storeRead', id: U('pdf', 'seed-1', '.pdf') },
    ],
    {},
    'an untitled copy becomes a working file the view edits; the file goes with the view',
  ),
  pc(
    [
      { op: 'storeWrite', id: PA, text: '%PDF orphan', title: 'a.pdf' },
      { op: 'openUntitled', id: 1, copy: PA, title: 'a.pdf', saveAsDefaultPath: doc('a.pdf') },
      { op: 'saveAsDefaultPath', id: 1, path: '$DIR/work/uuid-1.pdf' },
      { op: 'saveAsDefaultPath', id: 1, path: doc('a.pdf') },
      { op: 'openUntitled', id: 2, copy: PB, title: 'b.pdf' },
      { op: 'storeWrite', id: F('docs', doc('a.docx')), text: '%PDF docs' },
      { op: 'openUntitled', id: 3, copy: F('docs', doc('a.docx')), title: 'x' },
      { op: 'openUntitled', id: 4, copy: U('pdf', 'nothing', '.pdf'), title: 'x' },
      { op: 'openUntitled', id: 5, copy: PA, title: 'x', saveAsDefaultPath: '' },
      { op: 'saveAsDefaultPath', id: 5, path: '$DIR/work/uuid-2.pdf' },
      { op: 'sweep' },
      { op: 'destroyed', id: 1, dirty: false },
    ],
    {},
    'a copy whose original is missing names it as the first Save As; other kinds and gone copies load nothing',
  ),
  pc(
    [{ op: 'openUntitled', id: 1, copy: U('pdf', 'seed-1', '.pdf'), title: 'x' }],
    { storeMode: 'none' },
    'no store: nothing to open',
  ),
  pc(
    [{ op: 'sweep' }, { op: 'sweep', maxAgeMs: 1000 }, { op: 'sweep', maxAgeMs: 0 }],
    {},
    'no working folder: nothing to sweep',
  ),
  pc(
    [
      { op: 'storeWrite', id: U('pdf', 'seed-1', '.pdf'), text: '%PDF untitled' },
      { op: 'openUntitled', id: 1, copy: U('pdf', 'seed-1', '.pdf'), title: 'x' },
      { op: 'ls', dir: '$DIR/work' },
      { op: 'sweep' },
      { op: 'ls', dir: '$DIR/work' },
      { op: 'sweep', maxAgeMs: 0 },
      { op: 'ls', dir: '$DIR/work' },
    ],
    {},
    'only files older than the limit go, never a folder, and never one an open view uses',
    {
      'work/old.pdf': { text: 'old', mtimeMs: NOW - DAY - 1000 },
      'work/edge.pdf': { text: 'edge', mtimeMs: NOW - DAY },
      'work/fresh.pdf': { text: 'fresh', mtimeMs: NOW - 1000 },
      'work/future.pdf': { text: 'future', mtimeMs: NOW + DAY },
      'work/folder': { dir: true },
      'work/folder/inner.pdf': { text: 'inner', mtimeMs: NOW - 10 * DAY },
    },
  ),
  pc(
    [
      { op: 'sweep' },
      { op: 'ls', dir: '$DIR/work' },
      { op: 'sweep', maxAgeMs: 5000 },
      { op: 'ls', dir: '$DIR/work' },
    ],
    {},
    'a limit of the caller',
    {
      'work/a.pdf': { text: 'a', mtimeMs: NOW - 6000 },
      'work/b.pdf': { text: 'b', mtimeMs: NOW - 4000 },
      'work/c.pdf': { text: 'c', mtimeMs: NOW - 2 * DAY },
    },
  ),
  pc(
    [
      resolveOpen(1, doc('a.pdf')),
      pwrite(1, doc('a.pdf'), make('%PDF one', { during: { op: 'dontSave', id: 1, path: null } })),
      { op: 'storeRead', id: PA },
    ],
    {},
    "Don't Save with no copy to delete while the bytes are made still supersedes the write",
  ),
  pc(
    [
      { op: 'resolvedNow', id: 1, path: doc('a.pdf') },
      pwrite(1, doc('a.pdf'), make('%PDF one')),
      { op: 'storeRead', id: PA },
    ],
    {},
    'a path that needs no question is recorded as answered, so the view may write for it',
  ),
  pc(
    [
      {
        op: 'storeWrite',
        id: U('pdf', 'seed-1', '.pdf'),
        text: '%PDF untitled',
        title: 'Untitled copy',
      },
      { op: 'openUntitled', id: 1, copy: U('pdf', 'seed-1', '.pdf'), title: 'Untitled copy' },
      { op: 'now', ms: FUTURE },
      { op: 'sweep' },
      { op: 'ls', dir: '$DIR/work' },
    ],
    {},
    'a working file an open view uses stays however old the clock says it is',
    { 'work/old.pdf': { text: 'old', mtimeMs: NOW - 10 * DAY } },
  ),
]

const encrypted = (text: string, bytesAsView = false): Case => ({
  args: [hexOf(text), bytesAsView],
  note: JSON.stringify(text),
})

// ---------------------------------------------------------------------------
// recovery-policy.ts
// ---------------------------------------------------------------------------

/** a function of the module that reads `crypto.randomUUID` (`uuid-1`, ...) */
function withUuids<T>(run: () => T): T {
  let counter = 0
  const patched = crypto as unknown as { randomUUID: () => string }
  const real = patched.randomUUID
  patched.randomUUID = () => `uuid-${++counter}`
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    patched.randomUUID = real
    syncBuiltinESMExports()
  }
}

const LEGACY = (path: string): string => `${hash(path)}.xlsx`

interface MigrateScenario extends EnvOptions {
  dir: string
  calls: number
}

const migrateCase = (
  o: Partial<MigrateScenario>,
  note: string,
  files: Record<string, FileSpec>,
): Case => ({
  args: [{ userData: '$DIR/ud', dir: '$DIR/ud/sheets-autosave', calls: 1, now: NOW, ...o }],
  files,
  note,
})
const SHEETS_DIR = 'ud/sheets-autosave'
const legacyFile = (path: string, mtimeMs = 1_600_000_000_000): [string, FileSpec] => [
  `${SHEETS_DIR}/${LEGACY(path)}`,
  { text: `workbook of ${path}`, mtimeMs },
]
const index = (listed: unknown): [string, FileSpec] => [
  `${SHEETS_DIR}/unsaved-new.json`,
  typeof listed === 'string' ? listed : JSON.stringify(listed),
]

const sheetsOf = (...bytes: (number | null)[]): unknown[] =>
  bytes.map((sourceXmlBytes) => (sourceXmlBytes === null ? {} : { sourceXmlBytes }))
const MB64 = 64 * 1024 * 1024

export const part: Group = {
  // ---- html/recovery.ts and markdown/recovery.ts
  'html/recovery.RECOVERY_FLUSH_TIMEOUT_MS': {
    ts: () => htmlRecovery.RECOVERY_FLUSH_TIMEOUT_MS,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'html/recovery.createTextRecovery': {
    ts: (args, cx) => runText(htmlRecovery.createTextRecovery as never, args[0] as never, cx),
    cases: textCases,
  },
  'markdown/recovery.RECOVERY_FLUSH_TIMEOUT_MS': {
    ts: () => markdownRecovery.RECOVERY_FLUSH_TIMEOUT_MS,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'markdown/recovery.createTextRecovery': {
    ts: (args, cx) => runText(markdownRecovery.createTextRecovery as never, args[0] as never, cx),
    cases: textCases,
  },

  // ---- docs-recovery.ts
  'docs-recovery.createDocsRecovery': {
    ts: (args, cx) => runDocs(args[0] as DocsScenario, cx),
    cases: docsCases,
  },

  // ---- pdf-recovery.ts
  'pdf-recovery.PDF_RECOVERY_WORK_FILE_MAX_AGE_MS': {
    ts: () => pdfRecovery.PDF_RECOVERY_WORK_FILE_MAX_AGE_MS,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'pdf-recovery.pdfLooksEncrypted': {
    ts: (args) => {
      const raw = Buffer.from(args[0] as string, 'hex')
      return pdfRecovery.pdfLooksEncrypted(args[1] ? raw : new Uint8Array(raw))
    },
    cases: [
      encrypted('%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>'),
      encrypted('%PDF-1.7\ntrailer << /Root 1 0 R >>'),
      encrypted('/Encrypt'),
      encrypted('/Encrypt', true),
      encrypted('/Encrypted'),
      encrypted('/EncryptX /Encrypt/Filter'),
      encrypted('/Encrypt\n'),
      encrypted('/Encrypt('),
      encrypted('/Encrypt<'),
      encrypted('/Encrypt['),
      encrypted('/Encrypt#20'),
      encrypted('/Encryp'),
      encrypted('/Encrypt\u0000'),
      encrypted(''),
      encrypted('/Encrypts /Encrypt\r'),
      encrypted('/Encrypt\t/Encrypt'),
    ],
  },
  'pdf-recovery.createPdfRecovery': {
    ts: (args, cx) => runPdf(args[0] as PdfScenario, cx),
    cases: pdfCases,
  },

  // ---- recovery-policy.ts
  'recovery-policy.MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES': {
    ts: () => policy.MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'recovery-policy.allowsAutomaticWorkbookRecovery': {
    ts: (args) => policy.allowsAutomaticWorkbookRecovery(args[0] as never),
    cases: [
      { args: [[]] },
      { args: [sheetsOf(null)] },
      { args: [sheetsOf(0, 1_000)] },
      { args: [sheetsOf(MB64)] },
      { args: [sheetsOf(MB64 + 1)] },
      { args: [sheetsOf(10, null, MB64 + 1, 5)] },
      { args: [sheetsOf(MB64 - 1, MB64)] },
      { args: [sheetsOf(-1)] },
    ],
  },
  'recovery-policy.sessionRecoveryIdentity': {
    ts: (args) => policy.sessionRecoveryIdentity(args[0] as never),
    cases: [
      { args: [{ path: '/w/a.xlsx' }] },
      { args: [{ path: '/w/a.xlsx', restoreTarget: '/w/real.xlsx' }] },
      { args: [{ path: '/w/a.xlsx', restoreTarget: '' }], note: 'an empty restore target is kept' },
      { args: [{ path: '/w/a.xlsx', password: 'secret' }] },
      { args: [{ path: '/w/a.xlsx', password: '' }], note: 'an empty password is a password' },
      {
        args: [{ path: '/w/a.xlsx', password: 'x', recoveryIdentity: U('sheets', 'u1', '.xlsx') }],
      },
      { args: [{ path: '/t/new.xlsx', recoveryIdentity: U('sheets', 'u1', '.xlsx') }] },
      { args: [{ path: '/t/new.xlsx', unsavedNew: true }] },
      { args: [{ path: '/t/new.xlsx', unsavedNew: false }] },
      { args: [{ path: '/t/a.csv', csvSourcePath: '/w/a.csv' }] },
      { args: [{ path: '/t/a.csv', csvSourcePath: '' }] },
      { args: [{ path: '/t/a.xlsx', suggestSaveAs: '/w/a.xlsx' }] },
      { args: [{ path: '/t/a.xlsx', suggestSaveAs: '' }] },
      {
        args: [
          {
            path: '/t/a.xlsx',
            unsavedNew: true,
            recoveryIdentity: F('sheets', '/w/own.xlsx'),
          },
        ],
      },
    ],
  },
  'recovery-policy.convertedSessionRecovery': {
    ts: (args) =>
      withUuids(() => policy.convertedSessionRecovery(args[0] as never, args[1] as string)),
    cases: [
      { args: [{ csvSourcePath: '/w/a.csv' }, '/t/a.xlsx'] },
      { args: [{ suggestSaveAs: '/w/a.xls' }, '/w/a.xls'] },
      { args: [{ csvSourcePath: '', suggestSaveAs: '/x' }, '/t/b.xlsx'] },
      { args: [{ csvSourcePath: '/w/a.csv', password: 'x' }, '/t/a.xlsx'] },
      { args: [{ csvSourcePath: '/w/a.csv', password: '' }, '/t/a.xlsx'] },
      { args: [{ csvSourcePath: '/w/a.csv', unsavedNew: true }, '/t/a.xlsx'] },
      { args: [{ csvSourcePath: '/w/a.csv', unsavedNew: false }, '/t/a.xlsx'] },
      {
        args: [
          { csvSourcePath: '/w/a.csv', recoveryIdentity: U('sheets', 'u1', '.xlsx') },
          '/t/a.xlsx',
        ],
      },
      { args: [{}, '/w/a.xlsx'] },
    ],
  },
  'recovery-policy.saveAsDefaultFor': {
    ts: (args) => policy.saveAsDefaultFor(args[0] as string),
    cases: [
      { args: ['/w/book.xlsx'] },
      { args: ['/w/book.XLSM'] },
      { args: ['/w/book.xls'] },
      { args: ['/w/data.csv'] },
      { args: ['/w/data.tsv'] },
      { args: ['/w/noext'] },
      { args: ['/w/.hidden'] },
      { args: ['/w/a.b.csv'] },
      { args: ['/w/dir.d/file'] },
      { args: ['/w/a.csv/'], note: 'a trailing separator: the extension is still .csv' },
      { args: ['/w/Axlsx'], note: 'the dot of the pattern is any character' },
      { args: ['/w/book.xlsx\n'], note: '$ does not match before a newline' },
      { args: ['/w/\u{1F600}.csv'] },
      { args: ['/w/data.\u00e9'] },
      { args: [''] },
    ],
  },
  'recovery-policy.untitledWorkbookExt': {
    ts: (args) => policy.untitledWorkbookExt(args[0] as string),
    cases: [
      { args: ['/w/a.xlsm'] },
      { args: ['/w/a.XLSM'] },
      { args: ['/w/a.xlsx'] },
      { args: ['/w/a.csv'] },
      { args: ['/w/noext'] },
      { args: [''] },
      { args: ['/w/a.xlsm/'] },
    ],
  },
  'recovery-policy.LEGACY_UNSAVED_NEW_INDEX': {
    ts: () => policy.LEGACY_UNSAVED_NEW_INDEX,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'recovery-policy.legacyCopyName': {
    ts: (args) => policy.legacyCopyName(args[0] as string),
    cases: [
      { args: ['/w/a.xlsx'] },
      { args: ['/w/b.xlsx'] },
      { args: [''] },
      { args: ['/w/\u{1F600}.xlsx'] },
      { args: ['C:\\w\\a.xlsx'] },
    ],
  },
  'recovery-policy.migrateLegacyUnsavedNew': {
    ts: (args, cx) => {
      const o = args[0] as MigrateScenario
      return inEnv(o, cx, async (env) => {
        const out: unknown[] = []
        for (let i = 0; i < o.calls; i++) {
          out.push(policy.migrateLegacyUnsavedNew(env.store, o.dir))
        }
        return out
      })
    },
    cases: [
      migrateCase({}, 'no index file: nothing to do', {}),
      migrateCase({}, 'one listed workbook is adopted as a later copy and the index goes', {
        ...Object.fromEntries([legacyFile('/w/book.xlsx'), index(['/w/book.xlsx'])]),
      }),
      migrateCase(
        { calls: 2 },
        'a macro workbook keeps its format; an entry with no copy is dropped; duplicates once',
        Object.fromEntries([
          legacyFile('/w/macro.xlsm'),
          legacyFile('/w/plain.xlsx', 1_600_000_100_000),
          index(['/w/macro.xlsm', '/w/gone.xlsx', '/w/plain.xlsx', '/w/macro.xlsm', '', 5, null]),
        ]),
      ),
      migrateCase({}, 'an index that is not JSON is left in place', {
        ...Object.fromEntries([legacyFile('/w/book.xlsx'), index('not json {')]),
      }),
      migrateCase({}, 'an index that is not a list is left in place', {
        ...Object.fromEntries([legacyFile('/w/book.xlsx'), index({ listed: ['/w/book.xlsx'] })]),
      }),
      migrateCase({}, 'a list with nothing usable ends empty', {
        ...Object.fromEntries([index([1, '', null, ['/w/book.xlsx']])]),
      }),
      migrateCase(
        { dir: '$DIR/elsewhere' },
        'a copy outside the store folder stays listed for the next call',
        {
          'elsewhere/unsaved-new.json': JSON.stringify(['/w/book.xlsx']),
          [`elsewhere/${LEGACY('/w/book.xlsx')}`]: { text: 'workbook', mtimeMs: 1_600_000_000_000 },
        },
      ),
      migrateCase({}, 'an index that is a folder cannot be read and stays', {
        [`${SHEETS_DIR}/unsaved-new.json/keep`]: 'x',
      }),
      migrateCase(
        { dir: '$DIR/ud/sheets-autosave' },
        'a read-only store folder: the move fails, the index cannot be rewritten, and the warning says so',
        {
          [`${SHEETS_DIR}/${LEGACY('/w/book.xlsx')}`]: {
            text: 'workbook',
            mtimeMs: 1_600_000_000_000,
          },
          [`${SHEETS_DIR}/unsaved-new.json`]: JSON.stringify(['/w/book.xlsx', '/w/two.xlsx']),
          [SHEETS_DIR]: { dir: true, mode: 0o555 },
        },
      ),
      migrateCase(
        { dir: '$DIR/ud/sheets-autosave' },
        'a read-only store folder: the emptied index cannot be removed and the warning says so',
        {
          [`${SHEETS_DIR}/unsaved-new.json`]: JSON.stringify(['/w/gone.xlsx']),
          [SHEETS_DIR]: { dir: true, mode: 0o555 },
        },
      ),
    ],
  },
}
