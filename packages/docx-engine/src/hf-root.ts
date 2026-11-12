// The root element a rewritten header/footer part ends up under. It follows
// from the part's own bytes, so the reader and the writer agree on it: a
// wrapper carried on the part's runs may use only the prefixes that root
// declares.
import { splitXmlChildren } from './generate'
import { partNamespaces, type PartNamespaces } from './inline-opaque'
import { WATERMARK_NS, isWatermarkChild } from './watermark'
import { findStartTag } from './xml-tag'

export type HfRootName = 'w:hdr' | 'w:ftr'

/** what the root of a header/footer part written anew declares */
export const HF_ROOT_ATTRS =
  ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  WATERMARK_NS
const HF_ROOT_NAMESPACES = partNamespaces(`<w:hdr${HF_ROOT_ATTRS}>`)

/**
 * The original part split at its root, when the rewritten part keeps that
 * root: it holds something besides text paragraphs (a table, a block control,
 * a paragraph with a drawing the text model does not carry), which stays as
 * its original bytes. Null when the part is written anew, root and all.
 */
export function hfKeptRoot(root: HfRootName, originalXml: string) {
  const rootTag = findStartTag(originalXml, root)
  const closeIdx = originalXml.lastIndexOf(`</${root}>`)
  if (!rootTag || closeIdx < 0) return null
  const { text: open, start: openIdx } = rootTag
  const children = splitXmlChildren(originalXml.slice(openIdx + open.length, closeIdx))
  // a text paragraph whose pictures are all inline blips is fully modelled
  // (the parser keeps them on its runs), so it is regenerated like any text
  const isModelledPictures = (xml: string) =>
    /<w:t[\s>]/.test(xml) &&
    !/<w:pict[\s>]|<w:object[\s>]|<wp:anchor[\s>]/.test(xml) &&
    (xml.match(/<w:drawing[\s>][\s\S]*?<\/w:drawing>/g) ?? []).every(
      (d) => d.includes('<wp:inline') && d.includes('<a:blip'),
    )
  const isProtectedPara = (xml: string) =>
    /<w:drawing[\s>]|<w:pict[\s>]|<w:object[\s>]/.test(xml) && !isModelledPictures(xml)
  const isTextPara = (c: { name: string; xml: string }) =>
    c.name === 'w:p' && !isWatermarkChild(c) && !isProtectedPara(c.xml)
  if (!children.some((c) => !isTextPara(c))) return null
  return { before: originalXml.slice(0, openIdx), open, children, isTextPara }
}

/**
 * The prefixes a wrapper on the part's runs may use: those of the original
 * root when the rewritten part keeps it (`kept`), else those of a root
 * written anew, each only while it means what it meant in the part the runs
 * were read from.
 */
export function hfWrapNamespaces(originalXml: string | null, kept: boolean): PartNamespaces {
  if (!originalXml) return HF_ROOT_NAMESPACES
  const original = partNamespaces(originalXml)
  if (kept) return original
  return new Map(
    [...HF_ROOT_NAMESPACES].filter(([prefix, uri]) => (original.get(prefix) ?? uri) === uri),
  )
}
