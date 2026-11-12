/**
 * Group `b2-recovery`: the crash-recovery store and its contract, labels and
 * prompt, the unsaved-files question, the legacy-import preferences and the
 * save-conflict labels of packages/electron-utils.
 *
 * The recovery store holds process-wide state, so its functions are driven as
 * a scenario: one call carries a folder, a run id, a clock and a list of
 * steps, and answers one entry per step (`op`, then `ok` or `error`). The
 * scenario seeds the store's shared state (a fixed run id), reads the clock
 * from `Date.now` and the random ids from `crypto.randomUUID` (`uuid-1`,
 * `uuid-2`, ...), and both are put back afterwards. The store's folder is the
 * case's `$DIR/ud`, compared through the folder snapshot.
 *
 * A file copy's name is the SHA-1 of its original path, so the originals of
 * the cases live at fixed paths (`ORIG`, written by the `seed` step, removed
 * at the start and the end of a scenario): a path under `$DIR` would give each
 * side another copy name. Times that a case sets are whole seconds, which the
 * two sides read back alike; a time the store's own write gave is the real
 * time of the run and is written `<real>`.
 */
import crypto, { createHash } from 'node:crypto'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LEGACY_IMPORT_KINDS,
  LEGACY_IMPORT_SKIP_KEY,
  readLegacyImportPrompt,
  readLegacyImportSkip,
  writeLegacyImportPrompt,
  writeLegacyImportSkip,
} from '../../../packages/electron-utils/src/legacy-import-prefs.ts'
import {
  registerRecoveryEditor,
  recoveryEditor,
  recoveryEditors,
} from '../../../packages/electron-utils/src/recovery-contract.ts'
import type { RecoveryEditorContract } from '../../../packages/electron-utils/src/recovery-contract.ts'
import {
  RECOVERY_PROMPT_STRINGS,
  recoveryPromptLabels,
  unprotectableNoticeText,
} from '../../../packages/electron-utils/src/recovery-labels.ts'
import {
  promptRecoveryForFile,
  resolveRecoveryOnOpen,
} from '../../../packages/electron-utils/src/recovery-prompt.ts'
import {
  RECOVERY_COPY_MAX_AGE_MS,
  RECOVERY_EDITOR_KINDS,
  createRecoveryStore,
  isAppShuttingDown,
  isRecoveryEditorKind,
  isUntitledIdentity,
  markAppShuttingDown,
  newUntitledRecoveryId,
  recoveryFolderName,
  recoveryRunId,
  resetAppShuttingDown,
  resumeDiscardedCopies,
} from '../../../packages/electron-utils/src/recovery-store.ts'
import type {
  RecoveryCopyInfo,
  RecoveryCopyState,
  RecoveryEditorKind,
  RecoveryIdentity,
  RecoveryWriteOptions,
  RecoveryWriteTicket,
} from '../../../packages/electron-utils/src/recovery-store.ts'
import {
  SAVE_CONFLICT_STRINGS,
  saveConflictLabels,
} from '../../../packages/electron-utils/src/save-conflict-labels.ts'
import {
  UNSAVED_CHANGES_MESSAGE,
  assertFileSaved,
  fileHasUnsavedChanges,
  setOpenFilesSource,
  withoutUnsavedFiles,
} from '../../../packages/electron-utils/src/unsaved-files.ts'
import type { OpenFilesSource } from '../../../packages/electron-utils/src/unsaved-files.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'

const NOW = 1_700_000_000_000
const OLD = 946_684_800_000
const FUTURE = 4_102_444_800_000
const RUN = '0123456789abcdef'
const ORIG = join(tmpdir(), 'main-diff-b2-recovery-orig')

const SHARED = Symbol.for('seuoffice.recovery-store.shared')
const REGISTRY = Symbol.for('seuoffice.recovery-editors')
const holder = globalThis as unknown as Record<symbol, unknown>

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
function masked<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Error) error.message = maskTmp(error.message)
    throw error
  }
}

/** a `[0, 1000)` modification time the case set is kept, the run's real one is masked */
const maskTime = (value: number): number | string => (value % 1000 === 0 ? value : '<real>')

/** the copy's description as the scenario prints it (the keys stay in the store's order) */
function infoOut(info: RecoveryCopyInfo): unknown {
  return {
    ...info,
    writtenAt: info.legacy ? maskTime(info.writtenAt) : info.writtenAt,
    copyMtimeMs: maskTime(info.copyMtimeMs),
  }
}

// ---- the store scenario ----

interface Step {
  op: string
  [key: string]: unknown
}

function writeOptions(
  step: Step,
  tickets: Record<string, RecoveryWriteTicket>,
): RecoveryWriteOptions {
  const ticket = step.ticket
  return {
    title: (step.title as string | null | undefined) ?? undefined,
    ticket:
      typeof ticket === 'string'
        ? tickets[ticket]
        : ticket && typeof ticket === 'object'
          ? (ticket as RecoveryWriteTicket)
          : undefined,
    originalPath: (step.originalPath as string | null | undefined) ?? undefined,
    formulasDropped: (step.formulasDropped as number | null | undefined) ?? undefined,
  }
}

async function runStore(args: unknown[], cx: TsContext): Promise<unknown> {
  const o = args[0] as {
    userData: string
    orig?: string
    runId?: string
    now?: number
    steps: Step[]
  }
  let clock = o.now ?? cx.now
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
  const cleanOrig = (): void => {
    if (o.orig) rmSync(o.orig, { recursive: true, force: true })
  }
  cleanOrig()
  Date.now = () => clock
  patched.randomUUID = () => `uuid-${++counter}`
  syncBuiltinESMExports()
  try {
    const store = createRecoveryStore({ userDataDir: () => o.userData })
    const tickets: Record<string, RecoveryWriteTicket> = {}
    const out: unknown[] = []
    for (const step of o.steps) {
      const entry: Record<string, unknown> = { op: step.op }
      const id = step.id as RecoveryIdentity
      try {
        let value: unknown
        switch (step.op) {
          case 'now':
            clock = step.ms as number
            break
          case 'seed': {
            const path = join(o.orig as string, step.name as string)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, step.text as string)
            const ms = step.mtimeMs as number
            utimesSync(path, ms / 1000, ms / 1000)
            break
          }
          case 'touch':
            try {
              const ms = step.mtimeMs as number
              utimesSync(step.path as string, ms / 1000, ms / 1000)
            } catch {
              /* a missing path is left alone on both sides */
            }
            break
          case 'copyPath':
            value = store.copyPath(id)
            break
          case 'beginWrite': {
            const ticket = store.beginWrite(id)
            if (typeof step.name === 'string') tickets[step.name] = ticket
            value = ticket
            break
          }
          case 'writeCopy':
            value = await store.writeCopy(
              id,
              Buffer.from(step.text as string),
              writeOptions(step, tickets),
            )
            break
          case 'writeStreamed': {
            const w = step.writer as { mode: string; text?: string; reason?: string }
            value = await store.writeCopyStreamed(
              id,
              async (temp) => {
                if (w.mode === 'nothing') return
                writeFileSync(temp, w.text ?? '')
                if (w.mode === 'throw') throw new Error('writer failed')
                if (w.mode === 'deleteDuring') {
                  store.deleteCopy(id, (w.reason ?? 'saved') as 'saved')
                }
              },
              writeOptions(step, tickets),
            )
            break
          }
          case 'deleteCopy':
            value = store.deleteCopy(id, step.reason as 'saved')
            break
          case 'isDiscarded':
            value = store.isDiscarded(id)
            break
          case 'clearDiscarded':
            store.clearDiscarded(id)
            break
          case 'copyInfo': {
            const info = store.copyInfo(id)
            value = info ? infoOut(info) : null
            break
          }
          case 'readCopy': {
            const bytes = await store.readCopy(id)
            value = bytes ? bytes.toString('hex') : null
            break
          }
          case 'openPlan': {
            const plan = store.openPlan(id)
            value =
              plan.action === 'none' ? plan : { action: plan.action, copy: infoOut(plan.copy) }
            break
          }
          case 'setCopyState':
            value = store.setCopyState(id, step.state as RecoveryCopyState)
            break
          case 'applyLaunchDecision':
            value = store.applyLaunchDecision(id, step.decision as 'restore')
            break
          case 'markCopyLoaded':
            value = store.markCopyLoaded(id)
            break
          case 'listCopies':
            value = store.listCopies((step.filter as never) ?? undefined).map(infoOut)
            break
          case 'hasUnresolvedCopies':
            value = store.hasUnresolvedCopies()
            break
          case 'pruneStaleCopies':
            value = store.pruneStaleCopies(
              (step.maxAgeMs as number | null | undefined) ?? undefined,
            )
            break
          case 'adoptUntitledCopy':
            value = store.adoptUntitledCopy(
              step.kind as RecoveryEditorKind,
              step.source as string,
              {
                title: step.title as string,
                ext: step.ext as string,
                state: (step.state as RecoveryCopyState | null | undefined) ?? undefined,
                originalPath: (step.originalPath as string | null | undefined) ?? undefined,
              },
            )
            break
          case 'recoveryRunId':
            value = recoveryRunId()
            break
          case 'markAppShuttingDown':
            markAppShuttingDown()
            break
          case 'resetAppShuttingDown':
            resetAppShuttingDown()
            break
          case 'isAppShuttingDown':
            value = isAppShuttingDown()
            break
          case 'resumeDiscardedCopies':
            resumeDiscardedCopies()
            break
          case 'newUntitledRecoveryId':
            value = newUntitledRecoveryId()
            break
          default:
            throw new Error(`no such step: ${step.op}`)
        }
        if (value !== undefined) entry.ok = value
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown }
        entry.error = {
          code: typeof e.code === 'string' ? e.code : null,
          message: maskTmp(typeof e.message === 'string' ? e.message : String(error)),
        }
      }
      out.push(entry)
    }
    return out
  } finally {
    Date.now = realNow
    patched.randomUUID = realUuid
    syncBuiltinESMExports()
    delete holder[SHARED]
    cleanOrig()
  }
}

// ---- identities, copy names, seeded files ----

const doc = (name: string): string => `${ORIG}/${name}`
const F = (kind: string, name: string) => ({ kind, filePath: doc(name) })
const U = (kind: string, id: string, ext: string) => ({ kind, untitledId: id, ext })
const hash = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 16)
/** the copy's name under `ud/` for a file document of `name` */
const copyRel = (kind: string, name: string, ext: string): string =>
  `ud/${kind}-autosave/${hash(doc(name))}${ext}`
const untitledRel = (kind: string, id: string, ext: string): string =>
  `ud/${kind}-autosave/untitled/${id}${ext}`
const meta = (o: Record<string, unknown>): string =>
  JSON.stringify(
    {
      version: 1,
      kind: 'docs',
      filePath: null,
      untitledId: null,
      title: 't',
      writtenAt: NOW,
      runId: 'r',
      state: 'undecided',
      ...o,
    },
    null,
    2,
  )
/** a file document's metadata */
const fileMeta = (kind: string, name: string, o: Record<string, unknown> = {}): string =>
  meta({ kind, filePath: doc(name), ...o })

const scen = (steps: Step[], extra: Record<string, unknown> = {}) => ({
  userData: '$DIR/ud',
  orig: ORIG,
  runId: RUN,
  now: NOW,
  steps,
  ...extra,
})
const sc = (
  steps: Step[],
  files?: Record<string, FileSpec>,
  note?: string,
  extra?: Record<string, unknown>,
): Case => ({
  args: [scen(steps, extra)],
  files,
  note,
})

const A = F('docs', 'a.docx')
const B = F('sheets', 'b.xlsx')
const S = F('slides', 's.pptx')
const T1 = U('docs', 'tab-1', '.docx')
const T2 = U('sheets', 'tab-x', '.xlsx')
const seed = (name: string, mtimeMs: number, text = 'orig'): Step => ({
  op: 'seed',
  name,
  text,
  mtimeMs,
})
const touch = (path: string, mtimeMs: number): Step => ({
  op: 'touch',
  path: `$DIR/${path}`,
  mtimeMs,
})
const op = (name: string, id: unknown, extra: Record<string, unknown> = {}): Step => ({
  op: name,
  id,
  ...extra,
})

// ---- the store cases ----

const pathCases: Case[] = [
  sc(
    [
      op('copyPath', A),
      op('copyPath', F('docs', 'a.ODT')),
      op('copyPath', F('docs', 'a.odt.bak')),
      op('copyPath', F('docs', 'note.odt\n')),
      op('copyPath', F('sheets', 'b.csv')),
      op('copyPath', F('slides', 's.ppt')),
      op('copyPath', F('hwp', 'x.HWPX')),
      op('copyPath', F('pdf', 'noext')),
      op('copyPath', F('markdown', 'x.\u212A')),
      op('copyPath', F('markdown', 'x.\u00dc')),
      op('copyPath', F('mindmap', 'a.tar.gz')),
      op('copyPath', F('html', 'a.')),
      op('copyPath', F('diagram', 'x.verylongext12')),
      op('copyPath', F('diagram', 'x.verylongext1')),
      op('copyPath', F('diagram', 'x.\u0130')),
      op('copyPath', F('pdf', '\u{1F600}.PDF')),
      op('copyPath', T1),
      op('copyPath', U('hwp', 'A_b-9', '.hwpx')),
      op('copyPath', U('html', 'x'.repeat(64), '.a')),
    ],
    undefined,
    'every extension rule',
  ),
  sc(
    [
      op('copyPath', { kind: 'bogus', filePath: '/x/a.docx' }),
      op('copyPath', { kind: 'docs', filePath: '' }),
      op('copyPath', U('docs', '', '.docx')),
      op('copyPath', U('docs', 'a.b', '.docx')),
      op('copyPath', U('docs', 'x'.repeat(65), '.docx')),
      op('copyPath', U('docs', 'a b', '.docx')),
      op('copyPath', U('docs', 'a\n', '.docx')),
      op('copyPath', U('docs', 'ok', 'docx')),
      op('copyPath', U('docs', 'ok', '.DOCX')),
      op('copyPath', U('docs', 'ok', '.')),
      op('copyPath', U('docs', 'ok', '.abcdefghijk')),
      op('copyPath', U('docs', 'ok', '.docx\n')),
      op('copyPath', U('bogus', 'ok', '.docx')),
      op('beginWrite', { kind: 'bogus', filePath: '/x' }),
      op('beginWrite', U('docs', '../x', '.docx')),
    ],
    undefined,
    'identities that are refused',
  ),
]

const lifecycle = (name: string, originalMtime: number | null, copyMtime: number): Step[] => [
  ...(originalMtime === null ? [] : [seed(name, originalMtime)]),
  op('writeCopy', F('docs', name), { text: 'hello' }),
  touch(copyRel('docs', name, '.docx'), copyMtime),
  op('copyInfo', F('docs', name)),
]

const writeCases: Case[] = [
  sc(
    [
      seed('a.docx', OLD),
      op('writeCopy', A, { text: 'hello' }),
      touch(copyRel('docs', 'a.docx', '.docx'), NOW),
      op('copyInfo', A),
      op('readCopy', A),
      op('openPlan', A),
      op('applyLaunchDecision', A, { decision: 'later' }),
      op('openPlan', A),
      op('applyLaunchDecision', A, { decision: 'restore' }),
      op('openPlan', A),
      op('markCopyLoaded', A),
      op('copyInfo', A),
      { op: 'hasUnresolvedCopies' },
      op('deleteCopy', A, { reason: 'saved' }),
      op('copyInfo', A),
      op('readCopy', A),
      op('openPlan', A),
      { op: 'hasUnresolvedCopies' },
    ],
    undefined,
    'a file copy from write to delete',
  ),
  sc(
    [
      ...lifecycle('a.docx', FUTURE, NOW),
      seed('a.docx', NOW),
      op('copyInfo', A),
      seed('a.docx', NOW + 1000),
      op('copyInfo', A),
      seed('a.docx', OLD),
      op('copyInfo', A),
    ],
    undefined,
    'the file against the copy: newer, equal, older',
  ),
  sc(lifecycle('a.docx', null, NOW), undefined, 'the original is missing'),
  sc(
    [
      seed('b.xlsx', OLD),
      op('writeCopy', B, { text: 'sheet' }),
      op('writeCopy', S, { text: 'slides', title: '' }),
      op('writeCopy', F('hwp', 'h.HWPX'), { text: 'h', title: 'Titled \u{1F600}' }),
      op('writeCopy', F('docs', 'o.ODT'), { text: 'odt' }),
      op('copyInfo', B),
      op('copyInfo', S),
      op('copyInfo', F('hwp', 'h.HWPX')),
      op('copyInfo', F('docs', 'o.ODT')),
      op('writeCopy', B, { text: 'sheet 2' }),
      op('readCopy', B),
    ],
    undefined,
    'titles, extensions and a replaced copy',
  ),
  sc(
    [
      op('writeCopy', T1, {
        text: 'u1',
        title: 'Untitled 1',
        originalPath: '/x/y.csv',
        formulasDropped: 3,
      }),
      op('writeCopy', T2, { text: 'u2', formulasDropped: 0 }),
      op('copyInfo', T1),
      op('copyInfo', T2),
      op('setCopyState', T1, { state: 'later' }),
      op('copyInfo', T1),
      op('writeCopy', A, { text: 'f', originalPath: '/ignored', formulasDropped: 5 }),
      op('copyInfo', A),
      op('writeCopy', T1, { text: 'u1b', originalPath: '', formulasDropped: 1.5 }),
      op('copyInfo', T1),
      op('writeCopy', T1, { text: 'u1c', formulasDropped: -2, originalPath: '/p' }),
      op('copyInfo', T1),
      op('writeCopy', T1, { text: 'u1d', formulasDropped: 1e21 }),
      op('copyInfo', T1),
      op('readCopy', T1),
    ],
    undefined,
    'untitled copies: titles, original path, dropped formulas',
  ),
  sc(
    [
      { op: 'now', ms: 1_700_000_000_123.5 },
      op('writeCopy', A, { text: 'clock' }),
      op('copyInfo', A),
      { op: 'now', ms: 1_700_000_005_000 },
      op('writeCopy', A, { text: 'clock 2' }),
      op('copyInfo', A),
    ],
    undefined,
    'the clock is read at each write',
  ),
]

const ticketCases: Case[] = [
  sc(
    [
      op('beginWrite', A, { name: 'a1' }),
      op('beginWrite', B, { name: 'b1' }),
      op('deleteCopy', A, { reason: 'saved' }),
      op('writeCopy', A, { text: 'late', ticket: 'a1' }),
      op('readCopy', A),
      op('writeCopy', A, { text: 'now' }),
      op('readCopy', A),
      op('writeCopy', A, { text: 'wrong', ticket: 'b1' }),
      op('writeCopy', A, { text: 'forged', ticket: { key: 'x', epoch: 0 } }),
      op('beginWrite', A, { name: 'a2' }),
      op('writeCopy', A, { text: 'fresh ticket', ticket: 'a2' }),
      op('readCopy', A),
      op('deleteCopy', A, { reason: 'closedClean' }),
      op('writeCopy', A, { text: 'again', ticket: 'a2' }),
      op('readCopy', A),
    ],
    undefined,
    'a delete after the ticket wins',
  ),
]

const streamedCases: Case[] = [
  sc(
    [
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'streamed' } }),
      op('readCopy', A),
      op('copyInfo', A),
      op('writeStreamed', A, { writer: { mode: 'ok', text: '' }, title: 'T' }),
      op('readCopy', A),
      op('writeStreamed', T1, { writer: { mode: 'ok', text: 'u' }, originalPath: '/o' }),
      op('copyInfo', T1),
    ],
    undefined,
    'a streamed copy lands',
  ),
  sc(
    [
      op('writeCopy', A, { text: 'kept' }),
      op('writeStreamed', A, { writer: { mode: 'throw', text: 'half' } }),
      op('readCopy', A),
      op('writeStreamed', B, { writer: { mode: 'nothing' } }),
      op('readCopy', B),
      op('copyInfo', B),
    ],
    undefined,
    'a writer that throws or writes nothing: the temp is removed',
  ),
  sc(
    [
      op('writeCopy', A, { text: 'kept' }),
      op('writeStreamed', A, { writer: { mode: 'deleteDuring', text: 'x', reason: 'saved' } }),
      op('readCopy', A),
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'after' } }),
      op('readCopy', A),
      op('writeStreamed', A, { writer: { mode: 'deleteDuring', text: 'y', reason: 'dontSave' } }),
      op('isDiscarded', A),
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'blocked' } }),
      op('readCopy', A),
      op('writeCopy', A, { text: 'blocked too' }),
      op('readCopy', A),
      { op: 'resumeDiscardedCopies' },
      op('isDiscarded', A),
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'resumed' } }),
      op('readCopy', A),
    ],
    undefined,
    'a delete during the serialization',
  ),
  sc(
    [
      op('beginWrite', A, { name: 'a1' }),
      op('deleteCopy', A, { reason: 'saved' }),
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'never runs' }, ticket: 'a1' }),
      op('readCopy', A),
      op('writeStreamed', A, { writer: { mode: 'ok', text: 'x' }, ticket: { key: 'k', epoch: 1 } }),
    ],
    undefined,
    'a stale ticket: the writer is not called',
  ),
]

const diskCases: Case[] = [
  sc(
    [op('writeCopy', A, { text: 'x' }), op('readCopy', A), op('copyInfo', A), op('openPlan', A)],
    { [`${copyRel('docs', 'a.docx', '.docx')}/keep`]: 'inner' },
    'a folder stands where the copy goes',
  ),
]

const stateCases: Case[] = [
  sc(
    [
      op('writeCopy', A, { text: 'a' }),
      op('deleteCopy', A, { reason: 'dontSave' }),
      op('isDiscarded', A),
      op('isDiscarded', B),
      op('writeCopy', A, { text: 'blocked' }),
      op('readCopy', A),
      op('openPlan', A),
      op('isDiscarded', A),
      op('writeCopy', A, { text: 'free' }),
      op('deleteCopy', A, { reason: 'dontSave' }),
      op('clearDiscarded', A),
      op('isDiscarded', A),
      op('writeCopy', A, { text: 'cleared' }),
      op('readCopy', A),
      op('deleteCopy', A, { reason: 'dontSave' }),
      op('markCopyLoaded', A),
      op('isDiscarded', A),
      op('deleteCopy', A, { reason: 'dontSave' }),
      op('deleteCopy', B, { reason: 'dontSave' }),
      { op: 'resumeDiscardedCopies' },
      op('isDiscarded', A),
      op('isDiscarded', B),
      op('deleteCopy', { kind: 'bogus', filePath: '/x' }, { reason: 'saved' }),
      op('isDiscarded', { kind: 'bogus', filePath: '/x' }),
      op('clearDiscarded', { kind: 'docs', filePath: '' }),
    ],
    undefined,
    'the "Don\'t Save" block',
  ),
  sc(
    [
      { op: 'isAppShuttingDown' },
      op('writeCopy', A, { text: 'a' }),
      op('writeCopy', B, { text: 'b' }),
      { op: 'markAppShuttingDown' },
      { op: 'isAppShuttingDown' },
      op('deleteCopy', A, { reason: 'discarded' }),
      op('deleteCopy', A, { reason: 'closedClean' }),
      op('applyLaunchDecision', A, { decision: 'discard' }),
      op('readCopy', A),
      { op: 'pruneStaleCopies', maxAgeMs: 0 },
      op('writeCopy', A, { text: 'a2' }),
      op('deleteCopy', B, { reason: 'saved' }),
      op('readCopy', B),
      op('deleteCopy', A, { reason: 'dontSave' }),
      op('readCopy', A),
      op('isDiscarded', A),
      { op: 'resetAppShuttingDown' },
      { op: 'isAppShuttingDown' },
      op('deleteCopy', A, { reason: 'discarded' }),
    ],
    undefined,
    'the shutdown latch refuses all but saved and dontSave',
  ),
  sc(
    [
      op('writeCopy', A, { text: 'a' }),
      op('writeCopy', B, { text: 'b' }),
      op('writeCopy', S, { text: 's' }),
      op('applyLaunchDecision', A, { decision: 'restore' }),
      op('applyLaunchDecision', B, { decision: 'later' }),
      op('applyLaunchDecision', S, { decision: 'discard' }),
      op('applyLaunchDecision', S, { decision: 'discard' }),
      op('applyLaunchDecision', T1, { decision: 'restore' }),
      op('setCopyState', T1, { state: 'later' }),
      op('setCopyState', B, { state: 'undecided' }),
      { op: 'hasUnresolvedCopies' },
      op('setCopyState', B, { state: 'later' }),
      op('setCopyState', A, { state: 'later' }),
      { op: 'hasUnresolvedCopies' },
      op('openPlan', A),
      op('openPlan', S),
    ],
    undefined,
    'launch decisions and states',
  ),
  sc(
    [{ op: 'recoveryRunId' }, op('writeCopy', A, { text: 'a' }), op('copyInfo', A)],
    undefined,
    'the default run id',
  ),
  sc(
    [{ op: 'recoveryRunId' }, op('writeCopy', A, { text: 'a' }), op('copyInfo', A)],
    undefined,
    'another run id',
    { runId: 'fedcba9876543210' },
  ),
]

const listFiles: Record<string, FileSpec> = {
  [copyRel('docs', 'l1.docx', '.docx')]: { text: 'c1', mtimeMs: 1_699_000_000_000 },
  [`${copyRel('docs', 'l1.docx', '.docx')}.meta.json`]: fileMeta('docs', 'l1.docx', {
    title: 'L1',
    writtenAt: NOW + 3000,
    runId: 'r1',
  }),
  [copyRel('sheets', 'l2.xlsx', '.xlsx')]: { text: 'c2', mtimeMs: 1_699_000_001_000 },
  [`${copyRel('sheets', 'l2.xlsx', '.xlsx')}.meta.json`]: fileMeta('sheets', 'l2.xlsx', {
    title: 'L2',
    writtenAt: NOW + 1000,
    state: 'later',
  }),
  [copyRel('hwp', 't.hwp', '.hwp')]: { text: 'c3', mtimeMs: 1_699_000_002_000 },
  [`${copyRel('hwp', 't.hwp', '.hwp')}.meta.json`]: fileMeta('hwp', 't.hwp', {
    title: 'Tie',
    writtenAt: NOW + 3000,
    state: 'restoreChosen',
  }),
  [untitledRel('docs', 'u-a', '.docx')]: { text: 'ua', mtimeMs: 1_699_000_003_000 },
  [`${untitledRel('docs', 'u-a', '.docx')}.meta.json`]: meta({
    untitledId: 'u-a',
    title: 'Untitled A',
    writtenAt: NOW + 2000,
    state: 'restoreChosen',
    originalPath: '/o/p.csv',
    formulasDropped: 2,
  }),
  // no metadata: a legacy copy, found only per file
  [copyRel('docs', 'legacy.docx', '.docx')]: { text: 'legacy', mtimeMs: 1_650_000_000_000 },
  // the name of one path, the metadata of another
  [copyRel('docs', 'l3.docx', '.docx')]: 'c4',
  [`${copyRel('docs', 'l3.docx', '.docx')}.meta.json`]: fileMeta('docs', 'other.docx'),
  // metadata of another kind, a bad state, a bad time, an array, bad JSON
  [copyRel('hwp', 'k.hwp', '.hwp')]: 'c5',
  [`${copyRel('hwp', 'k.hwp', '.hwp')}.meta.json`]: fileMeta('docs', 'k.hwp'),
  [copyRel('slides', 'st.pptx', '.pptx')]: 'c6',
  [`${copyRel('slides', 'st.pptx', '.pptx')}.meta.json`]: fileMeta('slides', 'st.pptx', {
    state: 'bogus',
  }),
  [copyRel('pdf', 'w.pdf', '.pdf')]: 'c7',
  [`${copyRel('pdf', 'w.pdf', '.pdf')}.meta.json`]: fileMeta('pdf', 'w.pdf', { writtenAt: 'x' }),
  [copyRel('html', 'ar.html', '.html')]: 'c8',
  [`${copyRel('html', 'ar.html', '.html')}.meta.json`]: '[1]',
  [copyRel('markdown', 'bj.md', '.md')]: 'c9',
  [`${copyRel('markdown', 'bj.md', '.md')}.meta.json`]: '{"kind":',
  [untitledRel('docs', 'u-b', '.docx')]: 'ub',
  [`${untitledRel('docs', 'u-b', '.docx')}.meta.json`]: meta({ untitledId: 'other' }),
  [untitledRel('sheets', 'u-c', '.xlsx')]: 'uc',
  [`${untitledRel('sheets', 'u-c', '.xlsx')}.meta.json`]: meta({
    kind: 'sheets',
    untitledId: 'u-c',
    writtenAt: NOW,
    state: 'undecided',
    originalPath: 5,
    formulasDropped: 2.5,
  }),
  // names that are no copy's
  'ud/docs-autosave/ABCDEF0123456789.docx': 'upper',
  'ud/docs-autosave/zzz.docx': 'short',
  'ud/docs-autosave/untitled/u-d.verylongext1': 'long',
  'ud/docs-autosave/untitled/u d.docx': 'space',
  'ud/docs-autosave/readme.txt': 'text',
}

const listCases: Case[] = [
  sc(
    [
      { op: 'listCopies' },
      { op: 'listCopies', filter: { states: ['later'] } },
      { op: 'listCopies', filter: { kinds: ['docs'] } },
      { op: 'listCopies', filter: { untitled: true } },
      { op: 'listCopies', filter: { untitled: false } },
      {
        op: 'listCopies',
        filter: { states: ['undecided', 'restoreChosen'], kinds: ['docs', 'sheets'] },
      },
      { op: 'listCopies', filter: { states: [] } },
      { op: 'listCopies', filter: { states: ['nope'] } },
      { op: 'listCopies', filter: { kinds: [] } },
      { op: 'listCopies', filter: { kinds: ['bogus'] } },
      { op: 'hasUnresolvedCopies' },
      op('copyInfo', F('docs', 'legacy.docx')),
      op('openPlan', F('docs', 'legacy.docx')),
      op('copyInfo', F('docs', 'l3.docx')),
      op('copyInfo', F('hwp', 'k.hwp')),
      op('copyInfo', F('pdf', 'w.pdf')),
      op('copyInfo', F('html', 'ar.html')),
      op('copyInfo', F('markdown', 'bj.md')),
      op('copyInfo', U('docs', 'u-b', '.docx')),
      op('copyInfo', U('sheets', 'u-c', '.xlsx')),
      op('copyInfo', U('docs', 'u-a', '.docx')),
      op('copyInfo', F('docs', 'l1.docx')),
      op('readCopy', F('docs', 'l1.docx')),
    ],
    listFiles,
    'every kind of copy and metadata on disk',
  ),
  sc(
    [
      { op: 'hasUnresolvedCopies' },
      op('writeCopy', T2, { text: 'a' }),
      { op: 'hasUnresolvedCopies' },
      op('applyLaunchDecision', T2, { decision: 'later' }),
      { op: 'hasUnresolvedCopies' },
      { op: 'listCopies' },
    ],
    undefined,
    'nothing on disk, then one copy, then a later one',
  ),
  sc(
    [
      { op: 'now', ms: NOW + 9000 },
      op('writeCopy', A, { text: 'a' }),
      { op: 'now', ms: NOW + 3000 },
      op('writeCopy', B, { text: 'b' }),
      { op: 'now', ms: NOW + 6000 },
      op('writeCopy', S, { text: 's' }),
      op('writeCopy', T1, { text: 'u' }),
      { op: 'listCopies' },
      { op: 'listCopies', filter: { untitled: true } },
    ],
    undefined,
    'oldest first, ties in folder order',
  ),
  sc(
    [{ op: 'listCopies', filter: { kinds: ['bogus'] } }],
    {
      [`ud/bogus-autosave/${hash(doc('bg.docx'))}.docx`]: 'x',
      [`ud/bogus-autosave/${hash(doc('bg.docx'))}.docx.meta.json`]: fileMeta('bogus', 'bg.docx'),
    },
    'an unknown kind with a folder: the kind is refused',
  ),
]

const staleFiles: Record<string, FileSpec> = {
  [copyRel('docs', 'old.docx', '.docx')]: { text: 'old', mtimeMs: 1_600_000_000_000 },
  [`${copyRel('docs', 'old.docx', '.docx')}.meta.json`]: {
    text: fileMeta('docs', 'old.docx'),
    mtimeMs: 1_600_000_000_000,
  },
  [copyRel('docs', 'fresh.docx', '.docx')]: { text: 'fresh', mtimeMs: 1_699_999_000_000 },
  [`${copyRel('docs', 'fresh.docx', '.docx')}.meta.json`]: {
    text: fileMeta('docs', 'fresh.docx'),
    mtimeMs: 1_600_000_000_000,
  },
  [`${copyRel('docs', 'gone.docx', '.docx')}.meta.json`]: {
    text: fileMeta('docs', 'gone.docx'),
    mtimeMs: 1_600_000_000_000,
  },
  [`${copyRel('docs', 'newgone.docx', '.docx')}.meta.json`]: {
    text: fileMeta('docs', 'newgone.docx'),
    mtimeMs: 1_699_999_000_000,
  },
  [`ud/docs-autosave/${hash(doc('old.docx'))}.docx.0123456789ab.tmp`]: {
    text: 'tmp',
    mtimeMs: 1_600_000_000_000,
  },
  'ud/docs-autosave/ab.0123456789ab.tmp': { text: 'tmp2', mtimeMs: 1_699_999_000_000 },
  'ud/docs-autosave/notes.txt': { text: 'keep', mtimeMs: 1_600_000_000_000 },
  [untitledRel('docs', 'u-old', '.docx')]: { text: 'uo', mtimeMs: 1_600_000_000_000 },
  [`${untitledRel('docs', 'u-old', '.docx')}.meta.json`]: {
    text: meta({ untitledId: 'u-old' }),
    mtimeMs: 1_600_000_000_000,
  },
  [untitledRel('docs', 'u-new', '.docx')]: { text: 'un', mtimeMs: 1_699_999_000_000 },
  [`${untitledRel('docs', 'u-new', '.docx')}.meta.json`]: {
    text: meta({ untitledId: 'u-new' }),
    mtimeMs: 1_699_999_000_000,
  },
  [copyRel('sheets', 'legacy.xlsx', '.xlsx')]: { text: 'legacy', mtimeMs: 1_600_000_000_000 },
  [copyRel('slides', 'edge.pptx', '.pptx')]: { text: 'edge', mtimeMs: 1_697_408_000_000 },
  [copyRel('slides', 'edge2.pptx', '.pptx')]: { text: 'edge2', mtimeMs: 1_697_407_000_000 },
  'ud/pdf-autosave/untitled/not a copy.docx': { text: 'x', mtimeMs: 1_600_000_000_000 },
  'ud/bogus-autosave/old.docx': { text: 'x', mtimeMs: 1_600_000_000_000 },
}

const pruneCases: Case[] = [
  sc(
    [
      op('beginWrite', F('docs', 'old.docx'), { name: 'p' }),
      { op: 'pruneStaleCopies' },
      op('writeCopy', F('docs', 'old.docx'), { text: 'late', ticket: 'p' }),
      op('copyInfo', F('docs', 'fresh.docx')),
      { op: 'pruneStaleCopies' },
    ],
    staleFiles,
    'the default age: the edge file is kept, the one a second older goes',
  ),
  sc(
    [{ op: 'pruneStaleCopies', maxAgeMs: 1000 }],
    staleFiles,
    'a short age removes the fresh ones too',
  ),
  sc(
    [
      { op: 'pruneStaleCopies', maxAgeMs: -1000 },
      { op: 'pruneStaleCopies', maxAgeMs: 0.5 },
    ],
    staleFiles,
    'a negative age',
  ),
  sc([{ op: 'pruneStaleCopies', maxAgeMs: 1e15 }], staleFiles, 'nothing is old enough'),
  sc(
    [{ op: 'markAppShuttingDown' }, { op: 'pruneStaleCopies' }],
    staleFiles,
    'nothing is pruned while the app is ending',
  ),
  sc([{ op: 'pruneStaleCopies' }], undefined, 'no folders'),
]

const adoptFiles: Record<string, FileSpec> = {
  'ud/sheets-autosave/unsaved-1.xlsx': { text: 'x1', mtimeMs: 1_650_000_000_000 },
  'ud/sheets-autosave/..x.xlsx': { text: 'x2', mtimeMs: 1_651_000_000_000 },
  'other.xlsx': { text: 'out', mtimeMs: 1_652_000_000_000 },
  'ud/sheets-autosave/nested/deep.xlsx': { text: 'x3', mtimeMs: 1_653_000_000_000 },
}

const adoptCases: Case[] = [
  sc(
    [
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
        title: 'Book 1',
        ext: '.xlsx',
        originalPath: '/x/data.csv',
      },
      op('copyInfo', U('sheets', 'uuid-1', '.xlsx')),
      op('readCopy', U('sheets', 'uuid-1', '.xlsx')),
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/..x.xlsx',
        title: 'Dots',
        ext: '.csv',
        state: 'undecided',
      },
      op('copyInfo', U('sheets', 'uuid-2', '.csv')),
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/nested/deep.xlsx',
        title: 'Deep',
        ext: '.xlsx',
        originalPath: '',
      },
      op('copyInfo', U('sheets', 'uuid-3', '.xlsx')),
      { op: 'newUntitledRecoveryId' },
      { op: 'listCopies', filter: { untitled: true } },
    ],
    adoptFiles,
    'copies adopted into untitled slots',
  ),
  sc(
    [
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/other.xlsx',
        title: 'Out',
        ext: '.xlsx',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/../other.xlsx',
        title: 'Up',
        ext: '.xlsx',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave',
        title: 'Self',
        ext: '.xlsx',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/missing.xlsx',
        title: 'Gone',
        ext: '.xlsx',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'docs',
        source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
        title: 'Other kind',
        ext: '.docx',
      },
      { op: 'newUntitledRecoveryId' },
    ],
    adoptFiles,
    'sources that are refused: nothing moves',
  ),
  sc(
    [
      {
        op: 'adoptUntitledCopy',
        kind: 'bogus',
        source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
        title: 'x',
        ext: '.xlsx',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
        title: 'x',
        ext: '.XLSX',
      },
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/missing.xlsx',
        title: 'x',
        ext: '.XLSX',
      },
      { op: 'newUntitledRecoveryId' },
    ],
    adoptFiles,
    'a kind or an extension that is refused',
  ),
  sc(
    [
      {
        op: 'adoptUntitledCopy',
        kind: 'sheets',
        source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
        title: 'Blocked',
        ext: '.xlsx',
      },
    ],
    { ...adoptFiles, 'ud/sheets-autosave/untitled': 'a file where the folder goes' },
    'the untitled folder cannot be made: the source stays',
  ),
]

// ---- recovery-contract ----

interface RegistryStep {
  op: string
  label?: string
  kind?: string
  token?: string
}

function runRegistry(args: unknown[]): unknown {
  delete holder[REGISTRY]
  const made: Record<string, RecoveryEditorContract & { label: string }> = {}
  const tokens: Record<string, () => void> = {}
  const out: unknown[] = []
  try {
    for (const step of args[0] as RegistryStep[]) {
      const entry: Record<string, unknown> = { op: step.op }
      switch (step.op) {
        case 'register': {
          const fake = {
            label: step.label as string,
            kind: step.kind as RecoveryEditorKind,
            writeCopiesNow: async () => {},
            openFileWithDecision: () => {},
            openUntitledCopy: () => {},
            isUnprotectable: () => false,
          }
          made[fake.label] = fake
          tokens[step.token as string] = registerRecoveryEditor(fake)
          break
        }
        case 'registerAgain':
          tokens[step.token as string] = registerRecoveryEditor(made[step.label as string]!)
          break
        case 'unregister':
          tokens[step.token as string]?.()
          break
        case 'editor':
          entry.ok =
            (recoveryEditor(step.kind as RecoveryEditorKind) as { label?: string } | null)?.label ??
            null
          break
        case 'editors':
          entry.ok = recoveryEditors().map((c) => (c as unknown as { label: string }).label)
          break
      }
      out.push(entry)
    }
  } finally {
    delete holder[REGISTRY]
  }
  return out
}

const reg = (label: string, kind: string, token: string): RegistryStep => ({
  op: 'register',
  label,
  kind,
  token,
})
const regCases: Case[] = [
  {
    args: [
      [
        { op: 'editors' },
        { op: 'editor', kind: 'docs' },
        reg('a', 'docs', 'ta'),
        reg('b', 'sheets', 'tb'),
        { op: 'editor', kind: 'docs' },
        { op: 'editor', kind: 'slides' },
        { op: 'editors' },
      ],
    ],
    note: 'register, look up, list',
  },
  {
    args: [
      [
        reg('a', 'docs', 'ta'),
        reg('b', 'sheets', 'tb'),
        reg('c', 'docs', 'tc'),
        { op: 'editors' },
        { op: 'unregister', token: 'ta' },
        { op: 'editors' },
        { op: 'unregister', token: 'tc' },
        { op: 'editors' },
        { op: 'unregister', token: 'tc' },
        { op: 'unregister', token: 'nobody' },
        { op: 'editor', kind: 'docs' },
      ],
    ],
    note: 'a replaced registration keeps its place; a stale unregister does nothing',
  },
  {
    args: [
      [
        reg('a', 'docs', 'ta'),
        reg('b', 'pdf', 'tb'),
        reg('c', 'markdown', 'tc'),
        { op: 'registerAgain', label: 'a', token: 'ta2' },
        { op: 'editors' },
        { op: 'unregister', token: 'ta' },
        { op: 'editors' },
        { op: 'registerAgain', label: 'a', token: 'ta3' },
        { op: 'unregister', token: 'ta2' },
        { op: 'editors' },
        { op: 'editor', kind: 'constructor' },
        { op: 'editor', kind: '' },
      ],
    ],
    note: 'the same contract registered twice, and unknown kinds',
  },
]

// ---- recovery-labels, save-conflict-labels ----

const LANGS = [
  'ko',
  'en',
  'ko-KR',
  'ko_KR',
  'KO',
  ' ko ',
  '\ufeffko',
  'ko\n',
  'korean',
  'k\u00f6',
  '\u212Ao',
  'fr',
  'en-US',
  'ja',
  '',
  'KO-kr',
  'ko-',
  'ko_',
  '\u0130ko',
]

const NAMES = [
  'a.docx',
  '',
  'My \u201cdoc\u201d',
  '{name}',
  '$&',
  '\u{1F600}.xlsx',
  'x{name}y{name}',
  '{0}',
]

// ---- recovery-prompt ----

function fakeParent(parent: unknown): { isDestroyed: () => boolean } | null {
  return parent === 'live'
    ? { isDestroyed: () => false }
    : parent === 'destroyed'
      ? { isDestroyed: () => true }
      : null
}

function fakeDialog(response: unknown, log: (...args: unknown[]) => void) {
  return {
    showMessageBox: async (...given: unknown[]) => {
      if (given.length === 2) log('over', given[1])
      else log('box', given[0])
      return { response } as { response: number }
    },
  }
}

const promptCase = (o: Record<string, unknown>, note?: string): Case => ({
  args: [
    {
      lang: 'en',
      documentName: 'a.docx',
      fileChangedAfterCopy: false,
      response: 0,
      parent: null,
      ...o,
    },
  ],
  note,
})

const promptCases: Case[] = [
  promptCase({}, 'restore, unparented'),
  promptCase({ response: 1 }, 'discard'),
  promptCase(
    { lang: 'ko', fileChangedAfterCopy: true, response: 1, parent: 'live' },
    'Korean, over a window, newer file',
  ),
  promptCase({ lang: 'ko-KR', parent: 'live', response: 0 }),
  promptCase({ parent: 'destroyed', response: 1 }, 'a destroyed parent shows it unparented'),
  promptCase({ response: -1 }, 'closed: restore'),
  promptCase({ response: 2 }),
  promptCase({ response: 1.5 }),
  promptCase({ response: null }, 'no response number'),
  promptCase({ documentName: '{name} \u{1F600}', fileChangedAfterCopy: true, lang: '\u212Ao' }),
  promptCase({ lang: 'fr', documentName: '', response: 1 }),
]

// ---- resolveRecoveryOnOpen ----

const resolveCase = (
  o: Record<string, unknown>,
  files: Record<string, FileSpec> | undefined,
  note?: string,
): Case => ({
  args: [{ userData: '$DIR/ud', lang: 'en', response: 0, parent: null, ...o }],
  files,
  note,
})

const RA = F('docs', 'r1.docx')
const raCopy = copyRel('docs', 'r1.docx', '.docx')
const raFiles = (
  state: string,
  extra: Record<string, FileSpec> = {},
): Record<string, FileSpec> => ({
  [raCopy]: { text: 'copy bytes', mtimeMs: 1_699_000_000_000 },
  [`${raCopy}.meta.json`]: fileMeta('docs', 'r1.docx', { title: 'R1 title', state }),
  ...extra,
})
const RU = U('docs', 'ru-1', '.docx')
const ruFiles = (state: string): Record<string, FileSpec> => ({
  [untitledRel('docs', 'ru-1', '.docx')]: { text: 'untitled bytes', mtimeMs: 1_699_000_000_000 },
  [`${untitledRel('docs', 'ru-1', '.docx')}.meta.json`]: meta({
    untitledId: 'ru-1',
    title: 'Untitled R',
    state,
  }),
})

const resolveCases: Case[] = [
  resolveCase({ identity: RA }, undefined, 'no copy: original'),
  resolveCase({ identity: RA, response: 0 }, raFiles('undecided'), 'asked, restore'),
  resolveCase({ identity: RA, response: 1 }, raFiles('undecided'), 'asked, discard'),
  resolveCase(
    { identity: RA, response: 1, lang: 'ko', parent: 'live' },
    raFiles('later'),
    'later, discard, Korean',
  ),
  resolveCase(
    { identity: RA, response: 1 },
    raFiles('restoreChosen'),
    'restore already chosen: not asked',
  ),
  resolveCase({ identity: RA, response: 0 }, raFiles('restoreChosen'), 'restore chosen'),
  resolveCase({ identity: RA, documentName: 'Given name' }, raFiles('undecided'), 'a name given'),
  resolveCase(
    { identity: RA, documentName: '' },
    raFiles('undecided'),
    'an empty name given is kept',
  ),
  resolveCase(
    { identity: RA, parent: 'destroyed' },
    raFiles('later', { 'r1.docx-note': 'x' }),
    'a destroyed parent',
  ),
  resolveCase(
    { identity: RA },
    { [raCopy]: { text: 'legacy copy', mtimeMs: 1_699_000_000_000 } },
    'a legacy copy is asked about',
  ),
  resolveCase(
    { identity: RA },
    { [raCopy]: { dir: true }, [`${raCopy}/x`]: 'x' },
    'a copy that cannot be read: original, kept',
  ),
  resolveCase({ identity: RU, response: 0 }, ruFiles('undecided'), 'untitled: the title names it'),
  resolveCase({ identity: RU, response: 1, lang: 'ko' }, ruFiles('later'), 'untitled, discard'),
  resolveCase({ identity: RU }, ruFiles('restoreChosen'), 'untitled, restore chosen'),
  resolveCase(
    { identity: { kind: 'bogus', filePath: '/x' } },
    undefined,
    'an unknown kind is refused',
  ),
]

// ---- unsaved-files ----

/** a source for the spec: null (none), `{throws}`, or `{returns}`, sync or `async` */
function sourceOf(spec: unknown): OpenFilesSource | null {
  if (spec == null) return null
  const s = spec as { throws?: boolean; returns?: unknown; async?: boolean }
  const run = (): never => {
    if (s.throws) throw new Error('source failed')
    return s.returns as never
  }
  return s.async ? async () => run() : run
}

async function withSource<T>(spec: unknown, run: () => Promise<T>): Promise<T> {
  setOpenFilesSource(sourceOf(spec))
  try {
    return await run()
  } finally {
    setOpenFilesSource(null)
  }
}

const D = (name: string): string => `$DIR/${name}`
const docsList = {
  returns: [
    { filePath: D('a.docx'), dirty: true },
    { filePath: D('b.docx'), dirty: false },
    { dirty: true },
    { filePath: '', dirty: true },
    { filePath: D('gone.docx'), dirty: true },
    { filePath: D('sub/../c.docx'), dirty: 1 },
  ],
}
/** the open files spelt through a link: /proc/self/root on Linux, /private on macOS */
const linkedList = {
  returns: [
    { filePath: `/proc/self/root${D('a.docx')}`, dirty: true },
    { filePath: `/private${D('b.docx')}`, dirty: true },
  ],
}
const unsavedFiles: Record<string, FileSpec> = {
  'a.docx': 'a',
  'b.docx': 'b',
  'c.docx': 'c',
  'sub/keep.txt': 'k',
}
const hasCase = (source: unknown, path: string, note?: string): Case => ({
  args: [source, path],
  files: unsavedFiles,
  note,
})
const hasCases: Case[] = [
  hasCase(docsList, D('a.docx'), 'dirty'),
  hasCase(docsList, D('b.docx'), 'open and clean'),
  hasCase(docsList, D('./a.docx'), 'another spelling'),
  hasCase(docsList, D('sub/../a.docx')),
  hasCase(docsList, D('c.docx'), 'a truthy dirty'),
  hasCase(docsList, D('gone.docx'), 'a path that does not exist'),
  hasCase(docsList, D('other.docx')),
  hasCase(docsList, `/private${D('a.docx')}`, 'through the /var link of macOS'),
  hasCase(docsList, 'a.docx', 'relative to the working folder'),
  hasCase(docsList, '', 'the empty path'),
  hasCase(null, D('a.docx'), 'no source: nothing is blocked'),
  hasCase({ throws: true }, D('a.docx'), 'the source throws: unknown counts as unsaved'),
  hasCase({ throws: true, async: true }, D('zzz.docx')),
  hasCase({ ...docsList, async: true }, D('a.docx'), 'an asynchronous source'),
  hasCase({ returns: [] }, D('a.docx'), 'no open files'),
  hasCase({ returns: 5 }, D('a.docx'), 'not a list'),
  hasCase({ returns: null }, D('a.docx')),
  hasCase({}, D('a.docx'), 'a source that gives nothing'),
  hasCase({ returns: 'ab' }, D('a.docx'), 'a string lists its characters'),
  hasCase({ returns: [null] }, D('a.docx'), 'a null entry'),
  hasCase(
    { returns: [7, 'x', [1], { dirty: true, filePath: 0 }] },
    D('a.docx'),
    'entries that name no file',
  ),
  hasCase({ returns: [{ dirty: true, filePath: 5 }] }, D('a.docx'), 'a path that is no string'),
  hasCase({ returns: [{ dirty: false, filePath: 5 }] }, D('a.docx'), 'clean: the path is not read'),
  hasCase(linkedList, D('a.docx'), 'a listed path through a link is the file itself'),
  hasCase(linkedList, D('b.docx'), 'the same through the macOS link'),
  hasCase(linkedList, D('c.docx'), 'a file that is not listed'),
  hasCase(docsList, `/proc/self/root${D('a.docx')}`, 'asked through /proc/self/root'),
]

// ---- legacy-import-prefs ----

const SETTINGS = '$DIR/app-settings.json'
const settingsCase = (args: unknown[], text: FileSpec | undefined, note?: string): Case => ({
  args: [SETTINGS, ...args],
  files: text === undefined ? undefined : { 'app-settings.json': text },
  note,
})
const settingsTexts: [string | undefined, string][] = [
  [undefined, 'no file'],
  ['{', 'corrupt'],
  ['', 'empty'],
  ['[1]', 'an array'],
  ['null', 'null'],
  ['"text"', 'a string'],
  ['{}', 'an empty object'],
  [
    JSON.stringify({ theme: 'dark', legacyImportSkipConfirm: { odt: true, hwp: true } }),
    'two skips',
  ],
  [
    JSON.stringify({ legacyImportSkipConfirm: { hwp: 'true', ppt: 1, word97: false, ods: true } }),
    'values that are not true',
  ],
  [JSON.stringify({ legacyImportSkipConfirm: [true] }), 'a list'],
  [JSON.stringify({ legacyImportSkipConfirm: null, a: 1 }), 'null map'],
  [JSON.stringify({ legacyImportSkipConfirm: 'x', b: 2 }), 'a string map'],
  [
    JSON.stringify({
      2: 'two',
      legacyImportSkipConfirm: { ppt: true, word97: true, odp: true, 10: true, constructor: true },
      10: 'ten',
      z: 0,
    }),
    'order of keys',
  ],
  ['\ufeff{"legacyImportSkipConfirm":{"odt":true}}', 'a byte order mark'],
  [
    JSON.stringify({ legacyImportSkipConfirm: { ppt: true, odt: true } }),
    'the kinds not in the order of the list',
  ],
]
const allKinds = [
  ...LEGACY_IMPORT_KINDS,
  'constructor',
  '__proto__',
  'toString',
  'ODT',
  '2',
  '10',
  '',
  'odt ',
]

const readSkipCases: Case[] = [
  settingsCase(['odt'], settingsTexts[7]![0]),
  settingsCase(['hwp'], settingsTexts[7]![0]),
  settingsCase(['ppt'], settingsTexts[7]![0]),
  settingsCase(['odt'], undefined, 'no file'),
  settingsCase(['odt'], '{'),
  settingsCase(['ods'], settingsTexts[8]![0]),
  settingsCase(['hwp'], settingsTexts[8]![0], 'the string "true" is not true'),
  settingsCase(['ppt'], settingsTexts[8]![0]),
  settingsCase(['word97'], settingsTexts[8]![0]),
  settingsCase(['odt'], settingsTexts[9]![0]),
  settingsCase(['constructor'], settingsTexts[12]![0], 'an inherited name'),
  settingsCase(['__proto__'], settingsTexts[12]![0]),
  settingsCase(['odt'], settingsTexts[13]![0], 'a byte order mark keeps it unreadable'),
  settingsCase(['odt'], { dir: true }, 'a folder'),
]

const writeSkipCases: Case[] = [
  ...settingsTexts.flatMap(([text, note]): Case[] => [
    settingsCase(['odt', true], text, `${note}: set`),
    settingsCase(['odt', false], text, `${note}: clear`),
  ]),
  ...allKinds.map((kind) =>
    settingsCase([kind, true], settingsTexts[7]![0], `set ${JSON.stringify(kind)}`),
  ),
  ...allKinds.map((kind) =>
    settingsCase([kind, false], settingsTexts[12]![0], `clear ${JSON.stringify(kind)}`),
  ),
  settingsCase(['word97', true], settingsTexts[14]![0], 'a new kind goes last'),
  settingsCase(['hwp', true], { dir: true }, 'a folder where the file is'),
  settingsCase(['hwp', true], { text: '{}', mode: 0o444 }, 'a read-only file'),
]

const readPromptCases: Case[] = settingsTexts.map(([text, note]) => settingsCase([], text, note))

const writePromptCases: Case[] = [
  ...settingsTexts.flatMap(([text, note]): Case[] => [
    settingsCase([true], text, `${note}: ask`),
    settingsCase([false], text, `${note}: never ask`),
  ]),
  settingsCase([true], { dir: true }, 'a folder where the file is'),
]

// ---- unsaved ts runners ----

export const group: Group = {
  'recovery-contract.registerRecoveryEditor': { ts: (a) => runRegistry(a), cases: regCases },
  'recovery-contract.recoveryEditor': { ts: (a) => runRegistry(a), cases: regCases.slice(0, 2) },
  'recovery-contract.recoveryEditors': { ts: (a) => runRegistry(a), cases: regCases.slice(1) },

  'recovery-labels.RECOVERY_PROMPT_STRINGS': constant(RECOVERY_PROMPT_STRINGS),
  'recovery-labels.recoveryPromptLabels': {
    ts: (a) => recoveryPromptLabels(a[0] as string, a[1] as string),
    cases: [
      ...LANGS.map((lang): Case => ({ args: [lang, 'a.docx'] })),
      ...NAMES.map((name): Case => ({ args: ['ko', name] })),
      ...NAMES.map((name): Case => ({ args: ['en', name] })),
    ],
  },
  'recovery-labels.unprotectableNoticeText': {
    ts: (a) => unprotectableNoticeText(a[0] as string),
    cases: LANGS.map((lang): Case => ({ args: [lang] })),
  },

  'save-conflict-labels.SAVE_CONFLICT_STRINGS': constant(SAVE_CONFLICT_STRINGS),
  'save-conflict-labels.saveConflictLabels': {
    ts: (a) => saveConflictLabels(a[0] as string),
    cases: LANGS.map((lang): Case => ({ args: [lang] })),
  },

  'recovery-prompt.promptRecoveryForFile': {
    ts: async (a, cx) => {
      const o = a[0] as {
        lang: string
        documentName: string
        fileChangedAfterCopy: boolean
        response: unknown
        parent: unknown
      }
      return promptRecoveryForFile({
        dialog: fakeDialog(o.response, cx.log) as never,
        parent: fakeParent(o.parent) as never,
        documentName: o.documentName,
        fileChangedAfterCopy: o.fileChangedAfterCopy,
        lang: o.lang,
      })
    },
    cases: promptCases,
  },
  'recovery-prompt.resolveRecoveryOnOpen': {
    ts: async (a, cx) => {
      const o = a[0] as {
        userData: string
        identity: RecoveryIdentity
        lang: string
        documentName?: string | null
        response: unknown
        parent: unknown
      }
      holder[SHARED] = {
        shuttingDown: false,
        epochs: new Map(),
        queues: new Map(),
        runId: RUN,
        discarded: new Set(),
      }
      try {
        const store = createRecoveryStore({ userDataDir: () => o.userData })
        const result = await resolveRecoveryOnOpen({
          store,
          identity: o.identity,
          dialog: fakeDialog(o.response, cx.log) as never,
          parent: fakeParent(o.parent) as never,
          lang: o.lang,
          documentName: o.documentName ?? undefined,
        })
        return result.action === 'original'
          ? result
          : { action: 'restore', bytes: result.bytes.toString('hex'), copy: infoOut(result.copy) }
      } finally {
        delete holder[SHARED]
      }
    },
    cases: resolveCases,
  },

  'recovery-store.RECOVERY_EDITOR_KINDS': constant(RECOVERY_EDITOR_KINDS),
  'recovery-store.RECOVERY_COPY_MAX_AGE_MS': constant(RECOVERY_COPY_MAX_AGE_MS),
  'recovery-store.recoveryFolderName': {
    ts: (a) => recoveryFolderName(a[0] as RecoveryEditorKind),
    cases: ['docs', 'diagram', '', 'x y', '\u{1F600}', 'a/b'].map((kind): Case => ({
      args: [kind],
    })),
  },
  'recovery-store.isRecoveryEditorKind': {
    ts: (a) => isRecoveryEditorKind(a[0]),
    cases: [
      ...RECOVERY_EDITOR_KINDS,
      'DOCS',
      'docs ',
      '',
      'constructor',
      'toString',
      '__proto__',
      'dos\u017F',
      'html\u0131',
    ].map((kind): Case => ({ args: [kind] })),
  },
  'recovery-store.isUntitledIdentity': {
    ts: (a) => isUntitledIdentity(a[0] as RecoveryIdentity),
    cases: [
      { kind: 'docs', filePath: '/x/a.docx' },
      { kind: 'docs', untitledId: 'a', ext: '.docx' },
      {},
      { untitledId: '' },
      { untitledId: null },
      { filePath: '/x', untitledId: 'a' },
      { kind: 'docs', Untitled: 1 },
    ].map((identity): Case => ({ args: [identity] })),
  },
  'recovery-store.createRecoveryStore': {
    ts: runStore,
    cases: [
      ...pathCases,
      ...writeCases,
      ...ticketCases,
      ...streamedCases,
      ...diskCases,
      ...stateCases,
      ...listCases,
      ...pruneCases,
      ...adoptCases,
    ],
  },
  'recovery-store.recoveryRunId': {
    ts: runStore,
    cases: [
      sc([{ op: 'recoveryRunId' }], undefined, 'the default run id'),
      sc(
        [{ op: 'recoveryRunId' }, op('writeCopy', A, { text: 'a' })],
        undefined,
        'another run id, recorded in the copy',
        {
          runId: 'fedcba9876543210',
        },
      ),
      sc([{ op: 'recoveryRunId' }], undefined, 'a run id that is not hex', { runId: '' }),
    ],
  },
  'recovery-store.markAppShuttingDown': {
    ts: runStore,
    cases: [
      sc([
        { op: 'isAppShuttingDown' },
        { op: 'markAppShuttingDown' },
        { op: 'isAppShuttingDown' },
        { op: 'markAppShuttingDown' },
        { op: 'isAppShuttingDown' },
      ]),
      sc([
        op('writeCopy', A, { text: 'a' }),
        { op: 'markAppShuttingDown' },
        op('deleteCopy', A, { reason: 'closedClean' }),
        op('readCopy', A),
      ]),
    ],
  },
  'recovery-store.resetAppShuttingDown': {
    ts: runStore,
    cases: [
      sc([{ op: 'resetAppShuttingDown' }, { op: 'isAppShuttingDown' }]),
      sc([
        { op: 'markAppShuttingDown' },
        { op: 'resetAppShuttingDown' },
        { op: 'isAppShuttingDown' },
        op('writeCopy', A, { text: 'a' }),
        op('deleteCopy', A, { reason: 'discarded' }),
        op('readCopy', A),
      ]),
    ],
  },
  'recovery-store.isAppShuttingDown': {
    ts: runStore,
    cases: [
      sc([{ op: 'isAppShuttingDown' }]),
      sc([{ op: 'markAppShuttingDown' }, { op: 'isAppShuttingDown' }]),
      sc([
        { op: 'markAppShuttingDown' },
        { op: 'resetAppShuttingDown' },
        { op: 'isAppShuttingDown' },
      ]),
    ],
  },
  'recovery-store.resumeDiscardedCopies': {
    ts: runStore,
    cases: [
      sc([{ op: 'resumeDiscardedCopies' }, op('isDiscarded', A)]),
      sc([
        op('deleteCopy', A, { reason: 'dontSave' }),
        op('deleteCopy', B, { reason: 'dontSave' }),
        op('isDiscarded', A),
        { op: 'resumeDiscardedCopies' },
        op('isDiscarded', A),
        op('isDiscarded', B),
        op('writeCopy', A, { text: 'a' }),
        op('readCopy', A),
      ]),
    ],
  },
  'recovery-store.newUntitledRecoveryId': {
    ts: runStore,
    cases: [
      sc([{ op: 'newUntitledRecoveryId' }, { op: 'newUntitledRecoveryId' }]),
      sc([{ op: 'newUntitledRecoveryId' }]),
      sc(
        [
          {
            op: 'adoptUntitledCopy',
            kind: 'sheets',
            source: '$DIR/ud/sheets-autosave/unsaved-1.xlsx',
            title: 'x',
            ext: '.xlsx',
          },
          { op: 'newUntitledRecoveryId' },
        ],
        adoptFiles,
        'adopting uses the same source',
      ),
    ],
  },

  'unsaved-files.UNSAVED_CHANGES_MESSAGE': constant(UNSAVED_CHANGES_MESSAGE),
  'unsaved-files.setOpenFilesSource': {
    ts: async (a) => {
      setOpenFilesSource(sourceOf(a[0]))
      setOpenFilesSource(sourceOf(a[1]))
      try {
        return await fileHasUnsavedChanges(a[2] as string)
      } finally {
        setOpenFilesSource(null)
      }
    },
    cases: [
      { args: [docsList, null, D('a.docx')], files: unsavedFiles, note: 'set, then removed' },
      { args: [null, docsList, D('a.docx')], files: unsavedFiles, note: 'set after none' },
      { args: [docsList, { returns: [] }, D('a.docx')], files: unsavedFiles, note: 'replaced' },
      {
        args: [{ returns: [] }, docsList, D('a.docx')],
        files: unsavedFiles,
        note: 'replaced by a list with it',
      },
      {
        args: [docsList, { throws: true }, D('b.docx')],
        files: unsavedFiles,
        note: 'replaced by a failing source',
      },
      { args: [null, null, D('a.docx')], files: unsavedFiles, note: 'never set' },
    ],
  },
  'unsaved-files.fileHasUnsavedChanges': {
    ts: (a) => withSource(a[0], () => fileHasUnsavedChanges(a[1] as string)),
    cases: hasCases,
  },
  'unsaved-files.assertFileSaved': {
    ts: (a) => withSource(a[0], () => assertFileSaved(a[1] as string)),
    cases: hasCases,
  },
  'unsaved-files.withoutUnsavedFiles': {
    ts: (a) => withSource(a[0], () => withoutUnsavedFiles(a[1] as string[], (item) => item)),
    cases: [
      ...[docsList, null, { throws: true }, { returns: [] }, { returns: 5 }].map(
        (source): Case => ({
          args: [
            source,
            [D('a.docx'), D('b.docx'), D('c.docx'), D('./a.docx'), D('gone.docx'), D('other.docx')],
          ],
          files: unsavedFiles,
        }),
      ),
      { args: [docsList, []], files: unsavedFiles, note: 'no items' },
      {
        args: [docsList, [D('a.docx'), D('a.docx'), D('b.docx'), D('b.docx')]],
        files: unsavedFiles,
        note: 'duplicates stay',
      },
      {
        args: [
          linkedList,
          [D('a.docx'), D('b.docx'), D('c.docx'), `/proc/self/root${D('c.docx')}`],
        ],
        files: unsavedFiles,
        note: 'items matched to the open files through links',
      },
      {
        args: [
          docsList,
          [D('a.docx'), `/proc/self/root${D('a.docx')}`, `/private${D('a.docx')}`, D('b.docx')],
        ],
        files: unsavedFiles,
        note: 'items spelt through links match the open file',
      },
    ],
  },

  'legacy-import-prefs.LEGACY_IMPORT_SKIP_KEY': constant(LEGACY_IMPORT_SKIP_KEY),
  'legacy-import-prefs.LEGACY_IMPORT_KINDS': constant(LEGACY_IMPORT_KINDS),
  'legacy-import-prefs.readLegacyImportSkip': {
    ts: (a) => readLegacyImportSkip(a[0] as string, a[1] as 'odt'),
    cases: readSkipCases,
  },
  'legacy-import-prefs.writeLegacyImportSkip': {
    ts: (a) => masked(() => writeLegacyImportSkip(a[0] as string, a[1] as 'odt', a[2] as boolean)),
    cases: writeSkipCases,
  },
  'legacy-import-prefs.readLegacyImportPrompt': {
    ts: (a) => readLegacyImportPrompt(a[0] as string),
    cases: readPromptCases,
  },
  'legacy-import-prefs.writeLegacyImportPrompt': {
    ts: (a) => masked(() => writeLegacyImportPrompt(a[0] as string, a[1] as boolean)),
    cases: writePromptCases,
  },
}
