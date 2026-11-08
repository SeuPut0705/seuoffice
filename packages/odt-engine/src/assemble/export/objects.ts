/**
 * Objects of a docx that an ODT gets as pictures: charts, equations, shapes
 * and text boxes. The picture is, in order of preference: what the editor
 * rendered (`renderedObjects`), the file's own fallback picture
 * (`mc:Fallback`, an OLE preview), or a label box naming the kind. Plain
 * pictures stay pictures, read from the package by their relationship.
 */
import type { Run } from '@genoffice/docx-engine'
import type { OoxmlToOdfContext, RunWriter } from '../../core/convert'
import { escapeXmlAttr, escapeXmlText } from '../../core/xml'
import { base64Encode, sniffImage } from '../../objects/media'
import { crc32 } from '../zip'

/** What a docx object becomes. */
export type ExportObjectKind = 'chart' | 'equation' | 'shape' | 'textbox'

/** A picture of an object as the editor shows it. */
export interface RenderedObject {
  /** PNG bytes */
  png: Uint8Array
  /** display size in EMU (914400 per inch) */
  widthEmu: number
  heightEmu: number
}

export const LABEL_PREFIX = 'odt-label:'

const LABEL_TEXT: Record<ExportObjectKind, string> = {
  chart: 'Chart',
  equation: 'Equation',
  shape: 'Shape',
  textbox: 'Text box',
}

/** The part of an `mc:AlternateContent` the producer meant (its first choice), else the XML. */
function chosen(xml: string): string {
  const m = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(xml)
  return m ? m[1] : xml
}

/**
 * The kind of a drawing, VML or math fragment: `picture` for plain pictures,
 * null when it holds nothing drawable.
 */
export function classifyObject(xml: string): ExportObjectKind | 'picture' | null {
  const x = chosen(xml)
  if (/<m:oMath\b/.test(x)) return 'equation'
  if (/<w:object\b|<o:OLEObject\b/.test(x)) {
    const prog = /\bProgID="([^"]*)"/.exec(x)?.[1] ?? ''
    if (/^Equation\./i.test(prog)) return 'equation'
    if (/Chart|Excel/i.test(prog)) return 'chart'
    return 'shape'
  }
  if (/graphicData\s+uri="[^"]*\/(?:chart|chartex)"|<c:chart\b|<cx:chart\b/.test(x)) return 'chart'
  if (/<wps:txbx\b|<v:textbox\b|<w:txbxContent\b/.test(x)) return 'textbox'
  if (/<wps:wsp\b|<wpg:wgp\b|<wpc:wpc\b|<dgm:|graphicData\s+uri="[^"]*\/diagram"/.test(x))
    return 'shape'
  if (/<pic:pic\b|<a:blip\b/.test(x)) return 'picture'
  if (/<v:imagedata\b/.test(x)) return 'picture'
  if (/<v:(?:shape|rect|roundrect|oval|line|polyline|arc|curve|group)\b/.test(x)) return 'shape'
  return null
}

/** Display size of a drawing or VML fragment in EMU, when it states one. */
export function objectSize(xml: string): { cx: number; cy: number } | null {
  const x = chosen(xml)
  const ext = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(x)
  if (ext) return { cx: parseInt(ext[1], 10), cy: parseInt(ext[2], 10) }
  const style = /\bstyle="([^"]*)"/.exec(x)?.[1] ?? ''
  const len = (name: string) => {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)(pt|in|cm|mm|px)?`).exec(style)
    if (!m) return null
    const n = parseFloat(m[1])
    const per = { pt: 12700, in: 914400, cm: 360000, mm: 36000, px: 9525 }[m[2] ?? 'px'] ?? 9525
    return Math.round(n * per)
  }
  const w = len('width')
  const h = len('height')
  return w && h ? { cx: w, cy: h } : null
}

/** The relationship id of a fragment's fallback picture (`mc:Fallback`, OLE preview, VML image). */
export function fallbackPictureRId(xml: string): string | null {
  const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(xml)?.[1]
  const scope = fallback ?? (/<w:object\b/.test(xml) ? xml : null)
  if (!scope) return null
  return (
    /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(scope)?.[1] ??
    /<v:imagedata\b[^>]*\br:id="([^"]+)"/.exec(scope)?.[1] ??
    null
  )
}

/** A `w:drawing` the objects layer reads as a new picture of the given size and name. */
export function drawingXml(cx: number, cy: number, name: string): string {
  return (
    `<w:drawing><wp:inline><wp:extent cx="${Math.max(1, Math.round(cx))}" cy="${Math.max(1, Math.round(cy))}"/>` +
    `<wp:docPr id="1" name="${escapeXmlAttr(name)}"/></wp:inline></w:drawing>`
  )
}

export const dataUrlOf = (bytes: Uint8Array): string => {
  const mime = sniffImage(bytes)?.mime ?? 'image/png'
  return `data:${mime};base64,${base64Encode(bytes)}`
}

/** A picture run (written by the objects layer as a new frame). */
export function pictureRun(bytes: Uint8Array, cx: number, cy: number, name: string): Run {
  return { text: '', image: { dataUrl: dataUrlOf(bytes), xml: drawingXml(cx, cy, name) } }
}

/** A label run naming the object kind (written by `labelRunWriter`). */
export function labelRun(kind: ExportObjectKind, cx: number, cy: number): Run {
  return { text: '', image: { dataUrl: '', xml: drawingXml(cx, cy, `${LABEL_PREFIX}${kind}`) } }
}

/** Default sizes when an object states none (EMU). */
export function defaultSize(kind: ExportObjectKind, text = ''): { cx: number; cy: number } {
  if (kind === 'equation')
    return { cx: Math.max(720000, Math.min(5400000, text.length * 120000)), cy: 288000 }
  return { cx: 1800000, cy: 1080000 }
}

const emuToCm = (emu: number) => `${(emu / 360000).toFixed(3)}cm`

/** Writes label runs as a framed text box with the kind's name. */
export const labelRunWriter: RunWriter = {
  id: 'export-label',
  match(run) {
    return !!run.image && run.image.xml.includes(`name="${LABEL_PREFIX}`)
  },
  toOdf(rctx: OoxmlToOdfContext, run, env) {
    const xml = run.image?.xml ?? ''
    const kind = (new RegExp(`name="${LABEL_PREFIX}([a-z]+)"`).exec(xml)?.[1] ??
      'shape') as ExportObjectKind
    const cx = parseInt(/\bcx="(\d+)"/.exec(xml)?.[1] ?? '1800000', 10)
    const cy = parseInt(/\bcy="(\d+)"/.exec(xml)?.[1] ?? '1080000', 10)
    const graphic = rctx.derivedStyle(
      env.part,
      'export-label-graphic',
      'fr',
      (name) =>
        `<style:style style:name="${escapeXmlAttr(name)}" style:family="graphic">` +
        '<style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" ' +
        'fo:border="0.5pt solid #808080" fo:padding="0.05cm" draw:fill="solid" draw:fill-color="#f2f2f2" ' +
        'fo:background-color="#f2f2f2"/></style:style>',
    )
    const parent = rctx.map.styles.baseParagraphStyle
    const paragraph = rctx.derivedStyle(
      env.part,
      'export-label-paragraph',
      'P',
      (name) =>
        `<style:style style:name="${escapeXmlAttr(name)}" style:family="paragraph"` +
        `${parent ? ` style:parent-style-name="${escapeXmlAttr(parent)}"` : ''}>` +
        '<style:paragraph-properties fo:text-align="center" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:text-indent="0cm" fo:line-height="100%"/>' +
        '<style:text-properties fo:color="#595959" fo:font-size="9pt" style:font-size-asian="9pt" style:font-size-complex="9pt"/></style:style>',
    )
    return (
      `<draw:frame draw:style-name="${escapeXmlAttr(graphic)}" text:anchor-type="as-char" ` +
      `svg:width="${emuToCm(cx)}" svg:height="${emuToCm(cy)}">` +
      `<draw:text-box><text:p text:style-name="${escapeXmlAttr(paragraph)}">${escapeXmlText(LABEL_TEXT[kind])}</text:p></draw:text-box></draw:frame>`
    )
  },
}

/** A 1×1 PNG of one colour (stored zlib block), for drawn rules. */
export function solidPng(r: number, g: number, b: number): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat(data)
    const crc = crc32(new Uint8Array(body))
    const len = data.length
    return [
      (len >>> 24) & 255,
      (len >>> 16) & 255,
      (len >>> 8) & 255,
      len & 255,
      ...body,
      (crc >>> 24) & 255,
      (crc >>> 16) & 255,
      (crc >>> 8) & 255,
      crc & 255,
    ]
  }
  const raw = [0, r, g, b]
  let a = 1
  let s = 0
  for (const x of raw) {
    a = (a + x) % 65521
    s = (s + a) % 65521
  }
  const zlib = [0x78, 0x01, 0x01, raw.length, 0, ~raw.length & 255, 0xff, ...raw]
  zlib.push((s >>> 8) & 255, s & 255, (a >>> 8) & 255, a & 255)
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    ...chunk('IDAT', zlib),
    ...chunk('IEND', []),
  ])
}
