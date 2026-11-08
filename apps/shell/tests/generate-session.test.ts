import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Lang } from '@genoffice/i18n'
import type { GenerateHandoff, GenerateWindowState } from '../src/shared/generate-api'
import { DEFAULT_GENERATE_PROMPTS } from '../src/shared/generate-default-prompts'
import { MAX_MATERIALS, USAGE_NOTICE_CHARS } from '../src/main/generate/limits'
import type { MaterialStatus } from '../src/main/generate/materials'
import {
  GenerateSession,
  type GenerateSessionDeps,
  type MaterialRef,
} from '../src/main/generate/session'

/**
 * The generate window's state machine, with fake files and tabs: "make" only
 * with readable, saved material; it opens one tab with the request queued and
 * closes; nothing else starts.
 */

const p = (name: string) => join(tmpdir(), 'gen-session', name)

interface FakeFile {
  size: number
  length: number
  unsaved?: boolean
  problem?: MaterialStatus['problem']
}

function harness(
  files: Record<string, FakeFile>,
  options: { lang?: Lang; saveAction?: 'save' | 'show'; untitledPath?: string | null } = {},
) {
  const opened: GenerateHandoff[] = []
  const pushed: GenerateWindowState[] = []
  const saves: string[] = []
  let closed = 0
  let untitledPath = options.untitledPath ?? null
  const deps: GenerateSessionDeps = {
    lang: () => options.lang ?? 'en',
    inspect: async (path) => {
      const name = path.split(/[\\/]/).pop()!
      const f = files[name]
      if (!f)
        return {
          key: path,
          name,
          path,
          ext: 'md',
          unsaved: false,
          textLength: 0,
          problem: 'missing',
        }
      return {
        key: path,
        name,
        path,
        ext: name.split('.').pop()!,
        sizeBytes: f.size,
        unsaved: !!f.unsaved,
        textLength: f.problem ? 0 : f.length,
        ...(f.problem ? { problem: f.problem } : {}),
      }
    },
    pathOfUntitled: async () => untitledPath,
    saveActionFor: async () => options.saveAction ?? 'save',
    saveMaterial: async (path) => {
      saves.push(path)
      const f = files[path.split(/[\\/]/).pop()!]
      if (f) f.unsaved = false
      return 'saved'
    },
    showUntitled: async () => {},
    openTargetTab: (h) => {
      opened.push(h)
    },
    push: (s) => pushed.push(s),
    close: () => {
      closed++
    },
    newId: () => `id-${opened.length + 1}`,
    now: () => 1000,
    recheckDelayMs: 0,
  }
  return {
    deps,
    opened,
    pushed,
    saves,
    closedCount: () => closed,
    setUntitledPath: (path: string | null) => {
      untitledPath = path
    },
  }
}

async function start(h: ReturnType<typeof harness>, refs: MaterialRef[]) {
  const session = new GenerateSession(h.deps, { refs })
  await session.refresh()
  return session
}

describe('GenerateSession', () => {
  it('shows each material with its size, the total and a ready "make"', async () => {
    const h = harness({ 'a.docx': { size: 1000, length: 10 }, 'b.pdf': { size: 2000, length: 20 } })
    const s = await start(h, [{ path: p('a.docx') }, { path: p('b.pdf') }])
    const state = s.state()
    expect(state.materials.map((m) => [m.name, m.state, m.sizeBytes])).toEqual([
      ['a.docx', 'ready', 1000],
      ['b.pdf', 'ready', 2000],
    ])
    expect(state.totalBytes).toBe(3000)
    expect(state.readyCount).toBe(2)
    expect(state.canMake).toBe(true)
    expect(state.kind).toBe('slides')
  })

  it('lists unreadable materials with the reason and leaves them out of the total', async () => {
    const h = harness({
      'a.docx': { size: 1000, length: 10 },
      'c.pdf': { size: 5, length: 0, problem: 'unreadable' },
    })
    const s = await start(h, [{ path: p('a.docx') }, { path: p('c.pdf') }, { path: p('gone.md') }])
    const state = s.state()
    expect(
      state.materials.filter((m) => m.state === 'excluded').map((m) => [m.name, m.problem]),
    ).toEqual([
      ['c.pdf', 'unreadable'],
      ['gone.md', 'missing'],
    ])
    expect(state.totalBytes).toBe(1000)
    expect(state.canMake).toBe(true)
  })

  it('cannot make with no readable material', async () => {
    const h = harness({})
    const s = await start(h, [{ path: p('gone.md') }])
    expect(s.state().canMake).toBe(false)
    expect(await s.make('')).toBe(false)
    expect(h.opened).toEqual([])
  })

  it('blocks "make" while a material is unsaved, and allows it once its save button saved it', async () => {
    const files = {
      'a.docx': { size: 1, length: 1 },
      'b.md': { size: 1, length: 1, unsaved: true },
    }
    const h = harness(files)
    const s = await start(h, [{ path: p('a.docx') }, { path: p('b.md') }])
    const before = s.state()
    expect(before.canMake).toBe(false)
    const row = before.materials.find((m) => m.name === 'b.md')!
    expect(row).toMatchObject({ state: 'unsaved', saveAction: 'save' })
    expect(await s.make('')).toBe(false)
    expect(h.opened).toEqual([])

    await s.save(row.key)
    expect(h.saves).toEqual([p('b.md')])
    expect(s.state().canMake).toBe(true)
  })

  it('re-reads the materials at "make": a file changed since is caught then', async () => {
    const files: Record<string, FakeFile> = { 'a.docx': { size: 1, length: 1 } }
    const h = harness(files)
    const s = await start(h, [{ path: p('a.docx') }])
    files['a.docx'].unsaved = true
    expect(await s.make('')).toBe(false)
    expect(h.opened).toEqual([])
    expect(s.state().materials[0].state).toBe('unsaved')
  })

  it('opens one tab with the request queued and closes, exactly once', async () => {
    const h = harness({ 'a.docx': { size: 1, length: 1 }, 'b.pdf': { size: 2, length: 2 } })
    const s = await start(h, [{ path: p('a.docx') }, { path: p('b.pdf') }, { path: p('gone.md') }])
    s.setKind('mindmap')
    const [first, second] = await Promise.all([s.make('  focus on the summary  '), s.make('x')])
    expect([first, second]).toEqual([true, false])
    expect(await s.make('again')).toBe(false)
    expect(h.opened).toEqual([
      {
        id: 'id-1',
        mode: 'ai',
        target: 'mindmap',
        materials: [
          { path: p('a.docx'), name: 'a.docx' },
          { path: p('b.pdf'), name: 'b.pdf' },
        ],
        text: 'focus on the summary',
        defaultText: false,
        createdAt: 1000,
      },
    ])
    expect(h.closedCount()).toBe(1)
  })

  it('uses the kind’s default request in the UI language when the box is empty', async () => {
    for (const lang of ['ko', 'en', 'ja'] as const) {
      for (const kind of ['slides', 'html', 'mindmap'] as const) {
        const h = harness({ 'a.md': { size: 1, length: 1 } }, { lang })
        const s = await start(h, [{ path: p('a.md') }])
        s.setKind(kind)
        expect(await s.make('   ')).toBe(true)
        expect(h.opened[0]).toMatchObject({
          target: kind,
          text: DEFAULT_GENERATE_PROMPTS[lang][kind],
          defaultText: true,
        })
      }
    }
  })

  it('does not open a tab when the tab cannot be opened, and says so', async () => {
    const h = harness({ 'a.md': { size: 1, length: 1 } })
    h.deps.openTargetTab = () => {
      throw new Error('no window')
    }
    const s = await start(h, [{ path: p('a.md') }])
    expect(await s.make('')).toBe(false)
    expect(s.state()).toMatchObject({ failure: 'make', making: false, canMake: true })
    expect(h.closedCount()).toBe(0)
  })

  it('cannot make with more materials than the cap', async () => {
    const files: Record<string, FakeFile> = {}
    const refs: MaterialRef[] = []
    for (let i = 0; i <= MAX_MATERIALS; i++) {
      files[`${i}.md`] = { size: 1, length: 1 }
      refs.push({ path: p(`${i}.md`) })
    }
    const h = harness(files)
    const s = await start(h, refs)
    expect(s.state()).toMatchObject({ tooMany: true, canMake: false })
    s.remove(s.state().materials[0].key)
    expect(s.state()).toMatchObject({ tooMany: false, canMake: true })
  })

  it('lists a never-saved document as "save it first" until its tab has a path', async () => {
    const h = harness({ 'saved.md': { size: 3, length: 3 } })
    const s = await start(h, [{ untitled: { webContentsId: 12, title: 'Untitled' } }])
    expect(s.state().materials).toEqual([
      expect.objectContaining({
        name: 'Untitled',
        state: 'excluded',
        problem: 'untitled',
        saveAction: 'show',
      }),
    ])
    expect(s.state().canMake).toBe(false)
    h.setUntitledPath(p('saved.md'))
    await s.refresh()
    expect(s.state().materials).toEqual([
      expect.objectContaining({ name: 'saved.md', state: 'ready', path: p('saved.md') }),
    ])
    expect(s.state().canMake).toBe(true)
  })

  it('shows the notices from the materials’ text length, per kind', async () => {
    const h = harness({ 'long.md': { size: 1, length: 9000 } })
    const s = await start(h, [{ path: p('long.md') }])
    expect(s.state().notices).toEqual({ usage: false, longMaterial: true })
    s.setKind('mindmap')
    expect(s.state().notices).toEqual({ usage: false, longMaterial: false })
    const big = harness({ 'big.md': { size: 1, length: USAGE_NOTICE_CHARS + 1 } })
    const b = await start(big, [{ path: p('big.md') }])
    expect(b.state().notices.usage).toBe(true)
    // neither notice blocks "make"
    expect(b.state().canMake).toBe(true)
  })

  it('adds and removes materials, ignoring duplicates', async () => {
    const h = harness({ 'a.md': { size: 1, length: 1 }, 'b.md': { size: 1, length: 1 } })
    const s = await start(h, [{ path: p('a.md') }])
    await s.addPaths([p('a.md'), p('b.md'), 42])
    expect(s.state().materials.map((m) => m.name)).toEqual(['a.md', 'b.md'])
    s.remove(s.state().materials[0].key)
    expect(s.state().materials.map((m) => m.name)).toEqual(['b.md'])
  })

  it('starts over when the window is opened again', async () => {
    const h = harness({ 'a.md': { size: 1, length: 1 }, 'b.md': { size: 1, length: 1 } })
    const s = await start(h, [{ path: p('a.md') }])
    await s.reset([{ path: p('b.md') }])
    expect(s.state().materials.map((m) => m.name)).toEqual(['b.md'])
  })
})
