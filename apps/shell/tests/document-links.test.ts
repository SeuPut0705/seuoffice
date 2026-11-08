import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const atomicWrites = vi.hoisted(() => [] as string[])
vi.mock('@genoffice/electron-utils/atomic-write', async (importActual) => {
  const actual = await importActual<typeof import('@genoffice/electron-utils/atomic-write')>()
  return {
    ...actual,
    writeJsonAtomic: (path: string, value: unknown) => {
      atomicWrites.push(path)
      actual.writeJsonAtomic(path, value)
    },
  }
})

import {
  generateRunStartedEvents,
  queueGenerateHandoff,
  recordGenerateConverted,
  reportGenerateRunStarted,
  resetGenerateHandoffsForTest,
  takeGenerateHandoff,
  type GenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import {
  DOCUMENT_LINKS_FILE,
  DocumentLinks,
  documentLinkMenuModel,
  documentLinksAt,
  isFreshlySavedPath,
  parseDocumentLinks,
  readDocumentLinksFile,
  watchMakeEvents,
} from '../src/main/document-links'
import { documentLinkMenuItems } from '../src/main/document-links-menu'

/**
 * Spec 9, provenance records: written to the app data folder only when a tab
 * that was handed materials (an AI run that started with them, or a
 * conversion) has its document saved for the first time, in either order;
 * following renames; never removed for a missing file. The hand-off store is
 * the real one, so the events are exactly what the editors report.
 */

let dir: string
let file: string

const doc = (name: string) => join(dir, name)
const MAP = () => doc('plan.xmind')
const NOTES = () => doc('notes.docx')
const REQUEST = 'Please turn this into slides — SECRET-REQUEST-WORDS'

class FakeContents extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
  destroy(): void {
    this.emit('destroyed')
  }
}

function handoff(overrides: Partial<GenerateHandoff> = {}): GenerateHandoff {
  return {
    id: 'h1',
    mode: 'ai',
    target: 'slides',
    materials: [
      { path: MAP(), name: 'plan.xmind' },
      { path: NOTES(), name: 'notes.docx' },
    ],
    text: REQUEST,
    defaultText: false,
    createdAt: 1,
    ...overrides,
  }
}

/** a tab took a hand-off; the run starts later with these attachments */
function takeHandoff(wcId: number, overrides: Partial<GenerateHandoff> = {}): void {
  queueGenerateHandoff(wcId, handoff(overrides))
  expect(takeGenerateHandoff(overrides.target ?? 'slides', wcId)).not.toBeNull()
}

const stored = () => JSON.parse(readFileSync(file, 'utf8')) as { version: number; links: unknown[] }
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-links-'))
  file = join(dir, DOCUMENT_LINKS_FILE)
  resetGenerateHandoffsForTest()
  atomicWrites.length = 0
})
afterEach(() => resetGenerateHandoffsForTest())

describe('when a record is written', () => {
  it('writes nothing for a tab written by hand and saved (no run, no conversion)', () => {
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('mine.pptx'))
    expect(links.sync()).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(links.links()).toEqual([])
  })

  it('records a run that started before the first save, with the handed-over materials', () => {
    takeHandoff(1)
    expect(reportGenerateRunStarted('slides', 1, [MAP(), NOTES()])).not.toBeNull()
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('deck.pptx'))
    expect(stored()).toEqual({
      version: 1,
      links: [
        {
          derived: doc('deck.pptx'),
          sources: [MAP(), NOTES()],
          createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          via: 'ai',
        },
      ],
    })
  })

  it('records a run that starts after the first save, when it starts', async () => {
    const links = documentLinksAt(file)
    watchMakeEvents(
      () => 'tab-1',
      () => links.sync(),
    )
    takeHandoff(1)
    links.noteTabPath(new FakeContents(1), doc('deck.pptx'))
    expect(existsSync(file)).toBe(false)
    // blocked first, then sent by hand from that tab after connecting: the same report
    reportGenerateRunStarted('slides', 1, [NOTES()])
    await flush()
    // the record lists every handed-over material, not only the one still attached (9)
    expect(links.sourcesOf(doc('deck.pptx'))).toEqual([MAP(), NOTES()])
    expect(stored().links).toHaveLength(1)
    // the resolver still answers the tab id for the store
    expect(generateRunStartedEvents()[0]?.tabId).toBe('tab-1')
  })

  it('does not count a run sent with every handed-over material removed', () => {
    takeHandoff(1)
    expect(reportGenerateRunStarted('slides', 1, [])).toBeNull()
    expect(reportGenerateRunStarted('slides', 1, [doc('other.pdf')])).toBeNull()
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('deck.pptx'))
    expect(existsSync(file)).toBe(false)
  })

  it('records a conversion once the result is saved, as via "convert"', () => {
    recordGenerateConverted({
      webContentsId: 7,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(7), doc('plan.md'))
    expect(stored().links).toEqual([
      { derived: doc('plan.md'), sources: [MAP()], createdAt: expect.any(String), via: 'convert' },
    ])
  })

  it('keeps the record on the first saved path: a Save As adds nothing', async () => {
    const links = documentLinksAt(file)
    watchMakeEvents(
      () => undefined,
      () => links.sync(),
    )
    takeHandoff(1)
    const tab = new FakeContents(1)
    links.noteTabPath(tab, doc('first.pptx'))
    links.noteTabPath(tab, doc('copy.pptx'))
    reportGenerateRunStarted('slides', 1, [MAP()])
    await flush()
    links.noteTabPath(tab, doc('later-copy.pptx'))
    links.sync()
    expect(links.links().map((l) => l.derived)).toEqual([doc('first.pptx')])
    expect(links.sourcesOf(doc('copy.pptx'))).toEqual([])
  })

  it('writes nothing for a tab closed without saving', () => {
    takeHandoff(1)
    reportGenerateRunStarted('slides', 1, [MAP()])
    const links = documentLinksAt(file)
    const tab = new FakeContents(1)
    tab.destroy()
    links.sync()
    expect(existsSync(file)).toBe(false)
  })

  it('forgets a saved tab that closes before any run started', async () => {
    const links = documentLinksAt(file)
    watchMakeEvents(
      () => undefined,
      () => links.sync(),
    )
    const tab = new FakeContents(1)
    links.noteTabPath(tab, doc('deck.pptx'))
    tab.destroy()
    // a later webContents never reuses the id, but the tracker must not hold on either
    expect(links.paths()).toEqual([])
  })

  it('never records a tab whose first path was an existing file opened into it', () => {
    takeHandoff(1)
    reportGenerateRunStarted('slides', 1, [MAP()])
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('old.pptx'), { fresh: false })
    expect(existsSync(file)).toBe(false)
  })

  it('keeps one record per made document', () => {
    recordGenerateConverted({
      webContentsId: 1,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    recordGenerateConverted({
      webContentsId: 2,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [doc('other.xmind')],
      conversionId: 'c2',
    })
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    // a second tab saved over the same file: its record replaces the first
    links.noteTabPath(new FakeContents(2), doc('PLAN.md'))
    const derived = stored().links.map((l) => (l as { derived: string }).derived)
    expect(derived).toHaveLength(process.platform === 'win32' ? 1 : 2)
    expect(links.sourcesOf(doc('plan.md'))).toEqual(
      process.platform === 'win32' ? [doc('other.xmind')] : [MAP()],
    )
    // a source may appear in many records
    recordGenerateConverted({
      webContentsId: 3,
      target: 'slides',
      kind: 'mindmap-to-slides',
      sources: [MAP()],
      conversionId: 'c3',
    })
    links.noteTabPath(new FakeContents(3), doc('plan.pptx'))
    expect(links.derivedFrom(MAP())).toContain(doc('plan.pptx'))
  })

  it('never stores the request text', () => {
    takeHandoff(1)
    reportGenerateRunStarted('slides', 1, [MAP()])
    documentLinksAt(file).noteTabPath(new FakeContents(1), doc('deck.pptx'))
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('SECRET-REQUEST-WORDS')
    for (const link of stored().links) {
      expect(Object.keys(link as object).sort()).toEqual(['createdAt', 'derived', 'sources', 'via'])
    }
  })
})

describe('following renames and moves', () => {
  function recorded(): DocumentLinks {
    recordGenerateConverted({
      webContentsId: 1,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    return links
  }

  it('follows the made document', () => {
    const links = recorded()
    links.fileMoved(doc('plan.md'), doc('renamed.md'))
    expect(links.sourcesOf(doc('renamed.md'))).toEqual([MAP()])
    expect(links.sourcesOf(doc('plan.md'))).toEqual([])
    expect(readDocumentLinksFile(file)[0]?.derived).toBe(doc('renamed.md'))
  })

  it('follows a source', () => {
    const links = recorded()
    links.fileMoved(MAP(), doc('moved/plan.xmind'))
    expect(links.derivedFrom(doc('moved/plan.xmind'))).toEqual([doc('plan.md')])
    expect(readDocumentLinksFile(file)[0]?.sources).toEqual([doc('moved/plan.xmind')])
  })

  it('follows a saved tab whose run has not started yet', async () => {
    const links = documentLinksAt(file)
    watchMakeEvents(
      () => undefined,
      () => links.sync(),
    )
    takeHandoff(1)
    links.noteTabPath(new FakeContents(1), doc('deck.pptx'))
    links.fileMoved(doc('deck.pptx'), doc('folder/deck.pptx'))
    reportGenerateRunStarted('slides', 1, [MAP()])
    await flush()
    expect(links.links().map((l) => l.derived)).toEqual([doc('folder/deck.pptx')])
  })

  it('tells listeners and lists every path for folder moves', () => {
    const links = recorded()
    const heard = vi.fn()
    links.onChange(heard)
    const before = links.version
    links.fileMoved(doc('plan.md'), doc('b.md'))
    expect(heard).toHaveBeenCalledTimes(1)
    expect(links.version).toBe(before + 1)
    expect(links.paths()).toEqual([doc('b.md'), MAP()])
    links.fileMoved(doc('unrelated.md'), doc('x.md'))
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('the File-menu entries', () => {
  const labels = { make: 'Make', sources: 'View Sources', derived: 'Made from This' }

  it('dims a file that is gone and keeps its record', () => {
    recordGenerateConverted({
      webContentsId: 1,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    const model = documentLinkMenuModel(doc('plan.md'), links, () => false)
    expect(model.sources).toEqual([{ path: MAP(), name: 'plan.xmind', missing: true }])
    const opened: string[] = []
    const items = documentLinkMenuItems({
      model,
      labels,
      isMac: false,
      onMake: () => {},
      onOpen: (p) => opened.push(p),
    })
    const sources = items.find((i) => i.id === 'document-links-sources')
    const entry = (sources?.submenu as Array<{ enabled?: boolean; sublabel?: string }>)[0]
    expect(entry?.enabled).toBe(false)
    expect(entry?.sublabel).toBe(MAP())
    expect(items.find((i) => i.id === 'document-links-derived')).toBeUndefined()
    // nothing removed it: the record is still there, on disk too
    links.sync()
    expect(readDocumentLinksFile(file)).toHaveLength(1)
  })

  it('shows the derived list on the source, enabled when the file is there', () => {
    const links = new DocumentLinks({
      load: () => [
        { derived: doc('a.md'), sources: [MAP()], createdAt: 'x', via: 'convert' },
        { derived: doc('b.pptx'), sources: [MAP(), NOTES()], createdAt: 'x', via: 'ai' },
      ],
      save: () => {},
      events: () => [],
      now: () => new Date(0),
    })
    const model = documentLinkMenuModel(MAP(), links, (p) => p.endsWith('a.md'))
    expect(model.sources).toEqual([])
    expect(model.derived.map((e) => [e.name, e.missing])).toEqual([
      ['a.md', false],
      ['b.pptx', true],
    ])
    const opened: string[] = []
    let made = 0
    const items = documentLinkMenuItems({
      model,
      labels,
      isMac: true,
      onMake: () => void made++,
      onOpen: (p) => opened.push(p),
    })
    expect(items[0]?.type).toBe('separator')
    ;(items[1]?.click as () => void)()
    expect(made).toBe(1)
    const derived = items.find((i) => i.id === 'document-links-derived')
    const first = (derived?.submenu as Array<{ click: () => void; sublabel?: string }>)[0]!
    expect(first.sublabel).toBeUndefined()
    first.click()
    expect(opened).toEqual([doc('a.md')])
    expect(items.find((i) => i.id === 'document-links-sources')).toBeUndefined()
  })

  it('shows only the make entry for an unsaved document', () => {
    const links = new DocumentLinks({
      load: () => [],
      save: () => {},
      events: () => [],
      now: () => new Date(0),
    })
    const items = documentLinkMenuItems({
      model: documentLinkMenuModel(undefined, links, () => true),
      labels,
      isMac: false,
      onMake: () => {},
      onOpen: () => {},
    })
    expect(items.map((i) => i.id ?? i.type)).toEqual(['separator', 'document-links-make'])
  })
})

describe('the records file', () => {
  it('reads a broken file as no records and leaves it until the next write', () => {
    writeFileSync(file, '{ "version": 1, "links": [ {"derived": ')
    const links = documentLinksAt(file)
    expect(links.links()).toEqual([])
    expect(links.sourcesOf(doc('a.md'))).toEqual([])
    links.sync()
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, "links": [ {"derived": ')
    recordGenerateConverted({
      webContentsId: 1,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    expect(stored().links).toHaveLength(1)
  })

  it('reads the wrong shape as no records and skips malformed entries', () => {
    expect(parseDocumentLinks('[]')).toEqual([])
    expect(parseDocumentLinks('{"links": 3}')).toEqual([])
    expect(parseDocumentLinks('null')).toEqual([])
    const ok = { derived: doc('a.md'), sources: [MAP()], createdAt: 't', via: 'ai' }
    expect(
      parseDocumentLinks(
        JSON.stringify({
          version: 1,
          links: [
            ok,
            { ...ok, via: 'magic' },
            { ...ok, sources: [] },
            { ...ok, derived: 4 },
            { ...ok, request: 'x' },
          ],
        }),
      ),
    ).toEqual([ok])
    expect(readDocumentLinksFile(join(dir, 'missing.json'))).toEqual([])
  })

  it('writes through the atomic state-file helper and leaves no temporary file', () => {
    recordGenerateConverted({
      webContentsId: 1,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: [MAP()],
      conversionId: 'c1',
    })
    const links = documentLinksAt(file)
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    links.fileMoved(doc('plan.md'), doc('b.md'))
    expect(atomicWrites).toEqual([file, file])
    expect(readdirSync(dir)).toEqual([DOCUMENT_LINKS_FILE])
  })

  it('keeps the records in memory when the write fails', () => {
    const save = vi.fn(() => {
      throw new Error('disk full')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const links = new DocumentLinks({
      load: () => [],
      save,
      events: () => [{ webContentsId: 1, mode: 'convert', sources: [MAP()], at: 1 }],
      now: () => new Date(0),
    })
    links.noteTabPath(new FakeContents(1), doc('plan.md'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(links.sourcesOf(doc('plan.md'))).toEqual([MAP()])
    warn.mockRestore()
  })
})

describe('a path that is a save, not an opened file', () => {
  it('is fresh when not on disk yet or born just now, not when it is an older file', () => {
    const now = 1_000_000
    const gone = () => {
      throw new Error('ENOENT')
    }
    expect(isFreshlySavedPath('x', now, gone)).toBe(true)
    expect(isFreshlySavedPath('x', now, () => ({ birthtimeMs: now - 1000, mtimeMs: 0 }))).toBe(true)
    expect(isFreshlySavedPath('x', now, () => ({ birthtimeMs: now - 60_000, mtimeMs: now }))).toBe(
      false,
    )
    expect(isFreshlySavedPath('x', now, () => ({ birthtimeMs: 0, mtimeMs: now - 500 }))).toBe(true)
    expect(resolve(MAP())).toBe(MAP())
  })
})
