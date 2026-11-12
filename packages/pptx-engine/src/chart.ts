/**
 * Chart parsing (ppt/charts/chartN.xml → ChartModel).
 *
 * Read-only semantic parsing: on a slide a chart is a separate part referenced by
 * a <p:graphicFrame>; byte fidelity is guaranteed by passing the graphicFrame's
 * anchor bytes through verbatim, and the chart part is never rewritten.
 *
 * Supports data + explicit styling (series colors, axis label styles, gridlines)
 * for lineChart / barChart (incl. horizontal bars) / pieChart (incl. doughnut) /
 * areaChart / scatterChart / radarChart; missing styles fall back to the theme
 * palette. bar/area/line can be combined in one plotArea (column+line combo);
 * combined series carry plotKind and the primary type is picked bar > area > line;
 * series on the secondary value axis (axPos=r, not deleted, matched by the plot's
 * c:axId) carry secondaryAxis, with the secondary axis style/range parsed into
 * valAxis2.
 */
import { type Theme } from './theme'
import type { Fill } from './types'
import { call } from './engine'

export type ChartKind =
  'line' | 'bar' | 'pie' | 'area' | 'scatter' | 'radar' | 'funnel' | 'sunburst' | 'unknown'
export interface ChartSeries {
  name?: string
  /** Bar series with <c:spPr><a:noFill/>: an invisible spacer (waterfall base), never painted */
  noFill?: boolean
  /** Series main color #RRGGBB (explicit spPr color; render layer fills in from the theme palette otherwise) */
  color?: string
  values: Array<number | null>
  /** Combo chart (e.g. bar+line): the plot type this series belongs to; default = ChartModel.kind */
  plotKind?: 'line' | 'bar' | 'area'
  /** Scatter: x values (c:xVal numeric cache; y values in values). Empty → render layer uses ordinals 1..n */
  xValues?: Array<number | null>
  /** Bubble: per-point sizes (c:bubbleSize); marker radius ∝ √size (area represents value) */
  bubbleSizes?: Array<number | null>
  /** Value-from-cells data labels (c15:datalabelsRange cache), shown when the c15
   *  showDataLabelsRange flag is on */
  pointLabels?: string[]
  /** Line: smoothed curve */
  smooth?: boolean
  /** c:idx: automatic palette colors key off this, not document order */
  paletteIdx?: number
  /** Per-series data-label visibility (own c:dLbls, else the plot-level c:dLbls); undefined = fall back to the chart-level flag */
  dataLabels?: boolean
  /** Per-point <c:dLbl> overrides: a point's own show flags replace the series-level set
   *  (PowerPoint writes the complete flag set on each dLbl); `hidden` = <c:delete val="1"/> */
  dLblOverrides?: Array<{
    idx: number
    hidden?: boolean
    val?: boolean
    cat?: boolean
    ser?: boolean
    pct?: boolean
    sizePt?: number
    color?: string
    /** <c:tx><c:rich> literal label text (replaces the composed series/category/value text) */
    text?: string
    bold?: boolean
    /** Point dLbl spPr box colors; null = explicit a:noFill (clears the series box) */
    fill?: string | null
    border?: string | null
  }>
  /** The series block shows nothing and only point-level dLbls turned labels on: points without their own dLbl stay unlabeled */
  dLblOnlyPoints?: boolean
  /** Series-level c:dLbls/c:numFmt (wins over the chart-level format) */
  dataLabelFmt?: string
  /** Series-level c:dLbls/c:spPr: label box fill / outline color */
  dataLabelFill?: string
  dataLabelBorder?: string
  /** Line/scatter series stroke dash (c:spPr a:prstDash, non-solid only) */
  dash?: string
  /** Line/scatter series stroke width (pt, c:spPr a:ln @w) */
  lineWidthPt?: number
  /** Whether to draw data point markers (line defaults to false; scatter/radar default
   *  comes from the style; only set when <c:marker><c:symbol> is explicit) */
  marker?: boolean
  /** Explicit per-point colors <c:dPt> (common for pies; render layer palette otherwise) */
  pointColors?: Array<string | undefined>
  /** Per-point picture/gradient/pattern fills <c:dPt><c:spPr> (bars painted with a bitmap) */
  pointFills?: Array<Fill | undefined>
  /** Pie: <c:dPt><c:spPr><a:noFill/> — the wedge is outline-only */
  pointNoFill?: Array<boolean | undefined>
  /** Pie: per-point outline <c:dPt><c:spPr><a:ln> (color null = explicit no line) */
  pointLines?: Array<{ color: string | null; widthPt?: number } | undefined>
  /** Pie: slice offset from center as percent of diameter (series-level c:explosion → all slices) */
  explosionPct?: number
  /** Pie: per-point explosion overrides (c:dPt/c:explosion) */
  pointExplosionPct?: Array<number | undefined>
  /** Combo dual axes: this series is on the secondary value axis (independent right-side range; decided by the plot's c:axId) */
  secondaryAxis?: boolean
  /** Source cell number format of the values (c:numCache/c:formatCode, omitted for "General"); data-table cells use it */
  valFmt?: string
  /** Series belongs to c:stockChart: no connecting lines, participates in whisker/up-down-bar roles */
  fromStock?: boolean
}
export interface ChartAxisStyle {
  /** Explicit min/max (render layer computes a nice range from the data otherwise) */
  min?: number
  max?: number
  labelColor?: string
  labelSizePt?: number
  labelBold?: boolean
  /** Axis-title run styling (first rich run, else title txPr default run) */
  titleSizePt?: number
  titleBold?: boolean
  titleItalic?: boolean
  titleColor?: string

  /** Explicit tick-label rotation from txPr bodyPr rot (degrees, e.g. -45) */
  labelRotDeg?: number
  /** txPr defRPr cap="all" / spc (letter spacing, pt) on the tick labels */
  labelCaps?: boolean
  labelSpcPt?: number
  /** <c:delete val="1"/>: axis hidden (no tick labels or axis line) but its scale still applies */
  hidden?: boolean
  /** Tick labels off (<c:tickLblPos val="none"/>): no labels, no reserved space */
  tickLblHidden?: boolean
  /** <c:tickLblPos val="low"/"high">: labels pinned to the plot edge instead of next to the axis line */
  tickLblPos?: 'low' | 'high'
  /** Labels not rendered but their space still reserved (invalid txPr baseline sentinel) */
  tickLblGarbage?: boolean
  /** <c:numFmt formatCode>: source-linked data labels format numbers with this (omitted for "General") */
  numFmt?: string
  lineColor?: string
  /** <c:spPr><a:ln><a:noFill/>: the axis line is not drawn (labels/ticks unaffected) */
  lineHidden?: boolean
  gridColor?: string
  /** gridColor is the fallback (no explicit spPr color); the render layer picks the real default by hasStylePart */
  gridColorAuto?: boolean
  gridDash?: boolean
  /** prstDash value (dash/dashDot/sysDash/...) for a finer dash pattern */
  gridDashVal?: string
  /** Explicit major gridline width (EMU) */
  gridWidthEmu?: number
  /** Minor gridlines: only drawn with an explicit color (PowerPoint hides them by default) */
  minorGridColor?: string
  minorGridWidthEmu?: number
  /** <c:minorGridlines/> present without an explicit color */
  minorGridAuto?: boolean
  /** Explicit tick units (c:majorUnit / c:minorUnit) */
  majorUnit?: number
  minorUnit?: number
  /** Category-axis explicit skips: label every Nth category / tick+gridline every Nth slot */
  tickLblSkip?: number
  tickMarkSkip?: number
  title?: string
  /** <c:title><c:overlay val="1"/>: the axis title floats over the plot, reserving no space */
  titleOverlay?: boolean
  /** <c:orientation val="maxMin"/>: categories/values reversed (common for bar charts with the first category on top) */
  reversed?: boolean
  /** <c:logBase>: logarithmic value axis (ticks at powers of the base) */
  logBase?: number
  /** <c:crosses>: where this axis crosses the other one (max = at the far end) */
  crosses?: 'autoZero' | 'min' | 'max'
  /** The category axis is a c:dateAx (PowerPoint rotates its labels as soon as they collide) */
  isDate?: boolean
}
/** <c:dTable>: the data table PowerPoint draws under the category axis */
export interface ChartDataTable {
  showKeys: boolean
  horzBorder: boolean
  vertBorder: boolean
  outline: boolean
  sizePt?: number
  textColor?: string
  lineColor?: string
}
export interface ChartModel {
  kind: ChartKind
  /** bar only: col = vertical columns, bar = horizontal bars */
  barDir?: 'col' | 'bar'
  grouping?: 'clustered' | 'stacked' | 'percentStacked' | 'standard'
  /** Gap between bars (% of bar width, c:gapWidth, default 150) */
  gapWidthPct?: number
  /** Series overlap within a category (% of bar width, c:overlap; negative spreads bars apart) */
  overlapPct?: number
  categories: string[]
  series: ChartSeries[]
  /** Legend position (undefined when there is no c:legend) */
  legendPos?: 't' | 'b' | 'l' | 'r' | 'tr'
  /** Legend text size (pt) from c:legend/c:txPr default run properties */
  legendPt?: number
  legendBold?: boolean
  /** Legend txPr defRPr solid fill (legend text color; absent = axis label color) */
  legendColor?: string
  /** <c:legend><c:overlay val="1"/>: the legend floats over the plot, reserving no space */
  legendOverlay?: boolean
  /** Series indices in PowerPoint's legend display order with c:legendEntry deletions applied
   *  (absent = document order, nothing deleted) */
  legendOrder?: number[]
  /** c:legend manual layout: factor = offset from the auto position, edge = absolute, fractions of the frame */
  legendLayout?: {
    x?: number
    y?: number
    w?: number
    h?: number
    xMode?: 'edge' | 'factor'
    yMode?: 'edge' | 'factor'
  }
  /** Legend paragraphs are RTL (<c:legend><c:txPr>…<a:pPr rtl="1">): entries mirror (swatch right of the text, right-aligned rows) */
  legendRtl?: boolean
  /** Chart part has a Microsoft chartStyle companion (style1.xml); without one PowerPoint uses black label text */
  hasStylePart?: boolean
  /** Plot-area inner rectangle (c:plotArea/c:layout/c:manualLayout layoutTarget=inner), fractions of the chart frame */
  plotLayout?: { x: number; y: number; w: number; h: number }
  valAxis?: ChartAxisStyle
  /** Data table under the plot (c:plotArea/c:dTable) */
  dataTable?: ChartDataTable
  /** Secondary value axis (right side, combo column+line dual axes; undefined without a right value axis or style info) */
  valAxis2?: ChartAxisStyle
  catAxis?: ChartAxisStyle
  /** Doughnut hole (% of radius, c:holeSize; pie = 0) */
  holePct?: number
  /** First slice start angle (degrees, 12 o'clock = 0, clockwise; c:firstSliceAng) */
  firstSliceAngDeg?: number
  /** Scatter style (c:scatterStyle: line/lineMarker/marker/smooth/smoothMarker/none) */
  scatterStyle?: string
  /** Radar style (c:radarStyle) */
  radarStyle?: 'standard' | 'marker' | 'filled'
  /** Multi-level category axis: outer-level group labels with their starting leaf index */
  categoryGroups?: Array<{ label: string; start: number }>
  /** Data labels (showVal or showPercent on plot/ser-level c:dLbls) */
  dataLabels?: boolean
  /** Data labels show percentages only (showPercent only, common for pies) */
  dataLabelsPct?: boolean
  /** Data labels show both the value and the percentage ("0.28, 11%") */
  dataLabelsValPct?: boolean
  /** c:ofPieChart: the last splitPos points break out into a secondary pie (secondPieSize %
   *  of the main pie, gapWidth % of its diameter apart) */
  ofPie?: { splitPos: number; secondPieSize: number; gapWidth: number }
  /** Percent data labels divide by this instead of the series sum (pie-of-pie secondary pie) */
  pctBase?: number
  /** Data labels include the series name / category name (c:showSerName / c:showCatName) */
  dataLabelSerName?: boolean
  dataLabelCatName?: boolean
  /** Data labels omit the value itself (name-only labels) */
  dataLabelNoValue?: boolean
  /** Data-label number format (c:dLbls/c:numFmt formatCode, else the value axis's; omitted for "General") */
  dataLabelFmt?: string
  /** Data-label text size (pt) / bold from c:dLbls/c:txPr */
  dataLabelPt?: number
  dataLabelBold?: boolean
  /** c:dLbls/c:txPr bodyPr rot (degrees; -90 = reads bottom-to-top) */
  dataLabelRotDeg?: number
  dataLabelCaps?: boolean
  dataLabelSpcPt?: number
  /** Chart title (concatenated rich text of c:chart/c:title) */
  title?: string
  /** Title font size (pt) from c:title/c:txPr default run properties */
  titlePt?: number
  /** <c:title><c:overlay val="1"/>: the title floats over the plot, reserving no space */
  titleOverlay?: boolean
  /** Explicit c:title run styling (txPr default run, else the first rich run) */
  titleBold?: boolean
  titleItalic?: boolean
  titleColor?: string
  /** Title run cap="all" / spc (letter spacing, pt) */
  titleCaps?: boolean
  titleSpcPt?: number
  /** chartSpace-level <c:spPr> fill (whole-chart background, e.g. picture fill) */
  bgFill?: Fill
  /** Plot-area fill (c:plotArea's own spPr) */
  plotFill?: Fill
  /** Plot-area border (c:plotArea spPr ln) */
  plotBorder?: { color: string; widthEmu: number }
  /** chartSpace-level <c:spPr><a:ln> frame border around the whole chart */
  border?: { color: string; widthEmu: number }
  /** Theme accent1..6 resolved to #RRGGBB (default series/wedge colors, PowerPoint varyColors order) */
  themePalette?: string[]
  /** Pie: explicit <c:varyColors val="0"/> — every wedge uses the series color */
  varyColors?: boolean
  /** Bubble: <c:bubbleScale> % (default 100), scales the largest bubble's diameter */
  bubbleScale?: number
  /** Bubble: <c:sizeRepresents val="w"/> — size maps to diameter instead of area */
  bubbleSizeIsWidth?: boolean
  /** Stock chart: series are (open,)high,low,close roles in document order */
  stock?: { hiLowLines: boolean; upDownBars: boolean; gapWidthPct?: number }
  /** Sunburst (chartEx): levels leaf-first as stored (levels[0][i] = leaf label of point i,
   *  later levels = ancestors); '' = the point ends at a shallower depth. sizes align by point. */
  sunburst?: {
    levels: string[][]
    sizes: Array<number | null>
    pointColors?: Array<string | undefined>
  }
  /** chartUserShapes straight-line overlays; coordinates are fractions of the chart frame */
  userLines?: Array<{
    x1: number
    y1: number
    x2: number
    y2: number
    color: string
    widthEmu: number
  }>
  /** chartSpace-level <c:txPr> default text size (pt); chart text without its own txPr uses this */
  defaultTextPt?: number
  /** Chart text typeface (chartSpace txPr, else the first axis / legend / label / title txPr); render layer defaults to Calibri */
  fontFamily?: string
  /** chartSpace-level <c:txPr> default text color, or the legacy <c:style> row default (41-48 → lt1) */
  defaultTextColor?: string
  /** 3D chart type (pie3D/bar3D/…): render layer draws a pseudo-3D look on the 2D pipeline */
  pseudo3D?: boolean
  /** c:view3D rotX (degrees) — controls the pie tilt / bar extrusion feel */
  rotXDeg?: number
  /** c:bar3DChart: full 3D stage (series spread along a depth axis); angles in degrees */
  bar3D?: {
    rotX: number
    rotY: number
    /** c:depthPercent: bar depth as % of bar width */
    depthPct: number
    /** c:rAngAx: right-angle axes (parallel skew projection; PowerPoint's default) */
    rAngAx: boolean
    /** c:gapDepth: gap between depth rows as % of bar depth */
    gapDepthPct: number
    /** c:serAx present and visible: PowerPoint labels series names along the depth axis */
    serAxLabels: boolean
  }
  /** c:area3DChart: full 3D stage (standard grouping spreads series along the depth axis) */
  area3D?: {
    rotX: number
    rotY: number
    /** c:gapDepth: gap between depth rows as % of ribbon depth */
    gapDepthPct: number
    serAxLabels: boolean
  }
}
/** Parse one chartN.xml. Returns null for unrecognized plot types (caller falls back to a placeholder chip). */
export function parseChartXml(
  xml: string,
  theme?: Theme,
  /** DrawingML fill resolver (injected by parse.ts so chart-part blip rIds resolve correctly) */
  resolveFill?: (spPr: unknown) => Fill | undefined,
): ChartModel | null {
  return call('parseChartXml', [xml, theme, resolveFill], { names: ["xml","theme","resolveFill"], shape: {"k":"obj","f":{"series":{"k":"arr","v":{"k":"obj","f":{"pointColors":{"k":"arr","u":true},"pointFills":{"k":"arr","u":true},"pointNoFill":{"k":"arr","u":true},"pointLines":{"k":"arr","u":true},"pointExplosionPct":{"k":"arr","u":true}}}},"sunburst":{"k":"obj","f":{"pointColors":{"k":"arr","u":true}}}}} }) as never
}