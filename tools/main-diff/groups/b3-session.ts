/**
 * Group `b3-session`: the session record, the tab modules (lifecycle,
 * duplicate, document actions, menu, shortcuts), the split layout, the
 * open-documents registry, the window close guard and the small shell
 * modules around them.
 *
 * What the TypeScript takes as an Electron object or a callback is a fake
 * that logs each call (one `logs` line); the Rust side logs the same lines.
 * Timers of the session recorder are fakes the steps fire. A number a spec
 * writes as NaN reaches Rust as `null` (that is how JSON writes NaN), which
 * Rust reads as NaN again; a spec never writes an infinity.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CRASH_LOOP_WINDOW_MS,
  SESSION_RECORD_FILE,
  SESSION_RECORD_WRITE_DELAY_MS,
  createSessionRecorder,
  holdSessionTabsForUpdateRestart,
  initSessionRecord,
  judgePreviousExit,
  markSessionClosedToTray,
  markSessionCleanExit,
  markSessionOsEnd,
  markSessionUpdateRestart,
  noteSessionChanged,
  parseSessionRecord,
  readSessionRecord,
  resetSessionRecordForTests,
  sessionRecorder,
  sessionRecordPath,
  sessionRestoreLayout,
  sessionSnapshotFrom,
} from '../../../apps/shell/src/main/session-record.ts'
import type {
  SessionRecorder,
  SessionRecorderOptions,
  SessionRecordReadResult,
  SessionSnapshot,
  SessionSnapshotSource,
} from '../../../apps/shell/src/main/session-record.ts'
import {
  MAX_RECENTLY_CLOSED,
  closeTabsInOrder,
  createRecentlyClosedTracker,
} from '../../../apps/shell/src/main/tab-lifecycle.ts'
import { duplicateDocumentFile } from '../../../apps/shell/src/main/tab-duplicate.ts'
import { runTabDocumentAction } from '../../../apps/shell/src/main/tab-document-actions.ts'
import {
  baseName,
  isProgramFile,
  pathLabel,
  tabMenuTemplate,
} from '../../../apps/shell/src/main/tab-menu.ts'
import { handleTabShortcut, tabShortcutOf } from '../../../apps/shell/src/main/tab-shortcuts.ts'
import {
  SPLIT_EVEN_RATIO,
  activationMode,
  clampSplitRatio,
  decideSplitDrop,
  oppositeDocumentId,
  paneRects,
  splitAvailablePx,
  splitDropZone,
  splitRatioLimits,
  splitSurvivor,
} from '../../../apps/shell/src/main/split-layout.ts'
import {
  OPEN_DOCUMENTS_FILE,
  clearOpenDocuments,
  publishOpenDocuments,
} from '../../../apps/shell/src/main/open-documents.ts'
import {
  SHELL_BACKGROUND_DARK,
  SHELL_BACKGROUND_LIGHT,
  shellWindowBackground,
} from '../../../apps/shell/src/main/window-background.ts'
import { tabStripOverlay } from '../../../apps/shell/src/main/title-bar-overlay.ts'
import { isInstallableSkillDir } from '../../../apps/shell/src/main/skill-target.ts'
import { isMoveSource, isUserVisibleFile } from '../../../apps/shell/src/main/file-targets.ts'
import { registerResultStoreIpc } from '../../../apps/shell/src/main/result-store-ipc.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'

type J = any

const str = (a: unknown[], i: number): string => a[i] as string

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

/** `new Date()` and `Date.now()` read the clock of the call while `fn` runs */
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

/** an Error shows as `String(error)`, anything else as itself */
const shown = (value: unknown): unknown => (value instanceof Error ? String(value) : value)

/** `console[name]` logs `["console.<name>", ...args]` while `fn` runs */
function withConsole<T>(cx: TsContext, name: 'warn' | 'error', fn: () => T): T {
  const real = console[name]
  console[name] = (...args: unknown[]) => cx.log(`console.${name}`, ...args.map(shown))
  try {
    return fn()
  } finally {
    console[name] = real
  }
}

/** a temp name's random part differs on each side: `.<hex>.tmp` */
const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')
const maskPidTmp = (text: string): string =>
  text.replace(
    /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp/g,
    '.<pid>.<uuid>.tmp',
  )

// ------------------------------------------------------------------ session record

/** a record in the key order `parseSessionRecord` writes */
const rec = (o: J = {}): J => ({
  version: 1,
  cleanExit: false,
  startedAt: 1000,
  restoreRun: false,
  pastStartup: false,
  tabs: [],
  ...o,
})

/** a tab in the key order `normalizeTab` writes */
const tab = (kind: string, title: string, extra: J = {}): J => ({ kind, title, ...extra })

const U_OK = { untitledId: 'copy-1_A', ext: '.docx' }

const SPLIT_OK = { a: 0, b: 1, orientation: 'side', ratio: 0.5, focus: 'a' }

/** The source of `sessionSnapshotFrom`; `copies` is what `untitledCopyFor` answers by tab id. */
function snapshotSource(spec: J, cx: TsContext): SessionSnapshotSource {
  const copies: J = spec.copies
  const source: SessionSnapshotSource = {
    strip: spec.strip ?? null,
    ...(spec.detached ? { detached: spec.detached } : {}),
    ...(copies
      ? {
          untitledCopyFor: (t: J) => {
            cx.log('untitledCopyFor', t)
            return Object.prototype.hasOwnProperty.call(copies, t.id) ? copies[t.id] : undefined
          },
        }
      : {}),
  }
  return source
}

const stripOf = (tabs: J[], extra: J = {}): J => ({
  tabs,
  activeId: null,
  split: null,
  ...extra,
})

const snapshotCases: Case[] = [
  { args: [{ strip: null }], note: 'no strip, no detached' },
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A', filePath: '/w/a.docx', content: 'secret' },
            { id: 'b', kind: 'sheets', title: 'B', extra: 1 },
            { id: 'c', kind: 'slides', title: 'C' },
            { id: 'd', kind: 'pdf', title: 'D', filePath: '/w/d.pdf' },
          ],
          {
            activeId: 'b',
            split: { aTabId: 'a', bTabId: 'd', orientation: 'stack', ratio: 0.99, focus: 'b' },
          },
        ),
        detached: [{ id: 'e', kind: 'markdown', title: 'E', filePath: '/w/e.md' }],
        copies: {
          b: { untitledId: 'u_1', ext: '.xlsx' },
          c: { untitledId: 'bad id', ext: '.pptx' },
        },
      },
    ],
    note: 'a valid and an invalid untitled copy, extra fields, ratio clamped',
  },
  {
    args: [
      {
        strip: stripOf([{ id: 'a', kind: 'docs', title: 'A' }], { activeId: 'z' }),
        detached: [
          { id: 'd1', kind: 'html', title: 'D1', filePath: '/w/d1.html' },
          { id: 'd2', kind: 'hwp', title: 'D2' },
        ],
        copies: {},
      },
    ],
    note: 'detached tabs after the strip; no copy for an untitled one',
  },
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A' },
            { id: 'b', kind: 'epub', title: 'B', filePath: '/w/b.epub' },
          ],
          {
            activeId: 'd1',
            split: { aTabId: 'a', bTabId: 'd1', orientation: 'side', ratio: 0.5, focus: 'a' },
          },
        ),
        detached: [{ id: 'd1', kind: 'diagram', title: 'D1', filePath: '/w/d1.drawio' }],
      },
    ],
    note: 'the front tab and a split side are detached: neither is kept',
  },
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'home', kind: 'home', title: 'Home' },
            { id: 'x', kind: 'bogus', title: 'X' },
            { id: 'y', kind: 'docs' },
            { id: 'z', kind: 'docs', title: 7 },
            { id: 'e', kind: 'mindmap', title: 'E', filePath: '' },
            { id: 'n', kind: 'docs', title: 'N', filePath: null },
            { id: 'f', kind: 'docs', title: 'F', filePath: 5 },
            { id: 'g', kind: 'hwp', title: 'G', filePath: '/w/g.hwp' },
          ],
          { activeId: 'g' },
        ),
        copies: {
          e: { untitledId: 'e1', ext: '.mm' },
          n: null,
          f: { untitledId: 'f1', ext: '.docx' },
        },
      },
    ],
    note: 'unusable tabs dropped; bad file paths dropped from the tab, not the tab',
  },
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A', filePath: '/a' },
            { id: 'b', kind: 'docs', title: 'B', filePath: '/b' },
            { id: 'c', kind: 'docs', title: 'C', filePath: '/c' },
          ],
          {
            activeId: 'c',
            split: { aTabId: 'a', bTabId: 'a', orientation: 'side', ratio: 0.5, focus: 'a' },
          },
        ),
      },
    ],
    note: 'a split with one tab twice',
  },
  ...['diag', 'side', 'stack'].map((orientation): Case => ({
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A', filePath: '/a' },
            { id: 'b', kind: 'docs', title: 'B', filePath: '/b' },
          ],
          { split: { aTabId: 'a', bTabId: 'b', orientation, ratio: 0.01, focus: 'b' } },
        ),
      },
    ],
    note: `orientation ${orientation}, ratio clamped up`,
  })),
  ...[NaN, '0.5', 0.95, 1.5, -2, 0.05].map((ratio): Case => ({
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A', filePath: '/a' },
            { id: 'b', kind: 'docs', title: 'B', filePath: '/b' },
          ],
          { split: { aTabId: 'a', bTabId: 'b', orientation: 'side', ratio, focus: 'a' } },
        ),
      },
    ],
    note: `ratio ${String(ratio)}`,
  })),
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'a', kind: 'docs', title: 'A', filePath: '/a' },
            { id: 'b', kind: 'docs', title: 'B', filePath: '/b' },
          ],
          { split: { aTabId: 'a', bTabId: 'b', orientation: 'side', ratio: 0.5, focus: 'c' } },
        ),
      },
    ],
    note: 'a focus that is neither pane',
  },
  {
    args: [
      {
        strip: stripOf(
          [
            { id: 'dup', kind: 'docs', title: 'First', filePath: '/1' },
            { id: 'dup', kind: 'docs', title: 'Second', filePath: '/2' },
          ],
          { activeId: 'dup' },
        ),
      },
    ],
    note: 'two tabs with one id: the later index answers',
  },
  {
    args: [
      {
        strip: stripOf([
          { id: 'a', kind: 'docs', title: 'A\u0131\u{1F600}', filePath: '/w/\u017F.docx' },
          { id: 'b', kind: 'sheets', title: '', copies: 1 },
        ]),
        copies: { b: { untitledId: 'x'.repeat(64), ext: '.csv' } },
      },
    ],
    note: 'non-ASCII text, an id of 64 characters, an empty title',
  },
  {
    args: [
      {
        strip: stripOf([
          { id: 'a', kind: 'docs', title: 'A' },
          { id: 'b', kind: 'docs', title: 'B' },
          { id: 'c', kind: 'docs', title: 'C' },
          { id: 'd', kind: 'docs', title: 'D' },
          { id: 'e', kind: 'docs', title: 'E' },
          { id: 'f', kind: 'docs', title: 'F' },
          { id: 'g', kind: 'docs', title: 'G' },
          { id: 'h', kind: 'docs', title: 'H' },
        ]),
        copies: {
          a: { untitledId: 'x'.repeat(65), ext: '.docx' },
          b: { untitledId: 'ok', ext: '.DOCX' },
          c: { untitledId: 'ok', ext: '.abcdefghijk' },
          d: { untitledId: 'ok\n', ext: '.docx' },
          e: { untitledId: '\u0131d', ext: '.docx' },
          f: { untitledId: 'ok', ext: '.' },
          g: { untitledId: 'ok', ext: '.a0123456789' },
          h: [],
        },
      },
    ],
    note: 'untitled copy identities at the edges of their patterns',
  },
]

const RAW_RECORDS: [string, unknown][] = [
  ['null', null],
  ['an array', []],
  ['a number', 5],
  ['a string', 'x'],
  ['version 2', rec({ version: 2 })],
  ['version "1"', rec({ version: '1' })],
  ['cleanExit missing', { version: 1, startedAt: 1, restoreRun: false, tabs: [] }],
  ['cleanExit a string', rec({ cleanExit: 'true' })],
  ['startedAt a string', rec({ startedAt: '1' })],
  ['startedAt NaN', rec({ startedAt: NaN })],
  ['restoreRun missing', { version: 1, cleanExit: true, startedAt: 1, tabs: [] }],
  ['tabs an object', rec({ tabs: {} })],
  ['tabs missing', { version: 1, cleanExit: true, startedAt: 1, restoreRun: false }],
  ['empty', rec()],
  ['clean, startedAt a fraction', rec({ cleanExit: true, startedAt: 1700000000123.5 })],
  ['startedAt 1e21', rec({ startedAt: 1e21 })],
  ['startedAt negative zero', rec({ startedAt: -0 })],
  ['pastStartup "yes"', rec({ pastStartup: 'yes' })],
  ['pastStartup true', rec({ pastStartup: true })],
  [
    'everything',
    rec({
      cleanExit: true,
      restoreRun: true,
      pastStartup: true,
      tabs: [
        tab('docs', 'A', { filePath: '/a.docx' }),
        tab('sheets', 'B', { untitled: U_OK }),
        tab('html', 'C'),
      ],
      updateRestart: true,
      active: 1,
      split: { a: 0, b: 1, orientation: 'stack', ratio: 0.3, focus: 'b' },
    }),
  ],
  ['updateRestart "true"', rec({ updateRestart: 'true' })],
  [
    'strict tab rules',
    rec({
      tabs: [
        tab('docs', 'ok'),
        tab('home', 'home'),
        tab('docs', 'path', { filePath: '' }),
        tab('docs', 'path5', { filePath: 5 }),
        tab('docs', 'null', { filePath: null }),
        tab('docs', 'untitledNull', { untitled: null }),
        tab('docs', 'untitledBad', { untitled: { untitledId: 'a b', ext: '.docx' } }),
        tab('docs', 'untitledArray', { untitled: [] }),
        tab('docs', 'withPath', { filePath: '/p', untitled: U_OK }),
        tab('docs', 'withPathBad', { filePath: '/p', untitled: 5 }),
        { kind: 'docs' },
        { title: 'x' },
        null,
        [],
        'x',
        tab('pdf', 'det', { detached: 'true' }),
        tab('pdf', 'det2', { detached: true }),
        { kind: 'hwp', title: 'extra', filePath: '/h', content: 'secret', untitled: undefined },
      ],
    }),
  ],
  [
    'active and split remapped past dropped tabs',
    rec({
      tabs: [
        tab('docs', 'zero'),
        { kind: 'bogus', title: 'x' },
        tab('docs', 'two', { filePath: '/2' }),
        tab('docs', 'three', { filePath: '/3' }),
      ],
      active: 3,
      split: { a: 0, b: 3, orientation: 'side', ratio: 0.7, focus: 'b' },
    }),
  ],
  [
    'active at a dropped tab',
    rec({ tabs: [{ kind: 'bogus', title: 'x' }, tab('docs', 'one')], active: 0 }),
  ],
  [
    'split at a dropped tab',
    rec({
      tabs: [{ kind: 'bogus', title: 'x' }, tab('docs', 'one'), tab('docs', 'two')],
      split: { a: 0, b: 1, orientation: 'side', ratio: 0.5, focus: 'a' },
    }),
  ],
  ['active 1.5', rec({ tabs: [tab('docs', 'a'), tab('docs', 'b')], active: 1.5 })],
  ['active -1', rec({ tabs: [tab('docs', 'a')], active: -1 })],
  ['active negative zero', rec({ tabs: [tab('docs', 'a')], active: -0 })],
  ['active a string', rec({ tabs: [tab('docs', 'a')], active: '0' })],
  ['active past the end', rec({ tabs: [tab('docs', 'a')], active: 1 })],
  [
    'active is detached',
    rec({ tabs: [tab('docs', 'a'), tab('docs', 'b', { detached: true })], active: 1 }),
  ],
  [
    'split with a detached side',
    rec({
      tabs: [tab('docs', 'a'), tab('docs', 'b', { detached: true })],
      split: SPLIT_OK,
    }),
  ],
  ...(
    [
      ['ratio 5', { ratio: 5 }],
      ['ratio -3', { ratio: -3 }],
      ['ratio NaN', { ratio: NaN }],
      ['ratio a string', { ratio: '0.5' }],
      ['orientation diag', { orientation: 'diag' }],
      ['focus c', { focus: 'c' }],
      ['a equals b', { b: 0 }],
      ['a a fraction', { a: 0.5 }],
      ['b a string', { b: '1' }],
      ['a missing', { a: undefined }],
    ] as [string, J][]
  ).map(([name, override]): [string, unknown] => [
    `split ${name}`,
    rec({ tabs: [tab('docs', 'a'), tab('docs', 'b')], split: { ...SPLIT_OK, ...override } }),
  ]),
  ['split an array', rec({ tabs: [tab('docs', 'a'), tab('docs', 'b')], split: [] })],
  ['split null', rec({ tabs: [tab('docs', 'a')], split: null })],
  [
    'split b at the tab count',
    rec({ tabs: [tab('docs', 'a'), tab('docs', 'b')], split: { ...SPLIT_OK, b: 2 } }),
  ],
  [
    'split a at the tab count',
    rec({ tabs: [tab('docs', 'a'), tab('docs', 'b')], split: { ...SPLIT_OK, a: 2, b: 0 } }),
  ],
]

function sessionPathCases(): Case[] {
  return ['/x', '', 'rel', '/x/', '/a/../b', 'C:\\u', '/\u00fc\u0131/\u{1F600}'].map((d) => ({
    args: [d],
  }))
}

const readCases: Case[] = [
  { args: ['$DIR/none.json'], note: 'missing' },
  { args: ['$DIR/dir'], files: { dir: { dir: true } }, note: 'a folder' },
  { args: ['$DIR/f.txt/x'], files: { 'f.txt': 'x' }, note: 'a file as a folder' },
  { args: ['$DIR/r.json'], files: { 'r.json': JSON.stringify(rec({ tabs: [tab('docs', 'A')] })) } },
  { args: ['$DIR/r.json'], files: { 'r.json': '{ not json' }, note: 'not JSON' },
  { args: ['$DIR/r.json'], files: { 'r.json': '[]' }, note: 'JSON but no record' },
  { args: ['$DIR/r.json'], files: { 'r.json': '' }, note: 'empty' },
  {
    args: ['$DIR/r.json'],
    files: { 'r.json': { hex: 'efbbbf' + Buffer.from(JSON.stringify(rec())).toString('hex') } },
    note: 'a byte order mark in front',
  },
  {
    args: ['$DIR/r.json'],
    files: {
      'r.json': {
        hex:
          Buffer.from(
            '{"version":1,"cleanExit":true,"startedAt":5,"restoreRun":false,"tabs":[{"kind":"docs","title":"a',
          ).toString('hex') +
          'ff' +
          Buffer.from('b"}]}').toString('hex'),
      },
    },
    note: 'an ill-formed byte in a title',
  },
  {
    args: ['$DIR/r.json'],
    files: { 'r.json': { text: JSON.stringify(rec()), mode: 0 } },
    note: 'unreadable',
  },
  {
    args: ['$DIR/r.json'],
    files: {
      'r.json': JSON.stringify(
        rec({
          tabs: [tab('docs', 'A'), { kind: 'bogus', title: 'x' }, tab('sheets', 'B')],
          active: 2,
        }),
      ),
    },
    note: 'a tab dropped, the front tab remapped',
  },
]

const recOk = (o: J = {}): J => ({ status: 'ok', record: rec(o) })

const judgeCases: Case[] = [
  { args: [{ status: 'missing' }, false, null] },
  { args: [{ status: 'missing' }, true, { reopenedByInstaller: true }], note: 'no record wins' },
  { args: [{ status: 'corrupt' }, false, null] },
  { args: [{ status: 'corrupt' }, true, null] },
  { args: [{ status: 'corrupt' }, true, { reopenedByInstaller: true }] },
  { args: [recOk({ cleanExit: false, restoreRun: true, pastStartup: false }), false, null] },
  { args: [recOk({ cleanExit: false, restoreRun: true, pastStartup: true }), true, null] },
  { args: [recOk({ cleanExit: false, restoreRun: false }), true, { reopenedByInstaller: true }] },
  { args: [recOk({ cleanExit: true, updateRestart: true }), true, null] },
  { args: [recOk({ cleanExit: true }), true, { reopenedByInstaller: true }] },
  { args: [recOk({ cleanExit: true }), false, { reopenedByInstaller: true }] },
  { args: [recOk({ cleanExit: true }), true, null] },
  { args: [recOk({ cleanExit: true }), false, null] },
  { args: [recOk({ cleanExit: true }), false, {}] },
  { args: [recOk({ cleanExit: true }), false, { reopenedByInstaller: 'true' }] },
  { args: [recOk({ cleanExit: true }), false, { reopenedByInstaller: false }] },
]

const LAYOUT_RECORD = rec({
  cleanExit: false,
  restoreRun: true,
  tabs: [
    tab('docs', 'A', { filePath: '/a.docx' }),
    tab('sheets', 'B', { untitled: U_OK }),
    tab('pdf', 'C', { filePath: '/c.pdf', detached: true }),
  ],
  active: 1,
  split: { a: 0, b: 1, orientation: 'stack', ratio: 0.25, focus: 'b' },
})

const layoutCases: Case[] = [
  { args: [LAYOUT_RECORD, { crashLoop: false }] },
  { args: [LAYOUT_RECORD, { crashLoop: true }] },
  {
    args: [rec({ tabs: [tab('html', 'H')] }), { crashLoop: false }],
    note: 'no front tab, no split',
  },
  { args: [rec(), { crashLoop: true }], note: 'no tabs' },
  { args: [rec({ tabs: [tab('docs', 'A'), tab('docs', 'B')], active: 0 }), { crashLoop: false }] },
]

/** `[tabs, active, split]` as a step's snapshot */
const snap = (tabs: J, extra: J = {}): J => ({ tabs, ...extra })

/**
 * The scenario of `createSessionRecorder` and of the process-wide functions.
 * A recorder's timers are fakes (`fireWrite`, `fireStartup`); the delays of
 * the two are always unlike, which is how a fired timer is found.
 */
function sessionScenario(global: boolean) {
  return (a: unknown[], cx: TsContext) => {
    const spec = a[0] as J
    const writeDelay: number = spec.writeDelayMs ?? SESSION_RECORD_WRITE_DELAY_MS
    const loopWindow: number = spec.crashLoopWindowMs ?? CRASH_LOOP_WINDOW_MS
    if (writeDelay === loopWindow) throw new Error('the two delays must differ')
    return withClock(cx.now, () => {
      const pending: { fn: () => void; delay: number; unref(): void }[] = []
      const realSet = globalThis.setTimeout
      const realClear = globalThis.clearTimeout
      globalThis.setTimeout = ((fn: () => void, delay: number) => {
        const timer = { fn, delay, unref() {} }
        pending.push(timer)
        return timer
      }) as unknown as typeof setTimeout
      globalThis.clearTimeout = ((timer: unknown) => {
        const at = pending.indexOf(timer as (typeof pending)[number])
        if (at >= 0) pending.splice(at, 1)
      }) as unknown as typeof clearTimeout
      let failing = false
      const options: SessionRecorderOptions = {
        userDataDir: spec.userDataDir,
        ...(spec.clock === 'default' ? {} : { now: () => cx.now + 7 }),
        ...(spec.writeDelayMs !== undefined ? { writeDelayMs: spec.writeDelayMs } : {}),
        ...(spec.crashLoopWindowMs !== undefined
          ? { crashLoopWindowMs: spec.crashLoopWindowMs }
          : {}),
        ...(spec.write === 'real'
          ? {}
          : {
              writeJson: (filePath: string, value: unknown) => {
                cx.log('writeJson', filePath, JSON.parse(JSON.stringify(value)))
                if (failing) throw new Error('disk full')
              },
            }),
      }
      try {
        return withConsole(cx, 'warn', () => {
          if (global) resetSessionRecordForTests()
          const direct = global ? null : createSessionRecorder(options)
          const rc = (): SessionRecorder | null => (global ? sessionRecorder() : direct)
          const fire = (delay: number): void => {
            const at = pending.findIndex((t) => t.delay === delay)
            if (at < 0) return
            const [timer] = pending.splice(at, 1)
            timer.fn()
          }
          const steps: J[] = []
          for (const step of spec.steps as J[]) {
            const extra: J = {}
            switch (step.op) {
              case 'startRun':
                rc()?.startRun({ restoreRun: step.restoreRun === true })
                break
              case 'update':
                rc()?.update(step.snapshot as SessionSnapshot)
                break
              case 'flush':
                rc()?.flush()
                break
              case 'markCleanExit':
                rc()?.markCleanExit()
                break
              case 'hold':
                rc()?.holdTabsForUpdateRestart()
                break
              case 'markUpdateRestart':
                rc()?.markUpdateRestart()
                break
              case 'markClosedToTray':
                rc()?.markClosedToTray()
                break
              case 'markOsSessionEnd':
                rc()?.markOsSessionEnd()
                break
              case 'dispose':
                rc()?.dispose()
                break
              case 'fireWrite':
                fire(writeDelay)
                break
              case 'fireStartup':
                fire(loopWindow)
                break
              case 'failWrites':
                failing = step.on === true
                break
              case 'init': {
                const before = sessionRecorder()
                const got = initSessionRecord(options)
                extra.same = before !== null && got === before
                break
              }
              case 'recorder': {
                const r = sessionRecorder()
                extra.present = r !== null
                if (r) extra.previous = r.previous
                break
              }
              case 'note':
                noteSessionChanged(snapshotSource(step.source, cx))
                break
              case 'cleanExit':
                markSessionCleanExit()
                break
              case 'holdTabs':
                holdSessionTabsForUpdateRestart()
                break
              case 'updateRestart':
                markSessionUpdateRestart()
                break
              case 'closedToTray':
                markSessionClosedToTray()
                break
              case 'osEnd':
                markSessionOsEnd()
                break
              case 'reset':
                resetSessionRecordForTests()
                break
              default:
                throw new Error(`unknown step ${step.op}`)
            }
            steps.push({ op: step.op, timers: pending.map((t) => t.delay), ...extra })
          }
          return direct ? { previous: direct.previous, steps } : { steps }
        })
      } finally {
        if (global) resetSessionRecordForTests()
        globalThis.setTimeout = realSet
        globalThis.clearTimeout = realClear
      }
    })
  }
}

const UD = '$DIR/ud'

const PREV_FILE = (o: J = {}): Record<string, FileSpec> => ({
  'ud/session-record.json': JSON.stringify(rec(o)),
})

const PREV_RICH = {
  cleanExit: false,
  tabs: [
    tab('docs', 'A', { filePath: '/a.docx' }),
    tab('sheets', 'B', { untitled: U_OK }),
    tab('pdf', 'C', { filePath: '/c.pdf', detached: true }),
  ],
  active: 1,
  split: { a: 0, b: 1, orientation: 'side', ratio: 0.4, focus: 'a' },
}

const TWO = snap(
  [tab('docs', 'A', { filePath: '/a.docx' }), tab('html', 'B', { filePath: '/b.html' })],
  {
    active: 1,
    split: SPLIT_OK,
  },
)
const THREE = snap([...TWO.tabs, tab('mindmap', 'C')], { active: 0 })

const recorderCases: Case[] = [
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'update', snapshot: TWO },
          { op: 'flush' },
          { op: 'markCleanExit' },
          { op: 'startRun', restoreRun: false },
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'fireWrite' },
          { op: 'update', snapshot: TWO },
          { op: 'update', snapshot: THREE },
          { op: 'update', snapshot: THREE },
          { op: 'flush' },
          { op: 'fireStartup' },
          { op: 'update', snapshot: TWO },
          { op: 'markCleanExit' },
          { op: 'update', snapshot: THREE },
          { op: 'flush' },
          { op: 'startRun', restoreRun: true },
        ],
      },
    ],
    note: 'a fresh run: dropped updates, one write for a burst, the clean mark ends it',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: true },
          { op: 'update', snapshot: THREE },
          { op: 'markOsSessionEnd' },
          { op: 'update', snapshot: TWO },
          { op: 'fireWrite' },
          { op: 'markCleanExit' },
        ],
      },
    ],
    files: PREV_FILE(PREV_RICH),
    note: 'a restore run carries the previous tabs; an OS session end stops it without the mark',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: true },
          { op: 'fireStartup' },
          { op: 'markCleanExit' },
        ],
      },
    ],
    files: { 'ud/session-record.json': '{ broken' },
    note: 'restore with a corrupt previous record starts empty',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [{ op: 'startRun', restoreRun: false }, { op: 'markCleanExit' }],
      },
    ],
    files: PREV_FILE(PREV_RICH),
    note: 'not a restore run: the previous tabs are not carried',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'failWrites', on: true },
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'fireWrite' },
          { op: 'flush' },
          { op: 'failWrites', on: false },
          { op: 'flush' },
          { op: 'update', snapshot: TWO },
          { op: 'flush' },
        ],
      },
    ],
    note: 'a write that fails is warned about and tried again; the same text is not written twice',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'dispose' },
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
        ],
      },
    ],
    note: 'a disposed recorder starts no run',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'hold' },
          { op: 'markUpdateRestart' },
          { op: 'markClosedToTray' },
          { op: 'markOsSessionEnd' },
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'hold' },
          { op: 'update', snapshot: snap([tab('docs', 'Z')]) },
          { op: 'markUpdateRestart' },
          { op: 'markUpdateRestart' },
        ],
      },
    ],
    note: 'tabs held when the update quit began come back, with the mark last',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'markUpdateRestart' },
          { op: 'update', snapshot: THREE },
        ],
      },
    ],
    note: 'no hold: the tabs of the moment',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'flush' },
          { op: 'markClosedToTray' },
          { op: 'markClosedToTray' },
          { op: 'update', snapshot: THREE },
          { op: 'markClosedToTray' },
          { op: 'markCleanExit' },
        ],
      },
    ],
    note: 'closed into the tray empties the list; a tab change writes at once',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: { tabs: 'not a list' } },
          { op: 'update', snapshot: {} },
          {
            op: 'update',
            snapshot: {
              tabs: [
                { kind: 'docs', title: 'A', content: 'x' },
                { kind: 'bogus', title: 'B' },
                { kind: 'sheets', title: 'C', filePath: '' },
                { kind: 'pdf', title: 'D', filePath: '/d.pdf', detached: true },
              ],
              active: 3,
              split: { a: 0, b: 3, orientation: 'side', ratio: 0.5, focus: 'a' },
            },
          },
          { op: 'flush' },
          {
            op: 'update',
            snapshot: {
              tabs: [
                { kind: 'docs', title: 'A' },
                { kind: 'docs', title: 'B' },
              ],
              active: 1,
              split: { a: 0, b: 1, orientation: 'stack', ratio: 9, focus: 'b' },
            },
          },
          { op: 'flush' },
        ],
      },
    ],
    note: 'an update is validated again: bad tabs, an active tab that is detached, a split clamped',
  },
  {
    args: [
      {
        userDataDir: UD,
        write: 'real',
        steps: [
          { op: 'startRun', restoreRun: true },
          { op: 'update', snapshot: THREE },
          { op: 'flush' },
          { op: 'fireStartup' },
          { op: 'markCleanExit' },
        ],
      },
    ],
    files: PREV_FILE(PREV_RICH),
    note: 'the atomic JSON writer: the file after the run',
  },
  {
    args: [
      {
        userDataDir: UD,
        write: 'real',
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'markUpdateRestart' },
        ],
      },
    ],
    note: 'the atomic writer creates the folder; the update mark is written last',
  },
  {
    args: [
      {
        userDataDir: '$DIR/blocker/ud',
        write: 'real',
        steps: [
          { op: 'startRun', restoreRun: true },
          { op: 'update', snapshot: TWO },
          { op: 'flush' },
        ],
      },
    ],
    files: { blocker: 'a file, not a folder' },
    note: 'the previous record is missing (a file as a folder) and the atomic write fails',
  },
  {
    args: [
      {
        userDataDir: UD,
        writeDelayMs: 5,
        crashLoopWindowMs: 9,
        clock: 'default',
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'fireWrite' },
          { op: 'fireStartup' },
        ],
      },
    ],
    note: 'other delays and the clock `Date.now` gives',
  },
  {
    args: [
      {
        userDataDir: UD,
        writeDelayMs: 0,
        steps: [
          { op: 'startRun', restoreRun: false },
          { op: 'update', snapshot: TWO },
          { op: 'fireWrite' },
          { op: 'fireStartup' },
        ],
      },
    ],
    note: 'a write delay of 0 stays 0',
  },
  {
    args: [
      {
        userDataDir: UD,
        steps: [
          { op: 'startRun', restoreRun: true },
          { op: 'update', snapshot: TWO },
        ],
      },
    ],
    files: PREV_FILE({ cleanExit: true, updateRestart: true, tabs: [tab('docs', 'U')], active: 0 }),
    note: 'the previous record of an update restart',
  },
]

const globalCases = (steps: J[][], files?: Record<string, FileSpec>): Case[] =>
  steps.map((s, i): Case => ({
    args: [{ userDataDir: UD, steps: s }],
    ...(files && i === 0 ? { files } : {}),
  }))

const NOTE_SOURCE = {
  strip: stripOf(
    [
      { id: 'a', kind: 'docs', title: 'A', filePath: '/a.docx', content: 'secret' },
      { id: 'b', kind: 'sheets', title: 'B' },
    ],
    {
      activeId: 'a',
      split: { aTabId: 'a', bTabId: 'b', orientation: 'side', ratio: 0.5, focus: 'a' },
    },
  ),
  detached: [{ id: 'd', kind: 'pdf', title: 'D', filePath: '/d.pdf' }],
  copies: { b: U_OK },
}

const RUN = { op: 'startRun', restoreRun: false }

const globalSteps = {
  init: [
    [{ op: 'init' }, { op: 'recorder' }, { op: 'init' }, { op: 'recorder' }],
    [{ op: 'recorder' }],
    [{ op: 'init' }, RUN, { op: 'update', snapshot: { tabs: [tab('docs', 'A')] } }, { op: 'init' }],
  ],
  recorder: [
    [{ op: 'recorder' }],
    [{ op: 'init' }, { op: 'recorder' }],
    [{ op: 'init' }, { op: 'reset' }, { op: 'recorder' }],
  ],
  note: [
    [{ op: 'note', source: NOTE_SOURCE }, { op: 'init' }],
    [
      { op: 'init' },
      RUN,
      { op: 'note', source: NOTE_SOURCE },
      { op: 'flush' },
      { op: 'fireStartup' },
    ],
    [
      { op: 'init' },
      { op: 'note', source: NOTE_SOURCE },
      RUN,
      { op: 'note', source: NOTE_SOURCE },
      { op: 'note', source: NOTE_SOURCE },
    ],
    [
      { op: 'init' },
      RUN,
      { op: 'note', source: { strip: null } },
      { op: 'osEnd' },
      { op: 'note', source: NOTE_SOURCE },
    ],
  ],
  cleanExit: [
    [{ op: 'cleanExit' }],
    [{ op: 'init' }, { op: 'cleanExit' }, RUN, { op: 'cleanExit' }, { op: 'cleanExit' }],
  ],
  holdTabs: [
    [{ op: 'holdTabs' }, { op: 'init' }, RUN, { op: 'holdTabs' }, { op: 'updateRestart' }],
    [
      { op: 'init' },
      RUN,
      { op: 'update', snapshot: TWO },
      { op: 'holdTabs' },
      { op: 'update', snapshot: THREE },
      { op: 'updateRestart' },
    ],
  ],
  updateRestart: [
    [{ op: 'updateRestart' }],
    [
      { op: 'init' },
      RUN,
      { op: 'update', snapshot: TWO },
      { op: 'updateRestart' },
      { op: 'cleanExit' },
    ],
  ],
  closedToTray: [
    [{ op: 'closedToTray' }],
    [
      { op: 'init' },
      RUN,
      { op: 'update', snapshot: TWO },
      { op: 'closedToTray' },
      { op: 'update', snapshot: THREE },
    ],
  ],
  osEnd: [
    [{ op: 'osEnd' }],
    [
      { op: 'init' },
      RUN,
      { op: 'update', snapshot: TWO },
      { op: 'osEnd' },
      { op: 'fireWrite' },
      { op: 'cleanExit' },
    ],
  ],
  reset: [
    [{ op: 'reset' }],
    [
      { op: 'init' },
      RUN,
      { op: 'update', snapshot: TWO },
      { op: 'reset' },
      { op: 'recorder' },
      { op: 'init' },
      { op: 'recorder' },
    ],
  ],
}

// ------------------------------------------------------------------ tab lifecycle

const T = (id: string, extra: J = {}): J => ({ id, ...extra })

const closeCases: Case[] = [
  {
    args: [{ tabs: [T('home'), T('a'), T('b'), T('c')] }, ['a', 'b', 'c']],
    note: 'each closes in turn',
  },
  {
    args: [{ tabs: [T('home'), T('a'), T('b')] }, ['home', 'missing', 'a', 'b']],
    note: 'home and an unknown id are skipped',
  },
  {
    args: [
      { tabs: [T('a', { closable: false }), T('b', { closable: true }), T('c', { kind: 'docs' })] },
      ['a', 'b', 'c'],
    ],
    note: 'unclosable is skipped; true and absent close',
  },
  {
    args: [{ tabs: [T('a'), T('b'), T('c')], behavior: { b: 'cancel' } }, ['a', 'b', 'c']],
    note: 'a cancelled close stops the chain',
  },
  {
    args: [
      { tabs: [T('a'), T('b'), T('c'), T('d')], behavior: { a: ['a', 'b'] } },
      ['a', 'b', 'c'],
    ],
    note: 'closing a tab takes another with it',
  },
  { args: [{ tabs: [T('a')] }, []], note: 'no ids' },
  { args: [{ tabs: [T('a'), T('b')] }, ['a', 'a', 'b']], note: 'an id twice' },
  {
    args: [{ tabs: [T('a'), T('b')], behavior: { a: [] } }, ['a', 'b']],
    note: 'a close that removes nothing stops the chain',
  },
]

const pushStep = (filePath: string | undefined, kind?: string): J => ({
  op: 'push',
  closed: {
    ...(kind !== undefined ? { kind } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
  },
})
const REOPEN = (open: J = {}, exists: string[] | null = null): J => ({
  op: 'reopenNext',
  open,
  exists,
})
const ENTRIES = { op: 'getEntries' }

const manyPushes: J[] = Array.from({ length: 22 }, (_, i) => pushStep(`/f/${i}.docx`))

const trackerCases: Case[] = [
  {
    args: [null, [pushStep('/a.docx'), pushStep('/b.pdf', 'pdf'), ENTRIES]],
    note: 'default kind docs',
  },
  {
    args: [
      null,
      [
        pushStep('/a.docx'),
        pushStep('/b.docx'),
        pushStep('/a.docx'),
        pushStep('/c.docx', 'sheets'),
        ENTRIES,
      ],
    ],
    note: 'a repeated path moves to the top',
  },
  {
    args: [
      null,
      [
        pushStep(undefined),
        pushStep(''),
        pushStep('/h', 'home'),
        pushStep('/h', 'help'),
        pushStep('/m', 'markdown'),
        pushStep(undefined, 'pdf'),
        ENTRIES,
      ],
    ],
    note: 'untitled, empty, home and help are not kept',
  },
  { args: [null, [...manyPushes, ENTRIES]], note: 'bounded at 20' },
  { args: [3, [...manyPushes.slice(0, 5), ENTRIES]], note: 'bounded at 3' },
  { args: [0, [pushStep('/a'), ENTRIES]], note: 'max 0 keeps nothing' },
  { args: [-1, [pushStep('/a'), pushStep('/b'), ENTRIES]], note: 'max -1 keeps nothing' },
  {
    args: [2.5, [pushStep('/a'), pushStep('/b'), pushStep('/c'), pushStep('/d'), ENTRIES]],
    note: 'a fractional max',
  },
  { args: ['NaN', [...manyPushes, ENTRIES]], note: 'NaN never shifts' },
  {
    args: [
      null,
      [
        pushStep('/a'),
        pushStep('/b'),
        pushStep('/c'),
        REOPEN({ '/c': false, '/b': true }),
        ENTRIES,
        REOPEN({ '/a': true }),
        REOPEN({ '/a': true }),
        ENTRIES,
      ],
    ],
    note: 'a refused document is dropped and the next is tried',
  },
  {
    args: [
      null,
      [
        pushStep('/a'),
        pushStep('/b'),
        pushStep('/c'),
        REOPEN({ '/a': true, '/c': true }, ['/a', '/b']),
        ENTRIES,
      ],
    ],
    note: 'a file that is gone is skipped without opening it',
  },
  {
    args: [null, [pushStep('/a'), pushStep('/b'), REOPEN({}, []), ENTRIES]],
    note: 'nothing exists',
  },
  { args: [null, [REOPEN({ '/x': true }), ENTRIES]], note: 'an empty stack' },
  {
    args: [null, [pushStep('/a'), pushStep('/b'), { op: 'clear' }, ENTRIES, REOPEN()]],
    note: 'clear',
  },
]

// ------------------------------------------------------------------ tab duplicate

const duplicateCases: Case[] = [
  { args: ['$DIR/a.docx', 'copy'], files: { 'a.docx': 'one' } },
  {
    args: ['$DIR/a.docx', 'copy'],
    files: { 'a.docx': 'one', 'a copy.docx': 'x', 'a copy 2.docx': 'y' },
    note: 'the first free number',
  },
  {
    args: ['$DIR/a.docx', 'copy'],
    files: { 'a.docx': 'one', 'a copy.docx': 'x', 'a copy 3.docx': 'y' },
    note: 'a gap in the numbers is filled',
  },
  { args: ['$DIR/noext', 'copy'], files: { noext: 'n' }, note: 'no extension' },
  {
    args: ['$DIR/.hidden', 'copy'],
    files: { '.hidden': 'h' },
    note: 'a name that is only an extension',
  },
  { args: ['$DIR/a.tar.gz', 'copy'], files: { 'a.tar.gz': 'z' }, note: 'two dots' },
  {
    args: ['$DIR/Report.DOCX', 'copy'],
    files: { 'Report.DOCX': 'r' },
    note: 'an upper-case extension',
  },
  {
    args: ['$DIR/d.v1/a.odt', 'c\u00f6py \u0131\u{1F600}'],
    files: { 'd.v1/a.odt': { hex: 'c3a9' } },
    note: 'a suffix with non-ASCII text, a folder with a dot',
  },
  { args: ['$DIR/gone.docx', 'copy'], note: 'the source is missing: onError, nothing returned' },
  {
    args: ['$DIR/nodir/a.docx', 'copy'],
    note: 'the source folder is missing',
  },
  { args: ['$DIR/a b.docx', ''], files: { 'a b.docx': 'e' }, note: 'an empty suffix' },
  {
    args: ['$DIR/ro.docx', 'copy'],
    files: { 'ro.docx': { text: 'ro', mode: 0o444 } },
    note: 'a read-only source',
  },
]

// ------------------------------------------------------------------ tab document actions

const ACTION_TABS = [
  { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
  { id: 'help', kind: 'help', title: 'Help', closable: true, active: false },
  { id: 'd', kind: 'docs', title: 'D', closable: true, active: false, filePath: '/w/d.docx' },
  { id: 's', kind: 'sheets', title: 'S', closable: true, active: false },
  { id: 'sl', kind: 'slides', title: 'SL', closable: true, active: false },
  { id: 'p', kind: 'pdf', title: 'P', closable: true, active: false, filePath: '/w/p.pdf' },
  { id: 'pu', kind: 'pdf', title: 'PU', closable: true, active: false },
  { id: 'm', kind: 'markdown', title: 'M', closable: true, active: false },
  { id: 'h', kind: 'html', title: 'H', closable: true, active: false },
  { id: 'mm', kind: 'mindmap', title: 'MM', closable: true, active: false },
  { id: 'hw', kind: 'hwp', title: 'HW', closable: true, active: false },
  { id: 'e', kind: 'epub', title: 'E', closable: true, active: false },
  { id: 'dg', kind: 'diagram', title: 'DG', closable: true, active: false },
]
const ALL_IDS = ACTION_TABS.map((t) => t.id)
const ACTION_SPEC = { tabs: ACTION_TABS, canDetach: ALL_IDS }

const actionCases: Case[] = [
  ...['d', 's', 'sl', 'p', 'pu', 'm', 'h', 'mm', 'hw', 'e', 'dg'].flatMap((id) =>
    ['save', 'saveAs', 'print'].map((action): Case => ({
      args: [ACTION_SPEC, id, action],
      note: `${id} ${action}`,
    })),
  ),
  { args: [ACTION_SPEC, 'd', 'bogus'], note: 'an action that is none of the three' },
  { args: [ACTION_SPEC, 'm', 'bogus'], note: 'an unknown action reaches the markdown save' },
  { args: [ACTION_SPEC, 'p', 'bogus'], note: 'an unknown action is a PDF save' },
  { args: [ACTION_SPEC, 'home', 'save'], note: 'home' },
  { args: [ACTION_SPEC, 'help', 'print'], note: 'help' },
  { args: [ACTION_SPEC, 'nope', 'save'], note: 'no such tab' },
  { args: [{ ...ACTION_SPEC, canDetach: ['s'] }, 'd', 'save'], note: 'cannot detach' },
  { args: [{ ...ACTION_SPEC, noContents: ['d'] }, 'd', 'save'], note: 'no web contents' },
  { args: [{ ...ACTION_SPEC, destroyed: ['d'] }, 'd', 'save'], note: 'destroyed web contents' },
  {
    args: [{ ...ACTION_SPEC, noContents: ['home'] }, 'home', 'save'],
    note: 'home without contents',
  },
  {
    args: [{ ...ACTION_SPEC, noContents: ['nope'] }, 'nope', 'save'],
    note: 'neither tab nor contents',
  },
]

// ------------------------------------------------------------------ tab menu

const programPaths = [
  'a.exe',
  'A.EXE',
  'a.sh',
  'a.bash',
  'a.jar',
  'a.JAR',
  'a.app',
  'a.docx',
  'a.js',
  'a.json',
  'a.ps1',
  'noext',
  '.bashrc',
  '.exe',
  'dir.exe/file',
  'a.tar.gz',
  'C:\\dir\\a.exe',
  'a.\u212Ash',
  'a.\u017Fh',
  'a.\u0130nf',
  'a.\u0131nf',
  'a.exe.txt',
  '',
  'a.',
  'a.desktop',
  'a.Desktop',
  'a.out',
  'a.run',
  'a.lnk ',
]

const baseNames = [
  '/a/b/c.txt',
  'c.txt',
  'a\\b\\c.txt',
  'a/b\\c',
  '',
  'trailing/',
  'trailing\\',
  '/',
  '\u00fc/\u{1F600}.docx',
  'a//b',
]

const labelPaths = [
  '',
  '/short.docx',
  `/${'x'.repeat(79)}`,
  `/${'x'.repeat(80)}`,
  `/${'x'.repeat(100)}`,
  `/${'ab'.repeat(60)}/file.docx`,
  `\u{1F600}${'\u0131'.repeat(120)}\u{1F600}`,
  `${'\u00fc'.repeat(40)}${'\u017F'.repeat(41)}`,
  `C:\\Users\\someone\\Documents\\${'folder\\'.repeat(12)}final.docx`,
]

const TS3 = (over: J = {}): J[] => [
  { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
  { id: 'a', kind: 'docs', title: 'A', closable: true, active: true, filePath: '/w/a.docx' },
  { id: 'b', kind: 'sheets', title: 'B', closable: true, active: false },
  { id: 'c', kind: 'pdf', title: 'C', closable: true, active: false, filePath: '/w/c.pdf' },
  ...[over].filter((o) => Object.keys(o).length > 0),
]

const menuInput = (tabId: string, tabs: J[], o: J = {}): J => ({
  tab: tabs.find((t) => t.id === tabId) ?? {
    id: tabId,
    kind: 'docs',
    title: 'X',
    closable: true,
    active: false,
  },
  tabs,
  canDetach: true,
  fileExists: true,
  canReopen: true,
  ...o,
})

const menuCases: Case[] = [
  { args: [menuInput('a', TS3())], note: 'a document with a file' },
  { args: [menuInput('b', TS3())], note: 'an untitled document' },
  { args: [menuInput('c', TS3())], note: 'the last tab' },
  { args: [menuInput('home', TS3())], note: 'home' },
  {
    args: [menuInput('a', TS3(), { fileExists: false, canReopen: false })],
    note: 'the file is gone',
  },
  { args: [menuInput('a', TS3(), { canDetach: false })], note: 'cannot detach' },
  {
    args: [
      menuInput('x', TS3({ id: 'x', kind: 'help', title: 'Help', closable: true, active: false })),
    ],
    note: 'help',
  },
  {
    args: [
      menuInput(
        'x',
        TS3({
          id: 'x',
          kind: 'docs',
          title: 'Run',
          closable: true,
          active: false,
          filePath: '/w/run.sh',
        }),
      ),
    ],
    note: 'a program file is not opened by default',
  },
  {
    args: [
      menuInput('a', TS3(), {
        tab: {
          id: 'ghost',
          kind: 'docs',
          title: 'Ghost',
          closable: true,
          active: false,
          filePath: '/w/g.docx',
        },
      }),
    ],
    note: 'a tab that is not in the list',
  },
  {
    args: [
      menuInput('a', [
        { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
        { id: 'a', kind: 'docs', title: 'A', closable: false, active: true, filePath: '' },
        { id: 'b', kind: 'docs', title: 'B', closable: false, active: false },
      ]),
    ],
    note: 'unclosable tabs, an empty path',
  },
  {
    args: [
      menuInput('m', [
        { id: 'home', kind: 'home', title: 'Home', closable: false, active: false },
        { id: 'l', kind: 'docs', title: 'L', closable: true, active: false },
        {
          id: 'm',
          kind: 'docs',
          title: 'M',
          closable: true,
          active: true,
          filePath: `/${'long/'.repeat(30)}m.docx`,
        },
        { id: 'r', kind: 'docs', title: 'R', closable: true, active: false },
      ]),
    ],
    note: 'a tab in the middle with a long path',
  },
  {
    args: [
      menuInput('home', [
        { id: 'home', kind: 'home', title: 'Home', closable: false, active: true },
      ]),
    ],
    note: 'only home',
  },
  {
    args: [
      menuInput('a', [
        {
          id: 'a',
          kind: 'docs',
          title: 'A',
          closable: true,
          active: true,
          filePath: '/w/\u00fc\u{1F600}\\n.docx',
        },
      ]),
    ],
    note: 'a single tab, no home',
  },
]

// ------------------------------------------------------------------ tab shortcuts

const key = (o: J): J => ({
  type: 'keyDown',
  key: 'Tab',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...o,
})

const shortcutInputs: J[] = [
  key({ control: true }),
  key({ control: true, shift: true }),
  key({}),
  key({ control: true, meta: true }),
  key({ meta: true }),
  key({ control: true, alt: true }),
  key({ type: 'keyUp', control: true }),
  key({ type: 'char', control: true }),
  key({ key: 'w', control: true }),
  key({ key: 'W', control: true }),
  key({ key: 'w', meta: true }),
  key({ key: 'W', meta: true }),
  key({ key: 'w', control: true, meta: true }),
  key({ key: 'w' }),
  key({ key: 'w', control: true, shift: true }),
  key({ key: 'w', meta: true, shift: true }),
  key({ key: 'w', control: true, alt: true }),
  key({ key: 'w', type: 'keyUp', control: true }),
  key({ key: 'x', control: true }),
  key({ key: '', control: true }),
  key({ key: 'tab', control: true }),
  key({ key: '\u0131', control: true }),
  key({ key: '\u017F', control: true }),
  key({ key: '\u212A', control: true }),
  key({ key: 'ww', control: true }),
]

const shortcutCases: Case[] = shortcutInputs.flatMap((input) =>
  ['darwin', 'win32', 'linux', null].map((platform): Case => ({ args: [input, platform] })),
)

const HOST = { shell: [1, 2], tabs: [10, 11, 12] }
const handleCases: Case[] = [
  {
    args: [key({ control: true }), 1, { ...HOST, activeKind: 'docs' }],
    note: 'next from the shell',
  },
  {
    args: [key({ control: true, shift: true }), 11, { ...HOST, activeKind: 'home' }],
    note: 'previous from a tab',
  },
  {
    args: [key({ control: true }), 99, { ...HOST, activeKind: 'docs' }],
    note: 'a window that is neither',
  },
  {
    args: [key({ key: 'w', control: true }), 2, { ...HOST, activeKind: 'docs' }],
    note: 'close, Ctrl',
  },
  {
    args: [key({ key: 'w', meta: true }), 2, { ...HOST, activeKind: 'docs' }],
    note: 'close, Meta',
  },
  {
    args: [key({ key: 'w', control: true }), 12, { ...HOST, activeKind: 'home' }],
    note: 'close on home is left alone (Ctrl)',
  },
  {
    args: [key({ key: 'w', meta: true }), 12, { ...HOST, activeKind: 'home' }],
    note: 'close on home is left alone (Meta)',
  },
  {
    args: [key({ key: 'w', control: true }), 12, { ...HOST, activeKind: null }],
    note: 'close with no tab',
  },
  {
    args: [key({ key: 'w', meta: true }), 12, { ...HOST, activeKind: null }],
    note: 'close with no tab (Meta)',
  },
  {
    args: [key({ key: 'w', control: true }), 99, { ...HOST, activeKind: 'docs' }],
    note: 'close from elsewhere',
  },
  {
    args: [key({ key: 'x', control: true }), 1, { ...HOST, activeKind: 'docs' }],
    note: 'no shortcut',
  },
  {
    args: [key({ control: true }), 11, { shell: [], tabs: [], activeKind: null }],
    note: 'an empty host',
  },
  {
    args: [key({ control: true }), 11, { shell: [11], tabs: [11], activeKind: 'docs' }],
    note: 'both a shell and a tab',
  },
]

// ------------------------------------------------------------------ split layout

const RECTS: J[] = [
  { x: 0, y: 40, width: 1000, height: 700 },
  { x: 10, y: 50, width: 500, height: 300 },
  { x: 0, y: 0, width: 486, height: 486 },
  { x: 0, y: 0, width: 485, height: 485 },
  { x: 0, y: 0, width: 4, height: 6 },
  { x: 0, y: 0, width: 6, height: 6 },
  { x: 0, y: 0, width: 0, height: 0 },
  { x: -5, y: -5, width: -20, height: -20 },
  { x: 1.5, y: 2.25, width: 333.3, height: 777.7 },
  { x: 0, y: 0, width: NaN, height: 100 },
  { x: 0, y: 0, width: 100, height: NaN },
  { x: 0, y: 0, width: 1e308, height: 1e308 },
  { x: 0, y: 0, width: 726, height: 726 },
  { x: 0, y: 0, width: 727, height: 727 },
]

const rectOrientation: Case[] = RECTS.flatMap((r) =>
  ['side', 'stack'].map((o): Case => ({ args: [r, o] })),
)

const RATIOS = [0, 0.05, 0.25, 0.5, 0.75, 1, -1, 2, NaN, 0.333333]

const dropPoints: [number, number, number, number][] = [
  [100, 30, 1000, 700],
  [100, 39.9, 1000, 700],
  [100, 40, 1000, 700],
  [900, 300, 1000, 700],
  [880, 300, 1000, 700],
  [879.9, 300, 1000, 700],
  [500, 600, 1000, 700],
  [500, 580, 1000, 700],
  [500, 579.9, 1000, 700],
  [950, 650, 1000, 700],
  [950, 690, 1000, 700],
  [900, 660, 1000, 700],
  [910, 650, 1000, 700],
  [NaN, 300, 1000, 700],
  [300, NaN, 1000, 700],
  [1e308, 300, 1000, 700],
  [10, 100, NaN, 700],
  [10, 100, 1000, NaN],
  [-5, 100, 50, 50],
  [100, 1e308, 1000, 700],
  [900, 40, 1000, 700],
  [500, 40, 1000, 40],
]

const SPLIT = { aTabId: 'a', bTabId: 'b', orientation: 'side', focus: 'a' }
const dragged = (isDocument: boolean, isPaneTab: boolean, docPane: string | null): J => ({
  isDocument,
  isPaneTab,
  docPane,
})

const decideCases: Case[] = [
  {
    args: [{ split: null, dragged: dragged(false, false, null), dropped: 'side' }],
    note: 'not a document',
  },
  { args: [{ split: null, dragged: dragged(true, false, null), dropped: 'side' }], note: 'create' },
  {
    args: [{ split: null, dragged: dragged(true, false, null), dropped: 'stack' }],
    note: 'create, stacked',
  },
  {
    args: [{ split: null, dragged: dragged(true, true, null), dropped: 'side' }],
    note: 'a pane tab without a split',
  },
  {
    args: [{ split: null, dragged: dragged(true, false, 'a'), dropped: 'side' }],
    note: 'a doc pane but no split',
  },
  { args: [{ split: SPLIT, dragged: dragged(true, true, 'a'), dropped: 'side' }], note: 'noop' },
  { args: [{ split: SPLIT, dragged: dragged(true, true, 'b'), dropped: 'stack' }], note: 'flip' },
  { args: [{ split: SPLIT, dragged: dragged(true, false, 'a'), dropped: 'side' }], note: 'focus' },
  {
    args: [{ split: SPLIT, dragged: dragged(true, false, 'b'), dropped: 'stack' }],
    note: 'focus, other edge',
  },
  {
    args: [{ split: SPLIT, dragged: dragged(true, false, null), dropped: 'side' }],
    note: 'replace',
  },
  {
    args: [{ split: SPLIT, dragged: dragged(true, false, null), dropped: 'stack' }],
    note: 'reorient',
  },
  {
    args: [
      {
        split: { ...SPLIT, orientation: 'stack', focus: 'b' },
        dragged: dragged(true, false, null),
        dropped: 'stack',
      },
    ],
    note: 'replace, stacked',
  },
  {
    args: [
      {
        split: { ...SPLIT, orientation: 'stack' },
        dragged: dragged(true, false, null),
        dropped: 'side',
      },
    ],
    note: 'reorient to side',
  },
  {
    args: [{ split: SPLIT, dragged: dragged(false, true, 'a'), dropped: 'stack' }],
    note: 'a pane tab that is no document',
  },
]

const modeTabs: J[] = [
  { id: 'a', kind: 'docs' },
  { id: 'b', kind: 'sheets' },
  { id: 'c', kind: 'pdf' },
  { id: 'home', kind: 'home' },
  { id: 'help', kind: 'help' },
  { id: 'p', kind: 'slides', present: true },
  { id: 'q', kind: 'slides', present: false },
  { id: 'r', kind: 'docs', present: 'yes' },
]

const activationCases: Case[] = [
  ...modeTabs.map((t): Case => ({ args: [null, t], note: `no split, ${t.id}` })),
  ...modeTabs.map((t): Case => ({
    args: [{ aTabId: 'a', bTabId: 'b' }, t],
    note: `split a/b, ${t.id}`,
  })),
]

const opp = (o: J): J => ({
  activeId: 'a',
  previousActiveId: null,
  excludeId: 'x',
  tabs: [
    { id: 'a', kind: 'docs', hasView: true },
    { id: 'b', kind: 'sheets', hasView: true },
    { id: 'h', kind: 'home', hasView: true },
    { id: 'n', kind: 'docs', hasView: false },
    { id: 'p', kind: 'slides', present: true, hasView: true },
    { id: 'x', kind: 'pdf', hasView: true },
    { id: 'hp', kind: 'help', hasView: true },
  ],
  ...o,
})

const oppositeCases: Case[] = [
  { args: [opp({})], note: 'the active tab' },
  {
    args: [opp({ excludeId: 'a', previousActiveId: 'b' })],
    note: 'the active tab is the dragged one: the previous',
  },
  { args: [opp({ activeId: 'h', previousActiveId: 'b' })], note: 'active is home' },
  { args: [opp({ activeId: 'hp', previousActiveId: 'b' })], note: 'active is help' },
  { args: [opp({ activeId: 'n', previousActiveId: 'b' })], note: 'active has no view' },
  { args: [opp({ activeId: 'p', previousActiveId: 'a' })], note: 'active is a present tab' },
  { args: [opp({ activeId: 'zz', previousActiveId: 'zz' })], note: 'unknown tabs' },
  { args: [opp({ activeId: 'h', previousActiveId: 'h' })], note: 'only home' },
  { args: [opp({ excludeId: 'a', previousActiveId: 'a' })], note: 'both are the dragged tab' },
  { args: [opp({ activeId: 'h', previousActiveId: null })], note: 'no previous' },
  { args: [opp({ tabs: [] })], note: 'no tabs' },
]

// ------------------------------------------------------------------ open documents

const OD = '$DIR/open.json'

const publishCases: Case[] = [
  { args: [OD, ['/b.docx', '/a.docx']], note: 'sorted' },
  { args: [OD, []], note: 'none' },
  { args: [OD, ['/a', '/a', '/b', '/a']], note: 'duplicates' },
  {
    args: [
      OD,
      [
        '/z',
        '/Z',
        '/a',
        '/A',
        '/\u00e9',
        '/e',
        '/\u{1F600}',
        '/\uFF5E',
        '/\uFFFF',
        '/\u{10000}',
        '/\u0131',
        '/\u017F',
        '/10',
        '/2',
        '',
      ],
    ],
    note: 'code unit order, not code point order',
  },
  {
    args: [OD, ['/new.docx']],
    files: { 'open.json': '{"old":true}' },
    note: 'replaces the registry',
  },
  { args: ['$DIR/nodir/open.json', ['/a']], note: 'folder missing: warned about once' },
  { args: ['$DIR/nodir/open.json', ['/b']], note: 'the same error is not warned about twice' },
  {
    args: ['$DIR/f.txt/open.json', ['/a']],
    files: { 'f.txt': 'x' },
    note: 'a file as a folder: another code',
  },
  { args: ['$DIR/f.txt/open.json', ['/a']], files: { 'f.txt': 'x' }, note: 'and again' },
  {
    args: ['$DIR/dir', ['/a']],
    files: { dir: { dir: true } },
    note: 'the registry path is a folder',
  },
]

const clearCases: Case[] = [
  { args: [OD], files: { 'open.json': '{}' } },
  { args: [OD], note: 'missing' },
  { args: ['$DIR/dir'], files: { dir: { dir: true }, 'dir/x': 'x' }, note: 'a folder stays' },
]

// ------------------------------------------------------------------ small modules

const skillCases: Case[] = [
  { args: ['$DIR/skills/a', ['$DIR/skills/a']] },
  { args: ['$DIR/skills/a', ['$DIR/skills/b']], note: 'not vouched' },
  { args: ['$DIR/skills/a', ['$DIR/skills/b', '$DIR/skills/a/']], note: 'a trailing slash' },
  { args: ['$DIR/skills/a/../a', ['$DIR/skills/a']], note: 'a dot-dot' },
  { args: ['$DIR/skills/a', ['$DIR/skills/./a']], note: 'a dot' },
  { args: ['$DIR/skills/a', ['$DIR/skills//a']], note: 'a double slash' },
  { args: ['$DIR/skills/a', []], note: 'nothing vouched' },
  { args: ['skills/a', ['skills/a']], note: 'a relative path' },
  { args: ['', ['']], note: 'empty' },
  { args: [5, ['5']], note: 'a number' },
  { args: [null, ['a']], note: 'null' },
  { args: [{ x: 1 }, []], note: 'an object' },
  { args: [['/a'], ['/a']], note: 'an array' },
  { args: ['$DIR/skills/A', ['$DIR/skills/a']], note: 'another case' },
  { args: ['$DIR/s/\u0131', ['$DIR/s/I']], note: 'dotless i is no I' },
  {
    args: ['$DIR/s/\u{1F600}', ['$DIR/x', '$DIR/s/\u{1F600}']],
    note: 'astral, second in the list',
  },
  { args: ['/', ['/']], note: 'the root' },
  { args: ['/', ['/.']], note: 'the root again' },
  { args: ['$DIR/a', ['rel/path', '$DIR/a']], note: 'a relative entry first' },
]

const SRC = {
  roots: ['/r', '/r2'],
  tracked: ['/out/t.docx', '/out/u.docx'],
  dirs: ['/r/dir', '/r', '/out/dir', '/r2/x'],
}
const targetPaths: unknown[] = [
  '/r/a.docx',
  '/r',
  '/r/dir',
  '/r2/x',
  '/rr/a.docx',
  '/out/t.docx',
  '/out',
  '/out/t.doc',
  '/out/dir',
  '/out/other.docx',
  '',
  5,
  null,
  ['/r/a'],
  '/r/\u0131.docx',
]
const targetCases: Case[] = targetPaths.map((p): Case => ({ args: [p, SRC], note: String(p) }))

const overlayCases: Case[] = [
  { args: [false, null] },
  { args: [true, null] },
  { args: [false, 1] },
  { args: [true, 1.5] },
  { args: [false, 2] },
  { args: [true, 0.5] },
  { args: [false, 0.0125], note: 'a tie rounds up' },
  { args: [true, -0.0125], note: 'minus zero' },
  { args: [false, 0] },
  { args: [true, -1] },
  { args: [false, 1.2345] },
  { args: [true, 1e21] },
]

// ------------------------------------------------------------------ result store

const STORE_FILES: Record<string, FileSpec> = {
  'pdf-store/docs/aa/ai-read/1.json': { text: '12345' },
  'pdf-store/docs/aa/translations/ko/translation.json': { hex: 'c3a9c3a9' },
  'pdf-store/docs/bb/jobs/summary.json': '',
  'pdf-store/note-links.json': '[]',
  'other.txt': 'not in the store',
}

const storeCases: Case[] = [
  { args: ['$DIR', ['size']], files: STORE_FILES },
  { args: ['$DIR', ['size', 'deleteAll', 'size']], files: STORE_FILES, note: 'delete, then empty' },
  { args: ['$DIR', ['deleteAll', 'deleteAll']], files: STORE_FILES, note: 'delete twice' },
  { args: ['$DIR', ['size']], note: 'no store yet' },
  {
    args: ['$DIR', ['size', 'deleteAll']],
    files: { 'pdf-store': 'a file, not a folder' },
    note: 'the store is a file',
  },
  { args: ['relative/dir', ['size', 'deleteAll']], files: STORE_FILES, note: 'not absolute' },
  { args: ['$DIR/.genoffice/data', ['size']], files: STORE_FILES, note: 'the upstream folder' },
  {
    args: ['$DIR/.GenOffice', ['deleteAll']],
    files: STORE_FILES,
    note: 'the upstream folder, other case',
  },
  {
    args: ['$DIR/.genoffice.d', ['size']],
    files: STORE_FILES,
    note: 'a name that only begins like it',
  },
  { args: ['$DIR/.genoff\u0131ce', ['size']], files: STORE_FILES, note: 'dotless i is no i' },
  { args: ['', ['size']], note: 'empty' },
  { args: ['$DIR', []], note: 'registers only' },
]

// ------------------------------------------------------------------ window close guard

const GUARD_STUBS = `
const stub = () => (globalThis as any).__closeStub
export const docsQueryDirty = (wc: any) => stub().query(wc)
export const requestDocsClose = (wc: any, win: any) => stub().ask('docs', wc, win)
export const requestSheetsClose = (wc: any, win: any) => stub().ask('sheets', wc, win)
export const resetSheetsShuttingDown = () => stub().reset()
export const requestSlidesClose = (wc: any, win: any) => stub().ask('slides', wc, win)
export const requestPdfClose = (wc: any, win: any) => stub().ask('pdf', wc, win)
export const requestMarkdownClose = (wc: any, win: any) => stub().ask('markdown', wc, win)
export const requestHtmlClose = (wc: any, win: any) => stub().ask('html', wc, win)
export const requestMindmapClose = (wc: any, win: any) => stub().ask('mindmap', wc, win)
export const requestHwpClose = (wc: any, win: any) => stub().ask('hwp', wc, win)
export const requestEpubClose = (wc: any, win: any) => stub().ask('epub', wc, win)
export const requestDiagramClose = (wc: any, win: any) => stub().ask('diagram', wc, win)
`

let guardModule: Promise<J> | undefined

/**
 * window-close-guard.ts imports the editors' main modules, which need
 * Electron. The module under test is the source as it is, with those ten
 * imports pointed at a stub module (written beside it) whose answers the
 * scenario sets.
 */
function loadGuard(): Promise<J> {
  guardModule ??= (async () => {
    const source = readFileSync(
      new URL('../../../apps/shell/src/main/window-close-guard.ts', import.meta.url),
      'utf8',
    )
    const stubbed = source.replace(
      /from '\.\.\/\.\.\/\.\.\/[a-z]+\/src\/main\/[a-z-]+'/g,
      "from './guard-stubs.mts'",
    )
    if (stubbed === source) throw new Error('window-close-guard.ts: no import to stub')
    const dir = mkdtempSync(join(tmpdir(), 'main-diff-guard-'))
    writeFileSync(join(dir, 'guard-stubs.mts'), GUARD_STUBS)
    writeFileSync(join(dir, 'guard.mts'), stubbed)
    return import(pathToFileURL(join(dir, 'guard.mts')).href)
  })()
  return guardModule
}

/** the tabs of a family by id; `webContents` is `{ id }` */
const guardTabs = (spec: J, family: string): J[] =>
  ((spec.tabs ?? {})[family] ?? []).map((id: string) => ({ id, webContents: { id } }))

async function guardScenario(a: unknown[], cx: TsContext): Promise<undefined> {
  const spec = a[0] as J
  const { installShellCloseGuard } = await loadGuard()
  let handler: ((event: J) => void) | undefined
  const emit = (): void => {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    handler?.(event)
    cx.log('event', 'close', event.defaultPrevented)
  }
  const win: J = {
    on: (name: string, fn: (event: J) => void) => {
      if (name !== 'close') throw new Error(`unexpected event ${name}`)
      handler = fn
    },
    isDestroyed: () => {
      cx.log('isDestroyed')
      return spec.destroyed === true
    },
    close: () => {
      cx.log('win.close')
      emit()
    },
  }
  const listed = (name: string, family: string) => () => {
    cx.log(name)
    return guardTabs(spec, family)
  }
  const manager: J = {
    dirtySheetsTabs: listed('dirtySheetsTabs', 'sheets'),
    dirtyPdfTabs: listed('dirtyPdfTabs', 'pdf'),
    dirtyMarkdownTabs: listed('dirtyMarkdownTabs', 'markdown'),
    dirtyHtmlTabs: listed('dirtyHtmlTabs', 'html'),
    dirtyMindmapTabs: listed('dirtyMindmapTabs', 'mindmap'),
    dirtyOrMemoHwpTabs: listed('dirtyOrMemoHwpTabs', 'hwp'),
    dirtyEpubTabs: listed('dirtyEpubTabs', 'epub'),
    dirtyDiagramTabs: listed('dirtyDiagramTabs', 'diagram'),
    dirtySlidesTabs: listed('dirtySlidesTabs', 'slides'),
    docsTabs: listed('docsTabs', 'docs'),
    activateTab: (id: string) => {
      cx.log('activateTab', id)
      if ((spec.activateThrows ?? []).includes(id)) throw `boom activateTab:${id}`
    },
    beginExclusivePrompt: () => cx.log('beginExclusivePrompt'),
    endExclusivePrompt: () => cx.log('endExclusivePrompt'),
  }
  const answer = async (key: string): Promise<boolean> => {
    const v = (spec.answers ?? {})[key]
    if (v === 'throw') throw `boom ${key}`
    return typeof v === 'boolean' ? v : true
  }
  const stubs = {
    ask: (family: string, wc: J, w: J) => {
      cx.log('requestClose', family, wc.id, w === win)
      return answer(`${family}:${wc.id}`)
    },
    query: (wc: J) => {
      cx.log('docsQueryDirty', wc.id)
      return answer(`docs:${wc.id}:query`)
    },
    reset: () => cx.log('resetSheetsShuttingDown'),
  }
  const options: J =
    spec.onVetoed === 'ok'
      ? { onVetoed: () => cx.log('onVetoed') }
      : spec.onVetoed === 'throw'
        ? {
            onVetoed: () => {
              cx.log('onVetoed')
              throw 'boom onVetoed'
            },
          }
        : {}
  const realError = console.error
  console.error = (...args: unknown[]) => cx.log('console.error', ...args.map(String))
  ;(globalThis as J).__closeStub = stubs
  try {
    installShellCloseGuard(win, manager, options)
    for (const event of [...(spec.events as string[]), 'settle']) {
      if (event === 'close') emit()
      else await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    console.error = realError
    delete (globalThis as J).__closeStub
  }
  return undefined
}

const G = (o: J): J => o

const guardCases: Case[] = [
  {
    args: [G({ tabs: {}, events: ['close'] })],
    note: 'nothing dirty: the close goes through',
  },
  {
    args: [G({ tabs: { sheets: ['s1'] }, events: ['close', 'settle'] })],
    note: 'one dirty sheet, saved or discarded: the window closes',
  },
  {
    args: [G({ tabs: { sheets: ['s1', 's2'], pdf: ['p1'], docs: ['d1'] }, events: ['close'] })],
    note: 'several families in order, docs asked first whether they are dirty',
  },
  {
    args: [
      G({
        tabs: {
          sheets: ['s1'],
          markdown: ['m1'],
          html: ['h1'],
          mindmap: ['mm1'],
          hwp: ['hw1'],
          epub: ['e1'],
          diagram: ['dg1'],
          slides: ['sl1'],
          pdf: ['p1'],
          docs: ['d1', 'd2'],
        },
        answers: { 'docs:d1:query': false },
        events: ['close'],
      }),
    ],
    note: 'every family; a clean docs tab is not activated',
  },
  {
    args: [
      G({
        tabs: { sheets: ['s1'], pdf: ['p1'] },
        answers: { 'sheets:s1': false },
        events: ['close'],
      }),
    ],
    note: 'a denied close vetoes the quit',
  },
  {
    args: [
      G({
        tabs: { sheets: ['s1'], pdf: ['p1'] },
        answers: { 'pdf:p1': false },
        onVetoed: 'ok',
        events: ['close'],
      }),
    ],
    note: 'the second tab denies; the veto hook runs',
  },
  {
    args: [
      G({
        tabs: { docs: ['d1'] },
        answers: { 'docs:d1': false },
        onVetoed: 'throw',
        events: ['close'],
      }),
    ],
    note: 'the docs close request is denied; the veto hook throws',
  },
  {
    args: [G({ tabs: { sheets: ['s1'] }, answers: { 'sheets:s1': 'throw' }, events: ['close'] })],
    note: 'a prompt that fails vetoes the quit',
  },
  {
    args: [
      G({
        tabs: { docs: ['d1'] },
        answers: { 'docs:d1:query': 'throw' },
        onVetoed: 'ok',
        events: ['close'],
      }),
    ],
    note: 'the docs query fails',
  },
  {
    args: [
      G({ tabs: { pdf: ['p1'] }, activateThrows: ['p1'], onVetoed: 'throw', events: ['close'] }),
    ],
    note: 'activating a tab fails',
  },
  {
    args: [G({ tabs: { docs: ['d1'] }, activateThrows: ['d1'], events: ['close'] })],
    note: 'activating a docs tab fails',
  },
  {
    args: [G({ tabs: { sheets: ['s1'] }, events: ['close', 'close', 'close'] })],
    note: 'a second close while the prompts are open is cancelled',
  },
  {
    args: [G({ tabs: { sheets: ['s1'] }, events: ['close', 'settle', 'close', 'settle'] })],
    note: 'after the confirmed close, closing again is let through',
  },
  {
    args: [
      G({
        tabs: { sheets: ['s1'] },
        answers: { 'sheets:s1': false },
        events: ['close', 'settle', 'close', 'settle'],
      }),
    ],
    note: 'after a denial the next close prompts again',
  },
  {
    args: [G({ tabs: { sheets: ['s1'] }, destroyed: true, events: ['close'] })],
    note: 'the window is gone when the prompts end: it is not closed again',
  },
  {
    args: [G({ tabs: { hwp: ['hw1'], epub: ['e1'] }, events: ['close', 'settle'] })],
    note: 'hwp (memo open) and epub',
  },
]

// ------------------------------------------------------------------ the group

export const group: Group = {
  'session-record.SESSION_RECORD_FILE': constant(SESSION_RECORD_FILE),
  'session-record.SESSION_RECORD_WRITE_DELAY_MS': constant(SESSION_RECORD_WRITE_DELAY_MS),
  'session-record.CRASH_LOOP_WINDOW_MS': constant(CRASH_LOOP_WINDOW_MS),
  'session-record.sessionSnapshotFrom': {
    ts: (a, cx) => sessionSnapshotFrom(snapshotSource(a[0] as J, cx)),
    cases: snapshotCases,
  },
  'session-record.parseSessionRecord': {
    ts: (a) => parseSessionRecord(a[0]),
    cases: RAW_RECORDS.map(([note, raw]): Case => ({ args: [raw], note })),
  },
  'session-record.sessionRecordPath': {
    ts: (a) => sessionRecordPath(str(a, 0)),
    cases: sessionPathCases(),
  },
  'session-record.readSessionRecord': { ts: (a) => readSessionRecord(str(a, 0)), cases: readCases },
  'session-record.judgePreviousExit': {
    ts: (a, cx) =>
      judgePreviousExit(
        a[0] as SessionRecordReadResult,
        {
          hasUnresolvedCopies: () => {
            cx.log('hasUnresolvedCopies')
            return a[1] as boolean
          },
        } as never,
        (a[2] ?? undefined) as J,
      ),
    cases: judgeCases,
  },
  'session-record.sessionRestoreLayout': {
    ts: (a) => sessionRestoreLayout(a[0] as J, a[1] as J),
    cases: layoutCases,
  },
  'session-record.createSessionRecorder': { ts: sessionScenario(false), cases: recorderCases },
  'session-record.initSessionRecord': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.init, PREV_FILE(PREV_RICH)),
  },
  'session-record.sessionRecorder': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.recorder),
  },
  'session-record.noteSessionChanged': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.note),
  },
  'session-record.markSessionCleanExit': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.cleanExit),
  },
  'session-record.holdSessionTabsForUpdateRestart': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.holdTabs),
  },
  'session-record.markSessionUpdateRestart': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.updateRestart),
  },
  'session-record.markSessionClosedToTray': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.closedToTray),
  },
  'session-record.markSessionOsEnd': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.osEnd),
  },
  'session-record.resetSessionRecordForTests': {
    ts: sessionScenario(true),
    cases: globalCases(globalSteps.reset),
  },

  'tab-lifecycle.MAX_RECENTLY_CLOSED': constant(MAX_RECENTLY_CLOSED),
  'tab-lifecycle.closeTabsInOrder': {
    ts: async (a, cx) => {
      const spec = a[0] as J
      const tabs: J[] = (spec.tabs as J[]).map((t) => ({ ...t }))
      const behavior: J = spec.behavior ?? {}
      await closeTabsInOrder(
        {
          list: () => [...tabs],
          closeTab: async (id: string) => {
            cx.log('closeTab', id)
            const b = behavior[id]
            const removed: string[] = typeof b === 'string' ? [] : Array.isArray(b) ? b : [id]
            for (let i = tabs.length - 1; i >= 0; i--)
              if (removed.includes(tabs[i].id)) tabs.splice(i, 1)
          },
        },
        a[1] as string[],
      )
    },
    cases: closeCases,
  },
  'tab-lifecycle.createRecentlyClosedTracker': {
    ts: (a, cx) => {
      const max =
        a[0] === null || a[0] === undefined ? undefined : a[0] === 'NaN' ? NaN : (a[0] as number)
      const tracker = createRecentlyClosedTracker(max)
      const results: unknown[] = []
      for (const step of a[1] as J[]) {
        switch (step.op) {
          case 'push':
            tracker.push(step.closed)
            results.push(null)
            break
          case 'reopenNext':
            results.push(
              tracker.reopenNext(
                (p) => {
                  cx.log('open', p)
                  return step.open?.[p] === true
                },
                Array.isArray(step.exists)
                  ? (p) => {
                      cx.log('exists', p)
                      return step.exists.includes(p)
                    }
                  : undefined,
              ),
            )
            break
          case 'getEntries':
            results.push(JSON.parse(JSON.stringify(tracker.getEntries())))
            break
          case 'clear':
            tracker.clear()
            results.push(null)
            break
          default:
            throw new Error(`unknown step ${step.op}`)
        }
      }
      return results
    },
    cases: trackerCases,
  },

  'tab-duplicate.duplicateDocumentFile': {
    ts: (a, cx) =>
      duplicateDocumentFile(str(a, 0), {
        copySuffix: str(a, 1),
        recordRecentFile: (p) => cx.log('recordRecentFile', p),
        onError: (e) => {
          const err = e as J
          cx.log('onError', { code: err.code ?? null, message: maskTmp(err.message) })
        },
      }),
    cases: duplicateCases,
  },

  'tab-document-actions.runTabDocumentAction': {
    ts: (a, cx) => {
      const spec = a[0] as J
      const log = cx.log
      const includes = (key: string, id: string): boolean => (spec[key] ?? []).includes(id)
      const contents = (id: string): J => ({
        id,
        isDestroyed: () => {
          log('isDestroyed', id)
          return includes('destroyed', id)
        },
        send: (channel: string, command: string) => log('send', id, channel, command),
      })
      const deps: J = {
        tabs: {
          list: () => spec.tabs,
          activateTab: (id: string) => log('activateTab', id),
          canDetachTab: (id: string) => {
            log('canDetachTab', id)
            return includes('canDetach', id)
          },
          webContentsForTab: (id: string) => {
            log('webContentsForTab', id)
            return includes('noContents', id) ? undefined : contents(id)
          },
        },
        savePdf: (c: J) => log('savePdf', c.id),
        savePdfAs: (t: J) =>
          log('savePdfAs', { id: t.id, contentsId: t.webContents.id, filePath: t.filePath }),
        printPdf: (c: J) => log('printPdf', c.id),
        saveMarkdown: (c: J, m: string) => log('saveMarkdown', c.id, m),
        printMarkdown: (c: J) => log('printMarkdown', c.id),
        saveHtml: (c: J, m: string) => log('saveHtml', c.id, m),
        printHtml: (c: J) => log('printHtml', c.id),
        saveMindmap: (c: J, m: string) => log('saveMindmap', c.id, m),
        printMindmap: (c: J) => log('printMindmap', c.id),
        saveHwp: (c: J, m: string) => log('saveHwp', c.id, m),
        printHwp: (c: J) => log('printHwp', c.id),
      }
      runTabDocumentAction(deps, str(a, 1), str(a, 2) as J)
    },
    cases: actionCases,
  },

  'tab-menu.isProgramFile': {
    ts: (a) => isProgramFile(str(a, 0)),
    cases: programPaths.map((p): Case => ({ args: [p] })),
  },
  'tab-menu.baseName': {
    ts: (a) => baseName(str(a, 0)),
    cases: baseNames.map((p): Case => ({ args: [p] })),
  },
  'tab-menu.pathLabel': {
    ts: (a) => pathLabel(str(a, 0)),
    cases: labelPaths.map((p): Case => ({ args: [p] })),
  },
  'tab-menu.tabMenuTemplate': {
    ts: (a) => {
      const input = a[0] as J
      let last: unknown = null
      const note =
        (name: string) =>
        (...rest: unknown[]) => {
          last = [name, ...rest]
        }
      const actions: J = {
        save: note('save'),
        saveAs: note('saveAs'),
        print: note('print'),
        openInNewWindow: note('openInNewWindow'),
        splitBeside: note('splitBeside'),
        rename: note('rename'),
        duplicate: note('duplicate'),
        copyText: note('copyText'),
        reveal: note('reveal'),
        openDefault: note('openDefault'),
        move: note('move'),
        closeTabs: note('closeTabs'),
        reopenClosed: note('reopenClosed'),
      }
      const template = tabMenuTemplate({
        tab: input.tab,
        tabs: input.tabs,
        canDetach: input.canDetach === true,
        fileExists: input.fileExists === true,
        canReopen: input.canReopen === true,
        tm: (k) => `T:${k}`,
        actions,
      })
      return template.map((item) => {
        const out: J = {}
        for (const [k, v] of Object.entries(item)) {
          if (k !== 'click') out[k] = v
          else if (item.enabled === false) out.click = '(off)'
          else {
            last = null
            ;(v as () => void)()
            out.click = last
          }
        }
        return out
      })
    },
    cases: menuCases,
  },

  'tab-shortcuts.tabShortcutOf': {
    ts: (a) => tabShortcutOf(a[0] as J, (a[1] ?? undefined) as J),
    cases: shortcutCases,
  },
  'tab-shortcuts.handleTabShortcut': {
    ts: (a, cx) => {
      const spec = a[2] as J
      return handleTabShortcut(a[0] as J, a[1] as number, {
        isShellContents: (id) => {
          cx.log('isShellContents', id)
          return spec.shell.includes(id)
        },
        hasTab: (id) => {
          cx.log('hasTab', id)
          return spec.tabs.includes(id)
        },
        activeKind: () => {
          cx.log('activeKind')
          return spec.activeKind ?? undefined
        },
        cycle: (d) => cx.log('cycle', d),
        closeActive: () => cx.log('closeActive'),
      })
    },
    cases: handleCases,
  },

  'split-layout.SPLIT_EVEN_RATIO': constant(SPLIT_EVEN_RATIO),
  'split-layout.splitAvailablePx': {
    ts: (a) => splitAvailablePx(a[0] as J, a[1] as J),
    cases: rectOrientation,
  },
  'split-layout.splitRatioLimits': {
    ts: (a) => splitRatioLimits(a[0] as J, a[1] as J),
    cases: rectOrientation,
  },
  'split-layout.clampSplitRatio': {
    ts: (a) => clampSplitRatio(a[0] as number, a[1] as J, a[2] as J),
    cases: RATIOS.flatMap((ratio) =>
      [RECTS[0], RECTS[2], RECTS[3], RECTS[6], RECTS[9]].flatMap((r) =>
        ['side', 'stack'].map((o): Case => ({ args: [ratio, r, o] })),
      ),
    ),
  },
  'split-layout.paneRects': {
    ts: (a) => paneRects(a[0] as J, a[1] as J, a[2] as number),
    cases: RATIOS.flatMap((ratio) =>
      [RECTS[0], RECTS[1], RECTS[7], RECTS[8], RECTS[9]].flatMap((r) =>
        ['side', 'stack'].map((o): Case => ({ args: [r, o, ratio] })),
      ),
    ),
  },
  'split-layout.splitDropZone': {
    ts: (a) => splitDropZone(a[0] as number, a[1] as number, a[2] as number, a[3] as number),
    cases: dropPoints.map((p): Case => ({ args: p })),
  },
  'split-layout.decideSplitDrop': { ts: (a) => decideSplitDrop(a[0] as J), cases: decideCases },
  'split-layout.activationMode': {
    ts: (a) => activationMode(a[0] as J, a[1] as J),
    cases: activationCases,
  },
  'split-layout.splitSurvivor': {
    ts: (a) => splitSurvivor(a[0] as J, str(a, 1)),
    cases: ['a', 'b', 'c', '', 'A'].map((removed): Case => ({
      args: [{ aTabId: 'a', bTabId: 'b' }, removed],
    })),
  },
  'split-layout.oppositeDocumentId': {
    ts: (a) => oppositeDocumentId(a[0] as J),
    cases: oppositeCases,
  },

  'open-documents.OPEN_DOCUMENTS_FILE': constant(OPEN_DOCUMENTS_FILE),
  'open-documents.publishOpenDocuments': {
    ts: (a, cx) => {
      const real = console.warn
      console.warn = (...args: unknown[]) =>
        cx.log('console.warn', ...args.map((x) => (typeof x === 'string' ? maskPidTmp(x) : x)))
      try {
        return withClock(cx.now, () => publishOpenDocuments(str(a, 0), a[1] as string[]))
      } finally {
        console.warn = real
      }
    },
    cases: publishCases,
  },
  'open-documents.clearOpenDocuments': {
    ts: (a) => clearOpenDocuments(str(a, 0)),
    cases: clearCases,
  },

  'window-background.SHELL_BACKGROUND_LIGHT': constant(SHELL_BACKGROUND_LIGHT),
  'window-background.SHELL_BACKGROUND_DARK': constant(SHELL_BACKGROUND_DARK),
  'window-background.shellWindowBackground': {
    ts: (a) => shellWindowBackground(a[0] as boolean),
    cases: [{ args: [true] }, { args: [false] }],
  },
  'title-bar-overlay.tabStripOverlay': {
    ts: (a) => tabStripOverlay(a[0] as boolean, (a[1] ?? undefined) as number | undefined),
    cases: overlayCases,
  },
  'skill-target.isInstallableSkillDir': {
    ts: (a) => isInstallableSkillDir(a[0], a[1] as string[]),
    cases: skillCases,
  },
  'file-targets.isUserVisibleFile': {
    ts: (a, cx) => {
      const spec = a[1] as J
      return isUserVisibleFile(a[0] as string, {
        insideAnyRoot: (p) => {
          cx.log('insideAnyRoot', p)
          return spec.roots.some((r: string) => p === r || p.startsWith(`${r}/`))
        },
        trackedPaths: spec.tracked,
      })
    },
    cases: targetCases,
  },
  'file-targets.isMoveSource': {
    ts: (a, cx) => {
      const spec = a[1] as J
      return isMoveSource(a[0] as string, {
        insideAnyRoot: (p) => {
          cx.log('insideAnyRoot', p)
          return spec.roots.some((r: string) => p === r || p.startsWith(`${r}/`))
        },
        trackedPaths: spec.tracked,
        isDirectory: (p) => {
          cx.log('isDirectory', p)
          return spec.dirs.includes(p)
        },
        isAnyRoot: (p) => {
          cx.log('isAnyRoot', p)
          return spec.roots.includes(p)
        },
      })
    },
    cases: targetCases,
  },

  'result-store-ipc.registerResultStoreIpc': {
    ts: async (a, cx) => {
      const handlers: Record<string, () => unknown> = {}
      registerResultStoreIpc(
        {
          handle: (channel: string, fn: () => unknown) => {
            cx.log('handle', channel)
            handlers[channel] = fn
          },
        } as never,
        () => {
          cx.log('userDataDir')
          return str(a, 0)
        },
      )
      const results: unknown[] = []
      for (const step of a[1] as string[]) {
        const channel = step === 'size' ? 'home:result-store-size' : 'home:result-store-delete-all'
        try {
          const value = await handlers[channel]()
          results.push(value === undefined ? {} : { value })
        } catch (error) {
          results.push({ error: (error as Error).message })
        }
      }
      return results
    },
    cases: storeCases,
  },

  'window-close-guard.installShellCloseGuard': { ts: guardScenario, cases: guardCases },
}
