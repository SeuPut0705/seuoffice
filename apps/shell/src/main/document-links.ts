/**
 * Provenance records (spec 9): "this document was made from these files".
 *
 * - Kept in the app data folder's `document-links.json`, never inside a
 *   document file. The records live on this PC only; a file copied to another
 *   PC carries no link.
 * - A record is written when a tab that was handed materials (an AI run that
 *   started with at least one handed-over material attached, or a conversion
 *   without AI) has its document saved for the first time. Both must have
 *   happened, in either order. A tab saved by hand without any of that, a tab
 *   closed unsaved, and a later Save As to another path write nothing.
 * - One record per made document (`derived` never repeats); a source may
 *   appear in many records. The request text is never stored: the events this
 *   module reads carry no text, and a record has no field for one.
 * - A rename or move inside the app follows both `derived` and `sources`.
 *   Missing files are never removed from the records here.
 * - Writes replace the whole file through a temporary file (the same helper
 *   the recents and stars use). A file that cannot be read or parsed reads as
 *   no records; it is left as it is until the next record is written, which
 *   replaces it.
 *
 * No Electron import: the shell wires it (index.ts), the tests run it as is.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { writeJsonAtomic } from '@genoffice/electron-utils/atomic-write'
import {
  generateConvertedEvents,
  generateRunStartedEvents,
  setGenerateTabIdResolver,
} from '@genoffice/electron-utils/generate-handoff'

export const DOCUMENT_LINKS_FILE = 'document-links.json'

export type DocumentLinkVia = 'ai' | 'convert'

export interface DocumentLink {
  /** absolute path of the document that was made */
  derived: string
  /** absolute paths of the handed-over materials */
  sources: string[]
  /** ISO 8601 time the record was written */
  createdAt: string
  via: DocumentLinkVia
}

export interface DocumentLinksFile {
  version: 1
  links: DocumentLink[]
}

/** "something was made in this tab from these files", as the hand-off store records it */
export interface MakeEvent {
  webContentsId: number
  mode: DocumentLinkVia
  sources: readonly string[]
  /** ms since epoch */
  at: number
}

/** the part of a webContents the tracker needs (Electron's satisfies it) */
export interface LinkedWebContents {
  readonly id: number
  once(event: 'destroyed', listener: () => void): unknown
}

export interface DocumentLinksDeps {
  /** the stored records; a missing or broken file is no records */
  load(): DocumentLink[]
  /** replace the stored file with these records (atomically) */
  save(file: DocumentLinksFile): void
  /** the hand-off store's run-started and converted events */
  events(): MakeEvent[]
  now(): Date
}

/** the key two paths are compared by: resolved, and case-blind on Windows */
export function linkPathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((p) => typeof p === 'string' && p !== '')
}

function validLink(value: unknown): DocumentLink | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.derived !== 'string' || v.derived === '') return null
  if (!isStringList(v.sources) || v.sources.length === 0) return null
  if (typeof v.createdAt !== 'string') return null
  if (v.via !== 'ai' && v.via !== 'convert') return null
  return { derived: v.derived, sources: [...v.sources], createdAt: v.createdAt, via: v.via }
}

/**
 * The records in a file's text. Anything that is not the expected shape reads
 * as no records; a single malformed record is skipped, and a repeated
 * `derived` keeps its last record.
 */
export function parseDocumentLinks(text: string): DocumentLink[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const links = (raw as { links?: unknown }).links
  if (!Array.isArray(links)) return []
  const byDerived = new Map<string, DocumentLink>()
  for (const entry of links) {
    const link = validLink(entry)
    if (!link) continue
    const key = linkPathKey(link.derived)
    byDerived.delete(key)
    byDerived.set(key, link)
  }
  return [...byDerived.values()]
}

/** read the records file; missing or unreadable is no records */
export function readDocumentLinksFile(path: string): DocumentLink[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return parseDocumentLinks(text)
}

/** the hand-off store's events in the shape the join reads */
export function handoffStoreEvents(): MakeEvent[] {
  return [
    ...generateRunStartedEvents().map((e) => ({
      webContentsId: e.webContentsId,
      mode: 'ai' as const,
      // the record lists the materials handed over, not only those still attached (9)
      sources: e.handedOver,
      at: e.at,
    })),
    ...generateConvertedEvents().map((e) => ({
      webContentsId: e.webContentsId,
      mode: 'convert' as const,
      sources: e.sources,
      at: e.at,
    })),
  ]
}

/**
 * The hand-off store asks the shell for a tab id each time it records a run
 * start or a conversion, right before the record goes in. Answer as before
 * and look at the records once that one is in.
 */
export function watchMakeEvents(
  tabIdFor: (webContentsId: number) => string | undefined,
  onEvent: () => void,
): void {
  setGenerateTabIdResolver((webContentsId) => {
    queueMicrotask(onEvent)
    return tabIdFor(webContentsId)
  })
}

/**
 * Whether a path a tab just got is a document saved there now, not an
 * existing file opened into the tab: not on disk yet (the save is about to
 * write it), or born within the last few seconds.
 */
export function isFreshlySavedPath(
  path: string,
  nowMs: number,
  stat: (path: string) => { birthtimeMs: number; mtimeMs: number } = statSync,
): boolean {
  try {
    const s = stat(path)
    const born = s.birthtimeMs || s.mtimeMs
    return born >= nowMs - FRESH_WINDOW_MS
  } catch {
    return true
  }
}

const FRESH_WINDOW_MS = 10_000

interface TrackedTab {
  /** the path of the first save, following renames; null when the first path was not a save */
  path: string | null
  recorded: boolean
}

export class DocumentLinks {
  readonly #deps: DocumentLinksDeps
  #links: DocumentLink[] | null = null
  readonly #tabs = new Map<number, TrackedTab>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  constructor(deps: DocumentLinksDeps) {
    this.#deps = deps
  }

  /** bumps whenever the records change (menus compare it) */
  get version(): number {
    return this.#version
  }

  #all(): DocumentLink[] {
    this.#links ??= this.#deps.load()
    return this.#links
  }

  /** a copy of every record */
  links(): DocumentLink[] {
    return this.#all().map((l) => ({ ...l, sources: [...l.sources] }))
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * A tab's document got a path. Only the first one counts: a later Save As
   * to another path is not where the record goes. `fresh: false` says the
   * path is an existing file opened into the tab, not a save; such a tab is
   * never recorded.
   */
  noteTabPath(contents: LinkedWebContents, path: string, options?: { fresh?: boolean }): void {
    if (this.#tabs.has(contents.id)) return
    const fresh = options?.fresh ?? true
    this.#tabs.set(contents.id, { path: fresh ? resolve(path) : null, recorded: false })
    contents.once('destroyed', () => this.#tabs.delete(contents.id))
    this.sync()
  }

  /**
   * Write the records that are due: every tracked tab that has its first
   * saved path and a make event, and no record yet. Returns whether anything
   * was written.
   */
  sync(): boolean {
    const pending = [...this.#tabs].filter(([, t]) => t.path && !t.recorded)
    if (pending.length === 0) return false
    const events = this.#deps.events()
    let changed = false
    for (const [wcId, tab] of pending) {
      const event = events.filter((e) => e.webContentsId === wcId).sort((a, b) => a.at - b.at)[0]
      if (!event) continue
      tab.recorded = true
      const derived = tab.path!
      const derivedKey = linkPathKey(derived)
      const seen = new Set<string>()
      const sources: string[] = []
      for (const source of event.sources) {
        if (typeof source !== 'string' || source === '') continue
        const key = linkPathKey(source)
        if (key === derivedKey || seen.has(key)) continue
        seen.add(key)
        sources.push(resolve(source))
      }
      if (sources.length === 0) continue
      const kept = this.#all().filter((l) => linkPathKey(l.derived) !== derivedKey)
      kept.push({
        derived,
        sources,
        createdAt: this.#deps.now().toISOString(),
        via: event.mode,
      })
      this.#links = kept
      changed = true
    }
    if (changed) this.#commit()
    return changed
  }

  /** a file was renamed or moved inside the app: records and tracked tabs follow */
  fileMoved(oldPath: string, newPath: string): void {
    const oldKey = linkPathKey(oldPath)
    const next = resolve(newPath)
    for (const tab of this.#tabs.values()) {
      if (tab.path && linkPathKey(tab.path) === oldKey) tab.path = next
    }
    let changed = false
    let movedDerived = -1
    const moved = this.#all().map((link, i) => {
      const derivedMoved = linkPathKey(link.derived) === oldKey
      const sourcesMoved = link.sources.some((s) => linkPathKey(s) === oldKey)
      if (!derivedMoved && !sourcesMoved) return link
      changed = true
      if (derivedMoved) movedDerived = i
      return {
        ...link,
        derived: derivedMoved ? next : link.derived,
        sources: link.sources.map((s) => (linkPathKey(s) === oldKey ? next : s)),
      }
    })
    if (!changed) return
    // a made document moved onto another one's path: one record per path, the moved one
    const nextKey = linkPathKey(next)
    this.#links =
      movedDerived < 0
        ? moved
        : moved.filter((link, i) => i === movedDerived || linkPathKey(link.derived) !== nextKey)
    this.#commit()
  }

  /** the sources of the document at `path`, when it is a made document */
  sourcesOf(path: string): string[] {
    const key = linkPathKey(path)
    const link = this.#all().find((l) => linkPathKey(l.derived) === key)
    return link ? [...link.sources] : []
  }

  /** the documents made from `path`, oldest record first */
  derivedFrom(path: string): string[] {
    const key = linkPathKey(path)
    return this.#all()
      .filter((l) => l.sources.some((s) => linkPathKey(s) === key))
      .map((l) => l.derived)
  }

  /** every path the records and the tracked tabs mention (folder moves re-key them) */
  paths(): string[] {
    const all = new Map<string, string>()
    const add = (path: string) => {
      if (!all.has(linkPathKey(path))) all.set(linkPathKey(path), path)
    }
    for (const link of this.#all()) [link.derived, ...link.sources].forEach(add)
    for (const tab of this.#tabs.values()) if (tab.path && !tab.recorded) add(tab.path)
    return [...all.values()]
  }

  #commit(): void {
    this.#version += 1
    try {
      this.#deps.save({ version: 1, links: this.links() })
    } catch (error) {
      console.warn('[document-links] could not write the records:', error)
    }
    for (const listener of this.#listeners) listener()
  }
}

/** the records kept in `filePath`, written like the other state files */
export function documentLinksAt(filePath: string): DocumentLinks {
  return new DocumentLinks({
    load: () => readDocumentLinksFile(filePath),
    save: (file) => writeJsonAtomic(filePath, file),
    events: handoffStoreEvents,
    now: () => new Date(),
  })
}

/** one entry of a "View Sources" / "Documents Made from This" list */
export interface LinkMenuEntry {
  path: string
  name: string
  /** not on disk: drawn dimmed and not clickable */
  missing: boolean
}

export interface DocumentLinkMenuModel {
  sources: LinkMenuEntry[]
  derived: LinkMenuEntry[]
}

/** what the File menu shows for the open document; nothing for an unsaved one */
export function documentLinkMenuModel(
  filePath: string | undefined,
  links: Pick<DocumentLinks, 'sourcesOf' | 'derivedFrom'>,
  exists: (path: string) => boolean,
): DocumentLinkMenuModel {
  if (!filePath) return { sources: [], derived: [] }
  const entry = (path: string): LinkMenuEntry => ({
    path,
    name: basename(path),
    missing: !exists(path),
  })
  return {
    sources: links.sourcesOf(filePath).map(entry),
    derived: links.derivedFrom(filePath).map(entry),
  }
}
