/**
 * Synthetic Word documents for the docx → ODT tests: raw OOXML parts zipped
 * with JSZip, shaped like what Word writes (styles with docDefaults, numbering,
 * footnotes, headers and footers, media).
 */
import JSZip from 'jszip'

export const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

export interface DocxSpec {
  /** inner XML of `w:body` (put the final `w:sectPr` last) */
  body: string
  /** `w:docDefaults` element */
  docDefaults?: string
  /** `w:style` elements */
  styles?: string
  /** inner XML of `w:numbering` */
  numbering?: string
  /** footnotes by id (separators are added) */
  footnotes?: Record<string, string>
  /** header/footer parts by relationship id */
  parts?: Record<string, { kind: 'header' | 'footer'; inner: string }>
  /** media by relationship id: `word/media/<name>` */
  media?: Record<string, { name: string; data: Uint8Array }>
  /** inner XML of `w:settings` */
  settings?: string
  /** extra parts (path → content) with their document relationships */
  extra?: Array<{ rId: string; type: string; path: string; data: string; contentType: string }>
}

export const DEFAULT_DOC_DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="맑은 고딕" w:hAnsi="Calibri" w:cs="Arial"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'

export const DEFAULT_STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>' +
  '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '</w:tblBorders></w:tblPr></w:style>'

/** A4 portrait, 1-inch margins, header/footer at 0.5 inch. */
export const sectPr = (inner = '', size = '<w:pgSz w:w="11906" w:h="16838"/>') =>
  `<w:sectPr>${inner}${size}<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`

export const p = (text: string, pPr = '', rPr = '') =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

/** An inline picture run (`wp:inline`) of the media relationship `rId`. */
export function pictureRun(rId: string, cx: number, cy: number, id = 1): string {
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  )
}

/** A chart run with no fallback picture (a `c:chart` reference). */
export function chartRun(cx: number, cy: number, id = 10): string {
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Chart ${id}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  )
}

/** A shape (`wps:wsp`) in `mc:AlternateContent`, optionally with a fallback picture. */
export function shapeRun(cx: number, cy: number, fallbackRId: string | null, id = 20): string {
  const choice =
    `<w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Shape ${id}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:spPr><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>'
  const fallback = fallbackRId
    ? `<w:pict><v:shape style="width:100pt;height:50pt"><v:imagedata r:id="${fallbackRId}" o:title=""/></v:shape></w:pict>`
    : '<w:pict><v:oval style="width:100pt;height:50pt"/></w:pict>'
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent></w:r>`
}

export async function buildDocx(spec: DocxSpec): Promise<Uint8Array> {
  const zip = new JSZip()
  const overrides: string[] = [
    `<Override PartName="/word/document.xml" ContentType="${CT}.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="${CT}.styles+xml"/>`,
  ]
  const rels: string[] = [`<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`]
  zip.file(
    'word/styles.xml',
    `${DECL}<w:styles ${W_NS}>${spec.docDefaults ?? DEFAULT_DOC_DEFAULTS}${spec.styles ?? DEFAULT_STYLES}</w:styles>`,
  )
  if (spec.numbering) {
    zip.file('word/numbering.xml', `${DECL}<w:numbering ${W_NS}>${spec.numbering}</w:numbering>`)
    overrides.push(`<Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/>`)
    rels.push(`<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`)
  }
  if (spec.footnotes) {
    const notes =
      '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
      '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
      Object.entries(spec.footnotes)
        .map(
          ([id, text]) =>
            `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`,
        )
        .join('')
    zip.file('word/footnotes.xml', `${DECL}<w:footnotes ${W_NS}>${notes}</w:footnotes>`)
    overrides.push(`<Override PartName="/word/footnotes.xml" ContentType="${CT}.footnotes+xml"/>`)
    rels.push(`<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`)
  }
  for (const [rId, part] of Object.entries(spec.parts ?? {})) {
    const file = `${part.kind}_${rId}.xml`
    const root = part.kind === 'header' ? 'w:hdr' : 'w:ftr'
    zip.file(`word/${file}`, `${DECL}<${root} ${W_NS}>${part.inner}</${root}>`)
    overrides.push(`<Override PartName="/word/${file}" ContentType="${CT}.${part.kind}+xml"/>`)
    rels.push(`<Relationship Id="${rId}" Type="${REL}/${part.kind}" Target="${file}"/>`)
  }
  for (const [rId, m] of Object.entries(spec.media ?? {})) {
    zip.file(`word/media/${m.name}`, m.data)
    rels.push(`<Relationship Id="${rId}" Type="${REL}/image" Target="media/${m.name}"/>`)
  }
  if (spec.settings) {
    zip.file('word/settings.xml', `${DECL}<w:settings ${W_NS}>${spec.settings}</w:settings>`)
    overrides.push(`<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>`)
    rels.push(`<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`)
  }
  for (const e of spec.extra ?? []) {
    zip.file(e.path, e.data)
    overrides.push(`<Override PartName="/${e.path}" ContentType="${e.contentType}"/>`)
    rels.push(
      `<Relationship Id="${e.rId}" Type="${e.type}" Target="${e.path.replace(/^word\//, '')}"/>`,
    )
  }
  zip.file(
    '[Content_Types].xml',
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      `${overrides.join('')}</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `${DECL}<w:document ${W_NS} xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${spec.body}</w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
