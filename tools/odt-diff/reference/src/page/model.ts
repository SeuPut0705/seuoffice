/**
 * The page layer's slot in the bridge map (`ext.page`): how the bridge docx's
 * sections, section breaks and header/footer parts map back onto the ODT's
 * master pages and page layouts. Plain JSON, like the rest of the map.
 */
import type { BridgeMap, JsonValue } from '../core/convert'
import type { OdtMasterPageRegionName } from '../core/styles'

/** Key of the page layer in `BridgeMap.ext`. */
export const PAGE_EXT_KEY = 'page'
/** Owner id recorded on header/footer paragraphs. */
export const PAGE_OWNER = 'page'

/** A header/footer region of a master page; doubles as the docx slot it fills. */
export type HfRegion = OdtMasterPageRegionName

export const HF_REGIONS: readonly HfRegion[] = [
  'header',
  'header-left',
  'header-first',
  'footer',
  'footer-left',
  'footer-first',
]

/** One header/footer part of the bridge docx. */
export interface PageHfPart {
  rId: string
  /** zip path (`word/header1.xml`) */
  path: string
  kind: 'header' | 'footer'
  /** master page the part was made for */
  master: string
  /** the master page region whose paragraphs it shows (null for an empty filler) */
  region: HfRegion | null
  /**
   * `content`: the slot's own region. `fallback`: the slot has no region and
   * ODF shows another one in its place (a first or left page without its own
   * header shows the plain header). `empty`: a blank part that stops Word from
   * inheriting the previous section's part.
   */
  fill: 'content' | 'fallback' | 'empty'
  /** bridge paragraph records of the region's paragraphs, in order */
  paragraphs: number[]
  /** the exact part XML written (an unchanged part reads back byte for byte) */
  xml: string
}

/** One run of pages under one master page (an ODF "page section"). */
export interface PageRun {
  /** master page name (null when the document has none) */
  master: string | null
  /** page layout of the master page */
  layout: string | null
  /** paragraph record whose style switches to the master page, or null (implicit first run) */
  startParagraph: number | null
  /** bridge block whose start tag carries that style, or null */
  startBlock: number | null
  /** the style carrying `style:master-page-name` */
  startStyle: string | null
  startFamily: 'paragraph' | 'table' | null
  /** no docx section shows this run (its content shares a neighbour's section) */
  hidden: boolean
  /** header/footer parts by slot (rId) */
  slots: Partial<Record<HfRegion, string>>
}

/** One section of the bridge docx. */
export interface DocxSection {
  /** index into `PageExt.runs` */
  run: number
  /** bridge block of the `text:section` it lies in, or null */
  region: number | null
  /** starts without a page break (a `text:section` boundary) */
  continuous: boolean
  /** first and last bridge element (null when the section is empty) */
  first: number | null
  last: number | null
  /** bridge element whose paragraph carries the `w:sectPr` (null for the final section) */
  carrier: number | null
  /** exact `w:sectPr` written */
  sectPr: string
}

export interface PageExt {
  version: 1
  /** the master page used before any paragraph names one */
  defaultMaster: string | null
  /** the bridge docx sets `w:evenAndOddHeaders` */
  evenAndOdd: boolean
  runs: PageRun[]
  sections: DocxSection[]
  /** header/footer parts by rId */
  parts: Record<string, PageHfPart>
}

export function readPageExt(map: Pick<BridgeMap, 'ext'>): PageExt | null {
  const ext = map.ext[PAGE_EXT_KEY] as unknown as PageExt | undefined
  return ext && ext.version === 1 ? ext : null
}

export function writePageExt(map: Pick<BridgeMap, 'ext'>, ext: PageExt): void {
  map.ext[PAGE_EXT_KEY] = ext as unknown as JsonValue
}
