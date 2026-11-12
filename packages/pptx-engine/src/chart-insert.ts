/**
 * Chart insertion — writes the chart part (ppt/charts/chartN.xml) + Content_Types
 * Override + slide rels + graphicFrame fragment, going through appendRawElements to
 * reuse the existing chart parsing/rendering.
 *
 * The chartSpace template mirrors docx-engine's buildChartPartXml: the data goes through
 * strCache/numCache caches, and the embedded workbook (chart-workbook.ts) holds the same
 * data for PowerPoint's "Edit Data".
 */
import type { EmuRect, Slide } from './types'
import { type OpenedPptx } from './index'
import { call } from './engine'

export type NewChartKind =
  | 'bar'
  | 'barStacked'
  /** Percent-stacked column (no insert entry point; used to preserve the type subdivision when rebuilding an externally created chart during edits) */
  | 'barPercentStacked'
  | 'line'
  | 'area'
  | 'pie'
  | 'doughnut'
  | 'scatter'
  | 'radar'
  /** Combo chart: first N-1 series as clustered columns, last series as a line (on the right secondary value axis) */
  | 'comboBarLine'
  /** 3-D pie (c:pie3DChart + c:view3D; this app renders the pseudo-3D projection, PowerPoint renders true 3-D) */
  | 'pie3D'
  /** 3-D clustered column (c:bar3DChart + c:view3D) */
  | 'bar3D'
/** Chart element/style toggles (unset = current defaults: legend at bottom, no gridlines, no data labels). */
export interface ChartStyleOptions {
  /** Legend position; 'none' = do not write c:legend */
  legendPos?: 'b' | 't' | 'r' | 'l' | 'none'
  /** Data labels (plot-level c:dLbls showVal) */
  dataLabels?: boolean
  /** Major gridlines on the value axis */
  gridlines?: boolean
  catAxisTitle?: string
  valAxisTitle?: string
  /** Gap between bars (% of bar width, c:gapWidth, PowerPoint default 150) */
  gapWidthPct?: number
}
export interface NewChartOptions extends ChartStyleOptions {
  kind: NewChartKind
  title?: string
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  offset: EmuRect
  /** Bar direction (bar = horizontal bar chart; no insert entry point, used to preserve the direction when rebuilding an externally created chart during edits) */
  barDir?: 'col' | 'bar'
  /** Per-point fills, [seriesIdx][pointIdx] (sparse; written as <c:dPt>, wins over the series color) */
  pointColors?: Array<Array<string | undefined> | undefined>
  /** Per-series solid colors (#RRGGBB, cycled); line-like series color the stroke, others the fill */
  colorScheme?: string[]
  /** Doughnut hole size (percent, c:holeSize, default 50) */
  holeSizePct?: number
}
/**
 * Full c:chartSpace part XML. `externalDataRId` names the chart's relationship to its
 * embedded workbook, which PowerPoint opens for "Edit Data".
 */
export function buildChartSpaceXml(opts: NewChartOptions, externalDataRId?: string): string {
  return call('buildChartSpaceXml', [opts, externalDataRId]) as never
}
/**
 * Writes the chart's embedded workbook from the data in `opts` and returns the relationship
 * id c:externalData names. The workbook the chart part already points at is overwritten in
 * place; another data source (a linked file, an OLE object) is dropped, since the chart is
 * rebuilt from this data.
 */
export function writeChartWorkbook(
  opened: OpenedPptx,
  chartPath: string,
  opts: Pick<NewChartOptions, 'kind' | 'categories' | 'series'>,
): string {
  return call('writeChartWorkbook', [opened, chartPath, opts], { mut: { 0: 'opened' } }) as never
}
/**
 * Insert a chart: part surgery + graphicFrame fragment append + reparse.
 * Returns the new slide and element id (all ids on the slide refreshed).
 */
export function addChart(
  opened: OpenedPptx,
  slideIndex: number,
  opts: NewChartOptions,
): { slide: Slide; elementId: string } | null {
  const v = call('addChart', [opened, slideIndex, opts], { mut: { 0: 'opened' } }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
