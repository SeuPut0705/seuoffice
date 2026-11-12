import { mergeRuns } from '../../src/parse-props'
import type { GenerateContext } from '../../src/generate'
import type { Run } from '../../src/types'
import { buildDocx, type BuildDocxOptions } from './build-docx'

/** one text run, optionally with run properties */
export const T = (text: string, rPr = ''): string =>
  `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`

/** the xml with every text run reduced to [its text]: what sits around the runs stays visible */
export const skeleton = (xml: string): string =>
  xml.replace(
    /<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:(?:t|delText)[^>]*>([^<]*)<\/w:(?:t|delText)><\/w:r>/g,
    '[$1]',
  )

export const count = (xml: string, needle: string): number => xml.split(needle).length - 1

/** a generate context with predictable ids */
export function genCtx(): GenerateContext {
  let rel = 900
  let rev = 700
  return {
    headingStyleIds: new Map(),
    allocateHyperlinkRel: () => `rId${rel++}`,
    allocateRevisionId: () => String(rev++),
  }
}

export const HYPERLINK_REL =
  '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>'

const HDR_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'

/** a document whose default header holds `headerXml` (w:hdr children) */
export function buildWithHeader(
  headerXml: string,
  options: Partial<BuildDocxOptions> = {},
): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: `<w:p>${T('body')}</w:p>`,
    ...options,
    extraRels:
      (options.extraRels ?? '') +
      '<Relationship Id="rId50" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    extraParts: [
      ...(options.extraParts ?? []),
      {
        path: 'word/header1.xml',
        xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${HDR_NS}>${headerXml}</w:hdr>`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
      },
    ],
    sectPrExtra: '<w:headerReference w:type="default" r:id="rId50"/>',
  })
}

const isRunList = (value: unknown): value is Run[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (r) => typeof r === 'object' && r !== null && 'text' in r && typeof r.text === 'string',
  )

/**
 * A parsed value as the reader gave it before runs carried wrappers and kept
 * elements: kept elements gone, wrappers gone, and the runs a wrapper edge
 * split merged back. Two documents that differ only by such structure read
 * the same through this.
 */
export function withoutInlineStructure(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return `bytes:${value.length}`
  if (isRunList(value)) {
    const plain = value
      .filter((r) => r.opaqueXml === undefined)
      .map(({ wrap: _wrap, ...rest }) => rest)
    return mergeRuns(plain).map(withoutInlineStructure)
  }
  if (Array.isArray(value)) return value.map(withoutInlineStructure)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'function') out[key] = withoutInlineStructure(child)
  }
  return out
}

const REV = 'w:author="Ada" w:date="2024-01-01T00:00:00Z"'

/**
 * Paragraphs with none of the structure above, one per kind of run-level
 * content the generator writes: what reading and rebuilding them gives is
 * pinned in inline-wrappers-reading.test.ts.
 */
export const WRAPPERLESS_PARAGRAPHS: readonly string[] = [
  `<w:p>${T('plain ')}${T('bold', '<w:rPr><w:b/></w:rPr>')}${T(' red 14', '<w:rPr><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr>')}${T(' &amp; &lt;tail&gt;')}</w:p>`,
  `<w:p>${T('see ')}<w:hyperlink r:id="rId20" w:tooltip="tip">${T('site', '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>')}${T(' map')}</w:hyperlink><w:hyperlink w:anchor="top">${T('up')}</w:hyperlink></w:p>`,
  `<w:p>${T('kept ')}<w:ins w:id="11" ${REV}>${T('added')}</w:ins><w:del w:id="12" ${REV}><w:r><w:delText xml:space="preserve">gone</w:delText></w:r></w:del><w:ins w:id="13" ${REV}><w:del w:id="14" ${REV}><w:r><w:delText>both</w:delText></w:r></w:del></w:ins>${T(' end')}</w:p>`,
  `<w:p><w:moveFromRangeStart w:id="21" ${REV} w:name="move1"/><w:moveFrom w:id="22" ${REV}>${T('moved')}</w:moveFrom><w:moveFromRangeEnd w:id="21"/>${T(' stays')}</w:p>`,
  `<w:p>${T('a ')}<w:commentRangeStart w:id="0"/>${T('noted')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>${T(' z')}</w:p>`,
  `<w:p>${T('page ')}<w:fldSimple w:instr=" PAGE ">${T('3')}</w:fldSimple>${T(' ref ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF bm \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${T('target')}<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> XE "term" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  `<w:p><w:r><w:t>tab</w:t><w:tab/><w:t>break</w:t><w:br/><w:t>hy</w:t><w:noBreakHyphen/><w:t>phen</w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p>`,
  `<w:p><w:bookmarkStart w:id="1" w:name="bm"/><w:proofErr w:type="spellStart"/>${T('speling')}<w:proofErr w:type="spellEnd"/><w:bookmarkEnd w:id="1"/>${T(' note')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>`,
]
