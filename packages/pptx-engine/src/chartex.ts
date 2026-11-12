/**
 * chartEx parsing (2014 cx namespace: ppt/charts/chartExN.xml → ChartModel).
 *
 * Modern chart types PowerPoint stores outside the classic c: namespace.
 * Supported layoutIds: funnel (categories + values → centered bars) and
 * sunburst (multi-level strDim hierarchy + leaf sizes → rings). Other
 * layoutIds (waterfall, treemap, …) return null and fall back to the chip.
 */
import { type Theme } from './theme'
import type { ChartModel } from './chart'
import { call } from './engine'

export function parseChartExXml(xml: string, theme?: Theme): ChartModel | null {
  return call('parseChartExXml', [xml, theme], { shape: {"k":"obj","f":{"series":{"k":"arr","v":{"k":"obj","f":{"pointColors":{"k":"arr","u":true},"pointFills":{"k":"arr","u":true},"pointNoFill":{"k":"arr","u":true},"pointLines":{"k":"arr","u":true},"pointExplosionPct":{"k":"arr","u":true}}}},"sunburst":{"k":"obj","f":{"pointColors":{"k":"arr","u":true}}}}} }) as never
}