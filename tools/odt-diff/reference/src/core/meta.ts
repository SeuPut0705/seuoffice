/**
 * The producing application, from meta.xml's `meta:generator`. Hancom writes
 * `hwp/hangul/13, 0, 0, 711/Windows_10` (desktop) or
 * `hwp/hangul/11, 0, 0, 65535/NAME="Red_Hat_Enterprise_Linux_Server"`
 * (the government server converter).
 */
import { decodeXmlEntities, readRoot, walkElements } from './xml'

export type OdtProducer =
  | 'hancom'
  | 'libreoffice'
  | 'openoffice'
  | 'ms-word'
  | 'google-docs'
  | 'polaris'
  /** a generator string none of the above */
  | 'other'
  /** no generator recorded */
  | 'unknown'

export interface OdtGenerator {
  /** `meta:generator` text, decoded and trimmed; null when absent */
  name: string | null
  producer: OdtProducer
}

/** Names the producer of a generator string. */
export function classifyGenerator(name: string | null): OdtProducer {
  if (!name) return 'unknown'
  if (/^hwp\/|hancom|hangul/i.test(name)) return 'hancom'
  if (/libreoffice/i.test(name)) return 'libreoffice'
  if (/openoffice|staroffice/i.test(name)) return 'openoffice'
  if (/microsoft/i.test(name)) return 'ms-word'
  if (/google/i.test(name)) return 'google-docs'
  if (/polaris/i.test(name)) return 'polaris'
  return 'other'
}

/** Reads `meta:generator` from meta.xml (missing part or element: `unknown`). */
export function detectGenerator(metaXml: string | null | undefined): OdtGenerator {
  const root = metaXml ? readRoot(metaXml) : null
  if (!metaXml || !root) return { name: null, producer: 'unknown' }
  let name: string | null = null
  walkElements(metaXml, root.prefixes, {
    open() {},
    close(el) {
      if (el.name !== 'meta:generator') return
      const inner = metaXml.slice(el.openEnd, el.closeStart).replace(/<[^>]*>/g, '')
      name = decodeXmlEntities(inner).trim() || null
      return 'stop'
    },
  })
  return { name, producer: classifyGenerator(name) }
}
