// @vitest-environment node
/**
 * The two calls the renderer makes for the remembered design template. They
 * must exist inside the shell, where only the slides-only registration runs,
 * and they never take a file path: the main process knows which document a
 * window holds.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'slides-template-ipc-')))
const userData = join(root, 'userData')
const docs = join(root, 'docs')
mkdirSync(userData)
mkdirSync(docs)

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getName: () => 'slides-test',
    getVersion: () => '0',
    once: () => {},
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  nativeImage: {},
  net: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env;
// nothing here renders text.
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

// no status check: registering the subscription channels would look for the CLIs
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { registerSlidesOnlyAiIpc } from '../src/main/ai-ipc'
import { sessions, type Session } from '../src/main/session-state'
import { TEMPLATE_SELECTION_FILE } from '../src/main/template-selection-store'
import {
  followTemplateSelection,
  inheritTemplateSelection,
  moveSlidesTemplateSelection,
} from '../src/main/template-selection-ipc'
import type { TemplateSelection } from '../src/shared/ipc'

const GET = 'slides:ai-template-selection-get'
const SET = 'slides:ai-template-selection-set'

/** a window's document, as far as the template memory is concerned */
function open(wcId: number, path: string): Session {
  const session = { path } as Session
  sessions.set(wcId, session)
  return session
}

function deck(name: string): string {
  const path = join(docs, name)
  writeFileSync(path, 'pptx bytes')
  return path
}

const get = (wcId: number): TemplateSelection | null =>
  handlers.get(GET)!({ sender: { id: wcId } }) as TemplateSelection | null
const set = (wcId: number, ...args: unknown[]): TemplateSelection | null =>
  handlers.get(SET)!({ sender: { id: wcId } }, ...args) as TemplateSelection | null

const recordFile = join(userData, TEMPLATE_SELECTION_FILE)
const storedPaths = (): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(recordFile, 'utf8')) as { documents: Record<string, unknown> })
      .documents,
  )

beforeAll(() => {
  // the shell never calls registerAiIpc: only this function runs there
  registerSlidesOnlyAiIpc()
})

beforeEach(() => {
  sessions.clear()
  rmSync(recordFile, { force: true })
})

afterAll(() => {
  sessions.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('template selection IPC', () => {
  it('is registered by the slides-only registration, under the slides: prefix', () => {
    expect(handlers.has(GET)).toBe(true)
    expect(handlers.has(SET)).toBe(true)
  })

  it('is what the preload calls', () => {
    const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8')
    expect(preload).toContain(`getTemplateSelection: () => ipcRenderer.invoke('${GET}')`)
    expect(preload).toMatch(
      new RegExp(`setTemplateSelection: \\([^)]*\\) =>\\s+ipcRenderer\\.invoke\\('${SET}', `),
    )
  })

  it('answers null for a window with no document', () => {
    expect(get(900)).toBeNull()
    expect(set(900, { kind: 'builtin', key: 'aurora' })).toBeNull()
  })

  it('remembers the selection of the calling window’s document across a reopen', () => {
    const path = deck('a.pptx')
    open(1, path)
    const stored = set(1, { kind: 'builtin', key: 'aurora', adjustments: ['mostly blue'] })
    expect(stored).toMatchObject({ kind: 'builtin', key: 'aurora', adjustments: ['mostly blue'] })
    expect(typeof stored?.updatedAt).toBe('number')
    // closed, then opened in another window
    sessions.clear()
    open(2, path)
    expect(get(2)).toEqual(stored)
    expect(storedPaths()).toEqual([path])
  })

  it('takes the document from the calling window, never from the arguments', () => {
    const mine = deck('mine.pptx')
    const other = deck('other.pptx')
    open(1, mine)
    open(2, other)
    set(1, { kind: 'saved', key: 'Mine', path: other, filePath: other }, other)
    expect(get(1)?.key).toBe('Mine')
    expect(get(2)).toBeNull()
    expect(storedPaths()).toEqual([mine])
  })

  it('removes the selection on null and ignores malformed input without throwing', () => {
    open(1, deck('a.pptx'))
    set(1, { kind: 'builtin', key: 'aurora' })
    for (const bad of [undefined, 7, 'aurora', {}, { kind: 'cloud', key: 'x' }, { key: 'x' }]) {
      expect(() => set(1, bad)).not.toThrow()
      expect(get(1)?.key).toBe('aurora')
    }
    expect(set(1, null)).toBeNull()
    expect(get(1)).toBeNull()
  })

  it('keeps an unsaved document in memory and writes it on its first save', () => {
    const session = open(1, '')
    const stored = set(1, { kind: 'builtin', key: 'aurora', adjustments: ['mostly blue'] })
    expect(get(1)).toEqual(stored)
    expect(() => readFileSync(recordFile)).toThrow()
    // the first save: the session gets its path, then the memory follows
    const path = deck('first.pptx')
    session.path = path
    followTemplateSelection(session, '', path)
    expect(get(1)).toEqual(stored)
    expect(storedPaths()).toEqual([path])
  })

  it('two windows on one document see the later write the next time they ask', () => {
    const session = open(1, deck('shared.pptx'))
    sessions.set(2, session)
    set(1, { kind: 'builtin', key: 'aurora' })
    set(2, { kind: 'saved', key: 'Mine' })
    expect(get(1)?.key).toBe('Mine')
  })

  it('Save As keeps both paths', () => {
    const from = deck('a.pptx')
    const session = open(1, from)
    const stored = set(1, { kind: 'builtin', key: 'aurora' })
    const to = deck('b.pptx')
    followTemplateSelection(session, session.path, to)
    session.path = to
    expect(get(1)).toEqual(stored)
    expect(storedPaths().sort()).toEqual([from, to].sort())
  })

  it('a deck rebuilt by AI generation starts with the old one’s selection', () => {
    const from = deck('mine.pptx')
    const old = open(1, from)
    const stored = set(1, { kind: 'builtin', key: 'aurora' })
    const replacement = { path: '' } as Session
    inheritTemplateSelection(old, replacement)
    sessions.set(1, replacement)
    expect(get(1)).toEqual(stored)
    const draft = deck('draft.pptx')
    followTemplateSelection(replacement, replacement.path, draft)
    replacement.path = draft
    expect(get(1)).toEqual(stored)
    expect(storedPaths().sort()).toEqual([draft, from].sort())
  })

  it('a rename inside the app moves the record', () => {
    const from = deck('old-name.pptx')
    const session = open(1, from)
    const stored = set(1, { kind: 'builtin', key: 'aurora' })
    const to = join(docs, 'new-name.pptx')
    writeFileSync(to, readFileSync(from))
    rmSync(from)
    moveSlidesTemplateSelection(from, to)
    session.path = to
    expect(get(1)).toEqual(stored)
    expect(storedPaths()).toEqual([to])
  })
})
