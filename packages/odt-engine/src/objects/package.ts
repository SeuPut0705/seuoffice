/**
 * The objects layer's steps around a write-back, and the package changes it
 * hands to re-packing.
 *
 * Order (the assembling task calls these):
 *
 * ```ts
 * const rctx = new OoxmlToOdfContext(doc, map, edited, registry, options)
 * prepareObjectWriteBack(rctx) // before rebuildOdtBody
 * rebuildOdtBody(rctx)
 * updateOdtStyles(rctx)
 * const patches = rctx.finish()
 * const contentXml = applyTextPatches(doc.contentXml, patches['content.xml'])
 * const stylesXml = applyTextPatches(doc.stylesXml ?? '', patches['styles.xml'])
 * const changes = objectPackageChanges(rctx, { contentXml, stylesXml }) // after
 * // re-pack: drop changes.remove, add changes.add (stored or deflated like Pictures/),
 * // and write META-INF/manifest.xml = patchManifestXml(originalManifestXml, changes)
 * ```
 */
import type { OoxmlToOdfContext } from '../core/convert'
import { readManifest } from '../core/manifest'
import { decodeXmlEntities, escapeXmlAttr, readRoot } from '../core/xml'
import { hrefPath } from './analyze'
import { type AddedEntry, editedNote, noteKey, saveState } from './state'

/** Marks the bridge element of a paragraph as changed so the text layer rewrites it. */
function forceRewrite(rctx: OoxmlToOdfContext, paragraphId: number): void {
  const st = saveState(rctx)
  st.dirtyParagraphs.add(paragraphId)
  const own = rctx.map.elements.find((e) => e.paragraph === paragraphId)
  // a paragraph that is no element of its own (a table cell's): the tables of
  // its block are marked, and their owner asks `paragraphNeedsRewrite`
  const block = rctx.map.paragraphs[paragraphId]?.block ?? null
  const elements = own
    ? [own]
    : block === null
      ? []
      : rctx.map.elements.filter((e) => e.block === block && e.kind === 'table')
  for (const element of elements) {
    if (st.dirtyElements.some((d) => d.id === element.id)) continue
    st.dirtyElements.push({ id: element.id, xml: element.xml })
    rctx.map.elements[element.id] = { ...element, xml: `${element.xml}${REWRITE_MARK}` }
  }
}

/** Appended to a bridge element's XML so the flow hands it to its owner. */
export const REWRITE_MARK = '<!--odt-objects:rewrite-->'

/**
 * Before `rebuildOdtBody`: a note whose text the editor changed lives in
 * word/footnotes.xml, so its paragraph comes back unchanged and would be
 * copied verbatim. Such paragraphs are marked so the text layer rewrites them
 * (their note references then write the new note bodies). Also warns about
 * comment edits and new comments, which ODT documents do not save.
 *
 * For paragraphs that are not bridge elements (table cells) the tables of
 * their block are marked instead; the table layer then asks
 * `paragraphNeedsRewrite` for each cell paragraph.
 */
export function prepareObjectWriteBack(rctx: OoxmlToOdfContext): void {
  const st = saveState(rctx)
  if (st.prepared) return
  st.prepared = true
  for (const note of st.ext.notes) {
    const edited = editedNote(rctx, note.kind, note.id)
    if (edited && edited.text !== note.text) forceRewrite(rctx, note.paragraph)
  }
  for (const c of rctx.edited.comments ?? []) {
    const known = st.comments.get(c.id)
    if (!known) rctx.warn('dropped a new comment: ODT documents keep only their own comments')
    else if (c.text !== known.text) rctx.warn('comment edits are not saved into ODT documents')
  }
}

/**
 * Whether a paragraph record must be rewritten even though its OOXML came back
 * unchanged (a note in it changed). For owners whose paragraphs are not
 * bridge elements (table cells).
 */
export function paragraphNeedsRewrite(rctx: OoxmlToOdfContext, paragraphId: number): boolean {
  return saveState(rctx).dirtyParagraphs.has(paragraphId)
}

export interface OdtPackageChanges {
  /** new entries to write (each also needs a manifest entry) */
  add: AddedEntry[]
  /** entries nothing references any more (drop them and their manifest entries) */
  remove: string[]
}

/** Package paths named by any `*:href` of the final parts. */
function referencedPaths(parts: Array<string | null>): Set<string> {
  const out = new Set<string>()
  for (const xml of parts) {
    if (!xml) continue
    for (const m of xml.matchAll(/\s[\w.-]+:href\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const path = hrefPath(decodeXmlEntities(m[1] ?? m[2] ?? ''))
      if (path === null) continue
      out.add(path.replace(/\/$/, ''))
      try {
        out.add(decodeURIComponent(path).replace(/\/$/, ''))
      } catch {
        // not percent-encoded
      }
    }
  }
  return out
}

/**
 * After the patches are applied: the package entries to add (new pictures
 * still referenced) and to remove (entries pictures and objects referenced
 * that nothing references any more). Only entries the bridge recorded for
 * pictures and objects are ever removed. Restores the bridge map changed by
 * `prepareObjectWriteBack`.
 */
export function objectPackageChanges(
  rctx: OoxmlToOdfContext,
  final: { contentXml: string; stylesXml: string | null },
): OdtPackageChanges {
  const st = saveState(rctx)
  for (const d of st.dirtyElements)
    rctx.map.elements[d.id] = { ...rctx.map.elements[d.id], xml: d.xml }
  st.dirtyElements = []
  for (const note of st.ext.notes) {
    const edited = editedNote(rctx, note.kind, note.id)
    if (edited && edited.text !== note.text && !st.emittedNotes.has(noteKey(note.kind, note.id)))
      rctx.warn('a changed note could not be written back; it keeps its original text')
  }
  const referenced = referencedPaths([final.contentXml, final.stylesXml])
  const isReferenced = (entry: string) => {
    const path = entry.replace(/\/$/, '')
    if (referenced.has(path)) return true
    for (const r of referenced) if (path.startsWith(`${r}/`)) return true
    return false
  }
  const candidates = new Set<string>()
  for (const p of st.ext.pictures) for (const e of p.entries) candidates.add(e)
  for (const p of st.ext.placeholders) for (const e of p.entries) candidates.add(e)
  return {
    add: st.added.filter((a) => isReferenced(a.path)),
    remove: [...candidates].filter((e) => !isReferenced(e)).sort(),
  }
}

/**
 * The manifest with the package changes applied: removed entries' elements
 * cut out, new entries appended before the root's end tag; everything else
 * byte for byte.
 */
export function patchManifestXml(manifestXml: string, changes: OdtPackageChanges): string {
  if (!changes.add.length && !changes.remove.length) return manifestXml
  const manifest = readManifest(manifestXml)
  const remove = new Set(changes.remove)
  const cuts = manifest.entries
    .filter((e) => remove.has(e.fullPath))
    .sort((a, b) => b.start - a.start)
  let out = manifestXml
  for (const e of cuts) out = out.slice(0, e.start) + out.slice(e.end)
  const present = new Set(manifest.entries.map((e) => e.fullPath))
  const added = changes.add.filter((a) => !present.has(a.path))
  if (!added.length) return out
  const tag = readRoot(out)?.tag ?? null
  const prefix = tag && tag.includes(':') ? `${tag.split(':')[0]}:` : 'manifest:'
  const xml = added
    .map(
      (a) =>
        `<${prefix}file-entry ${prefix}full-path="${escapeXmlAttr(a.path)}" ${prefix}media-type="${escapeXmlAttr(a.mediaType)}"/>`,
    )
    .join('')
  const close = tag ? out.lastIndexOf(`</${tag}>`) : -1
  if (close < 0) return out + xml
  return out.slice(0, close) + xml + out.slice(close)
}
