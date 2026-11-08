import type JSZip from 'jszip'
import { fileNames, loadArchive, readEntry, rewriteArchive } from './archive'
import { serializeSheets } from './content'
import { CONTENT_ENTRY, MANIFEST_ENTRY, THUMBNAIL_ENTRY } from './entry-names'
import { isResourceEntry } from './resource-entry'
import { checkContentStructure } from './structure-check'
import { isRecord, type XmindSheet } from './types'
import { sheetToView, type ViewSheet } from './view'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

export interface XmindSaveOptions {
  /**
   * A new preview picture (PNG) for a save that rewrites the file. Leave it out
   * when no picture could be made: the one in the file then stays. Anything that
   * is not a PNG counts as left out.
   */
  thumbnail?: Uint8Array | null
  /** timestamp for rewritten archive entries; the current time when left out */
  now?: Date
}

/**
 * A map file that opened. It holds the file's original bytes and the source
 * tree, and is the only thing that can produce bytes to save. A file that did
 * not open as `ok` never becomes a document, so there is nothing to save it
 * with.
 *
 * The class is not exported from the package: documents come from `openXmind`
 * and the create functions only.
 *
 * Changing the map means changing the source tree: edit `sheets` in place (the
 * objects are the live tree) or swap a sheet with `replaceSheet`, then call
 * `markChanged`. `save` rewrites `content.json` from the tree when the document
 * was marked, and also when the tree no longer serialises the way it did at the
 * baseline, so an edit nobody marked is still written. That comparison can only
 * ever err towards writing: two trees that serialise alike would be written
 * alike.
 */
export class XmindDocument {
  /** the whole file as last opened or saved */
  #baseline: Uint8Array
  /** `serializeSheets` of the tree at the baseline */
  #baselineContent: string
  #zip: JSZip
  #sheets: XmindSheet[]
  #marked = false
  /** picture entries a tool added and no save has written yet, by entry name */
  #added = new Map<string, Uint8Array>()
  /** "changed" was set only by adding picture entries, so taking them back makes it unchanged again */
  #addedMarked = false

  /** @internal Use `openXmind` or `createXmindDocument`. */
  constructor(baseline: Uint8Array, zip: JSZip, sheets: XmindSheet[], baselineContent: string) {
    this.#baseline = baseline
    this.#zip = zip
    this.#sheets = sheets
    this.#baselineContent = baselineContent
  }

  /**
   * The source tree: one entry per sheet, in file order. These are the live
   * objects, including every key the engine does not model.
   */
  get sheets(): XmindSheet[] {
    return this.#sheets
  }

  /** Puts another tree in a sheet's place and marks the document changed. */
  replaceSheet(index: number, sheet: XmindSheet): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.#sheets.length) {
      throw new Error(`xmind: there is no sheet ${index}`)
    }
    const check = checkContentStructure([sheet])
    if (!check.ok) throw new Error(`xmind: ${check.problem}`)
    this.#sheets[index] = sheet
    this.#marked = true
    this.#addedMarked = false
  }

  /** Records that the source tree was edited, so the next save rewrites `content.json`. */
  markChanged(): void {
    this.#marked = true
    this.#addedMarked = false
  }

  /**
   * Whether the next save writes a new file rather than the baseline's bytes.
   * True once marked; otherwise it compares the tree with the baseline, which
   * costs one serialisation of the tree.
   */
  get changed(): boolean {
    if (this.#marked) return true
    try {
      return serializeSheets(this.#sheets) !== this.#baselineContent
    } catch {
      return true
    }
  }

  /** The view data of every sheet, built fresh from the source tree. */
  viewSheets(): ViewSheet[] {
    return this.#sheets.map((sheet, index) => sheetToView(sheet, index))
  }

  /** Names of the files inside the archive, in archive order, then the picture entries added since. */
  get entryNames(): string[] {
    const names = fileNames(this.#zip)
    for (const name of this.#added.keys()) if (!names.includes(name)) names.push(name)
    return names
  }

  /**
   * The bytes of a file inside the archive (a picture, the preview), or null.
   * A picture entry added since the last save is answered from memory, so the
   * editor can draw it before the file is written.
   */
  readEntry(name: string): Promise<Uint8Array | null> {
    const pending = this.#added.get(name)
    if (pending) return Promise.resolve(new Uint8Array(pending))
    return readEntry(this.#zip, name)
  }

  /** Whether the archive (or a picture entry added since) holds this name. */
  hasEntry(name: string): boolean {
    return this.#added.has(name) || this.#zip.file(name) !== null
  }

  /**
   * Adds a picture entry the next save writes into the archive, and marks the
   * document changed. Only `resources/` entries: that is the one folder the
   * editor draws pictures from, and the only one a state may reference. The
   * name must not be used yet; the caller makes one (see `newXmindId`).
   */
  addEntry(name: string, bytes: Uint8Array): void {
    if (!isResourceEntry(name)) throw new Error(`xmind: ${name} is not a resources entry`)
    if (this.hasEntry(name)) throw new Error(`xmind: the archive already has ${name}`)
    if (bytes.byteLength === 0) throw new Error('xmind: an entry cannot be empty')
    if (!this.#marked) this.#addedMarked = true
    this.#added.set(name, new Uint8Array(bytes))
    this.#marked = true
  }

  /**
   * Drops a picture entry added since the last save (an edit that was then
   * refused). When adding it was the only change, the document is unchanged
   * again and the next save hands back the baseline bytes.
   */
  removeAddedEntry(name: string): void {
    if (!this.#added.delete(name)) return
    if (this.#addedMarked && this.#added.size === 0) {
      this.#addedMarked = false
      this.#marked = false
    }
  }

  /**
   * The bytes to write to disk.
   *
   * Unchanged: the baseline, byte for byte, whatever else was passed.
   * Changed: the same archive with `content.json` rewritten from the source
   * tree. Every other entry goes out as it came in, except the preview picture
   * when a new one is passed, the picture entries added since the last save,
   * and `manifest.json` when those entries have to be listed.
   *
   * The result becomes the new baseline, so the next save without further
   * edits returns these bytes again, and "the old picture" is then the one
   * written here. Throws instead of producing a file that would not open.
   */
  async save(options: XmindSaveOptions = {}): Promise<Uint8Array> {
    const content = this.#serialize()
    if (!this.#marked && content === this.#baselineContent) return new Uint8Array(this.#baseline)
    const check = checkContentStructure(this.#sheets)
    if (!check.ok) throw new Error(`xmind: cannot save, ${check.problem}`)

    const replacements = new Map<string, Uint8Array>()
    replacements.set(CONTENT_ENTRY, new TextEncoder().encode(content))
    if (isPng(options.thumbnail)) {
      replacements.set(THUMBNAIL_ENTRY, new Uint8Array(options.thumbnail))
    }
    for (const [name, bytes] of this.#added) replacements.set(name, bytes)
    const manifest = await this.#manifestWithAdded()
    if (manifest) replacements.set(MANIFEST_ENTRY, manifest)
    const saved = await rewriteArchive(this.#baseline, replacements, options.now ?? new Date())

    this.#zip = await loadArchive(saved)
    this.#baseline = saved
    this.#baselineContent = content
    this.#marked = false
    this.#added.clear()
    this.#addedMarked = false
    return new Uint8Array(saved)
  }

  /**
   * The manifest with this save's picture entries listed. A manifest the file
   * does not have, or one that is not the JSON object the format uses, is left
   * alone: guessing at its shape would break the file more than a picture the
   * reader has to find by its reference. `manifest.json` is otherwise never
   * rewritten, so an unchanged map keeps its bytes; this is the one case that
   * adds an entry (recorded in `docs/tracking/decisions/0070-*.md`).
   */
  async #manifestWithAdded(): Promise<Uint8Array | null> {
    if (this.#added.size === 0) return null
    const bytes = await readEntry(this.#zip, MANIFEST_ENTRY)
    if (!bytes) return null
    try {
      const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!isRecord(manifest)) return null
      const entries = manifest['file-entries']
      if (!isRecord(entries)) return null
      for (const name of this.#added.keys()) {
        if (!Object.hasOwn(entries, name)) entries[name] = {}
      }
      return new TextEncoder().encode(JSON.stringify(manifest))
    } catch {
      return null
    }
  }

  #serialize(): string {
    try {
      return serializeSheets(this.#sheets)
    } catch (error) {
      throw new Error('xmind: cannot save, the map cannot be written as JSON', { cause: error })
    }
  }
}

function isPng(bytes: Uint8Array | null | undefined): bytes is Uint8Array {
  return (
    bytes != null &&
    bytes.byteLength > PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  )
}
