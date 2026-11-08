/**
 * The note links (reading-assist spec 5.4): which Markdown note belongs to
 * which PDF, in one file `pdf-store/note-links.json`. Only the pdf editor's
 * main process reads and writes it.
 *
 * A link is keyed by the PDF's path, not by its content hash, so a note
 * survives every save that changes the hash. The hash is the fallback: a
 * copy or a moved file finds the most recent note of the same bytes.
 *
 * `notePath` only ever holds a path the person chose in a save dialog; the
 * main process opens only paths read from this file.
 */
import { resolve } from 'node:path'
import { isSegment } from './reading'

export const NOTE_LINKS_FILE = 'note-links.json'

export interface NoteLink {
  /** absolute path of the Markdown note */
  notePath: string
  /** content hash of the PDF when the link was last written or updated */
  docHash: string
  /** epoch ms of the last write */
  updatedAt: number
}

export interface NoteLinks {
  version: 1
  /** keyed by noteLinkKey(pdf path) */
  links: Record<string, NoteLink>
}

/** a link found for a PDF, and how it was found */
export interface FoundNoteLink extends NoteLink {
  /** the key of the link in NoteLinks.links */
  pdfKey: string
  matchedBy: 'path' | 'docHash'
}

/** the key of a PDF: its path.resolve()d path, lower-cased on Windows */
export function noteLinkKey(pdfPath: string, platform: NodeJS.Platform = process.platform): string {
  const full = resolve(pdfPath)
  return platform === 'win32' ? full.toLowerCase() : full
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** the readable links of a parsed file; anything else counts as no links */
export function asNoteLinks(raw: unknown): NoteLinks {
  // no prototype: a path key such as `__proto__` stays an ordinary entry
  const out: NoteLinks = { version: 1, links: Object.create(null) as NoteLinks['links'] }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.links)) return out
  for (const [key, link] of Object.entries(raw.links)) {
    if (!isRecord(link) || typeof link.notePath !== 'string' || link.notePath === '') continue
    if (!isSegment(link.docHash)) continue
    if (typeof link.updatedAt !== 'number' || !Number.isFinite(link.updatedAt)) continue
    out.links[key] = { notePath: link.notePath, docHash: link.docHash, updatedAt: link.updatedAt }
  }
  return out
}
