/**
 * Assembles the bridge docx from an `OdfToOoxmlContext` and reads parts of an
 * edited docx. The bridge docx opens with the docx engine's `parseDocx`; its
 * body elements are exactly `ctx.map.elements[*].xml`, in order, followed by
 * the final section properties.
 */
import JSZip from 'jszip'
import type { OdfToOoxmlContext } from './convert'
import { escapeXmlAttr } from './xml'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

/** Namespaces declared on the bridge document root. */
export const BRIDGE_DOCUMENT_NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
]

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}

/** `w:sectPr` for the default page layout of the ODT (A4 portrait when none). */
export function defaultSectPr(ctx: OdfToOoxmlContext): string {
  const styles = ctx.doc.styles
  const master = styles.masterPage('Standard') ?? styles.masterPages[0]
  const layout = master?.pageLayoutName ? styles.pageLayout(master.pageLayoutName) : undefined
  const p = layout?.properties['style:page-layout-properties'] ?? {}
  const tw = (v: string | undefined, d: number) => {
    const m = v ? /^([-+]?\d*\.?\d+)(cm|mm|in|pt)$/.exec(v.trim()) : null
    if (!m) return d
    const n = parseFloat(m[1])
    const f = m[2] === 'cm' ? 1440 / 2.54 : m[2] === 'mm' ? 1440 / 25.4 : m[2] === 'in' ? 1440 : 20
    return Math.round(n * f)
  }
  const w = tw(p['fo:page-width'], 11906)
  const h = tw(p['fo:page-height'], 16838)
  const orient = p['style:print-orientation'] === 'landscape' ? ' w:orient="landscape"' : ''
  return (
    `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"${orient}/>` +
    `<w:pgMar w:top="${tw(p['fo:margin-top'], 1440)}" w:right="${tw(p['fo:margin-right'], 1440)}" ` +
    `w:bottom="${tw(p['fo:margin-bottom'], 1440)}" w:left="${tw(p['fo:margin-left'], 1440)}" ` +
    'w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
  )
}

/** The word/document.xml of the bridge docx. */
export function bridgeDocumentXml(ctx: OdfToOoxmlContext): string {
  const ns = [...BRIDGE_DOCUMENT_NAMESPACES, ...ctx.docx.namespaces].join(' ')
  const body = ctx.map.elements.map((e) => e.xml).join('')
  return `${XML_DECL}<w:document ${ns}><w:body>${body}${ctx.docx.sectPr ?? defaultSectPr(ctx)}</w:body></w:document>`
}

/** Builds the bridge docx bytes from everything the converters accumulated. */
export async function buildBridgeDocx(ctx: OdfToOoxmlContext): Promise<Uint8Array> {
  const zip = new JSZip()
  const overrides = [
    [
      '/word/document.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    ],
    [
      '/word/styles.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    ],
    [
      '/word/numbering.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    ],
  ]
  const defaults = new Set(['rels', 'xml'])
  for (const part of ctx.docx.parts) {
    if (part.contentType) overrides.push([`/${part.path}`, part.contentType])
    else {
      const ext = /\.([A-Za-z0-9]+)$/.exec(part.path)?.[1]?.toLowerCase()
      if (ext && MEDIA_TYPES[ext]) defaults.add(ext)
    }
  }
  const defaultXml = [...defaults]
    .map((ext) =>
      ext === 'rels'
        ? '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        : ext === 'xml'
          ? '<Default Extension="xml" ContentType="application/xml"/>'
          : `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext]}"/>`,
    )
    .join('')
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaultXml}` +
      overrides
        .map(
          ([name, type]) => `<Override PartName="${escapeXmlAttr(name)}" ContentType="${type}"/>`,
        )
        .join('') +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      (ctx.docx.parts.some((p) => p.path === 'docProps/core.xml')
        ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        : '') +
      '</Relationships>',
  )
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...ctx.docx.relationships.map(
      (r) =>
        `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
    ),
  ]
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  )
  zip.file(
    'word/styles.xml',
    `${XML_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `${ctx.docx.docDefaults || '<w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>'}` +
      `${ctx.docx.styles.join('')}</w:styles>`,
  )
  zip.file(
    'word/numbering.xml',
    `${XML_DECL}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `${ctx.docx.abstractNums.join('')}${ctx.docx.nums.join('')}</w:numbering>`,
  )
  zip.file('word/document.xml', bridgeDocumentXml(ctx))
  for (const part of ctx.docx.parts) zip.file(part.path, part.data)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** Reads one part of a docx as text (null when missing). */
export async function readDocxPart(bytes: Uint8Array, path: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file(path)
  return file ? file.async('string') : null
}
