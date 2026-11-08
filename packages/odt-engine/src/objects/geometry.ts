/**
 * Lengths and the OOXML drawing markup of bridge pictures.
 */
import { escapeXmlAttr } from '../core/xml'

export const EMU_PER_CM = 360000

/** An ODF length (`4.547cm`, `12pt`, `1in` …) in EMU, or null. */
export function lengthToEmu(value: string | undefined | null): number | null {
  if (!value) return null
  const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(cm|mm|in|inch|pt|pc|px)?\s*$/.exec(value)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2] ?? 'cm'
  const per: Record<string, number> = {
    cm: EMU_PER_CM,
    mm: 36000,
    in: 914400,
    inch: 914400,
    pt: 12700,
    pc: 152400,
    px: 9525,
  }
  return Math.round(n * per[unit])
}

/** EMU as an ODF centimetre length with at most three decimals (`2cm`, `4.763cm`). */
export function emuToCm(emu: number): string {
  const cm = Math.round((emu / EMU_PER_CM) * 1000) / 1000
  return `${cm}cm`
}

/** Placement of a floating drawing. */
export interface DrawingAnchor {
  h: { relativeFrom: string; offset: number | null; align: string | null }
  v: { relativeFrom: string; offset: number | null; align: string | null }
  wrap: 'none' | 'square' | 'topAndBottom'
  behind: boolean
  z: number
}

export interface DrawingSpec {
  docPrId: number
  name: string
  descr?: string
  rId: string
  cx: number
  cy: number
  /** null → inline (`wp:inline`) */
  anchor: DrawingAnchor | null
}

const PIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

/** The `<w:drawing>` of one picture. */
export function drawingXml(spec: DrawingSpec): string {
  const cx = Math.max(1, Math.round(spec.cx))
  const cy = Math.max(1, Math.round(spec.cy))
  const name = escapeXmlAttr(spec.name)
  const descr = spec.descr ? ` descr="${escapeXmlAttr(spec.descr)}"` : ''
  const docPr = `<wp:docPr id="${spec.docPrId}" name="${name}"${descr}/>`
  const graphic =
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${PIC_URI}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${spec.docPrId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${escapeXmlAttr(spec.rId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic>'
  const extent = `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
  const a = spec.anchor
  if (!a) {
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent}${docPr}${graphic}</wp:inline></w:drawing>`
  }
  const pos = (axis: 'H' | 'V', p: DrawingAnchor['h']) =>
    `<wp:position${axis} relativeFrom="${p.relativeFrom}">` +
    (p.align !== null
      ? `<wp:align>${p.align}</wp:align>`
      : `<wp:posOffset>${Math.round(p.offset ?? 0)}</wp:posOffset>`) +
    `</wp:position${axis}>`
  const wrap =
    a.wrap === 'none'
      ? '<wp:wrapNone/>'
      : a.wrap === 'square'
        ? '<wp:wrapSquare wrapText="bothSides"/>'
        : '<wp:wrapTopAndBottom/>'
  return (
    `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${251658240 + Math.max(0, Math.min(1000000, a.z))}" ` +
    `behindDoc="${a.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
    `${pos('H', a.h)}${pos('V', a.v)}${extent}${wrap}${docPr}${graphic}</wp:anchor></w:drawing>`
  )
}

/** Facts the save path reads back from an edited `<w:drawing>`. */
export interface DrawingFacts {
  name: string | null
  cx: number | null
  cy: number | null
  rId: string | null
  anchored: boolean
  xOffset: number | null
  yOffset: number | null
}

const decodeAttr = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function readDrawing(xml: string): DrawingFacts {
  const docPr = /<wp:docPr\b[^>]*>/.exec(xml)?.[0] ?? ''
  const name = /\bname\s*=\s*"([^"]*)"/.exec(docPr)?.[1]
  const extent = /<wp:extent\b[^>]*>/.exec(xml)?.[0] ?? ''
  const num = (tag: string, attr: string) => {
    const v = new RegExp(`\\b${attr}\\s*=\\s*"(-?\\d+)"`).exec(tag)?.[1]
    return v === undefined ? null : parseInt(v, 10)
  }
  const offset = (axis: 'H' | 'V') => {
    const m = new RegExp(
      `<wp:position${axis}\\b[^>]*>\\s*<wp:posOffset>(-?\\d+)</wp:posOffset>`,
    ).exec(xml)
    return m ? parseInt(m[1], 10) : null
  }
  return {
    name: name === undefined ? null : decodeAttr(name),
    cx: num(extent, 'cx'),
    cy: num(extent, 'cy'),
    rId: /<a:blip\b[^>]*\br:embed\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null,
    anchored: /<wp:anchor\b/.test(xml),
    xOffset: offset('H'),
    yOffset: offset('V'),
  }
}

/** Every `<w:drawing>` fragment of an OOXML string, in order. */
export function drawingsOf(xml: string): string[] {
  return xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? []
}
