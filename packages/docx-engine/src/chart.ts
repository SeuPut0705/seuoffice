import { colLetter } from '@seuoffice/pptx-engine/chart-workbook'
import type { ChartDisplay, NewChart, ThemeColors } from './types'
import { invoke, invokeAsync } from './engine'

export { CHART_WORKBOOK_REL_TYPE, colLetter } from '@seuoffice/pptx-engine/chart-workbook'
/**
 * Read the display model of a chart part (word/charts/chartN.xml). Only the
 * caches Word writes next to the data references (c:strCache / c:numCache)
 * are read — the embedded workbook is never opened. Returns null when the
 * part has no series with cached values.
 */
export function parseChartPartXml(
  xml: string,
  partPath: string,
  theme?: ThemeColors | null,
): ChartDisplay | null {
  return invoke('parseChartPartXml', [xml, partPath, theme]) as never
}
/** a:lumMod/a:lumOff — HSL luminance L' = L*mod + off */
export function lumHex(hex: string, mod: number, off: number): string {
  return invoke('lumHex', [hex, mod, off]) as never
}
/**
 * Build a complete chart part (word/charts/chartN.xml) from data. The chart
 * references an embedded workbook via c:externalData so Word's "Edit Data" works.
 * Pass `externalDataRId` to wire the c:externalData relationship; omit it when
 * the workbook will be added in a separate step.
 */
export function buildChartPartXml(chart: NewChart, externalDataRId?: string): string {
  return invoke('buildChartPartXml', [chart, externalDataRId ?? '']) as never
}
export interface ChartSeriesPatch {
  name?: string
  /** aligned with ChartSeries.values; null = keep the original value */
  values?: (number | null)[]
}
export interface ChartPatch {
  title?: string
  /** aligned with ChartDisplay.categories; null = keep */
  categories?: (string | null)[]
  /** aligned with ChartDisplay.series; null = keep that series untouched */
  series?: (ChartSeriesPatch | null)[]
}
/**
 * Patch cached texts/numbers of a chart part while keeping the structure —
 * data references (c:f), styling, layout — byte-identical. Anything the
 * patch cannot anchor (missing title, missing cache point) is left as-is.
 * The embedded workbook is intentionally not touched: Word renders from
 * these caches, but "Edit Data" will show the original sheet numbers.
 */
export function patchChartPartXml(xml: string, patch: ChartPatch): string {
  return invoke('patchChartPartXml', [xml, patch]) as never
}
// ---- embedded xlsx workbook ----

/** The chart's embedded workbook (pptx-engine's chart-workbook.ts), base64-encoded. */
export async function buildChartWorkbookXlsxBase64(
  categories: string[],
  series: Array<{ name: string; values: (number | null)[] }>,
): Promise<string> {
  return invokeAsync('buildChartWorkbookXlsxBase64', [categories, series, Date.now()]) as never
}
/**
 * Patch the Sheet1 sheetData inside an embedded xlsx file (base64).
 * Rewrites category column A and each series column with the provided values.
 * Returns the updated base64, or null on failure.
 */
export async function patchChartWorkbookXlsxBase64(
  base64: string,
  categories: string[],
  series: Array<{ name: string; values: (number | null)[] }>,
): Promise<string | null> {
  return invokeAsync('patchChartWorkbookXlsxBase64', [base64, categories, series, Date.now()]) as never
}