// @vitest-environment node
/**
 * The design template a deck was made with is remembered per document, on this
 * PC only: one JSON file in the user-data folder, keyed by the document's
 * canonical path. Nothing here touches Electron, a .pptx, or the network.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalPathKey } from '@genoffice/project-store'
import {
  TEMPLATE_SELECTION_FILE,
  TEMPLATE_SELECTION_MAX_DOCUMENTS,
  TEMPLATE_SELECTION_TOUCH_INTERVAL_MS,
  TemplateSelectionMemory,
  TemplateSelectionStore,
} from '../src/main/template-selection-store'
import {
  TEMPLATE_ADJUSTMENTS_MAX_CHARS,
  TEMPLATE_KEY_MAX_CHARS,
  normalizeTemplateSelection,
  type TemplateSelectionInput,
} from '../src/shared/template-selection'

let root: string
let userData: string
let docs: string

/** a clock the test advances by hand, so "least recently used" is not a race */
let clock: number
const now = (): number => clock

beforeEach(() => {
  // resolved once, so a path built from it is already in its canonical spelling
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'slides-template-selection-')))
  userData = join(root, 'userData')
  docs = join(root, 'docs')
  mkdirSync(userData)
  mkdirSync(docs)
  clock = 1_000
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** a document that exists on disk (the canonical key needs a real file) */
function deck(name: string): string {
  const path = join(docs, name)
  writeFileSync(path, 'pptx bytes')
  return path
}

const recordFile = (): string => join(userData, TEMPLATE_SELECTION_FILE)
const newStore = (maxDocuments?: number): TemplateSelectionStore =>
  new TemplateSelectionStore(userData, { now, ...(maxDocuments ? { maxDocuments } : {}) })
const newMemory = (): TemplateSelectionMemory => new TemplateSelectionMemory(userData, { now })

const BLUE: TemplateSelectionInput = {
  kind: 'builtin',
  key: 'aurora',
  adjustments: ['mostly blue'],
}

describe('normalizeTemplateSelection', () => {
  it('accepts both kinds and stamps updatedAt itself', () => {
    expect(normalizeTemplateSelection({ kind: 'builtin', key: 'aurora' }, 42)).toEqual({
      kind: 'builtin',
      key: 'aurora',
      adjustments: [],
      updatedAt: 42,
    })
    expect(
      normalizeTemplateSelection(
        { kind: 'saved', key: 'My style', adjustments: ['a'], updatedAt: 7 },
        42,
      ),
    ).toEqual({ kind: 'saved', key: 'My style', adjustments: ['a'], updatedAt: 42 })
  })

  it('rejects anything that is not a selection', () => {
    for (const bad of [
      null,
      undefined,
      'aurora',
      7,
      [],
      {},
      { kind: 'cloud', key: 'aurora' },
      { kind: 'builtin' },
      { kind: 'builtin', key: '' },
      { kind: 'builtin', key: '   ' },
      { kind: 'builtin', key: 7 },
      { kind: 'builtin', key: 'aurora', adjustments: 'mostly blue' },
    ]) {
      expect(normalizeTemplateSelection(bad, 1), JSON.stringify(bad)).toBeNull()
    }
  })

  it('rejects a key longer than the cap and keeps one exactly at it', () => {
    const atCap = 'k'.repeat(TEMPLATE_KEY_MAX_CHARS)
    expect(TEMPLATE_KEY_MAX_CHARS).toBe(128)
    expect(normalizeTemplateSelection({ kind: 'saved', key: atCap }, 1)?.key).toBe(atCap)
    expect(normalizeTemplateSelection({ kind: 'saved', key: `${atCap}k` }, 1)).toBeNull()
  })

  it('keeps a key as given, inner and outer spaces included', () => {
    // a saved style is looked up by its exact name
    expect(normalizeTemplateSelection({ kind: 'saved', key: ' My  style ' }, 1)?.key).toBe(
      ' My  style ',
    )
  })

  it('trims the added requests and drops empty and non-string entries', () => {
    const r = normalizeTemplateSelection(
      {
        kind: 'builtin',
        key: 'aurora',
        adjustments: ['  mostly blue ', '', '   ', 7, null, 'big'],
      },
      1,
    )
    expect(r?.adjustments).toEqual(['mostly blue', 'big'])
  })

  it('drops the oldest added requests once their total length passes the cap', () => {
    expect(TEMPLATE_ADJUSTMENTS_MAX_CHARS).toBe(600)
    const a = 'a'.repeat(300)
    const b = 'b'.repeat(300)
    const c = 'c'.repeat(10)
    // exactly at the cap: nothing is dropped
    expect(
      normalizeTemplateSelection({ kind: 'builtin', key: 'k', adjustments: [a, b] }, 1)
        ?.adjustments,
    ).toEqual([a, b])
    // one more: the oldest goes, the order of the rest stays
    expect(
      normalizeTemplateSelection({ kind: 'builtin', key: 'k', adjustments: [a, b, c] }, 1)
        ?.adjustments,
    ).toEqual([b, c])
    // several old ones go when one new long request arrives
    expect(
      normalizeTemplateSelection(
        { kind: 'builtin', key: 'k', adjustments: [c, c, c, 'd'.repeat(595)] },
        1,
      )?.adjustments,
    ).toEqual(['d'.repeat(595)])
  })

  it('cuts a single request that is longer than the cap by itself', () => {
    const r = normalizeTemplateSelection(
      { kind: 'builtin', key: 'k', adjustments: ['old', 'x'.repeat(700)] },
      1,
    )
    expect(r?.adjustments).toEqual(['x'.repeat(TEMPLATE_ADJUSTMENTS_MAX_CHARS)])
  })
})

describe('TemplateSelectionStore', () => {
  it('still has the selection after the document is closed and reopened', () => {
    const path = deck('a.pptx')
    clock = 5_000
    expect(newStore().set(path, BLUE)).toEqual({
      kind: 'builtin',
      key: 'aurora',
      adjustments: ['mostly blue'],
      updatedAt: 5_000,
    })
    // a new store is what the next app start has
    expect(newStore().get(path)).toEqual({
      kind: 'builtin',
      key: 'aurora',
      adjustments: ['mostly blue'],
      updatedAt: 5_000,
    })
  })

  it('writes one file in the user-data folder, keyed by the canonical path, and nothing beside the document', () => {
    const path = deck('a.pptx')
    newStore().set(path, BLUE)
    expect(readdirSync(userData)).toEqual([TEMPLATE_SELECTION_FILE])
    expect(readdirSync(docs)).toEqual(['a.pptx'])
    expect(readFileSync(path, 'utf8')).toBe('pptx bytes')
    const stored = JSON.parse(readFileSync(recordFile(), 'utf8')) as {
      documents: Record<string, unknown>
    }
    expect(Object.keys(stored.documents)).toEqual([canonicalPathKey(path)])
    expect(stored.documents[canonicalPathKey(path)]).toMatchObject({
      kind: 'builtin',
      key: 'aurora',
      adjustments: ['mostly blue'],
      updatedAt: 1_000,
    })
  })

  it.runIf(process.platform === 'win32')(
    'finds the record through another spelling of the same path (case)',
    () => {
      const path = deck('Report.pptx')
      const store = newStore()
      store.set(path, BLUE)
      expect(store.get(path.toUpperCase())?.key).toBe('aurora')
      store.set(path.toLowerCase(), { kind: 'saved', key: 'Mine' })
      expect(store.get(path)?.key).toBe('Mine')
      const stored = JSON.parse(readFileSync(recordFile(), 'utf8')) as {
        documents: Record<string, unknown>
      }
      expect(Object.keys(stored.documents)).toHaveLength(1)
    },
  )

  it('finds the record through a symlink to the same document', (ctx) => {
    const path = deck('a.pptx')
    const link = join(root, 'linked-docs')
    try {
      symlinkSync(docs, link, 'junction')
    } catch {
      ctx.skip()
      return
    }
    const store = newStore()
    store.set(join(link, 'a.pptx'), BLUE)
    expect(store.get(path)?.key).toBe('aurora')
    expect(Object.keys(JSON.parse(readFileSync(recordFile(), 'utf8')).documents)).toEqual([
      canonicalPathKey(path),
    ])
  })

  it('keeps a record written before the file exists and finds it once the file is there', () => {
    // the first save names the draft before it writes it
    const path = join(docs, 'not-yet.pptx')
    const store = newStore()
    store.set(path, BLUE)
    expect(store.get(path)?.key).toBe('aurora')
    writeFileSync(path, 'pptx bytes')
    expect(store.get(path)?.key).toBe('aurora')
    expect(Object.keys(JSON.parse(readFileSync(recordFile(), 'utf8')).documents)).toEqual([
      canonicalPathKey(path),
    ])
  })

  it('set(null) removes the selection, and a second set(null) is harmless', () => {
    const path = deck('a.pptx')
    const store = newStore()
    store.set(path, BLUE)
    expect(store.set(path, null)).toBeNull()
    expect(store.get(path)).toBeNull()
    expect(store.set(path, null)).toBeNull()
    expect(JSON.parse(readFileSync(recordFile(), 'utf8')).documents).toEqual({})
  })

  it('does not create the record file for a document that never had a selection', () => {
    const path = deck('a.pptx')
    const store = newStore()
    expect(store.get(path)).toBeNull()
    expect(store.set(path, null)).toBeNull()
    store.copy(path, deck('b.pptx'))
    store.move(path, deck('c.pptx'))
    expect(existsSync(recordFile())).toBe(false)
  })

  it('stores a changed kind or key as given: the caller decides what happens to the added requests', () => {
    const path = deck('a.pptx')
    const store = newStore()
    store.set(path, BLUE)
    clock = 2_000
    expect(store.set(path, { kind: 'saved', key: 'Mine', adjustments: [] })).toEqual({
      kind: 'saved',
      key: 'Mine',
      adjustments: [],
      updatedAt: 2_000,
    })
    clock = 3_000
    // the same store does not clear them by itself either
    expect(store.set(path, { kind: 'builtin', key: 'dusk', adjustments: ['kept'] })).toEqual({
      kind: 'builtin',
      key: 'dusk',
      adjustments: ['kept'],
      updatedAt: 3_000,
    })
    expect(store.get(path)?.adjustments).toEqual(['kept'])
  })

  it('applies the added-request cap on every write', () => {
    const path = deck('a.pptx')
    const old = 'o'.repeat(400)
    const fresh = 'n'.repeat(400)
    const stored = newStore().set(path, { kind: 'builtin', key: 'k', adjustments: [old, fresh] })
    expect(stored?.adjustments).toEqual([fresh])
    expect(newStore().get(path)?.adjustments).toEqual([fresh])
  })

  it('ignores malformed input and answers with what is still stored', () => {
    const path = deck('a.pptx')
    const store = newStore()
    store.set(path, BLUE)
    const before = readFileSync(recordFile(), 'utf8')
    for (const bad of [undefined, 'aurora', {}, { kind: 'cloud', key: 'x' }, { kind: 'saved' }]) {
      expect(store.set(path, bad)?.key).toBe('aurora')
    }
    expect(readFileSync(recordFile(), 'utf8')).toBe(before)
    expect(store.set(deck('b.pptx'), { kind: 'nope', key: 'x' })).toBeNull()
  })

  it('returns a record that points at something this version does not know, as stored', () => {
    const path = deck('a.pptx')
    const store = newStore()
    store.set(path, { kind: 'builtin', key: 'template-from-a-newer-version', adjustments: ['x'] })
    expect(newStore().get(path)).toMatchObject({
      kind: 'builtin',
      key: 'template-from-a-newer-version',
      adjustments: ['x'],
    })
    // the caller finds nothing under that key and clears it
    expect(store.set(path, null)).toBeNull()
    expect(store.get(path)).toBeNull()
  })

  it.each([
    ['not JSON', '{"version":1,"documents":{'],
    ['empty', ''],
    ['an array', '[1,2,3]'],
    ['a string', '"hello"'],
    ['documents of the wrong type', '{"version":1,"documents":[]}'],
    ['null', 'null'],
  ])('a corrupt record file (%s) reads as no selection and the next set repairs it', (_n, raw) => {
    const path = deck('a.pptx')
    writeFileSync(recordFile(), raw)
    const store = newStore()
    expect(store.get(path)).toBeNull()
    // reading must not rewrite a file it could not understand
    expect(readFileSync(recordFile(), 'utf8')).toBe(raw)
    expect(store.set(path, BLUE)?.key).toBe('aurora')
    expect(newStore().get(path)?.key).toBe('aurora')
    expect(() => JSON.parse(readFileSync(recordFile(), 'utf8'))).not.toThrow()
  })

  it('skips a damaged entry without losing the others', () => {
    const good = deck('good.pptx')
    const bad = deck('bad.pptx')
    writeFileSync(
      recordFile(),
      JSON.stringify({
        version: 1,
        documents: {
          [canonicalPathKey(good)]: { kind: 'saved', key: 'Mine', adjustments: ['x', 3] },
          [canonicalPathKey(bad)]: { kind: 'unknown-kind', key: 'x', adjustments: [] },
          'C:\\nowhere\\junk.pptx': 'not an object',
        },
      }),
    )
    const store = newStore()
    expect(store.get(bad)).toBeNull()
    expect(store.get(good)).toMatchObject({ kind: 'saved', key: 'Mine', adjustments: ['x'] })
  })

  it('leaves no temporary file behind', () => {
    const store = newStore()
    for (let i = 0; i < 5; i++) store.set(deck(`d${i}.pptx`), BLUE)
    expect(readdirSync(userData)).toEqual([TEMPLATE_SELECTION_FILE])
  })

  describe('at most 2,000 documents', () => {
    it('names the cap', () => {
      expect(TEMPLATE_SELECTION_MAX_DOCUMENTS).toBe(2000)
    })

    it('drops the least recently used document when one more than the cap is written', () => {
      const documents: Record<string, unknown> = {}
      for (let i = 0; i < TEMPLATE_SELECTION_MAX_DOCUMENTS; i++) {
        documents[`C:\\decks\\deck-${i}.pptx`] = {
          kind: 'builtin',
          key: 'aurora',
          adjustments: [],
          updatedAt: 10 + i,
          usedAt: 10 + i,
        }
      }
      // the oldest by use is not the first in the file
      documents['C:\\decks\\deck-700.pptx'] = {
        kind: 'builtin',
        key: 'aurora',
        adjustments: [],
        updatedAt: 1,
        usedAt: 1,
      }
      writeFileSync(recordFile(), JSON.stringify({ version: 1, documents }))
      clock = 1_000_000
      const path = deck('new.pptx')
      newStore().set(path, BLUE)
      const after = JSON.parse(readFileSync(recordFile(), 'utf8')).documents as Record<
        string,
        unknown
      >
      expect(Object.keys(after)).toHaveLength(TEMPLATE_SELECTION_MAX_DOCUMENTS)
      expect(after['C:\\decks\\deck-700.pptx']).toBeUndefined()
      expect(after['C:\\decks\\deck-0.pptx']).toBeDefined()
      expect(after[canonicalPathKey(path)]).toBeDefined()
    })

    it('counts a read as a use', () => {
      const store = newStore(3)
      const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => deck(`${n}.pptx`)) as [
        string,
        string,
        string,
        string,
      ]
      for (const path of [a, b, c]) {
        clock += 10
        store.set(path, BLUE)
      }
      clock += TEMPLATE_SELECTION_TOUCH_INTERVAL_MS
      expect(store.get(a)?.key).toBe('aurora') // a is now the most recently used
      clock += 10
      store.set(d, BLUE)
      expect(store.get(b)).toBeNull() // b was the least recently used
      expect(store.get(a)?.key).toBe('aurora')
      expect(store.get(c)?.key).toBe('aurora')
      expect(store.get(d)?.key).toBe('aurora')
    })

    it('does not rewrite the file for every read of the same document', () => {
      const path = deck('a.pptx')
      const store = newStore()
      store.set(path, BLUE)
      const written = readFileSync(recordFile(), 'utf8')
      clock += TEMPLATE_SELECTION_TOUCH_INTERVAL_MS - 1
      expect(store.get(path)?.key).toBe('aurora')
      expect(readFileSync(recordFile(), 'utf8')).toBe(written)
      clock += 1
      expect(store.get(path)?.key).toBe('aurora')
      expect(readFileSync(recordFile(), 'utf8')).not.toBe(written)
    })

    it('never drops the document being written, even when the clock went backwards', () => {
      const store = newStore(2)
      clock = 9_000
      store.set(deck('a.pptx'), BLUE)
      store.set(deck('b.pptx'), BLUE)
      clock = 10
      const late = deck('c.pptx')
      store.set(late, { kind: 'saved', key: 'Mine' })
      expect(store.get(late)?.key).toBe('Mine')
    })
  })

  describe('when the document path changes', () => {
    it('copy writes the same content under the new path and keeps the original', () => {
      const from = deck('a.pptx')
      const to = deck('b.pptx')
      const store = newStore()
      clock = 2_000
      const stored = store.set(from, BLUE)
      clock = 3_000
      store.copy(from, to)
      expect(store.get(to)).toEqual(stored)
      expect(store.get(from)).toEqual(stored)
    })

    it('move leaves nothing under the old path', () => {
      const from = deck('a.pptx')
      const store = newStore()
      const stored = store.set(from, BLUE)
      const to = join(docs, 'renamed.pptx')
      renameSync(from, to)
      store.move(from, to)
      expect(store.get(to)).toEqual(stored)
      expect(store.get(from)).toBeNull()
      expect(Object.keys(JSON.parse(readFileSync(recordFile(), 'utf8')).documents)).toEqual([
        canonicalPathKey(to),
      ])
    })

    it('move follows a file into another folder', () => {
      const from = deck('a.pptx')
      const store = newStore()
      store.set(from, BLUE)
      mkdirSync(join(docs, 'sub'))
      const to = join(docs, 'sub', 'a.pptx')
      renameSync(from, to)
      store.move(from, to)
      expect(store.get(to)?.key).toBe('aurora')
      expect(store.get(from)).toBeNull()
    })

    it.runIf(process.platform === 'win32')('move follows a rename that only changes case', () => {
      const from = deck('report.pptx')
      const store = newStore()
      store.set(from, BLUE)
      const to = join(docs, 'Report.pptx')
      renameSync(from, to)
      // the caller's spelling of the old name need not be the one the record is under
      store.move(join(docs, 'REPORT.pptx'), to)
      expect(store.get(to)?.key).toBe('aurora')
      expect(Object.keys(JSON.parse(readFileSync(recordFile(), 'utf8')).documents)).toEqual([
        canonicalPathKey(to),
      ])
    })

    it('the later write wins when the new path already had a record', () => {
      const from = deck('a.pptx')
      const to = deck('b.pptx')
      const store = newStore()
      store.set(to, { kind: 'saved', key: 'Old one' })
      store.set(from, BLUE)
      store.copy(from, to)
      expect(store.get(to)?.key).toBe('aurora')
    })

    it('a document without a selection takes the place of one that had it: nothing is left to show', () => {
      const from = deck('a.pptx')
      const to = deck('b.pptx')
      const store = newStore()
      store.set(to, { kind: 'saved', key: 'Old one' })
      store.copy(from, to)
      expect(store.get(to)).toBeNull()
      store.set(to, { kind: 'saved', key: 'Old one' })
      store.move(from, to)
      expect(store.get(to)).toBeNull()
    })

    it('copying a document onto itself keeps its record', () => {
      const path = deck('a.pptx')
      const store = newStore()
      store.set(path, BLUE)
      store.copy(path, path)
      store.move(path, path)
      expect(store.get(path)?.key).toBe('aurora')
    })
  })
})

describe('TemplateSelectionMemory (a document as its window holds it)', () => {
  it('remembers an unsaved document only in memory', () => {
    const memory = newMemory()
    const doc = { path: '' }
    const other = { path: '' }
    clock = 4_000
    expect(memory.set(doc, BLUE)).toEqual({
      kind: 'builtin',
      key: 'aurora',
      adjustments: ['mostly blue'],
      updatedAt: 4_000,
    })
    expect(memory.get(doc)?.key).toBe('aurora')
    // another untitled window is another document
    expect(memory.get(other)).toBeNull()
    expect(existsSync(recordFile())).toBe(false)
    expect(memory.set(doc, { kind: 'bad' })?.key).toBe('aurora')
    expect(memory.set(doc, null)).toBeNull()
    expect(memory.get(doc)).toBeNull()
  })

  it('first save: what the window remembered is written under the new path', () => {
    const memory = newMemory()
    const doc = { path: '' }
    const stored = memory.set(doc, BLUE)
    const path = deck('first.pptx')
    doc.path = path
    memory.follow(doc, '', path)
    expect(memory.get(doc)).toEqual(stored)
    // on disk now: the next app start finds it
    expect(newStore().get(path)).toEqual(stored)
  })

  it('first save of a document without a selection does not inherit a deleted file’s record', () => {
    const memory = newMemory()
    const path = deck('reused-name.pptx')
    newStore().set(path, { kind: 'saved', key: 'From a file deleted long ago' })
    const doc = { path: '' }
    doc.path = path
    memory.follow(doc, '', path)
    expect(memory.get(doc)).toBeNull()
  })

  it('reads and writes a saved document under its path', () => {
    const memory = newMemory()
    const path = deck('a.pptx')
    const doc = { path }
    const stored = memory.set(doc, BLUE)
    expect(newStore().get(path)).toEqual(stored)
    // a second window on the same file sees the later write the next time it asks
    expect(memory.get({ path })).toEqual(stored)
    expect(memory.set(doc, null)).toBeNull()
    expect(newStore().get(path)).toBeNull()
  })

  it.each([
    ['Save As', 'copy.pptx'],
    ['the draft written after AI generation', 'draft.pptx'],
    ['a save by an external tool to another path', 'exported.pptx'],
  ])('%s: the same content under the new path, the original stays', (_name, file) => {
    const memory = newMemory()
    const from = deck('mine.pptx')
    const doc = { path: from }
    const stored = memory.set(doc, BLUE)
    const to = deck(file)
    memory.follow(doc, from, to)
    doc.path = to
    expect(memory.get(doc)).toEqual(stored)
    expect(newStore().get(from)).toEqual(stored)
    expect(newStore().get(to)).toEqual(stored)
  })

  it('AI generation that rebuilds the deck: the new document starts with what the old one had', () => {
    const memory = newMemory()
    const from = deck('mine.pptx')
    const old = { path: from }
    const stored = memory.set(old, BLUE)
    const replacement = { path: '' }
    memory.inherit(old, replacement)
    // the draft is not written yet
    expect(memory.get(replacement)).toEqual(stored)
    const draft = deck('draft.pptx')
    memory.follow(replacement, '', draft)
    replacement.path = draft
    expect(newStore().get(draft)).toEqual(stored)
    expect(newStore().get(from)).toEqual(stored)
  })

  it('AI generation in an unsaved document carries the selection to the draft', () => {
    const memory = newMemory()
    const old = { path: '' }
    const stored = memory.set(old, BLUE)
    const replacement = { path: '' }
    memory.inherit(old, replacement)
    memory.inherit(undefined, { path: '' })
    const draft = deck('draft.pptx')
    memory.follow(replacement, '', draft)
    replacement.path = draft
    expect(memory.get(replacement)).toEqual(stored)
  })

  it('rename or move inside the app: the record moves, nothing stays behind', () => {
    const memory = newMemory()
    const from = deck('a.pptx')
    const stored = memory.set({ path: from }, BLUE)
    const to = join(docs, 'b.pptx')
    renameSync(from, to)
    memory.moved(from, to)
    expect(memory.get({ path: to })).toEqual(stored)
    expect(memory.get({ path: from })).toBeNull()
  })

  it('a rename outside the app is not followed', () => {
    const memory = newMemory()
    const from = deck('a.pptx')
    memory.set({ path: from }, BLUE)
    const to = join(docs, 'b.pptx')
    renameSync(from, to)
    expect(memory.get({ path: to })).toBeNull()
  })

  it('does not replace a record file it could not read with a new one', () => {
    // a folder where the file should be stands in for a locked or unreadable file
    mkdirSync(recordFile())
    const path = deck('a.pptx')
    expect(() => newStore().set(path, BLUE)).toThrow()
    const memory = newMemory()
    expect(memory.get({ path })).toBeNull()
    expect(memory.set({ path }, BLUE)).toBeNull()
    expect(() => memory.follow({ path }, path, deck('b.pptx'))).not.toThrow()
    expect(() => memory.moved(path, deck('c.pptx'))).not.toThrow()
    expect(readdirSync(recordFile())).toEqual([])
  })

  it('never throws when the user-data folder cannot be written', () => {
    // a file where the folder should be: every write fails
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'x')
    const memory = new TemplateSelectionMemory(join(blocked, 'userData'), { now })
    const path = deck('a.pptx')
    const doc = { path }
    expect(() => memory.set(doc, BLUE)).not.toThrow()
    expect(memory.set(doc, BLUE)).toBeNull()
    expect(memory.get(doc)).toBeNull()
    expect(() => memory.follow(doc, path, deck('b.pptx'))).not.toThrow()
    expect(() => memory.moved(path, deck('c.pptx'))).not.toThrow()
    const unsaved = { path: '' }
    memory.set(unsaved, BLUE)
    expect(() => memory.follow(unsaved, '', path)).not.toThrow()
  })
})
