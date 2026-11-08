/**
 * docx → a new ODT (no original ODT): "다른 이름으로 저장" as ODT, new
 * documents, markdown/HTML export through docx, CLI convert.
 *
 * It shares the writers of the narrow-patch save. A minimal ODT skeleton is
 * built from the docx's styles and page setup (document defaults, paragraph
 * styles, page layouts and master pages), opened like a received ODT with an
 * empty bridge, and every body element is written as new content by the
 * layers' free writers (paragraphs, lists, tables, pictures, notes). Headers
 * and footers fill the master pages through the page layer's region writer.
 * Each page section's first element points at its master page.
 *
 * What an ODT cannot hold (charts, equations, shapes, text boxes, tracked
 * changes, comments …) is converted or dropped and listed in the report.
 */
import {
  type HfParagraph,
  type ParsedDoc,
  type SectionInfo,
  parseDocx,
  readPageColor,
  readSections,
} from '@genoffice/docx-engine'
import JSZip from 'jszip'
import {
  type AlignedItem,
  type EditedItem,
  OoxmlToOdfContext,
  applyTextPatches,
  createBridgeMap,
} from '../../core/convert'
import { rebuildFlow } from '../../core/flow'
import { openOdt } from '../../core/open'
import { PrefixMap, decodeXmlEntities, escapeXmlAttr, escapeXmlText } from '../../core/xml'
import { objectPackageChanges } from '../../objects'
import { regionInnerXml } from '../../page/hf'
import { startStyle } from '../../page/register'
import { editStyleXml } from '../../text/style-xml'
import { odtRegistry } from '../registry'
import { type ConversionReport, ReportBuilder } from '../report'
import { type ZipEntryInput, writeZip } from '../zip'
import { BlockNormaliser } from './blocks'
import { headingsAsParagraphs } from './headings'
import { unresolvedThemeReferences } from './theme'
import { type RenderedObject, labelRunWriter } from './objects'
import {
  FontSet,
  type MasterSpec,
  defaultStyleXml,
  masterPageXml,
  pageLayoutXml,
  columnsXml,
  outlineStyleXml,
  paragraphStylesXml,
} from './styles'

export type { RenderedObject } from './objects'

export interface DocxToOdtOptions {
  /**
   * Pictures the editor rendered for objects an ODT cannot hold (charts,
   * equations, shapes, text boxes), keyed by body position:
   * `"<docxIndex>:<n>"` is the n-th such object (0-based, document order,
   * table cells included) inside the body element with that `Block.docxIndex`;
   * `"<docxIndex>"` alone stands for its first object.
   */
  renderedObjects?: Record<string, RenderedObject> | ReadonlyMap<string, RenderedObject>
}

export interface DocxToOdtResult {
  odtBytes: Uint8Array
  /** what the ODT does not keep as it was */
  report: ConversionReport
}

const ODT_MEDIA_TYPE = 'application/vnd.oasis.opendocument.text'
const ODF_VERSION = '1.3'
const IDENTITY = new PrefixMap()

const NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'

const SEQUENCE_DECLS =
  '<text:sequence-decls>' +
  ['Illustration', 'Table', 'Text', 'Drawing', 'Figure']
    .map((n) => `<text:sequence-decl text:display-outline-level="0" text:name="${n}"/>`)
    .join('') +
  '</text:sequence-decls>'

type Region = MasterSpec['regions'][number]

/** A run of pages under one master page: docx sections joined by continuous breaks. */
interface PageGroup {
  first: number
  last: number
  section: SectionInfo
  master: MasterSpec
  /** region → header/footer part shown there (null: an empty region) */
  parts: Partial<Record<Region, string | null>>
  /** the docx sections of the run (continuous breaks), with their text columns */
  subsections: Array<{ first: number; last: number; columns: { count: number; gap: number } }>
}

const encoder = new TextEncoder()

/** Converts a whole docx into a new ODT. Throws when the bytes are not a readable docx. */
export async function docxToOdt(
  docxBytes: Uint8Array,
  options: DocxToOdtOptions = {},
): Promise<DocxToOdtResult> {
  const parsed = await parseDocx(docxBytes)
  const zip = await JSZip.loadAsync(docxBytes)
  const rels = await documentRelationships(zip)
  const report = new ReportBuilder()
  const renderedMap = options.renderedObjects
  const rendered = (key: string): RenderedObject | undefined =>
    !renderedMap
      ? undefined
      : renderedMap instanceof Map
        ? renderedMap.get(key)
        : (renderedMap as Record<string, RenderedObject>)[key]
  const normaliser = new BlockNormaliser({
    parsed,
    rendered,
    report,
    media: async (rId) => {
      const target = rels.get(rId)
      const file = target ? zip.file(target) : null
      return file ? file.async('uint8array') : null
    },
  })

  // ---- body elements
  const items: EditedItem[] = []
  const blocks = []
  for (const b of parsed.blocks) {
    for (const item of await normaliser.block(b)) {
      items.push(item)
      blocks.push(...item.blocks)
    }
  }
  for (const item of normaliser.end()) {
    items.push(item)
    blocks.push(...item.blocks)
  }
  countTocs(parsed, report)

  // ---- page groups and master pages
  const sections = readSections(parsed)
  const groups = pageGroups(parsed, sections, report)
  const hfParas = new Map<string, HfParagraph[]>()
  for (const [rId, part] of Object.entries(parsed.hfParts ?? {})) {
    const paras: HfParagraph[] = []
    for (const p of (part.paras ?? []).filter((x) => !x.cells)) {
      const runs = await normaliser.runs(p.runs)
      paras.push({ ...p, runs })
    }
    hfParas.set(rId, paras)
  }
  report.add('dropped', 'revision', normaliser.revisions)
  const documentXml = await readPart(zip, 'word/document.xml')
  documentLevelReport(parsed, report, documentXml)
  const hfXml: string[] = []
  for (const rId of Object.keys(parsed.hfParts ?? {})) {
    const target = rels.get(rId)
    if (target) hfXml.push(await readPart(zip, target))
  }
  report.add(
    'converted',
    'theme',
    unresolvedThemeReferences(parsed, {
      documentXml,
      stylesXml: await readPart(zip, 'word/styles.xml'),
      parts: hfXml,
    }),
  )

  // ---- the skeleton
  const fonts = new FontSet()
  const defaults = defaultStyleXml(parsed.docDefaults, fonts)
  const paragraphStyles = paragraphStylesXml(parsed, fonts)
  const masters = [...new Map(groups.map((g) => [g.master.name, g.master])).values()]
  const stylesXml =
    `${XML_DECL}<office:document-styles ${NAMESPACES} office:version="${ODF_VERSION}">` +
    `<office:font-face-decls>${fonts.decls()}</office:font-face-decls>` +
    `<office:styles>${defaults}${paragraphStyles.xml}${outlineStyleXml()}</office:styles>` +
    `<office:automatic-styles>${masters.map(pageLayoutXml).join('')}</office:automatic-styles>` +
    `<office:master-styles>${masters.map(masterPageXml).join('')}</office:master-styles>` +
    '</office:document-styles>'
  const contentXml =
    `${XML_DECL}<office:document-content ${NAMESPACES} office:version="${ODF_VERSION}">` +
    '<office:font-face-decls/><office:automatic-styles/>' +
    `<office:body><office:text>${SEQUENCE_DECLS}</office:text></office:body></office:document-content>`
  const manifest = (extra: Array<{ path: string; mediaType: string }>) =>
    `${XML_DECL}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="${ODF_VERSION}">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="${ODF_VERSION}" manifest:media-type="${ODT_MEDIA_TYPE}"/>` +
    ['content.xml', 'styles.xml', 'meta.xml']
      .map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="text/xml"/>`)
      .join('') +
    extra
      .map(
        (e) =>
          `<manifest:file-entry manifest:full-path="${escapeXmlAttr(e.path)}" manifest:media-type="${escapeXmlAttr(e.mediaType)}"/>`,
      )
      .join('') +
    '</manifest:manifest>'
  const metaXml = await buildMetaXml(zip, parsed)
  const skeleton = await writeZip([
    { kind: 'data', name: 'mimetype', data: encoder.encode(ODT_MEDIA_TYPE), store: true },
    { kind: 'data', name: 'META-INF/manifest.xml', data: encoder.encode(manifest([])) },
    { kind: 'data', name: 'content.xml', data: encoder.encode(contentXml) },
    { kind: 'data', name: 'styles.xml', data: encoder.encode(stylesXml) },
    { kind: 'data', name: 'meta.xml', data: encoder.encode(metaXml) },
  ])
  const doc = await openOdt(skeleton)

  // ---- write the body and the master page regions as new content
  const map = createBridgeMap(doc)
  map.styles = {
    paragraph: [...paragraphStyles.names].map(([styleId, odfName]) => ({
      styleId,
      odfName,
      headingLevel: null,
      xml: '',
    })),
    docDefaults: '',
    defaultFamily: 'paragraph',
    baseParagraphStyle: paragraphStyles.base,
  }
  const edited: ParsedDoc = { ...parsed, blocks }
  const registry = odtRegistry().addRunWriter(labelRunWriter)
  const rctx = new OoxmlToOdfContext(doc, map, edited, registry)
  let body = ''
  let sectionSeq = 0
  groups.forEach((g, i) => {
    let xml = ''
    for (const sub of g.subsections) {
      const own = items.filter((it) => it.index >= sub.first && it.index <= sub.last)
      if (!own.length) continue
      const aligned: AlignedItem[] = own.map((item) => ({ item, element: null, unchanged: false }))
      const flow = rebuildFlow(rctx, aligned, { parent: null })
      // a continuous section with its own columns is a text:section of the page run
      if (g.subsections.length > 1 && sub.columns.count > 1) {
        const style = rctx.derivedStyle(
          'content.xml',
          `export-section:${sub.columns.count}:${sub.columns.gap}`,
          'Sect',
          (name) =>
            `<style:style style:name="${name}" style:family="section"><style:section-properties>` +
            `${columnsXml(sub.columns)}</style:section-properties></style:style>`,
        )
        xml += `<text:section text:style-name="${style}" text:name="Section${++sectionSeq}">${flow}</text:section>`
      } else xml += flow
    }
    if (!xml) return
    const start = i > 0 || g.master.name !== 'Standard' || g.section.pageNumberStart !== undefined
    if (start) xml = startPageRun(rctx, xml, g.master.name, g.section.pageNumberStart)
    body += xml
  })
  const text = doc.body.text
  rctx.patch('content.xml', text.closeStart, text.closeStart, body)
  for (const m of masters) {
    const master = doc.styles.masterPage(m.name)
    const group = groups.find((g) => g.master.name === m.name)
    if (!master || !group) continue
    for (const region of m.regions) {
      const range = master.regions[region]
      const rId = group.parts[region]
      if (!range || !rId) continue
      const inner = regionInnerXml(rctx, null, [], undefined, hfParas.get(rId) ?? [])
      if (inner)
        rctx.patch(
          'styles.xml',
          range.start,
          range.end,
          `<style:${region}>${inner}</style:${region}>`,
        )
    }
  }
  const patches = rctx.finish()
  // headings as Hancom writes them (it numbers every text:h)
  const levels = new Map<string, number>()
  for (const [styleId, odfName] of paragraphStyles.names) {
    const level = parsed.styles.get(styleId)?.headingLevel
    if (level) levels.set(odfName, level)
  }
  const content = headingsAsParagraphs(
    applyTextPatches(doc.contentXml, patches['content.xml']),
    levels,
  )
  const styles = headingsAsParagraphs(
    applyTextPatches(doc.stylesXml ?? '', patches['styles.xml']),
    levels,
  )
  const changes = objectPackageChanges(rctx, { contentXml: content, stylesXml: styles })

  const entries: ZipEntryInput[] = [
    { kind: 'data', name: 'mimetype', data: encoder.encode(ODT_MEDIA_TYPE), store: true },
    {
      kind: 'data',
      name: 'META-INF/manifest.xml',
      data: encoder.encode(
        manifest(changes.add.map((a) => ({ path: a.path, mediaType: a.mediaType }))),
      ),
    },
    { kind: 'data', name: 'content.xml', data: encoder.encode(content) },
    { kind: 'data', name: 'styles.xml', data: encoder.encode(styles) },
    { kind: 'data', name: 'meta.xml', data: encoder.encode(metaXml) },
    ...changes.add.map((a) => ({ kind: 'data' as const, name: a.path, data: a.data, store: true })),
  ]
  return { odtBytes: await writeZip(entries), report: report.build() }
}

// ---------------------------------------------------------------------------

async function readPart(zip: JSZip, path: string): Promise<string> {
  return (await zip.file(path)?.async('string')) ?? ''
}

/** Relationship id → package path of word/document.xml's relationships. */
async function documentRelationships(zip: JSZip): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const xml = await readPart(zip, 'word/_rels/document.xml.rels')
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1]
    if (!id || !target || /TargetMode="External"/.test(m[0])) continue
    const t = decodeXmlEntities(target)
    out.set(id, t.startsWith('/') ? t.slice(1) : `word/${t.replace(/^\.\//, '')}`)
  }
  return out
}

/** The part a section shows in a slot, inherited from earlier sections as Word does. */
function effectiveRef(
  sections: readonly SectionInfo[],
  index: number,
  kind: 'header' | 'footer',
  variant: 'default' | 'first' | 'even',
): string | undefined {
  for (let j = index; j >= 0; j--) {
    const refs = kind === 'header' ? sections[j].headerRefs : sections[j].footerRefs
    if (refs[variant]) return refs[variant]
  }
  return undefined
}

/** Docx sections → page groups (continuous breaks join the previous group) with their masters. */
function pageGroups(
  parsed: ParsedDoc,
  sections: readonly SectionInfo[],
  report: ReportBuilder,
): PageGroup[] {
  const evenOdd = !!parsed.evenAndOddHeaders
  const groups: PageGroup[] = []
  let unequal = 0
  const columnsOf = (s: SectionInfo) => {
    const st = s.settings
    if (st.columns > 1 && st.colWidths && new Set(st.colWidths).size > 1) unequal++
    return { count: Math.max(1, st.columns || 1), gap: st.colSpace ?? 720 }
  }
  sections.forEach((s, i) => {
    const prev = groups[groups.length - 1]
    if (prev && (s.startType === 'continuous' || s.startType === 'nextColumn')) {
      prev.last = s.lastBlockIndex
      prev.subsections.push({
        first: s.firstBlockIndex,
        last: s.lastBlockIndex,
        columns: columnsOf(s),
      })
      // a page run of several column layouts gets them from its sections
      prev.master.columns = { count: 1, gap: 0 }
      return
    }
    const parts: Partial<Record<Region, string | null>> = {}
    for (const kind of ['header', 'footer'] as const) {
      const def = effectiveRef(sections, i, kind, 'default')
      if (def) parts[kind] = def
      if (s.titlePg) parts[`${kind}-first`] = effectiveRef(sections, i, kind, 'first') ?? null
      if (evenOdd) parts[`${kind}-left`] = effectiveRef(sections, i, kind, 'even') ?? null
    }
    const regions = (Object.keys(parts) as Region[]).sort(
      (a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b),
    )
    // one master page per docx page section, so the sections stay sections
    const n = groups.length + 1
    const columns = columnsOf(s)
    const master: MasterSpec = {
      name: n === 1 ? 'Standard' : `MP${n}`,
      layoutName: `Mpm${n}`,
      settings: s.settings,
      header: regions.some((r) => r.startsWith('header')),
      footer: regions.some((r) => r.startsWith('footer')),
      regions,
      numFormat: s.pageNumberFmt ?? null,
      mirrored: !!parsed.mirrorMargins,
      columns,
    }
    groups.push({
      first: s.firstBlockIndex,
      last: s.lastBlockIndex,
      section: s,
      master,
      parts,
      subsections: [{ first: s.firstBlockIndex, last: s.lastBlockIndex, columns }],
    })
  })
  if (!groups.length) {
    const fallback: MasterSpec = {
      name: 'Standard',
      layoutName: 'Mpm1',
      settings: {
        pageWidth: 11906,
        pageHeight: 16838,
        orientation: 'portrait',
        marginTop: 1440,
        marginBottom: 1440,
        marginLeft: 1440,
        marginRight: 1440,
        pageBorder: false,
        columns: 1,
      },
      header: false,
      footer: false,
      regions: [],
      numFormat: null,
      mirrored: false,
      columns: { count: 1, gap: 0 },
    }
    groups.push({
      first: 0,
      last: Number.MAX_SAFE_INTEGER,
      section: {
        settings: fallback.settings,
        startType: 'nextPage',
        firstBlockIndex: 0,
        lastBlockIndex: Number.MAX_SAFE_INTEGER,
        sectPrXml: '',
        titlePg: false,
        headerRefs: {},
        footerRefs: {},
      },
      master: fallback,
      parts: {},
      subsections: [{ first: 0, last: Number.MAX_SAFE_INTEGER, columns: { count: 1, gap: 0 } }],
    })
  }
  // the last group takes everything after it (trailing elements)
  const lastGroup = groups[groups.length - 1]
  lastGroup.last = Number.MAX_SAFE_INTEGER
  lastGroup.subsections[lastGroup.subsections.length - 1].last = Number.MAX_SAFE_INTEGER
  // ODF columns are equal: unequal docx column widths become equal ones
  report.add('converted', 'columns', unequal)
  // mirror margins are style:page-usage="mirrored": kept as they are, not reported
  return groups
}

const REGION_ORDER: Region[] = [
  'header',
  'header-left',
  'header-first',
  'footer',
  'footer-left',
  'footer-first',
]

/** Points the first element of a page run at its master page (and page number start). */
function startPageRun(
  rctx: OoxmlToOdfContext,
  xml: string,
  master: string,
  pageNumber: number | undefined,
): string {
  const change = {
    master,
    ...(pageNumber !== undefined ? { pageNumber: String(pageNumber) } : {}),
  }
  const table = /^<table:table\b[^>]*>/.exec(xml)
  if (table) {
    const name = /\stable:style-name="([^"]*)"/.exec(table[0])?.[1]
    const queued = name
      ? rctx
          .newAutomaticStyles('content.xml')
          .find((s) => s.startsWith(`<style:style style:name="${name}"`))
      : undefined
    if (!name || !queued) return xml
    const derived = rctx.derivedStyle(
      'content.xml',
      `page-start-table:${name}:${master}`,
      name,
      (n) =>
        editStyleXml(queued, IDENTITY, { name: n, attrs: { 'style:master-page-name': master } }),
    )
    return xml.replace(
      table[0],
      table[0].replace(`table:style-name="${name}"`, `table:style-name="${derived}"`),
    )
  }
  const m = /<(text:p|text:h)(?=[\s/>])[^>]*>/.exec(xml)
  if (!m) return xml
  const raw = /\stext:style-name="([^"]*)"/.exec(m[0])?.[1]
  const current = raw === undefined ? null : decodeXmlEntities(raw)
  const name = startStyle(rctx, current, change)
  const attr = `text:style-name="${escapeXmlAttr(name)}"`
  const tag =
    raw === undefined
      ? m[0].replace(/^<(text:p|text:h)/, (open) => `${open} ${attr}`)
      : m[0].replace(`text:style-name="${raw}"`, attr)
  return xml.slice(0, m.index) + tag + xml.slice(m.index + m[0].length)
}

/** One table of contents per run of TOC lines. */
function countTocs(parsed: ParsedDoc, report: ReportBuilder): void {
  let inToc = false
  for (const b of parsed.blocks) {
    const toc = b.fieldDisplay?.kind === 'tocLine'
    if (toc && !inToc) report.add('converted', 'toc')
    if (!b.hidden) inToc = toc
  }
}

/** Document-level features: fields, comments, page colour, theme, ink, watermark, protection. */
function documentLevelReport(parsed: ParsedDoc, report: ReportBuilder, documentXml: string): void {
  let citations = 0
  let references = 0
  const instructions = [
    ...[...documentXml.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => m[1]),
    ...[...documentXml.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)].map((m) => m[1]),
  ]
  for (const raw of instructions) {
    const instr = decodeXmlEntities(raw).trim()
    if (/^(?:CITATION|BIBLIOGRAPHY)\b|^ADDIN\s+(?:ZOTERO|EN\.CITE|CSL|Mendeley)/i.test(instr))
      citations++
    else if (/^(?:REF|NOTEREF|SEQ)\b/i.test(instr) || /^PAGEREF\s+(?!_Toc)/i.test(instr))
      references++
  }
  citations += (documentXml.match(/<w:citation\b/g) ?? []).length
  report.add('converted', 'citation', citations)
  report.add('converted', 'cross_reference', references)
  report.add('dropped', 'page_color', readPageColor(parsed) ? 1 : 0)
  report.add('dropped', 'comment', parsed.comments.length)
  report.add('dropped', 'ink', parsed.inks.length)
  if (parsed.watermarkText || parsed.watermarkPicture) report.add('dropped', 'watermark')
  const passwords = (parsed.protection?.hash ? 1 : 0) + (parsed.writeProtection?.hash ? 1 : 0)
  report.add('dropped', 'password', passwords)
  const restrictions =
    (parsed.protection?.enforced ? 1 : 0) + (parsed.writeProtection?.recommended ? 1 : 0)
  report.add('dropped', 'protection', restrictions)
}

/** meta.xml from docx core properties (people fields only when not asked to remove them). */
async function buildMetaXml(zip: JSZip, parsed: ParsedDoc): Promise<string> {
  const core = await readPart(zip, 'docProps/core.xml')
  const field = (tag: string) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`).exec(core)
    return m ? decodeXmlEntities(m[1]).trim() : ''
  }
  const title = field('dc:title')
  const creator = parsed.removePersonalInfo ? '' : field('dc:creator')
  const modifier = parsed.removePersonalInfo ? '' : field('cp:lastModifiedBy')
  const created = field('dcterms:created').replace(/Z$/, '')
  const modified = field('dcterms:modified').replace(/Z$/, '')
  return (
    `${XML_DECL}<office:document-meta ${NAMESPACES} office:version="${ODF_VERSION}"><office:meta>` +
    '<meta:generator>IeumOffice</meta:generator>' +
    (title ? `<dc:title>${escapeXmlText(title)}</dc:title>` : '') +
    (creator ? `<meta:initial-creator>${escapeXmlText(creator)}</meta:initial-creator>` : '') +
    (modifier ? `<dc:creator>${escapeXmlText(modifier)}</dc:creator>` : '') +
    (/^\d{4}-\d{2}-\d{2}T/.test(created)
      ? `<meta:creation-date>${created}</meta:creation-date>`
      : '') +
    (/^\d{4}-\d{2}-\d{2}T/.test(modified) ? `<dc:date>${modified}</dc:date>` : '') +
    '</office:meta></office:document-meta>'
  )
}
