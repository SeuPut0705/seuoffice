/**
 * `w:sectPr` markup for the bridge docx, and carrying it in a paragraph.
 *
 * A non-final docx section ends with a `w:sectPr` inside the `w:pPr` of its
 * last paragraph. The text layer wrote that paragraph without one; the page
 * layer injects it, and on save strips it again (from the bridge element and
 * from the edited element alike) so the text layer compares paragraphs as if
 * no section break existed. `stripParagraphSectPr(injectParagraphSectPr(x, s))`
 * is exactly `x`.
 */
import type { PageGeometry } from './geometry'

export interface SectPrSpec {
  /** `w:headerReference` / `w:footerReference` elements */
  references: string[]
  continuous: boolean
  geometry: PageGeometry
  /** overrides the layout's columns (a `text:section`'s own columns) */
  columns?: { count: number; gap: number }
  pageNumber: { fmt?: string; start?: number }
  titlePg: boolean
}

/** A `w:sectPr` in CT_SectPr child order. */
export function buildSectPr(spec: SectPrSpec): string {
  const g = spec.geometry
  let out = '<w:sectPr>' + spec.references.join('')
  if (spec.continuous) out += '<w:type w:val="continuous"/>'
  out += `<w:pgSz w:w="${g.width}" w:h="${g.height}"${g.landscape ? ' w:orient="landscape"' : ''}/>`
  out +=
    `<w:pgMar w:top="${g.top}" w:right="${g.right}" w:bottom="${g.bottom}" w:left="${g.left}" ` +
    `w:header="${g.header}" w:footer="${g.footer}" w:gutter="0"/>`
  const { fmt, start } = spec.pageNumber
  if (fmt !== undefined || start !== undefined) {
    out += `<w:pgNumType${fmt !== undefined ? ` w:fmt="${fmt}"` : ''}${start !== undefined ? ` w:start="${start}"` : ''}/>`
  }
  const cols = spec.columns ?? { count: g.columns, gap: g.columnGap }
  if (cols.count > 1) out += `<w:cols w:num="${cols.count}" w:space="${cols.gap}"/>`
  if (spec.titlePg) out += '<w:titlePg/>'
  return out + '</w:sectPr>'
}

const SECT_PR = /<w:sectPr(?:\s[^>]*)?\/>|<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/

/** Puts `sectPr` into the paragraph's `w:pPr` (creating one when missing). */
export function injectParagraphSectPr(paragraphXml: string, sectPr: string): string {
  const open = /^<w:p(?:\s[^>]*)?>/.exec(paragraphXml)
  if (!open) return paragraphXml
  const at = open[0].length
  const rest = paragraphXml.slice(at)
  if (rest.startsWith('<w:pPr/>'))
    return `${paragraphXml.slice(0, at)}<w:pPr>${sectPr}</w:pPr>${rest.slice('<w:pPr/>'.length)}`
  if (/^<w:pPr[\s>]/.test(rest)) {
    const close = rest.indexOf('</w:pPr>')
    if (close >= 0)
      return paragraphXml.slice(0, at) + rest.slice(0, close) + sectPr + rest.slice(close)
  }
  return `${paragraphXml.slice(0, at)}<w:pPr>${sectPr}</w:pPr>${rest}`
}

/** The paragraph-level `w:sectPr` of a body element, or null. */
export function paragraphSectPr(xml: string): string | null {
  if (!/^<w:p[\s>]/.test(xml)) return null
  const pPr = /^<w:p(?:\s[^>]*)?><w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(xml)
  if (!pPr) return null
  return SECT_PR.exec(pPr[1])?.[0] ?? null
}

/** Removes the paragraph-level `w:sectPr` (and a `w:pPr` left empty by it). */
export function stripParagraphSectPr(xml: string): string {
  const sect = paragraphSectPr(xml)
  if (sect === null) return xml
  const at = xml.indexOf(sect)
  const out = xml.slice(0, at) + xml.slice(at + sect.length)
  return out.replace(/^(<w:p(?:\s[^>]*)?>)<w:pPr><\/w:pPr>/, '$1')
}

/** A `w:pPr` string without its `w:sectPr` (undefined when nothing else remains). */
export function stripPPrSectPr(pPr: string | undefined): string | undefined {
  if (pPr === undefined || !pPr.includes('<w:sectPr')) return pPr
  const out = pPr.replace(SECT_PR, '')
  return /^<w:pPr(?:\s[^>]*)?>\s*<\/w:pPr>$/.test(out) ? undefined : out
}
