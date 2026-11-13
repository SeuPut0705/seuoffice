/**
 * The JSON of the bridge map's feature slots as `AGENTS.md` documents it:
 * `ext.table`, `ext.page`. (`ext.objects` is the public `ObjectsExt`.) Tests
 * read the map through these shapes; the engine does not export them.
 */
import type { BridgeMap } from '../../src'

export interface RangeRecord {
  start: number
  end: number
}

export interface ElementRecord extends RangeRecord {
  openEnd: number
  closeStart: number
  selfClosing: boolean
}

export interface NestedStep {
  row: number
  col: number
  index: number
}

export type UnitRecord =
  | { kind: 'p'; paragraph: number; start: number; end: number }
  | { kind: 't'; table: number; start: number; end: number }
  | {
      kind: 'f'
      start: number
      end: number
      paragraph: number | null
      paragraphFirst: boolean
      tables: number[]
    }

export interface AnchorCellRecord extends ElementRecord {
  kind: 'cell'
  tc: number
  style: string | null
  units: UnitRecord[]
  colSpan?: number
  rowSpan?: number
  protected?: true
  synthetic?: 'trailing' | 'empty'
}

export interface CoveredCellRecord extends RangeRecord {
  kind: 'covered'
  anchor: [number, number]
  tc: number | null
}

export interface EmptyCellRecord extends RangeRecord {
  kind: 'orphan' | 'filler'
  tc: number
}

export type CellRecord = AnchorCellRecord | CoveredCellRecord | EmptyCellRecord

export interface RowRecord extends ElementRecord {
  header: boolean
  style: string | null
  heightCm: number | null
}

export interface ColumnRecord extends ElementRecord {
  style: string | null
  repeated: boolean
  widthTwips: number
}

export interface FrameRecord {
  paragraph: RangeRecord
  frame: ElementRecord
  style: string | null
  anchor: string | null
}

export interface TableRecord extends ElementRecord {
  id: number
  block: number
  element: number | null
  host: { table: number; row: number; col: number; index: number } | null
  frame: FrameRecord | null
  headerRows: ElementRecord | null
  rows: RowRecord[]
  columns: ColumnRecord[]
  cells: CellRecord[][]
  widthTwips: number
  structureLocked: string | null
}

export interface TableExt {
  version: 1
  tables: TableRecord[]
  elements: Record<string, number>
  protectedCells: Array<{ table: number; path: NestedStep[]; row: number; col: number; tc: number }>
}

export type HfRegion =
  'header' | 'header-left' | 'header-first' | 'footer' | 'footer-left' | 'footer-first'

export interface PageHfPart {
  rId: string
  path: string
  kind: 'header' | 'footer'
  master: string
  region: HfRegion | null
  fill: 'content' | 'fallback' | 'empty'
  paragraphs: number[]
  xml: string
}

export interface PageRun {
  master: string | null
  layout: string | null
  startParagraph: number | null
  startBlock: number | null
  startStyle: string | null
  startFamily: 'paragraph' | 'table' | null
  hidden: boolean
  slots: Partial<Record<HfRegion, string>>
}

export interface DocxSection {
  run: number
  region: number | null
  continuous: boolean
  first: number | null
  last: number | null
  carrier: number | null
  sectPr: string
}

export interface PageExt {
  version: 1
  defaultMaster: string | null
  evenAndOdd: boolean
  runs: PageRun[]
  sections: DocxSection[]
  parts: Record<string, PageHfPart>
}

/** `ext.page` of a map, or null when it has none. */
export function pageExtOf(map: Pick<BridgeMap, 'ext'>): PageExt | null {
  const ext = map.ext.page as unknown as PageExt | undefined
  return ext && ext.version === 1 ? ext : null
}
