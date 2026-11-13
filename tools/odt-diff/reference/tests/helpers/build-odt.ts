/**
 * Builds Hancom-like ODT packages in memory for tests.
 *
 * The defaults reproduce what Hancom writes, which breaks the ODF packaging
 * rules: entries in alphabetical order (so `mimetype` is not first), every
 * entry deflated (including `mimetype`), no `office:version` on any root, a
 * paragraph parent style (`Standard`) and a graphic parent style (`Frame`) that
 * are referenced but never defined. Every part can be replaced or extended so
 * later tests can craft their own cases.
 *
 * Never put a real document here; fixtures are synthetic.
 */
import JSZip from 'jszip'
import {
  escapeAttr,
  hFrameGraphicStyle,
  hPara,
  hParagraphAutoStyle,
  hTableAutoStyles,
  hTextAutoStyle,
} from './hancom-fragments'

export const ODT_TEXT_MIMETYPE = 'application/vnd.oasis.opendocument.text'
export const HANCOM_DESKTOP_GENERATOR = 'hwp/hangul/13, 0, 0, 711/Windows_10'
export const HANCOM_SERVER_GENERATOR =
  'hwp/hangul/11, 0, 0, 65535/NAME="Red_Hat_Enterprise_Linux_Server"'

/** The namespace declarations Hancom puts on every root element. */
export const HANCOM_NAMESPACES =
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:tableooo="http://openoffice.org/2009/table" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:dr3d="urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0" ' +
  'xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" ' +
  'xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0" ' +
  'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ' +
  'xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:math="http://www.w3.org/1998/Math/MathML" ' +
  'xmlns:xforms="http://www.w3.org/2002/xforms" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" ' +
  'xmlns:ooo="http://openoffice.org/2004/office" ' +
  'xmlns:ooow="http://openoffice.org/2004/writer" ' +
  'xmlns:oooc="http://openoffice.org/2004/calc" ' +
  'xmlns:dom="http://www.w3.org/2001/xml-events" ' +
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:officeooo="http://openoffice.org/2009/office" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'

export interface OdtFixtureEntry {
  name: string
  data: string | Uint8Array
  /** deflate the entry (default true, as Hancom does) */
  compress?: boolean
  /** manifest media type; omit to leave the entry out of the manifest */
  mediaType?: string
}

export interface BuildOdtOptions {
  /** put `mimetype` first (default false: Hancom's alphabetical order) */
  mimetypeFirst?: boolean
  /** deflate `mimetype` (default: true unless `mimetypeFirst`) */
  mimetypeCompressed?: boolean
  /** content of `mimetype`; `null` leaves the entry out */
  mimetype?: string | null
  /** `office:version` on every root; default `null` (omitted, as Hancom does) */
  officeVersion?: string | null
  /** `meta:generator`; `null` omits the element; default Hancom desktop */
  generator?: string | null
  /** inner XML of `office:text`; default one Hancom paragraph */
  body?: string
  /** replaces the default inner XML of content.xml `office:automatic-styles` */
  contentAutomaticStyles?: string
  /** appended to content.xml `office:automatic-styles` */
  extraContentAutomaticStyles?: string
  /** replaces the default inner XML of styles.xml `office:styles` */
  commonStyles?: string
  /** appended to styles.xml `office:styles` */
  extraCommonStyles?: string
  /** replaces the default inner XML of styles.xml `office:automatic-styles` */
  stylesAutomaticStyles?: string
  /** appended to styles.xml `office:automatic-styles` */
  extraStylesAutomaticStyles?: string
  /** replaces the default inner XML of `office:master-styles` */
  masterStyles?: string
  /** files added under `Pictures/` (name without the folder) */
  pictures?: Record<string, Uint8Array>
  /** any other entries (embedded objects, extra parts) */
  extraEntries?: OdtFixtureEntry[]
  /** mark content.xml and styles.xml encrypted in the manifest (bytes are not real ciphertext) */
  encrypted?: boolean
  /** replace a whole part's text (`content.xml`, `styles.xml`, `meta.xml`, `META-INF/manifest.xml`) */
  overrideParts?: Record<string, string | Uint8Array>
}

/** Default content.xml automatic styles: per-paragraph styles with Hancom attributes and tab stops. */
export function defaultContentAutomaticStyles(): string {
  return [
    hTextAutoStyle('T1'),
    hTextAutoStyle('T33'),
    hTextAutoStyle('T2', '14.00pt', 'bold'),
    hParagraphAutoStyle('P1_0', {
      tabStops: [
        { position: '14.993cm', type: 'right', leader: 'dotted' },
        { position: '15.500cm', type: 'right' },
      ],
    }),
    hParagraphAutoStyle('P73_0', { align: 'center' }),
    hParagraphAutoStyle('P73_0_MS1_b3', { align: 'center', masterPage: 'Standard' }),
    hParagraphAutoStyle('P270_172_MS2_b7', { parent: '+제목', masterPage: 'MP2' }),
    // a third section that returns to the first section's master page
    hParagraphAutoStyle('P5_0_MS3_b3', { masterPage: 'Standard' }),
    hParagraphAutoStyle('P2_0', { parent: '바탕글 1' }),
    hTableAutoStyles('Table1', 3),
    hTableAutoStyles('Table2', 1),
    hTableAutoStyles('Table3', 2),
    hFrameGraphicStyle('tableinfakeframe_gr1'),
  ].join('')
}

/** Default common styles: Hancom's empty `text` default style plus named paragraph styles. */
export function defaultCommonStyles(): string {
  const props = (indent: string) =>
    `<style:paragraph-properties fo:line-height="160%" fo:text-align="justify" fo:margin-left="${indent}" fo:margin-right="0cm" fo:text-indent="0cm" fo:margin-top="0cm" fo:margin-bottom="0cm" style:text-autospace="none" style:snap-to-layout-grid="true"/>`
  const text =
    '<style:text-properties style:font-name="함초롬바탕" fo:font-family="함초롬바탕" fo:font-size="10.00pt" fo:language="en" style:language-asian="ko" style:letter-kerning="false"/>'
  return (
    '<style:default-style style:family="text"><style:graphic-properties/><style:paragraph-properties/><style:text-properties/><style:table-properties/><style:table-column-properties/><style:table-row-properties/><style:table-cell-properties/></style:default-style>' +
    `<style:style style:name="바탕글" style:display-name="바탕글" style:family="paragraph">${props('0cm')}${text}</style:style>` +
    `<style:style style:name="바탕글 1" style:display-name="바탕글 1" style:parent-style-name="바탕글" style:family="paragraph">${props('0.529cm')}</style:style>` +
    `<style:style style:name="+제목" style:display-name="+제목" style:family="paragraph">${props('0cm')}<style:graphic-properties draw:fill="none"/></style:style>` +
    `<style:style style:name="개요 1" style:display-name="개요 1" style:default-outline-level="1" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.353cm"><style:tab-stops><style:tab-stop style:position="0.706cm" style:type="right" style:leader-style="none"/></style:tab-stops></style:paragraph-properties></style:style>`
  )
}

/** Default styles.xml automatic styles: two page layouts and the header paragraph styles. */
export function defaultStylesAutomaticStyles(): string {
  const layout = (name: string, orientation: string, w: string, h: string) =>
    `<style:page-layout style:name="${name}"><style:page-layout-properties fo:page-width="${w}" fo:page-height="${h}" style:print-orientation="${orientation}" fo:margin-left="2.000cm" fo:margin-right="2.000cm" fo:margin-top="1.000cm" fo:margin-bottom="1.000cm" fo:border="none" style:shadow="none" style:writing-mode="lr-tb"><style:columns fo:column-count="1"><style:column style:rel-width="9622*"/><style:column-sep style:style="none" style:width="0.010cm" style:color="#000000"/></style:columns></style:page-layout-properties><style:header-style><style:header-footer-properties svg:height="1.500cm"/></style:header-style><style:footer-style><style:header-footer-properties svg:height="1.000cm"/></style:footer-style></style:page-layout>`
  return (
    hParagraphAutoStyle('MP445_1', { parent: '바탕글' }) +
    hTextAutoStyle('MT40') +
    // same name as a content.xml automatic style: the two scopes must not collide
    hParagraphAutoStyle('P1_0', { align: 'right' }) +
    layout('Mpm1', 'portrait', '21.000cm', '29.700cm') +
    layout('Mpm2', 'landscape', '29.700cm', '21.000cm')
  )
}

/** Default master pages: `Standard` with header and footer, `MP2` with header plus left/first variants. */
export function defaultMasterStyles(): string {
  const hp = (text: string) => hPara(text, { style: 'MP445_1', span: 'MT40' })
  return (
    `<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:header>${hp('header')}</style:header><style:footer>${hp('footer')}</style:footer></style:master-page>` +
    `<style:master-page style:name="MP2" style:page-layout-name="Mpm2"><style:header>${hp('header 2')}</style:header><style:header-left>${hp('left header')}</style:header-left><style:footer-first>${hp('first footer')}</style:footer-first></style:master-page>`
  )
}

const versionAttr = (v: string | null | undefined) =>
  v == null ? '' : ` office:version="${escapeAttr(v)}"`

export function buildContentXml(opts: BuildOdtOptions = {}): string {
  const autos =
    (opts.contentAutomaticStyles ?? defaultContentAutomaticStyles()) +
    (opts.extraContentAutomaticStyles ?? '')
  const body = opts.body ?? hPara('Hello')
  return (
    `${XML_DECL}<office:document-content ${HANCOM_NAMESPACES}${versionAttr(opts.officeVersion)}>` +
    '<office:font-face-decls><style:font-face svg:font-family="함초롬바탕" style:name="함초롬바탕"/></office:font-face-decls>' +
    `<office:automatic-styles>${autos}</office:automatic-styles>` +
    `<office:body><office:text>${body}</office:text></office:body></office:document-content>`
  )
}

export function buildStylesXml(opts: BuildOdtOptions = {}): string {
  const common = (opts.commonStyles ?? defaultCommonStyles()) + (opts.extraCommonStyles ?? '')
  const autos =
    (opts.stylesAutomaticStyles ?? defaultStylesAutomaticStyles()) +
    (opts.extraStylesAutomaticStyles ?? '')
  const master = opts.masterStyles ?? defaultMasterStyles()
  return (
    `${XML_DECL}<office:document-styles ${HANCOM_NAMESPACES}${versionAttr(opts.officeVersion)}>` +
    '<office:font-face-decls><style:font-face svg:font-family="함초롬바탕" style:name="함초롬바탕"/></office:font-face-decls>' +
    `<office:styles>${common}</office:styles>` +
    `<office:automatic-styles>${autos}</office:automatic-styles>` +
    `<office:master-styles>${master}</office:master-styles></office:document-styles>`
  )
}

export function buildMetaXml(opts: BuildOdtOptions = {}): string {
  const generator = opts.generator === undefined ? HANCOM_DESKTOP_GENERATOR : opts.generator
  const gen = generator === null ? '' : `<meta:generator>${escapeAttr(generator)}</meta:generator>`
  return (
    `${XML_DECL}<office:document-meta ${HANCOM_NAMESPACES}${versionAttr(opts.officeVersion)}>` +
    '<office:meta><dc:title/><dc:description/><dc:subject/><meta:keyword/><dc:creator>tester</dc:creator>' +
    `<meta:creation-date>2024-01-02T03:04:05.000</meta:creation-date>${gen}</office:meta></office:document-meta>`
  )
}

const SETTINGS_XML = `${XML_DECL}<office:document-settings ${HANCOM_NAMESPACES}><office:settings/></office:document-settings>`

function encryptionData(): string {
  return (
    `<manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA">` +
    '<manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/>' +
    `<manifest:start-key-generation manifest:start-key-generation-name="http://www.w3.org/2000/09/xmldsig#sha256" manifest:key-size="32"/>` +
    `<manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/>` +
    '</manifest:encryption-data>'
  )
}

export function buildManifestXml(
  entries: Array<{ name: string; mediaType: string; encrypted?: boolean; size?: number }>,
  rootMediaType: string = ODT_TEXT_MIMETYPE,
): string {
  const items = entries
    .map((e) =>
      e.encrypted
        ? `<manifest:file-entry manifest:media-type="${escapeAttr(e.mediaType)}" manifest:full-path="${escapeAttr(e.name)}" manifest:size="${e.size ?? 0}">${encryptionData()}</manifest:file-entry>`
        : `<manifest:file-entry manifest:media-type="${escapeAttr(e.mediaType)}" manifest:full-path="${escapeAttr(e.name)}"/>`,
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
    `<manifest:file-entry manifest:media-type="${escapeAttr(rootMediaType)}" manifest:full-path="/"/>${items}</manifest:manifest>`
  )
}

export interface BuiltOdt {
  bytes: Uint8Array
  /** entries in archive order, with the exact uncompressed bytes written */
  entries: Array<{ name: string; bytes: Uint8Array; compressed: boolean }>
  contentXml: string
  stylesXml: string
  metaXml: string
  manifestXml: string
}

const utf8 = (s: string | Uint8Array) => (typeof s === 'string' ? new TextEncoder().encode(s) : s)

/** Builds the package and reports exactly what went into it. */
export async function buildOdtPackage(opts: BuildOdtOptions = {}): Promise<BuiltOdt> {
  const contentXml = buildContentXml(opts)
  const stylesXml = buildStylesXml(opts)
  const metaXml = buildMetaXml(opts)
  const parts: OdtFixtureEntry[] = [
    { name: 'content.xml', data: contentXml, mediaType: 'text/xml' },
    { name: 'meta.xml', data: metaXml, mediaType: 'text/xml' },
    { name: 'settings.xml', data: SETTINGS_XML, mediaType: 'text/xml' },
    { name: 'styles.xml', data: stylesXml, mediaType: 'text/xml' },
  ]
  for (const [name, data] of Object.entries(opts.pictures ?? {})) {
    parts.push({ name: `Pictures/${name}`, data, mediaType: '' })
  }
  parts.push(...(opts.extraEntries ?? []))
  for (const part of parts) {
    const override = opts.overrideParts?.[part.name]
    if (override !== undefined) part.data = override
    if (opts.encrypted && (part.name === 'content.xml' || part.name === 'styles.xml')) {
      // not real ciphertext; only the manifest marks it encrypted
      part.data = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff))
    }
  }
  const manifestXml =
    (opts.overrideParts?.['META-INF/manifest.xml'] as string | undefined) ??
    buildManifestXml(
      parts
        .filter((p) => p.mediaType !== undefined)
        .map((p) => ({
          name: p.name,
          mediaType: p.mediaType as string,
          encrypted: !!opts.encrypted && (p.name === 'content.xml' || p.name === 'styles.xml'),
          size: utf8(p.data).length,
        })),
    )
  const mimetype = opts.mimetype === undefined ? ODT_TEXT_MIMETYPE : opts.mimetype
  const mimetypeFirst = opts.mimetypeFirst ?? false
  const mimetypeCompressed = opts.mimetypeCompressed ?? !mimetypeFirst

  const all: Array<{ name: string; data: Uint8Array; compress: boolean }> = [
    { name: 'META-INF/manifest.xml', data: utf8(manifestXml), compress: true },
    ...parts.map((p) => ({ name: p.name, data: utf8(p.data), compress: p.compress ?? true })),
  ]
  if (mimetype !== null) {
    all.push({ name: 'mimetype', data: utf8(mimetype), compress: mimetypeCompressed })
  }
  if (mimetypeFirst) {
    const i = all.findIndex((e) => e.name === 'mimetype')
    if (i >= 0) all.unshift(...all.splice(i, 1))
  } else {
    // Hancom writes entries in plain code-point order
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  const zip = new JSZip()
  for (const e of all) {
    zip.file(e.name, e.data, {
      compression: e.compress ? 'DEFLATE' : 'STORE',
      // Hancom writes no directory entries
      createFolders: false,
    })
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  return {
    bytes,
    entries: all.map((e) => ({ name: e.name, bytes: e.data, compressed: e.compress })),
    contentXml:
      typeof opts.overrideParts?.['content.xml'] === 'string'
        ? opts.overrideParts['content.xml']
        : contentXml,
    stylesXml:
      typeof opts.overrideParts?.['styles.xml'] === 'string'
        ? opts.overrideParts['styles.xml']
        : stylesXml,
    metaXml:
      typeof opts.overrideParts?.['meta.xml'] === 'string'
        ? opts.overrideParts['meta.xml']
        : metaXml,
    manifestXml,
  }
}

/** Builds a Hancom-like ODT and returns its bytes. */
export async function buildOdt(opts: BuildOdtOptions = {}): Promise<Uint8Array> {
  return (await buildOdtPackage(opts)).bytes
}
