/**
 * META-INF/manifest.xml: the listed parts and, above all, whether any part is
 * encrypted. A password-protected ODT marks its encrypted parts with
 * `manifest:encryption-data`; such a document is never opened.
 */
import { attributeMap, readRoot, walkElements } from './xml'

export interface OdtManifestEntry {
  fullPath: string
  mediaType: string | null
  version: string | null
  /** the entry carries `manifest:encryption-data` */
  encrypted: boolean
  /** source range of the `manifest:file-entry` element */
  start: number
  end: number
}

export interface OdtManifest {
  entries: OdtManifestEntry[]
  /** media type of the `/` entry (the package itself) */
  rootMediaType: string | null
  /** any entry is encrypted */
  encrypted: boolean
}

/** Reads the manifest leniently; a missing or unreadable manifest yields no entries. */
export function readManifest(xml: string | null | undefined): OdtManifest {
  const entries: OdtManifestEntry[] = []
  const root = xml ? readRoot(xml) : null
  if (!xml || !root) return { entries, rootMediaType: null, encrypted: false }
  let current: OdtManifestEntry | null = null
  walkElements(xml, root.prefixes, {
    open(el) {
      if (el.name === 'manifest:file-entry') {
        const a = attributeMap(xml, el.nameEnd, el.openEnd, root.prefixes)
        const entry: OdtManifestEntry = {
          fullPath: a['manifest:full-path'] ?? '',
          mediaType: a['manifest:media-type'] ?? null,
          version: a['manifest:version'] ?? null,
          encrypted: false,
          start: el.start,
          end: el.openEnd,
        }
        entries.push(entry)
        el.data = entry
        current = entry
      } else if (el.name === 'manifest:encryption-data' && current) {
        current.encrypted = true
      }
    },
    close(el) {
      const entry = el.data as OdtManifestEntry | undefined
      if (!entry) return
      entry.end = el.end
      if (current === entry) current = null
    },
  })
  return {
    entries,
    rootMediaType: entries.find((e) => e.fullPath === '/')?.mediaType ?? null,
    encrypted: entries.some((e) => e.encrypted),
  }
}
