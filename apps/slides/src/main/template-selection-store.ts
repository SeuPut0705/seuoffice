/**
 * Per-document memory of the chosen design template, on this PC only: one JSON
 * file in the user-data folder, keyed by the document's canonical path (the
 * same key the per-document chat history uses, so a symlink or another case
 * spelling of a path lands on the same document). Nothing is written into a
 * .pptx or beside it.
 *
 * No Electron here: the user-data folder is a constructor argument.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '@genoffice/electron-utils/atomic-write'
import { canonicalPathKey } from '@genoffice/project-store'
import { normalizeTemplateSelection, type TemplateSelection } from '../shared/template-selection'

/** The record file, directly in the user-data folder */
export const TEMPLATE_SELECTION_FILE = 'slides-template-selections.json'
/** Documents remembered at most; beyond it the least recently used are dropped (tunable default) */
export const TEMPLATE_SELECTION_MAX_DOCUMENTS = 2000
/** A read counts as a use, but rewrites the file at most this often per document */
export const TEMPLATE_SELECTION_TOUCH_INTERVAL_MS = 60_000

export interface TemplateSelectionStoreOptions {
  maxDocuments?: number
  /** The clock, for tests */
  now?: () => number
}

/** A stored record: the selection plus when it was last read or written (what the cap goes by) */
interface StoredSelection extends TemplateSelection {
  usedAt: number
}

type Documents = Map<string, StoredSelection>

function selectionOf(entry: StoredSelection): TemplateSelection {
  return {
    kind: entry.kind,
    key: entry.key,
    adjustments: [...entry.adjustments],
    updatedAt: entry.updatedAt,
  }
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** One entry of the file, or null when it is not a record this version can read */
function storedSelectionOf(value: unknown): StoredSelection | null {
  const selection = normalizeTemplateSelection(value, 0)
  if (!selection) return null
  const raw = value as { updatedAt?: unknown; usedAt?: unknown }
  const updatedAt = finiteOr(raw.updatedAt, 0)
  return { ...selection, updatedAt, usedAt: finiteOr(raw.usedAt, updatedAt) }
}

/**
 * The key a document's record is under, also when it was written under the
 * path as given (a path that did not resolve at the time).
 */
function findKey(documents: Documents, filePath: string): string | undefined {
  const key = canonicalPathKey(filePath)
  if (documents.has(key)) return key
  for (const alt of [filePath, filePath.normalize('NFC')]) {
    if (alt !== key && documents.has(alt)) return alt
  }
  return undefined
}

export class TemplateSelectionStore {
  private readonly filePath: string
  private readonly maxDocuments: number
  readonly now: () => number

  constructor(userDataDir: string, options: TemplateSelectionStoreOptions = {}) {
    this.filePath = join(userDataDir, TEMPLATE_SELECTION_FILE)
    this.maxDocuments = options.maxDocuments ?? TEMPLATE_SELECTION_MAX_DOCUMENTS
    this.now = options.now ?? Date.now
  }

  /** What is stored for the document, exactly as stored; null when nothing is. Counts as a use. */
  get(filePath: string): TemplateSelection | null {
    const documents = this.read()
    const found = findKey(documents, filePath)
    if (found === undefined) return null
    const entry = documents.get(found)!
    const key = canonicalPathKey(filePath)
    const now = this.now()
    // also rewritten when the record is still under an earlier spelling of the path
    if (found !== key || now - entry.usedAt >= TEMPLATE_SELECTION_TOUCH_INTERVAL_MS) {
      documents.delete(found)
      documents.set(key, { ...entry, usedAt: now })
      try {
        this.write(documents, key)
      } catch {
        // reading still works when the folder cannot be written
      }
    }
    return selectionOf(entry)
  }

  /**
   * Remember `input` for the document, or forget the document on null. Input
   * that is not a selection is ignored. Returns what is stored afterwards.
   */
  set(filePath: string, input: unknown): TemplateSelection | null {
    if (input === null) {
      this.put(filePath, null)
      return null
    }
    const selection = normalizeTemplateSelection(input, this.now())
    if (!selection) {
      const documents = this.read()
      const found = findKey(documents, filePath)
      return found === undefined ? null : selectionOf(documents.get(found)!)
    }
    this.put(filePath, selection)
    return selection
  }

  /** Write an already normalized record as it is (its `updatedAt` included), or remove the document's on null. */
  put(filePath: string, selection: TemplateSelection | null): void {
    const documents = this.read()
    const found = findKey(documents, filePath)
    // forgetting a document that has no record must not create or rewrite the file
    if (!selection && found === undefined) return
    if (found !== undefined) documents.delete(found)
    const key = canonicalPathKey(filePath)
    if (selection) documents.set(key, { ...selection, usedAt: this.now() })
    this.write(documents, key)
  }

  /**
   * The document is also at `toPath` now (Save As, a draft copy): the same
   * record is written there and the one under `fromPath` stays.
   */
  copy(fromPath: string, toPath: string): void {
    this.transfer(fromPath, toPath, false)
  }

  /** The file went from `fromPath` to `toPath` (rename, move): nothing stays under the old path. */
  move(fromPath: string, toPath: string): void {
    this.transfer(fromPath, toPath, true)
  }

  /**
   * After this the record under `toPath` is what `fromPath` had, which removes
   * a record a file replaced at `toPath` left behind when `fromPath` has none.
   */
  private transfer(fromPath: string, toPath: string, removeSource: boolean): void {
    const documents = this.read()
    const toKey = canonicalPathKey(toPath)
    const fromKey = findKey(documents, fromPath)
    if (fromKey === toKey) return
    if (canonicalPathKey(fromPath) === toKey) {
      // Both paths are one file (a rename that only changes case, a save onto
      // itself): the record may still be under the earlier spelling.
      const folded = toKey.toLowerCase()
      const earlier =
        fromKey ??
        findKey(documents, toPath) ??
        [...documents.keys()].find(
          (key) => key.toLowerCase() === folded && canonicalPathKey(key) === toKey,
        )
      if (earlier === undefined || earlier === toKey) return
      const entry = documents.get(earlier)!
      documents.delete(earlier)
      documents.set(toKey, entry)
      this.write(documents, toKey)
      return
    }
    const entry = fromKey === undefined ? undefined : documents.get(fromKey)
    const displaced = findKey(documents, toPath)
    if (!entry && displaced === undefined) return
    if (displaced !== undefined) documents.delete(displaced)
    if (removeSource && fromKey !== undefined) documents.delete(fromKey)
    if (entry) documents.set(toKey, { ...entry, usedAt: this.now() })
    this.write(documents, toKey)
  }

  /**
   * A missing or corrupt file reads as no records; an entry that does not
   * validate is skipped. A file that is there but cannot be read right now (a
   * lock, a permission) throws instead: reading it as empty would let the next
   * write replace every document's record with one.
   */
  private read(): Documents {
    const documents: Documents = new Map()
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return documents
      throw err
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return documents
    }
    const stored = (raw as { documents?: unknown } | null)?.documents
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return documents
    for (const [key, value] of Object.entries(stored)) {
      const entry = storedSelectionOf(value)
      if (entry) documents.set(key, entry)
    }
    return documents
  }

  /** Atomic (temp file, then rename). Over the cap, the least recently used go, never `keep`. */
  private write(documents: Documents, keep: string): void {
    const excess = documents.size - this.maxDocuments
    if (excess > 0) {
      const oldestFirst = [...documents]
        .filter(([key]) => key !== keep)
        .sort((a, b) => a[1].usedAt - b[1].usedAt)
      for (const [key] of oldestFirst.slice(0, excess)) documents.delete(key)
    }
    writeJsonAtomic(this.filePath, { version: 1, documents: Object.fromEntries(documents) })
  }
}

/** A document as its window holds it: `path` is '' until it has been saved. */
export interface TemplateSelectionDocument {
  path: string
}

/**
 * The store as the editor uses it: a saved document is remembered on disk
 * under its path, one that has no path yet only in memory, for as long as its
 * window holds it. Nothing here throws: a failed write costs the memory of one
 * document, never a save or an IPC call.
 */
export class TemplateSelectionMemory {
  readonly store: TemplateSelectionStore
  private readonly unsaved = new WeakMap<TemplateSelectionDocument, TemplateSelection>()

  constructor(userDataDir: string, options: TemplateSelectionStoreOptions = {}) {
    this.store = new TemplateSelectionStore(userDataDir, options)
  }

  get(doc: TemplateSelectionDocument): TemplateSelection | null {
    try {
      return doc.path ? this.store.get(doc.path) : (this.unsaved.get(doc) ?? null)
    } catch (err) {
      console.warn('[slides] template selection not read:', err)
      return null
    }
  }

  /** Remember `input` (null forgets; anything that is not a selection is ignored). Returns what is remembered afterwards. */
  set(doc: TemplateSelectionDocument, input: unknown): TemplateSelection | null {
    try {
      if (doc.path) return this.store.set(doc.path, input)
      if (input === null) this.unsaved.delete(doc)
      else {
        const selection = normalizeTemplateSelection(input, this.store.now())
        if (selection) this.unsaved.set(doc, selection)
      }
      return this.unsaved.get(doc) ?? null
    } catch (err) {
      console.warn('[slides] template selection not written:', err)
      return this.get(doc)
    }
  }

  /**
   * The document is re-pointed from `fromPath` to `toPath` (first save, Save
   * As, the draft written after AI generation, a save by an external tool):
   * what it has is written under `toPath`, and a record under `fromPath`
   * stays. `fromPath` is '' for a document that was never saved, whose record
   * lived in memory until now.
   */
  follow(doc: TemplateSelectionDocument, fromPath: string, toPath: string): void {
    try {
      if (!toPath || fromPath === toPath) return
      if (fromPath) {
        this.store.copy(fromPath, toPath)
        return
      }
      const remembered = this.unsaved.get(doc) ?? null
      this.unsaved.delete(doc)
      this.store.put(toPath, remembered)
    } catch (err) {
      console.warn('[slides] template selection did not follow the document:', err)
    }
  }

  /**
   * A new document object takes the place of `previous` in its window (AI
   * generation rebuilds the deck and has no path until its draft is written):
   * it starts with what the old one had.
   */
  inherit(
    previous: TemplateSelectionDocument | undefined,
    replacement: TemplateSelectionDocument,
  ): void {
    if (!previous || replacement.path) return
    const selection = this.get(previous)
    if (selection) this.unsaved.set(replacement, selection)
  }

  /** The file was renamed or moved inside the app: the record moves, nothing stays under the old path. */
  moved(oldPath: string, newPath: string): void {
    try {
      this.store.move(oldPath, newPath)
    } catch (err) {
      console.warn('[slides] template selection did not follow the rename:', err)
    }
  }
}
