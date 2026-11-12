// Group `chart` of comparison (f): chart.ts and chartex.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_chart.rs to `pptxChart.<module>.<TypeScript name>`.
import { parseChartXml } from '../../packages/pptx-engine/src/chart'
import { parseChartExXml } from '../../packages/pptx-engine/src/chartex'
import {
  parseClrMap,
  parseTheme,
  type Theme,
  themeWithOverride,
} from '../../packages/pptx-engine/src/theme'
import type { Fill } from '../../packages/pptx-engine/src/types'
import { relsPathFor, resolveTarget } from '../../packages/pptx-engine/src/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { mulberry32 } from '../docx-diff/synthetic'

type Args = Record<string, unknown>
type Parts = ReadonlyMap<string, string>

/** A value as it reaches Rust: keys that hold undefined are gone. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * `resolveFill` is a function and cannot cross JSON. `args.resolveFill:
 * 'stub'` passes this resolver; the Rust dispatch holds the same rule.
 */
function stubFill(spPr: unknown): Fill | undefined {
  if (!spPr || typeof spPr !== 'object' || Array.isArray(spPr)) return undefined
  const sp = spPr as Record<string, unknown>
  const own = (o: unknown, k: string): unknown =>
    o && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k)
      ? (o as Record<string, unknown>)[k]
      : undefined
  if (Object.hasOwn(sp, 'a:noFill')) return { type: 'none' }
  if (Object.hasOwn(sp, 'a:blipFill')) {
    return {
      type: 'image',
      mediaRef: String(own(own(sp['a:blipFill'], 'a:blip'), '@_r:embed') ?? ''),
    }
  }
  if (Object.hasOwn(sp, 'a:pattFill')) {
    return {
      type: 'pattern',
      fg: '#000000',
      bg: '#FFFFFF',
      preset: String(own(sp['a:pattFill'], '@_prst') ?? ''),
    }
  }
  if (Object.hasOwn(sp, 'a:gradFill')) return { type: 'gradient', stops: [] }
  return undefined
}

// ── Themes ────────────────────────────────────────────────────────────

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

const themeXml = (
  colors: Array<[string, string]>,
  major = 'Calibri Light',
  minor = 'Calibri',
): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<a:theme ${A_NS} name="Office Theme"><a:themeElements>` +
  `<a:clrScheme name="Office">${colors.map(([k, c]) => `<a:${k}>${c}</a:${k}>`).join('')}</a:clrScheme>` +
  `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="${minor}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  '</a:themeElements></a:theme>'

const srgbSlot = (hex: string): string => `<a:srgbClr val="${hex}"/>`
const OFFICE_COLORS: Array<[string, string]> = [
  ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
  ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
  ['dk2', srgbSlot('44546A')],
  ['lt2', srgbSlot('E7E6E6')],
  ['accent1', srgbSlot('4472C4')],
  ['accent2', srgbSlot('ED7D31')],
  ['accent3', srgbSlot('A5A5A5')],
  ['accent4', srgbSlot('FFC000')],
  ['accent5', srgbSlot('5B9BD5')],
  ['accent6', srgbSlot('70AD47')],
  ['hlink', srgbSlot('0563C1')],
  ['folHlink', srgbSlot('954F72')],
]
const T_OFFICE = wire(parseTheme(themeXml(OFFICE_COLORS)))
/** Five accents (no palette), dark dk1/lt1 and other fonts. */
const T_PARTIAL = wire(
  parseTheme(
    themeXml(
      [['dk1', srgbSlot('101010')], ['lt1', srgbSlot('FAFAFA')], ...OFFICE_COLORS.slice(4, 9)],
      'Georgia',
      '',
    ),
  ),
)
const T_DARK = wire({
  ...T_OFFICE,
  clrMap: parseClrMap(
    '<p:clrMap xmlns:p="p" bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent2" accent2="accent1" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>',
  ),
})
const T_EMPTY = wire(parseTheme(''))

// ── Chart part builders ───────────────────────────────────────────────

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  `${A_NS} ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart" ' +
  'xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

const space = (chart: string, pre = '', post = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${NS}>${pre}<c:chart>${chart}</c:chart>${post}</c:chartSpace>`

const v = (tag: string, val: string | number): string => `<c:${tag} val="${val}"/>`
type Pt = string | number | null
const pts = (vals: Pt[]): string =>
  vals.map((x, i) => (x === null ? '' : `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`)).join('')
const strCache = (vals: Pt[], count: number | string = vals.length): string =>
  `<c:strCache><c:ptCount val="${count}"/>${pts(vals)}</c:strCache>`
const strRef = (vals: Pt[], count?: number | string): string =>
  `<c:strRef><c:f>Sheet1!$A$2:$A$9</c:f>${strCache(vals, count)}</c:strRef>`
const numCache = (vals: Pt[], fmt = 'General', count: number | string = vals.length): string =>
  `<c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${count}"/>${pts(vals)}</c:numCache>`
const numRef = (vals: Pt[], fmt?: string, count?: number | string): string =>
  `<c:numRef><c:f>Sheet1!$B$2:$B$9</c:f>${numCache(vals, fmt, count)}</c:numRef>`
const cat = (vals: Pt[]): string => `<c:cat>${strRef(vals)}</c:cat>`
const val = (vals: Pt[], fmt?: string): string => `<c:val>${numRef(vals, fmt)}</c:val>`
const tx = (name: string): string => `<c:tx>${strRef([name])}</c:tx>`
const solid = (hex: string, mods = ''): string =>
  `<a:solidFill><a:srgbClr val="${hex}">${mods}</a:srgbClr></a:solidFill>`
const schemeFill = (name: string, mods = ''): string =>
  `<a:solidFill><a:schemeClr val="${name}">${mods}</a:schemeClr></a:solidFill>`
const spPr = (inner: string): string => `<c:spPr>${inner}</c:spPr>`
const ln = (inner: string, w?: number | string): string =>
  `<a:ln${w === undefined ? '' : ` w="${w}"`}>${inner}</a:ln>`
const txPr = (defRPr: string, bodyAttrs = ''): string =>
  `<c:txPr><a:bodyPr${bodyAttrs}/><a:lstStyle/><a:p><a:pPr>${defRPr}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`
const run = (t: string, rPr = '<a:rPr lang="en-US"/>'): string => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`
const rich = (paras: string[]): string =>
  `<c:tx><c:rich><a:bodyPr/><a:lstStyle/>${paras.map((p) => `<a:p>${p}</a:p>`).join('')}</c:rich></c:tx>`

const CATS = ['Q1', 'Q2', 'Q3', 'Q4']

interface SerOpts {
  idx?: number | string
  order?: number | string
  name?: string
  sp?: string
  extra?: string
  cat?: string
  val?: string
  tail?: string
}
const ser = (o: SerOpts = {}): string =>
  '<c:ser>' +
  (o.idx === undefined ? '' : v('idx', o.idx)) +
  (o.order === undefined ? '' : v('order', o.order)) +
  (o.name === undefined ? '' : tx(o.name)) +
  (o.sp ?? '') +
  (o.extra ?? '') +
  (o.cat ?? cat(CATS)) +
  (o.val ?? val([10, 20, 30, 40])) +
  (o.tail ?? '') +
  '</c:ser>'
const sers = (n: number, f: (i: number) => SerOpts = () => ({})): string =>
  Array.from({ length: n }, (_, i) => ser({ idx: i, order: i, name: `S${i + 1}`, ...f(i) })).join(
    '',
  )

const AX = v('axId', 1) + v('axId', 2)
const bar = (
  body: string,
  dir = 'col',
  grouping = 'clustered',
  extra = '',
  tag = 'c:barChart',
): string => `<${tag}>${v('barDir', dir)}${v('grouping', grouping)}${body}${extra}${AX}</${tag}>`
const line = (body: string, grouping = 'standard', extra = '', tag = 'c:lineChart'): string =>
  `<${tag}>${v('grouping', grouping)}${body}${extra}${AX}</${tag}>`
const area = (body: string, grouping = 'standard', extra = '', tag = 'c:areaChart'): string =>
  `<${tag}>${v('grouping', grouping)}${body}${extra}${AX}</${tag}>`
const pie = (body: string, extra = '', tag = 'c:pieChart'): string =>
  `<${tag}>${body}${extra}</${tag}>`

const catAx = (
  extra = '',
  id: string | number = 1,
  cross: string | number = 2,
  tag = 'c:catAx',
): string =>
  `<${tag}>${v('axId', id)}<c:scaling>${v('orientation', 'minMax')}</c:scaling>${v('delete', 0)}${v('axPos', 'b')}${extra}${v('crossAx', cross)}</${tag}>`
const valAx = (
  extra = '',
  scaling = v('orientation', 'minMax'),
  pos = 'l',
  id: string | number = 2,
  cross: string | number = 1,
): string =>
  `<c:valAx>${v('axId', id)}<c:scaling>${scaling}</c:scaling>${v('delete', 0)}${v('axPos', pos)}${extra}${v('crossAx', cross)}</c:valAx>`
const AXES = catAx() + valAx()
const plotArea = (plots: string, axes = AXES, extra = '', layout = '<c:layout/>'): string =>
  `<c:plotArea>${layout}${plots}${axes}${extra}</c:plotArea>`
const legend = (inner = v('legendPos', 'r')): string => `<c:legend>${inner}</c:legend>`
const chartOf = (
  pa: string,
  opts: { title?: string; legend?: string; pre?: string; post?: string } = {},
): string =>
  space(
    (opts.title ?? '') +
      v('autoTitleDeleted', 0) +
      pa +
      (opts.legend ?? legend()) +
      v('plotVisOnly', 1),
    opts.pre ?? '',
    opts.post ?? '',
  )

const dLbls = (inner: string): string => `<c:dLbls>${inner}</c:dLbls>`
const SHOW_VAL =
  v('showLegendKey', 0) +
  v('showVal', 1) +
  v('showCatName', 0) +
  v('showSerName', 0) +
  v('showPercent', 0)

// ── Built chart parts ─────────────────────────────────────────────────

const DATE_SERIALS = [43862, 43831, 43891, 43922]

const HAND: Array<[string, string]> = [
  ['clustered column', chartOf(plotArea(bar(sers(2)), AXES))],
  [
    'stacked bar, maxMin, gap and overlap',
    chartOf(
      plotArea(
        bar(sers(3), 'bar', 'stacked', v('gapWidth', 55) + v('overlap', 100)),
        catAx('', 1, 2) + valAx(),
      ).replace('<c:orientation val="minMax"/>', '<c:orientation val="maxMin"/>'),
    ),
  ],
  [
    'percent stacked column, bad gap, empty overlap',
    chartOf(
      plotArea(bar(sers(2), 'col', 'percentStacked', v('gapWidth', 'abc') + v('overlap', ''))),
      {
        legend: legend(v('legendPos', 'b')),
      },
    ),
  ],
  [
    'hbar clustered, legend left, entry deleted',
    chartOf(plotArea(bar(sers(3), 'bar')), {
      legend: legend(
        v('legendPos', 'l') + `<c:legendEntry>${v('idx', 0)}${v('delete', 1)}</c:legendEntry>`,
      ),
    }),
  ],
  [
    'line with markers, smooth, dash, width',
    chartOf(
      plotArea(
        line(
          sers(2, (i) => ({
            sp: spPr(
              ln(solid('4CAF50') + `<a:prstDash val="${i ? 'dash' : 'solid'}"/>`, i ? 28575 : 'x'),
            ),
            extra: `<c:marker><c:symbol val="${i ? 'none' : 'circle'}"/></c:marker>`,
            tail: v('smooth', i),
          })),
          'standard',
          v('marker', 1),
        ),
      ),
      { legend: legend(v('legendPos', 't')) },
    ),
  ],
  [
    'line, plot marker 0, series without symbol',
    chartOf(plotArea(line(sers(2), 'standard', v('marker', 0))), {
      legend: legend(v('legendPos', 'tr')),
    }),
  ],
  [
    'stacked area',
    chartOf(
      plotArea(
        area(
          sers(3, (i) => ({ sp: spPr(schemeFill(`accent${i + 1}`)) })),
          'stacked',
        ),
      ),
      {
        legend: legend(v('legendPos', 'r') + v('overlay', 0)),
      },
    ),
  ],
  [
    'pie with dPt colors, explosion, noFill and lines',
    chartOf(
      plotArea(
        pie(
          v('varyColors', 1) +
            ser({
              idx: 0,
              name: 'Share',
              extra:
                v('explosion', 25) +
                `<c:dPt>${v('idx', 0)}${spPr('<a:noFill/>' + ln(solid('AA0000'), 19050))}</c:dPt>` +
                `<c:dPt>${v('idx', 1)}${v('explosion', 10)}${spPr(solid('0000AA'))}</c:dPt>` +
                `<c:dPt>${v('idx', 2)}${spPr('<a:pattFill prst="pct5"/>' + ln('<a:noFill/>'))}</c:dPt>` +
                `<c:dPt>${v('idx', 3)}${spPr('<a:blipFill><a:blip r:embed="rId3"/></a:blipFill>' + ln('', 'x'))}</c:dPt>` +
                `<c:dPt>${v('idx', 9)}${spPr(solid('00FF00'))}</c:dPt>` +
                `<c:dPt>${v('idx', 4)}${v('explosion', 7)}${spPr(solid('00FF00'))}</c:dPt>` +
                `<c:dPt>${v('idx', -1)}${spPr(solid('00FF00'))}</c:dPt>` +
                `<c:dPt>${v('idx', 'x')}</c:dPt><c:dPt/>`,
            }) +
            v('firstSliceAng', 90),
        ),
        '',
      ),
    ),
  ],
  [
    'doughnut, hole default, varyColors false',
    chartOf(plotArea(pie(v('varyColors', 'false') + ser({ idx: 0 }), '', 'c:doughnutChart'), '')),
  ],
  [
    'doughnut with hole and bad angle',
    chartOf(
      plotArea(
        pie(ser({ idx: 0 }), v('firstSliceAng', 'x') + v('holeSize', 60), 'c:doughnutChart'),
        '',
      ),
    ),
  ],
  [
    'of-pie',
    chartOf(
      plotArea(
        pie(
          v('ofPieType', 'pie') + ser({ idx: 0, val: val([0, 33, 27, 3]) }),
          v('gapWidth', 100) + v('splitType', 'pos') + v('splitPos', 3) + v('secondPieSize', '-5'),
          'c:ofPieChart',
        ),
        '',
      ),
    ),
  ],
  [
    'pie3D with view3D',
    chartOf(plotArea(pie(ser({ idx: 0 }), '', 'c:pie3DChart'), ''), {
      pre: '',
    }).replace(
      '<c:autoTitleDeleted val="0"/>',
      `<c:autoTitleDeleted val="0"/><c:view3D>${v('rotX', 30)}</c:view3D>`,
    ),
  ],
  [
    'scatter with x values and two value axes',
    chartOf(
      plotArea(
        `<c:scatterChart>${v('scatterStyle', 'lineMarker')}${v('varyColors', 0)}` +
          ser({
            idx: 0,
            name: 'Sample',
            cat: `<c:xVal>${numRef([1, 2, 3])}</c:xVal>`,
            val: `<c:yVal>${numRef([3, 'x', 5], '0.0')}</c:yVal>`,
            sp: spPr(ln(solid('112233')) + solid('445566')),
            extra: `<c:marker><c:symbol val="none"/></c:marker>`,
          }) +
          `${AX}</c:scatterChart>`,
        valAx(
          '',
          v('orientation', 'minMax') + '<c:max val="10"/><c:min val="Infinity"/>',
          'b',
          1,
          2,
        ) + valAx(`<c:majorGridlines/>`, v('orientation', 'minMax'), 'l', 2, 1),
      ),
    ),
  ],
  [
    'bubble with sizes, scale and width',
    chartOf(
      plotArea(
        `<c:bubbleChart>${v('varyColors', 0)}` +
          ser({
            idx: 0,
            cat: `<c:xVal>${numRef([1, 2])}</c:xVal>`,
            val: `<c:yVal>${numRef([3, 4])}</c:yVal>`,
            tail: `<c:bubbleSize>${numRef([5, null])}</c:bubbleSize>`,
            sp: spPr(ln(solid('112233')) + solid('445566')),
          }) +
          v('bubbleScale', 150) +
          v('sizeRepresents', 'w') +
          `${AX}</c:bubbleChart>`,
        valAx('', undefined, 'l', 1, 2) + valAx('', undefined, 'r', 2, 1),
      ),
    ),
  ],
  [
    'radar filled with markers',
    chartOf(
      plotArea(
        `<c:radarChart>${v('radarStyle', 'filled')}${sers(2, (i) => ({
          extra: `<c:marker><c:symbol val="${i ? 'none' : 'square'}"/></c:marker>`,
        }))}${AX}</c:radarChart>`,
      ),
    ),
  ],
  [
    'radar marker',
    chartOf(plotArea(`<c:radarChart>${v('radarStyle', 'marker')}${sers(1)}${AX}</c:radarChart>`)),
  ],
  ['radar no style', chartOf(plotArea(`<c:radarChart>${sers(1)}${AX}</c:radarChart>`))],
  [
    'stock with hi-low lines and up-down bars',
    chartOf(
      plotArea(
        `<c:stockChart>${sers(4, (i) => ({
          extra: i === 2 ? `<c:marker><c:symbol val="none"/></c:marker>` : '',
        }))}<c:hiLowLines/><c:upDownBars>${v('gapWidth', 150)}<c:upBars/><c:downBars/></c:upDownBars>${AX}</c:stockChart>`,
      ),
    ),
  ],
  [
    'stock without bars, bad gap',
    chartOf(
      plotArea(
        `<c:stockChart>${sers(3)}<c:upDownBars>${v('gapWidth', -4)}</c:upDownBars>${AX}</c:stockChart>`,
      ),
    ),
  ],
  [
    'combo column + line on a secondary axis',
    chartOf(
      plotArea(
        bar(sers(2), 'col', 'stacked') +
          `<c:lineChart>${v('grouping', 'standard')}${ser({ idx: 2, order: 2, name: 'Growth' })}${v('marker', 1)}${v('axId', 3)}${v('axId', 4)}</c:lineChart>`,
        catAx() +
          valAx(`<c:numFmt formatCode="0%" sourceLinked="0"/>`) +
          catAx('', 3, 4).replace(v('delete', 0), v('delete', 1)) +
          valAx('', undefined, 'r', 4, 3),
      ),
      {
        legend: legend(
          v('legendPos', 'r') + `<c:legendEntry>${v('idx', 1)}${v('delete', 1)}</c:legendEntry>`,
        ),
      },
    ),
  ],
  [
    'two line charts in one plot area',
    chartOf(
      plotArea(
        line(sers(1)) +
          `<c:lineChart>${v('grouping', 'standard')}${ser({ idx: 5, name: 'Second' })}${v('axId', 3)}${v('axId', 4)}</c:lineChart>`,
        catAx() +
          valAx() +
          catAx('', 3, 4) +
          valAx('', undefined, 'r', 4, 3).replace(v('delete', 0), v('delete', 1)),
      ),
    ),
  ],
  [
    'bar + area + stock combo',
    chartOf(
      plotArea(
        bar(sers(1)) + area(ser({ idx: 1 })) + `<c:stockChart>${sers(2)}${AX}</c:stockChart>`,
      ),
    ),
  ],
  [
    'bar3D with serAx and view3D',
    chartOf(
      plotArea(
        bar(sers(2), 'col', 'standard', v('gapDepth', 80), 'c:bar3DChart'),
        AXES + `<c:serAx>${v('axId', 3)}${v('delete', 0)}${v('tickLblPos', 'nextTo')}</c:serAx>`,
      ),
    ).replace(
      '<c:autoTitleDeleted val="0"/>',
      `<c:autoTitleDeleted val="0"/><c:view3D>${v('rotX', 15)}${v('rotY', 'x')}${v('depthPercent', 200)}${v('rAngAx', 0)}</c:view3D>`,
    ),
  ],
  [
    'area3D with hidden serAx',
    chartOf(
      plotArea(
        area(sers(2), 'standard', '', 'c:area3DChart'),
        AXES + `<c:serAx>${v('axId', 3)}${v('delete', 0)}${v('tickLblPos', 'none')}</c:serAx>`,
      ),
    ),
  ],
  ['line3D', chartOf(plotArea(line(sers(1), 'standard', '', 'c:line3DChart')))],
  [
    'surface chart is not a chart kind',
    chartOf(plotArea(`<c:surface3DChart>${sers(1)}${AX}</c:surface3DChart>`)),
  ],
  ['chart without plot area', space(v('autoTitleDeleted', 1) + legend())],
  ['plot area with only axes', chartOf(plotArea(''))],
  [
    'series without caches',
    chartOf(plotArea(bar(ser({ val: '<c:val><c:numRef><c:f>x</c:f></c:numRef></c:val>' })))),
  ],
  [
    'values with gaps and text',
    chartOf(
      plotArea(
        line(
          ser({
            idx: 0,
            cat: cat(['a', null, 'c', '', 'e', 'f', 'g', 'h']),
            val: val(['#N/A', '', '1e3', '0x10', 'Infinity', ' 7 ', '-0', '1,5']),
          }),
        ),
      ),
    ),
  ],
  [
    'idx out of order, repeated, hostile ptCount',
    chartOf(
      plotArea(
        bar(
          ser({
            idx: 3,
            val:
              '<c:val><c:numRef><c:numCache><c:ptCount val="7"/>' +
              '<c:pt idx="4"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>11</c:v></c:pt>' +
              '<c:pt idx="-2"><c:v>9</c:v></c:pt><c:pt><c:v>0</c:v></c:pt><c:pt idx="x"><c:v>5</c:v></c:pt>' +
              '</c:numCache></c:numRef></c:val>',
          }) +
            ser({
              idx: 1,
              val: `<c:val>${numRef([1, 2], 'General', 'abc')}</c:val>`,
              cat: `<c:cat>${strRef(['x', 'y'], -3)}</c:cat>`,
            }) +
            ser({ idx: 'x', val: `<c:val>${numRef([1], 'General', 100000)}</c:val>` }),
        ),
      ),
    ),
  ],
  [
    'numLit values and strLit categories',
    chartOf(
      plotArea(
        bar(
          ser({
            cat: `<c:cat><c:strLit>${'<c:ptCount val="2"/>'}${pts(['L1', 'L2'])}</c:strLit></c:cat>`,
            val: `<c:val><c:numLit><c:formatCode>#,##0</c:formatCode><c:ptCount val="2"/>${pts([5, 6])}</c:numLit></c:val>`,
            name: 'Lit',
            tail: '',
          }),
        ),
      ),
    ),
  ],
  [
    'literal series name in c:v and object c:v',
    chartOf(
      plotArea(
        bar(
          ser({ extra: '<c:tx><c:v>Literal</c:v></c:tx>' }) +
            ser({ extra: '<c:tx><c:v xml:space="preserve"> spaced </c:v></c:tx>' }) +
            ser({
              extra:
                '<c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v a="1">attr</c:v></c:pt></c:strCache></c:strRef></c:tx>',
            }),
        ),
      ),
    ),
  ],
  [
    'multi-level categories',
    chartOf(
      plotArea(
        bar(
          ser({
            cat:
              '<c:cat><c:multiLvlStrRef><c:f>x</c:f><c:multiLvlStrCache><c:ptCount val="3"/>' +
              `<c:lvl>${pts(['SF', 'LA', 'NY'])}</c:lvl>` +
              `<c:lvl><c:pt idx="2"><c:v>East</c:v></c:pt><c:pt idx="0"><c:v>CA</c:v></c:pt><c:pt><c:v a="1">X</c:v></c:pt></c:lvl>` +
              '</c:multiLvlStrCache></c:multiLvlStrRef></c:cat>',
            val: val([1, 2, 3]),
          }),
        ),
      ),
    ),
  ],
  [
    'date axis sorted chronologically with per-point data',
    chartOf(
      plotArea(
        line(
          ser({
            idx: 0,
            cat: `<c:cat>${numRef(DATE_SERIALS, 'm/d/yyyy')}</c:cat>`,
            val: val([1, 2, 3, 4, 5]),
            extra:
              `<c:dPt>${v('idx', 1)}${spPr(solid('FF0000'))}</c:dPt>` +
              `<c:dPt>${v('idx', 3)}${v('explosion', 4)}${spPr(ln(solid('00FF00'), 12700))}</c:dPt>` +
              dLbls(
                `<c:dLbl>${v('idx', 0)}${SHOW_VAL}</c:dLbl><c:dLbl>${v('idx', 7)}${v('delete', 1)}</c:dLbl>` +
                  v('showVal', 0),
              ) +
              `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:datalabelsRange><c15:f>x</c15:f><c15:dlblRangeCache><c:ptCount val="3"/>${pts(['a', 'b', 'c'])}</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`,
          }),
        ),
        `<c:dateAx>${v('axId', 1)}<c:scaling>${v('orientation', 'maxMin')}</c:scaling>${v('delete', 0)}${v('axPos', 'b')}<c:numFmt formatCode="mmm-yy"/>${v('crossAx', 2)}</c:dateAx>` +
          valAx(),
      ),
    ).replace(
      '</c:dLbls>',
      '<c:extLst><c:ext uri="x"><c15:showDataLabelsRange val="1"/></c:ext></c:extLst></c:dLbls>',
    ),
  ],
  [
    'date categories in other formats, 1904 system',
    chartOf(
      plotArea(
        bar(
          ser({
            cat: `<c:cat>${numRef([37261, 1e9, -1, 0, 2958465.5, 'x'], 'yyyy\\-mm\\-dd d mmm yy m')}</c:cat>`,
            val: val([1, 2, 3, 4, 5, 6]),
          }),
        ),
      ),
      { pre: v('date1904', 1) },
    ),
  ],
  [
    'date categories, date1904 without val, deleted catAx beside a dateAx',
    chartOf(
      plotArea(
        bar(ser({ cat: `<c:cat>${numRef([43831, 43800], 'd-mmm')}</c:cat>`, val: val([1, 2]) })),
        catAx().replace(v('delete', 0), v('delete', 1)) +
          `<c:dateAx>${v('axId', 1)}<c:scaling/>${v('delete', 0)}${v('crossAx', 2)}</c:dateAx>` +
          valAx(),
      ),
      { pre: '<c:date1904/>' },
    ),
  ],
  [
    'numeric categories that are not dates',
    chartOf(
      plotArea(
        bar(ser({ cat: `<c:cat>${numRef([1.5, 2, null], '0.00')}</c:cat>`, val: val([1, 2, 3]) })),
      ),
    ),
  ],
  [
    'axes with every option',
    chartOf(
      plotArea(
        bar(sers(1)),
        catAx(
          v('tickLblPos', 'low') +
            v('tickLblSkip', 2) +
            v('tickMarkSkip', 1) +
            `<c:title>${rich([run('Quarter', '<a:rPr lang="en-US" sz="1400" b="1" i="1">' + solid('123456') + '</a:rPr>')])}${v('overlay', 1)}</c:title>` +
            txPr(
              `<a:defRPr sz="900" b="1" cap="all" spc="120" baseline="-2147483648">${solid('666666')}</a:defRPr>`,
              ' rot="-2700000"',
            ) +
            spPr(ln('<a:noFill/>')),
        ) +
          valAx(
            '<c:majorGridlines>' +
              spPr(ln(solid('D9D9D9') + '<a:prstDash val="sysDash"/>', 9525)) +
              '</c:majorGridlines><c:minorGridlines>' +
              spPr(ln(solid('EEEEEE'), 3175)) +
              '</c:minorGridlines>' +
              '<c:numFmt formatCode="#,##0" sourceLinked="1"/>' +
              v('crosses', 'max') +
              v('majorUnit', 5) +
              v('minorUnit', '0') +
              v('tickLblPos', 'none') +
              `<c:title>${rich([run('Value')])}${txPr('<a:defRPr sz="1100"/>')}</c:title>` +
              txPr('<a:defRPr sz="auto"/>', ' rot="-60000000"') +
              spPr(ln(solid('000000'))),
            v('logBase', 10) + v('orientation', 'minMax') + '<c:max val="100"/><c:min val="1"/>',
          ),
      ),
    ),
  ],
  [
    'axis titles from a cache and placeholders',
    chartOf(
      plotArea(
        bar(sers(1)),
        catAx(
          `<c:title><c:tx>${strRef(['From cell'])}</c:tx></c:title>` + v('crosses', 'autoZero'),
        ) +
          valAx(
            `<c:title>${v('overlay', 0)}</c:title><c:minorGridlines/>` +
              v('crosses', 'nowhere') +
              v('tickLblPos', 'high'),
            v('logBase', 1),
          ),
      ),
    ),
  ],
  [
    'axis bodies that are text or empty',
    chartOf(plotArea(bar(sers(1)), '<c:catAx/><c:valAx>text</c:valAx>')),
  ],
  [
    'legend manual layout, txPr, rtl',
    chartOf(plotArea(bar(sers(2))), {
      legend: legend(
        v('legendPos', 'b') +
          `<c:layout><c:manualLayout>${v('xMode', 'edge')}${v('yMode', 'factor')}${v('x', '0.1')}${v('y', '')}${v('w', '-0.2')}${v('h', '0.3')}</c:manualLayout></c:layout>` +
          `<c:txPr><a:bodyPr/><a:p><a:pPr rtl="1"><a:defRPr sz="1000" b="1">${solid('FF00FF')}<a:latin typeface="Arial"/></a:defRPr></a:pPr></a:p></c:txPr>`,
      ),
    }),
  ],
  [
    'legend without position, layout with only height',
    chartOf(plotArea(bar(sers(2))), {
      legend: legend(
        `<c:layout><c:manualLayout>${v('h', '0.3')}${v('w', 'x')}</c:manualLayout></c:layout>`,
      ),
    }),
  ],
  [
    'legend hidden by baseline sentinel',
    chartOf(plotArea(bar(sers(2), 'bar', 'stacked')), {
      legend: legend(v('legendPos', 'r') + txPr('<a:defRPr baseline="-2147483648"/>')),
    }),
  ],
  ['empty legend element', chartOf(plotArea(bar(sers(2))), { legend: '<c:legend/>' })],
  [
    'chart title rich, two paragraphs, styled',
    chartOf(plotArea(bar(sers(1))), {
      title: `<c:title>${rich([
        run('Revenue ', '<a:rPr lang="en-US" b="0" cap="all" spc="-50"/>') + run('2024'),
        run('second line'),
      ])}${v('overlay', 1)}${txPr(`<a:defRPr sz="1800" i="1">${schemeFill('accent2')}<a:latin typeface="+mj-lt"/></a:defRPr>`)}</c:title>`,
    }),
  ],
  [
    'chart title from paragraph defaults',
    chartOf(plotArea(bar(sers(1))), {
      title: `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-IN"/><a:t>Cumulative</a:t></a:r></a:p></c:rich></c:tx></c:title>`,
    }),
  ],
  [
    'chart title from a cell',
    chartOf(plotArea(bar(sers(1))), {
      title: `<c:title><c:tx>${strRef(['Cell title'])}</c:tx></c:title>`,
    }),
  ],
  [
    'auto title, one series',
    chartOf(plotArea(bar(sers(1))), { title: `<c:title>${v('overlay', 0)}</c:title>` }),
  ],
  [
    'auto title, two series',
    chartOf(plotArea(bar(sers(2))), { title: `<c:title>${v('overlay', 0)}</c:title>` }),
  ],
  ['empty title element', chartOf(plotArea(bar(sers(1))), { title: '<c:title/>' })],
  [
    'blank rich title',
    chartOf(plotArea(bar(sers(1))), { title: `<c:title>${rich([run('  ')])}</c:title>` }),
  ],
  [
    'plot-level data labels with formats',
    chartOf(
      plotArea(
        bar(
          sers(2),
          'col',
          'clustered',
          dLbls(
            '<c:numFmt formatCode="0.0%" sourceLinked="0"/>' +
              txPr('<a:defRPr sz="800" b="1" cap="all" spc="50"/>', ' rot="-5400000"') +
              v('showVal', 1) +
              v('showPercent', 1) +
              v('showSerName', 1) +
              v('showCatName', 1),
          ),
        ),
      ),
    ),
  ],
  [
    'pie percent labels, series-level block',
    chartOf(
      plotArea(
        pie(
          v('varyColors', 1) +
            ser({
              extra: dLbls(
                v('showVal', 0) +
                  v('showPercent', 1) +
                  spPr(solid('FFFFFF') + ln(solid('000000'))) +
                  '<c:numFmt formatCode="General"/>',
              ),
            }),
          dLbls(v('showVal', 1)),
        ),
        '',
      ),
    ),
  ],
  [
    'name-only labels and value axis format',
    chartOf(
      plotArea(
        line(
          sers(1, () => ({
            extra: dLbls(v('showSerName', 1) + spPr('<a:noFill/>' + ln('<a:noFill/>'))),
          })),
        ),
        catAx() + valAx('<c:numFmt formatCode="$#,##0"/>'),
      ),
    ),
  ],
  [
    'labels inherit the value axis format',
    chartOf(
      plotArea(
        line(sers(1, () => ({ extra: dLbls(SHOW_VAL) }))),
        catAx() + valAx('<c:numFmt formatCode="0.00"/>'),
      ),
    ),
  ],
  [
    'point label overrides with rich text and boxes',
    chartOf(
      plotArea(
        bar(
          sers(1, () => ({
            extra: dLbls(
              `<c:dLbl>${v('idx', 0)}${rich([run('Peak', '<a:rPr b="1" sz="1400">' + solid('FF0000') + '</a:rPr>')])}${spPr('<a:noFill/>' + ln(solid('00FF00')))}</c:dLbl>` +
                `<c:dLbl>${v('idx', 1)}${v('delete', 1)}</c:dLbl>` +
                `<c:dLbl>${v('idx', 2)}${SHOW_VAL}${txPr(`<a:defRPr sz="700">${solid('0000FF')}</a:defRPr>`)}${spPr(solid('EEEEEE') + ln('<a:noFill/>'))}</c:dLbl>` +
                `<c:dLbl>${v('idx', 3)}${v('showLegendKey', 1)}</c:dLbl>` +
                `<c:dLbl>${v('idx', 'x')}${SHOW_VAL}</c:dLbl><c:dLbl>${v('idx', 5)}${rich([run(' ')])}</c:dLbl>` +
                v('showVal', 0),
            ),
          })),
        ),
      ),
    ),
  ],
  [
    'series data labels deleted, plot labels on',
    chartOf(
      plotArea(
        bar(
          sers(2, (i) => ({ extra: i ? dLbls(v('delete', 1)) : '<c:dLbls/>' })),
          'col',
          'clustered',
          dLbls(SHOW_VAL),
        ),
      ),
    ),
  ],
  [
    'value-from-cells labels without the flag',
    chartOf(
      plotArea(
        bar(
          ser({
            extra:
              dLbls(SHOW_VAL) +
              `<c:extLst><c:ext uri="x"><c15:datalabelsRange><c15:dlblRangeCache><c:ptCount val="2"/>${pts(['', ''])}</c15:dlblRangeCache></c15:datalabelsRange></c:ext><c:ext uri="y"/></c:extLst>`,
          }),
        ),
      ),
    ),
  ],
  [
    'plot area layout, fill and border; chart frame',
    chartOf(
      plotArea(
        bar(sers(1)),
        AXES,
        spPr(solid('F2F2F2') + ln(solid('BFBFBF'), 'x')),
        `<c:layout><c:manualLayout>${v('layoutTarget', 'inner')}${v('xMode', 'edge')}${v('yMode', 'edge')}${v('x', 0.1)}${v('y', '0.05')}${v('w', '0.8')}${v('h', '0.7')}</c:manualLayout></c:layout>`,
      ),
      {
        post:
          spPr(solid('FFFFFF') + ln(solid('000000'), 12700)) +
          txPr(`<a:defRPr sz="1000">${solid('333333')}<a:latin typeface="Segoe UI"/></a:defRPr>`),
      },
    ),
  ],
  [
    'plot layout in factor mode is ignored; picture backgrounds',
    chartOf(
      plotArea(
        bar(sers(1)),
        AXES,
        spPr(
          '<a:blipFill><a:blip r:embed="rId9"/></a:blipFill>' + ln('<a:noFill/>' + solid('000000')),
        ),
        `<c:layout><c:manualLayout>${v('layoutTarget', 'inner')}${v('xMode', 'factor')}${v('x', 0.1)}${v('y', 0.1)}${v('w', 0.5)}${v('h', 0.5)}</c:manualLayout></c:layout>`,
      ),
      { post: spPr('<a:gradFill/>' + ln('<a:noFill/>')) },
    ),
  ],
  ['legacy style 12 ramp', chartOf(plotArea(bar(sers(4))), { pre: v('style', 12) })],
  ['legacy style 3, one series', chartOf(plotArea(bar(sers(1))), { pre: v('style', 3) })],
  ['legacy style 2 does not ramp', chartOf(plotArea(bar(sers(3))), { pre: v('style', 2) })],
  ['legacy style 43, black', chartOf(plotArea(bar(sers(2))), { pre: v('style', 43) })],
  [
    'legacy style 48 with own fill and text color',
    chartOf(plotArea(bar(sers(2)), AXES, spPr('<a:noFill/>')), {
      pre: v('style', 48),
      post: spPr(solid('FFFFFF')) + txPr(`<a:defRPr>${solid('222222')}</a:defRPr>`),
    }),
  ],
  [
    'style inside mc:AlternateContent is not read',
    chartOf(plotArea(bar(sers(3))), {
      pre: `<mc:AlternateContent><mc:Choice Requires="c14">${'<c14:style val="102"/>'}</mc:Choice><mc:Fallback>${v('style', 2)}</mc:Fallback></mc:AlternateContent>`,
    }),
  ],
  [
    'data table',
    chartOf(
      plotArea(
        bar(sers(2)),
        AXES,
        `<c:dTable>${v('showHorzBorder', 1)}${v('showVertBorder', 0)}${v('showOutline', 1)}${v('showKeys', 0)}${txPr(`<a:defRPr sz="900">${solid('404040')}</a:defRPr>`)}${spPr(ln(solid('A0A0A0')))}</c:dTable>`,
      ),
    ),
  ],
  ['empty data table', chartOf(plotArea(bar(sers(1)), AXES, '<c:dTable/>'))],
  ['data table on a pie is dropped', chartOf(plotArea(pie(ser({})), '', '<c:dTable/>'))],
  [
    'fonts from axis, legend, labels and title',
    chartOf(
      plotArea(
        bar(
          sers(1, () => ({
            extra: dLbls(
              SHOW_VAL +
                `<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr><a:latin typeface="Lbl"/></a:defRPr></a:pPr></a:p></c:txPr>`,
            ),
          })),
        ),
        catAx(
          `<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr><a:latin typeface="+mn-lt"/></a:defRPr></a:pPr></a:p></c:txPr>`,
        ) + valAx(),
      ),
    ),
  ],
  [
    'font from the title run only',
    chartOf(plotArea(bar(sers(1))), {
      title: `<c:title>${rich([run('T', '<a:rPr><a:latin typeface="+mj-ea"/></a:rPr>')])}</c:title>`,
    }),
  ],
  [
    'theme colors through schemeClr with modifiers',
    chartOf(
      plotArea(
        bar(
          sers(2, (i) => ({
            sp: spPr(
              schemeFill(i ? 'accent2' : 'tx1', '<a:lumMod val="75000"/><a:lumOff val="25000"/>'),
            ),
          })),
        ),
      ),
      { legend: legend(v('legendPos', 'r') + txPr(`<a:defRPr>${schemeFill('bg1')}</a:defRPr>`)) },
    ),
  ],
  [
    'bar series with no fill is a spacer',
    chartOf(
      plotArea(
        bar(
          sers(2, (i) => ({ sp: spPr(i ? solid('FF0000') : '<a:noFill/>' + ln('<a:noFill/>')) })),
          'col',
          'stacked',
        ),
      ),
    ),
  ],
  ['256 series cap', chartOf(plotArea(bar(sers(260, () => ({ val: val([1]), cat: '' })))))],
  ['not xml', 'this is not < xml'],
  ['empty text', ''],
  ['another root', `<p:sld xmlns:p="p"><p:cSld/></p:sld>`],
  ['chartSpace without chart', `<c:chartSpace ${NS}/>`],
  ['chart element empty', `<c:chartSpace ${NS}><c:chart/></c:chartSpace>`],
  [
    'plot area is text',
    `<c:chartSpace ${NS}><c:chart><c:plotArea>x</c:plotArea></c:chart></c:chartSpace>`,
  ],
  [
    'empty pie element falls through',
    chartOf(plotArea('<c:pieChart/>' + pie(ser({}), '', 'c:doughnutChart'), '')),
  ],
  [
    'empty scatter element beside a bubble chart',
    chartOf(plotArea(`<c:scatterChart/><c:bubbleChart>${ser({})}</c:bubbleChart>`)),
  ],
  // TypeScript `in` on a text throws a TypeError
  ['bar series spPr is text', chartOf(plotArea(bar(ser({ sp: '<c:spPr>text</c:spPr>' }))))],
  [
    'pie point spPr is text',
    chartOf(plotArea(pie(ser({ extra: `<c:dPt>${v('idx', 0)}<c:spPr>t</c:spPr></c:dPt>` })), '')),
  ],
  [
    'style 41 with chartSpace spPr text',
    chartOf(plotArea(bar(sers(1))), { pre: v('style', 41), post: '<c:spPr>t</c:spPr>' }),
  ],
  [
    'line series spPr text does not throw',
    chartOf(plotArea(line(ser({ sp: '<c:spPr>t</c:spPr>' })))),
  ],
]

// ── CT_Boolean sites ──────────────────────────────────────────────────

/** `undefined`: the element is absent; `null`: present without `val`. */
type BoolForm = string | null | undefined
const BOOL_FORMS: BoolForm[] = ['1', '0', 'true', 'false', null, undefined, '', 'TRUE', ' 1']
const el = (tag: string, form: BoolForm): string =>
  form === undefined ? '' : form === null ? `<${tag}/>` : `<${tag} val="${form}"/>`

const BOOL_SITES: Array<[string, (form: BoolForm) => string]> = [
  [
    'series dLbls c:delete',
    (f) =>
      chartOf(
        plotArea(bar(sers(1, () => ({ extra: dLbls(el('c:delete', f) + v('showVal', 1)) })))),
      ),
  ],
  [
    'series dLbls c:showVal',
    (f) => chartOf(plotArea(bar(sers(1, () => ({ extra: dLbls(el('c:showVal', f)) }))))),
  ],
  [
    'plot dLbls c:showPercent',
    (f) => chartOf(plotArea(pie(ser({}), dLbls(el('c:showPercent', f))), '')),
  ],
  [
    'dLbl c:delete',
    (f) =>
      chartOf(
        plotArea(
          bar(
            sers(1, () => ({
              extra: dLbls(`<c:dLbl>${v('idx', 1)}${el('c:delete', f)}${v('showVal', 1)}</c:dLbl>`),
            })),
          ),
        ),
      ),
  ],
  [
    'dLbl c:showCatName',
    (f) =>
      chartOf(
        plotArea(
          bar(
            sers(1, () => ({
              extra: dLbls(
                `<c:dLbl>${v('idx', 0)}${el('c:showCatName', f)}${v('showVal', 0)}</c:dLbl>`,
              ),
            })),
          ),
        ),
      ),
  ],
  [
    'dLbl c:showSerName, series shows nothing',
    (f) =>
      chartOf(
        plotArea(
          bar(
            sers(1, () => ({
              extra: dLbls(
                `<c:dLbl>${v('idx', 0)}${el('c:showSerName', f)}</c:dLbl>` + v('showVal', 0),
              ),
            })),
          ),
        ),
      ),
  ],
  [
    'series dLbls c:showSerName beside an override',
    (f) =>
      chartOf(
        plotArea(
          bar(
            sers(1, () => ({
              extra: dLbls(`<c:dLbl>${v('idx', 0)}${SHOW_VAL}</c:dLbl>` + el('c:showSerName', f)),
            })),
          ),
        ),
      ),
  ],
  ['plot c:marker', (f) => chartOf(plotArea(line(sers(2), 'standard', el('c:marker', f))))],
  ['c:smooth', (f) => chartOf(plotArea(line(sers(1, () => ({ tail: el('c:smooth', f) })))))],
  [
    'c15:showDataLabelsRange',
    (f) =>
      chartOf(
        plotArea(
          bar(
            ser({
              extra:
                `<c:dLbls>${SHOW_VAL}<c:extLst><c:ext uri="x">${el('c15:showDataLabelsRange', f)}</c:ext></c:extLst></c:dLbls>` +
                `<c:extLst><c:ext uri="y"><c15:datalabelsRange><c15:dlblRangeCache><c:ptCount val="2"/>${pts(['p', 'q'])}</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`,
            }),
          ),
        ),
      ),
  ],
  [
    'secondary value axis c:delete',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(1)) +
            `<c:lineChart>${v('grouping', 'standard')}${ser({ idx: 1 })}${v('axId', 3)}${v('axId', 4)}</c:lineChart>`,
          catAx() +
            valAx() +
            catAx('', 3, 4) +
            valAx('', undefined, 'r', 4, 3).replace(v('delete', 0), el('c:delete', f)),
        ),
      ),
  ],
  [
    'serAx c:delete',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(2), 'col', 'standard', '', 'c:bar3DChart'),
          AXES + `<c:serAx>${v('axId', 3)}${el('c:delete', f)}</c:serAx>`,
        ),
      ),
  ],
  [
    'view3D c:rAngAx',
    (f) =>
      chartOf(plotArea(bar(sers(1), 'col', 'clustered', '', 'c:bar3DChart'))).replace(
        '<c:autoTitleDeleted val="0"/>',
        `<c:autoTitleDeleted val="0"/><c:view3D>${el('c:rAngAx', f)}</c:view3D>`,
      ),
  ],
  ['pie c:varyColors', (f) => chartOf(plotArea(pie(el('c:varyColors', f) + ser({})), ''))],
  [
    'legend c:overlay',
    (f) =>
      chartOf(plotArea(bar(sers(1))), { legend: legend(v('legendPos', 'b') + el('c:overlay', f)) }),
  ],
  [
    'legend c:overlay without position',
    (f) => chartOf(plotArea(bar(sers(1))), { legend: legend(el('c:overlay', f)) }),
  ],
  [
    'catAx c:delete under maxMin',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(3), 'bar'),
          catAx().replace(v('delete', 0), el('c:delete', f)).replace('minMax', 'maxMin') + valAx(),
        ),
      ),
  ],
  [
    'legendEntry c:delete',
    (f) =>
      chartOf(plotArea(bar(sers(2))), {
        legend: legend(
          v('legendPos', 'r') + `<c:legendEntry>${v('idx', 0)}${el('c:delete', f)}</c:legendEntry>`,
        ),
      }),
  ],
  [
    'title c:overlay',
    (f) =>
      chartOf(plotArea(bar(sers(1))), {
        title: `<c:title>${rich([run('T')])}${el('c:overlay', f)}</c:title>`,
      }),
  ],
  [
    'c:autoTitleDeleted',
    (f) =>
      space(
        `<c:title>${v('overlay', 0)}</c:title>` +
          el('c:autoTitleDeleted', f) +
          plotArea(bar(sers(1))) +
          legend(),
      ),
  ],
  [
    'plot dLbls c:delete',
    (f) => chartOf(plotArea(line(sers(1), 'standard', dLbls(el('c:delete', f) + SHOW_VAL)))),
  ],
  [
    'plot dLbls c:showCatName',
    (f) => chartOf(plotArea(line(sers(1), 'standard', dLbls(el('c:showCatName', f))))),
  ],
  [
    'category axis pick c:delete',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(1)),
          catAx(v('tickLblSkip', 3)).replace(v('delete', 0), el('c:delete', f)) +
            catAx(v('tickLblSkip', 4), 3, 4) +
            valAx(),
        ),
      ),
  ],
  [
    'dTable c:showKeys and c:showOutline',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(1)),
          AXES,
          `<c:dTable>${el('c:showKeys', f)}${el('c:showOutline', f)}</c:dTable>`,
        ),
      ),
  ],
  [
    'valAx c:delete',
    (f) =>
      chartOf(plotArea(bar(sers(1)), catAx() + valAx().replace(v('delete', 0), el('c:delete', f)))),
  ],
  [
    'axis title c:overlay',
    (f) =>
      chartOf(
        plotArea(
          bar(sers(1)),
          catAx(`<c:title>${rich([run('Axis')])}${el('c:overlay', f)}</c:title>`) + valAx(),
        ),
      ),
  ],
]

const BOOL_INPUTS: Input[] = BOOL_SITES.flatMap(([, build]) =>
  BOOL_FORMS.map((form): Input => {
    const text = build(form)
    // ledger chart-xsd-boolean: val="true"/"false" and a CT_Boolean without val are read by ECMA-376 in the Rust
    const ledger = form === 'true' || form === 'false' || form === null
    return ledger
      ? { text, args: { theme: T_OFFICE }, seed: false }
      : { text, args: { theme: T_OFFICE } }
  }),
)

// ── Generated chart parts ─────────────────────────────────────────────

const VALUE_POOL: Pt[] = [
  '1',
  '2.5',
  '-3',
  '#N/A',
  '',
  '1e3',
  '0x10',
  'Infinity',
  ' 7 ',
  'NaN',
  '-0',
  '1,5',
  '42',
  null,
  '0.000001',
  '9007199254740993',
]
const DATE_FORMATS = [
  'm/d/yyyy',
  'mmm-yy',
  'd-mmm',
  'yyyy',
  'General',
  '0.0',
  '[$-409]mmmm d, yyyy;@',
  'dd\\/mm\\/yy',
]
const LEGEND_POS = ['r', 'l', 't', 'b', 'tr', 'x']

function generated(seed: number, count: number): Array<[string, Args]> {
  const random = mulberry32(seed)
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
  const chance = (p: number): boolean => random() < p
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1))
  const out: Array<[string, Args]> = []
  for (let n = 0; n < count; n++) {
    const points = int(0, 6)
    const serCount = int(1, 4)
    const kind = pick([
      'bar',
      'col',
      'line',
      'area',
      'pie',
      'doughnut',
      'scatter',
      'bubble',
      'radar',
      'stock',
      'combo',
      'ofPie',
      'bar3D',
      'area3D',
      'pie3D',
    ])
    const datey = chance(0.25)
    const catVals = Array.from({ length: points }, (_, i) =>
      datey ? 43000 + int(-40, 40) : chance(0.1) ? null : `C${i}`,
    )
    const catXml = datey
      ? `<c:cat>${numRef(catVals, pick(DATE_FORMATS), chance(0.2) ? points + 2 : points)}</c:cat>`
      : chance(0.1)
        ? ''
        : cat(catVals)
    const serXml = (i: number): string => {
      const vals = Array.from({ length: points }, () => pick(VALUE_POOL))
      const order = Array.from({ length: points }, (_, k) => k)
      if (chance(0.3)) order.reverse()
      const ptXml = order
        .map((k) =>
          vals[k] === null
            ? ''
            : `<c:pt idx="${chance(0.05) ? k + 3 : k}"><c:v>${vals[k]}</c:v></c:pt>`,
        )
        .join('')
      const valXml = `<c:numRef><c:numCache><c:formatCode>${pick(['General', '0%', '#,##0.00'])}</c:formatCode><c:ptCount val="${points}"/>${ptXml}</c:numCache></c:numRef>`
      const dPts = chance(0.3)
        ? Array.from(
            { length: int(1, 3) },
            () =>
              `<c:dPt>${v('idx', int(-1, points))}${spPr(chance(0.5) ? solid('A1B2C3') : schemeFill(pick(['accent1', 'accent4', 'bg2'])))}${chance(0.3) ? v('explosion', int(0, 20)) : ''}</c:dPt>`,
          ).join('')
        : ''
      const labels = chance(0.3)
        ? dLbls(
            (chance(0.3) ? `<c:dLbl>${v('idx', int(0, 3))}${SHOW_VAL}</c:dLbl>` : '') +
              v('showVal', int(0, 1)) +
              v('showPercent', int(0, 1)) +
              v('showCatName', int(0, 1)) +
              v('showSerName', int(0, 1)),
          )
        : ''
      const sp = chance(0.5)
        ? spPr(
            chance(0.5)
              ? solid(pick(['FF0000', '00B050', '7030A0']))
              : ln(schemeFill(`accent${int(1, 6)}`), int(0, 40000)),
          )
        : ''
      const idx = chance(0.2) ? int(0, 3) : i
      return ser({
        idx,
        order: chance(0.2) ? serCount - i : i,
        name: chance(0.8) ? `Series ${i}` : undefined,
        sp,
        extra:
          dPts +
          labels +
          (chance(0.2) ? `<c:marker><c:symbol val="${pick(['none', 'circle'])}"/></c:marker>` : ''),
        cat:
          kind === 'scatter' || kind === 'bubble'
            ? chance(0.7)
              ? `<c:xVal>${numRef(catVals.map((_, k) => k + 1))}</c:xVal>`
              : ''
            : catXml,
        val:
          kind === 'scatter' || kind === 'bubble'
            ? `<c:yVal>${valXml}</c:yVal>`
            : `<c:val>${valXml}</c:val>`,
        tail:
          (kind === 'bubble'
            ? `<c:bubbleSize>${numRef(vals.map(() => int(1, 9)))}</c:bubbleSize>`
            : '') + (chance(0.2) ? v('smooth', int(0, 1)) : ''),
      })
    }
    const body = Array.from({ length: serCount }, (_, i) => serXml(i)).join('')
    const grouping = pick(['clustered', 'stacked', 'percentStacked', 'standard'])
    const plot =
      kind === 'bar' || kind === 'col'
        ? bar(
            body,
            kind,
            grouping,
            chance(0.5) ? v('gapWidth', int(0, 500)) + v('overlap', int(-100, 100)) : '',
          )
        : kind === 'bar3D'
          ? bar(body, 'col', grouping, '', 'c:bar3DChart')
          : kind === 'line'
            ? line(body, grouping, chance(0.5) ? v('marker', int(0, 1)) : '')
            : kind === 'area'
              ? area(body, grouping)
              : kind === 'area3D'
                ? area(body, grouping, '', 'c:area3DChart')
                : kind === 'pie'
                  ? pie(v('varyColors', int(0, 1)) + body)
                  : kind === 'pie3D'
                    ? pie(body, '', 'c:pie3DChart')
                    : kind === 'doughnut'
                      ? pie(body, chance(0.5) ? v('holeSize', int(10, 90)) : '', 'c:doughnutChart')
                      : kind === 'ofPie'
                        ? pie(body, v('splitPos', int(-1, 4)), 'c:ofPieChart')
                        : kind === 'scatter'
                          ? `<c:scatterChart>${v('scatterStyle', pick(['lineMarker', 'smoothMarker', 'marker']))}${body}${AX}</c:scatterChart>`
                          : kind === 'bubble'
                            ? `<c:bubbleChart>${body}${v('bubbleScale', int(0, 200))}${AX}</c:bubbleChart>`
                            : kind === 'radar'
                              ? `<c:radarChart>${v('radarStyle', pick(['standard', 'marker', 'filled']))}${body}${AX}</c:radarChart>`
                              : kind === 'stock'
                                ? `<c:stockChart>${body}${chance(0.5) ? '<c:hiLowLines/>' : ''}${AX}</c:stockChart>`
                                : bar(body, 'col', grouping) + line(serXml(serCount))
    const dateAxis = datey && chance(0.6)
    const axes =
      kind === 'pie' || kind === 'doughnut' || kind === 'ofPie' || kind === 'pie3D'
        ? ''
        : kind === 'scatter' || kind === 'bubble'
          ? valAx('', undefined, 'b', 1, 2) +
            valAx(chance(0.5) ? '<c:majorGridlines/>' : '', undefined, 'l', 2, 1)
          : (dateAxis
              ? `<c:dateAx>${v('axId', 1)}<c:scaling>${v('orientation', pick(['minMax', 'maxMin']))}</c:scaling>${v('delete', 0)}${v('crossAx', 2)}</c:dateAx>`
              : catAx(chance(0.3) ? v('tickLblSkip', int(0, 3)) : '')) +
            valAx(
              chance(0.5) ? '<c:majorGridlines/>' : '',
              v('orientation', 'minMax') + (chance(0.3) ? `<c:max val="${int(0, 100)}"/>` : ''),
            )
    const leg = chance(0.8)
      ? legend(
          v('legendPos', pick(LEGEND_POS)) +
            (chance(0.2)
              ? `<c:legendEntry>${v('idx', int(0, 3))}${v('delete', 1)}</c:legendEntry>`
              : ''),
        )
      : ''
    const title = chance(0.4)
      ? `<c:title>${chance(0.5) ? rich([run(`Title ${n}`)]) : ''}${v('overlay', 0)}</c:title>`
      : ''
    const pre =
      (chance(0.2) ? v('date1904', int(0, 1)) : '') + (chance(0.3) ? v('style', int(1, 48)) : '')
    const xml = chartOf(
      plotArea(plot, axes, chance(0.2) ? `<c:dTable>${v('showKeys', 1)}</c:dTable>` : ''),
      { title, legend: leg, pre },
    )
    const args: Args = pick<Args>([
      {},
      { theme: T_OFFICE },
      { theme: T_OFFICE, resolveFill: 'stub' },
      { theme: T_PARTIAL },
      { theme: T_DARK },
    ])
    out.push([xml, args])
  }
  return out
}

const THEMES_OF_HAND: Args[] = [{}, { theme: T_OFFICE }, { theme: T_OFFICE, resolveFill: 'stub' }]
const CHART_INPUTS: Input[] = [
  ...HAND.flatMap(([, text]) => THEMES_OF_HAND.map((args) => ({ text, args }))),
  ...HAND.slice(0, 12).flatMap(([, text]) => [
    { text, args: { theme: T_PARTIAL } },
    { text, args: { theme: T_DARK } },
    { text, args: { theme: T_EMPTY } },
  ]),
  ...generated(0x0c4a7, 90).map(([text, args]) => ({ text, args })),
  ...BOOL_INPUTS,
]

// ── chartEx parts ─────────────────────────────────────────────────────

const CX_NS =
  'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" ' +
  `${A_NS} ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const cxLvl = (
  vals: Array<string | number | null>,
  count: number | string = vals.length,
  attrs = '',
): string =>
  `<cx:lvl ptCount="${count}"${attrs}>${vals.map((x, i) => (x === null ? '' : `<cx:pt idx="${i}">${x}</cx:pt>`)).join('')}</cx:lvl>`
const cxData = (id: string | number | undefined, str: string, num: string): string =>
  `<cx:data${id === undefined ? '' : ` id="${id}"`}>${str}${num}</cx:data>`
const strDim = (...lvls: string[]): string =>
  `<cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$4</cx:f>${lvls.join('')}</cx:strDim>`
const numDim = (lvl: string): string =>
  `<cx:numDim type="size"><cx:f>Sheet1!$B$2:$B$4</cx:f>${lvl}</cx:numDim>`
interface CxOpts {
  layout: string
  data?: string
  dataId?: string | null
  title?: string
  dataPts?: string
  axis?: string
}
const cxSpace = (o: CxOpts): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cx:chartSpace ${CX_NS}>` +
  `<cx:chartData>${o.data ?? cxData(0, strDim(cxLvl(['C1', 'C2', 'C3'])), numDim(cxLvl([50, 100, 200], 3, ' formatCode="General"')))}</cx:chartData>` +
  `<cx:chart>${o.title ?? ''}<cx:plotArea><cx:plotAreaRegion>` +
  `<cx:series layoutId="${o.layout}" uniqueId="{X}">${o.dataId === null ? '' : `<cx:dataId val="${o.dataId ?? '0'}"/>`}${o.dataPts ?? ''}</cx:series>` +
  `</cx:plotAreaRegion>${o.axis ?? ''}</cx:plotArea></cx:chart></cx:chartSpace>`
const cxTitle = (text: string): string =>
  `<cx:title><cx:tx><cx:txData><cx:v>${text}</cx:v></cx:txData><cx:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r><a:r><a:t xml:space="preserve"> more</a:t></a:r></a:p></cx:rich></cx:tx></cx:title>`
const cxDataPt = (idx: string | number, fill: string): string =>
  `<cx:dataPt idx="${idx}"><cx:spPr>${fill}</cx:spPr></cx:dataPt>`
const SUNBURST_DATA = cxData(
  0,
  strDim(
    cxLvl(['Leaf1', 'Leaf2', null, 'Leaf4']),
    cxLvl(['Branch', 'Branch', 'Twig', null]),
    cxLvl(['Root', 'Root', 'Root', 'Root']),
  ),
  numDim(cxLvl([10, 'x', 5, 7])),
)

const CX_HAND: string[] = [
  // a point with a negative idx after idx 0: it must not take the place of the first
  cxSpace({
    layout: 'funnel',
    data: cxData(
      0,
      strDim(
        '<cx:lvl ptCount="2"><cx:pt idx="0">A</cx:pt><cx:pt idx="1">B</cx:pt><cx:pt idx="-1">Z</cx:pt></cx:lvl>',
      ),
      numDim(
        '<cx:lvl ptCount="2"><cx:pt idx="0">3</cx:pt><cx:pt idx="1">4</cx:pt><cx:pt idx="-1">9</cx:pt></cx:lvl>',
      ),
    ),
  }),
  cxSpace({
    layout: 'funnel',
    axis: '<cx:axis id="0"><cx:catScaling gapWidth="0.5"/></cx:axis>',
    title: '<cx:title/>',
  }),
  cxSpace({
    layout: 'funnel',
    axis: '<cx:axis id="0"><cx:catScaling gapWidth="-1"/></cx:axis>',
    title: cxTitle('My Funnel'),
  }),
  cxSpace({
    layout: 'funnel',
    axis: '<cx:axis id="0"><cx:catScaling gapWidth="abc"/></cx:axis><cx:axis id="1"/>',
  }),
  cxSpace({ layout: 'funnel', axis: '<cx:axis id="0"><cx:catScaling gapWidth="1e2"/></cx:axis>' }),
  cxSpace({
    layout: 'sunburst',
    data: SUNBURST_DATA,
    dataPts:
      cxDataPt(0, solid('FF0000')) +
      cxDataPt(3, schemeFill('accent2')) +
      cxDataPt(-1, solid('00FF00')) +
      cxDataPt('x', solid('0000FF')) +
      cxDataPt(5000, solid('ABCDEF')) +
      cxDataPt(1, '<a:noFill/>'),
  }),
  cxSpace({ layout: 'sunburst', data: SUNBURST_DATA }),
  cxSpace({
    layout: 'sunburst',
    data: SUNBURST_DATA,
    dataPts: cxDataPt(4294967295, solid('FF0000')) + cxDataPt('Infinity', solid('FF0000')),
  }),
  cxSpace({ layout: 'sunburst', data: SUNBURST_DATA, dataPts: cxDataPt('-0', schemeFill('tx1')) }),
  ...[
    'waterfall',
    'treemap',
    'histogram',
    'boxWhisker',
    'paretoLine',
    'clusteredColumn',
    'regionMap',
    '',
  ].map((layout) => cxSpace({ layout })),
  cxSpace({ layout: 'funnel', dataId: '7' }),
  cxSpace({ layout: 'funnel', dataId: null }),
  cxSpace({
    layout: 'funnel',
    dataId: 'undefined',
    data:
      cxData(undefined, strDim(cxLvl(['A'])), numDim(cxLvl([1]))) +
      cxData(7, strDim(cxLvl(['B'])), numDim(cxLvl([2]))),
  }),
  cxSpace({
    layout: 'funnel',
    dataId: '7',
    data: cxData(0, '', numDim(cxLvl([1]))) + cxData(7, strDim(cxLvl(['B'])), numDim(cxLvl([3]))),
  }),
  cxSpace({
    layout: 'funnel',
    data: cxData(0, strDim(cxLvl(['A', 'B'])), numDim(cxLvl(['x', '']))),
  }),
  cxSpace({ layout: 'funnel', data: cxData(0, strDim(cxLvl(['A', 'B'])), '') }),
  cxSpace({ layout: 'funnel', data: cxData(0, '', numDim(cxLvl([' 4', '5px', '-0', '1e400']))) }),
  cxSpace({
    layout: 'funnel',
    data: cxData(0, strDim(cxLvl(['A'], '99999999')), numDim(cxLvl([1], 'abc') + cxLvl([2]))),
  }),
  cxSpace({
    layout: 'funnel',
    data: cxData(0, strDim(cxLvl(['A', 'B'], -2)), numDim(cxLvl([1, 2], '2.9'))),
  }),
  cxSpace({
    layout: 'funnel',
    data: cxData(
      0,
      strDim(
        '<cx:lvl ptCount="3"><cx:pt idx="2">c</cx:pt><cx:pt idx="0" x="1">a</cx:pt><cx:pt>none</cx:pt><cx:pt idx="1"/></cx:lvl>',
      ),
      numDim(cxLvl([1, 2, 3])),
    ),
  }),
  cxSpace({ layout: 'funnel', data: '<cx:data id="0"/>' }),
  cxSpace({ layout: 'funnel', data: '' }),
  cxSpace({
    layout: 'funnel',
    title:
      '<cx:title><cx:tx><cx:rich><a:p><a:r><a:t>A</a:t><a:t>B</a:t></a:r></a:p><a:p><a:fld><a:t>C</a:t></a:fld></a:p></cx:rich></cx:tx></cx:title>',
  }),
  cxSpace({
    layout: 'funnel',
    title:
      '<cx:title><cx:tx><cx:rich><a:p><a:r><a:t></a:t></a:r></a:p></cx:rich></cx:tx></cx:title>',
  }),
  `<cx:chartSpace ${CX_NS}><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="funnel"/><cx:series layoutId="sunburst"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`,
  `<cx:chartSpace ${CX_NS}/>`,
  'not < xml',
  '',
  chartOf(plotArea(bar(sers(1)))),
]
const CX_INPUTS: Input[] = CX_HAND.flatMap((text) => [
  { text },
  { text, args: { theme: T_OFFICE } },
  { text, args: { theme: T_DARK } },
])

// ── The corpus ────────────────────────────────────────────────────────

const CHART_PART = /^ppt\/charts\/chart\d+\.xml$/
const CHARTEX_PART = /^ppt\/charts\/chartEx\d+\.xml$/
const THEME_PART = /^ppt\/theme\/theme\d+\.xml$/
const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/

/** The parts `type` relationships of `part` name. */
function relatedAll(parts: Parts, part: string | undefined, type: string): string[] {
  const rels = part === undefined ? undefined : parts.get(relsPathFor(part))
  if (part === undefined || rels === undefined) return []
  const out: string[] = []
  for (const [rel] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!rel.includes(`/${type}"`)) continue
    const target = /\bTarget="([^"]*)"/.exec(rel)?.[1]
    const path = target === undefined ? '' : resolveTarget(part, target)
    if (path && parts.has(path)) out.push(path)
  }
  return out
}

function parsedTheme(xml: string | undefined): Theme | undefined {
  if (xml === undefined) return undefined
  try {
    return parseTheme(xml)
  } catch {
    return undefined
  }
}

/** Each chart part with the theme of the slide that shows it (its master's, the chain's clrMap, its override). */
function chartsOf(parts: Parts, name: RegExp): Array<[string, Theme | undefined]> {
  const out: Array<[string, Theme | undefined]> = []
  const firstTheme = [...parts].find(([path]) => THEME_PART.test(path))?.[1]
  for (const [path, text] of parts) {
    if (!name.test(path)) continue
    const slide = [...parts.keys()].find(
      (s) =>
        SLIDE_PART.test(s) &&
        relatedAll(parts, s, 'chart')
          .concat(relatedAll(parts, s, 'chartEx'))
          .includes(path),
    )
    const layout = relatedAll(parts, slide, 'slideLayout')[0]
    const master = relatedAll(parts, layout, 'slideMaster')[0]
    const themePath = relatedAll(parts, master, 'theme')[0]
    const base = parsedTheme(themePath === undefined ? firstTheme : parts.get(themePath))
    let theme =
      base &&
      ({
        ...base,
        clrMap: parseClrMap(
          master === undefined ? undefined : parts.get(master),
          layout === undefined ? undefined : parts.get(layout),
          slide === undefined ? undefined : parts.get(slide),
        ),
      } as Theme)
    const override = relatedAll(parts, path, 'themeOverride')[0]
    if (override !== undefined) {
      try {
        theme = themeWithOverride(theme, parts.get(override)!)
      } catch {
        // an override the parser refuses: the deck theme
      }
    }
    out.push([text, theme && wire(theme)])
  }
  return out
}

/** The deck's themes, each read with a few built parts: no tracked deck holds a chart. */
function deckThemes(parts: Parts): Theme[] {
  return [...parts]
    .filter(([path]) => THEME_PART.test(path))
    .map(([, text]) => parsedTheme(text))
    .filter((t): t is Theme => t !== undefined)
    .map((t) => wire(t))
}

const withTheme = (theme: Theme | undefined): Args => (theme === undefined ? {} : { theme })

// ── Specs ─────────────────────────────────────────────────────────────

/**
 * ledger chart-xsd-boolean: a CT_Boolean element that the schema reads
 * otherwise than the TypeScript: `val="true"`, `val="false"`, or no `val`
 * (true). The parser keeps no attribute without a value, so `<c:delete x/>`
 * is that last form too, and a mutation can make one: the class is named by
 * this test, not by a list of texts. The names are those the Rust reads
 * through `xsd_bool` (crates/pptx-engine/src/chart).
 */
const XSD_BOOLEAN_FORM = new RegExp(
  '<c(?:15)?:(?:delete|showVal|showPercent|showSerName|showCatName|marker|smooth|' +
    'showDataLabelsRange|rAngAx|varyColors|overlay|autoTitleDeleted|showKeys|showHorzBorder|' +
    'showVertBorder|showOutline)' +
    '(?:\\s(?![^<>]*\\bval\\s*=)[^<>]*?)?\\/>|' +
    '<c(?:15)?:\\w+\\s[^<>]*\\bval="(?:true|false)"',
)
const xsdBooleanClass = (text: string): string | undefined =>
  XSD_BOOLEAN_FORM.test(text) ? 'chart-xsd-boolean' : undefined

export const CHART: CallSpec[] = [
  {
    fn: 'pptxChart.chart.parseChartXml',
    call: (text, args) =>
      parseChartXml(
        text,
        args.theme as Theme | undefined,
        args.resolveFill === 'stub' ? stubFill : undefined,
      ),
    fromDocument: (parts) => [
      ...chartsOf(parts, CHART_PART).flatMap(([text, theme]) => [
        { text, args: withTheme(theme) },
        { text },
        { text, args: { ...withTheme(theme), resolveFill: 'stub' } },
      ]),
      ...deckThemes(parts).flatMap((theme) =>
        HAND.slice(0, 8).map(([, text]) => ({ text, args: { theme } })),
      ),
    ],
    built: CHART_INPUTS,
    listed: xsdBooleanClass,
  },
  {
    fn: 'pptxChart.chartex.parseChartExXml',
    call: (text, args) => parseChartExXml(text, args.theme as Theme | undefined),
    fromDocument: (parts) => [
      ...chartsOf(parts, CHARTEX_PART).flatMap(([text, theme]) => [
        { text, args: withTheme(theme) },
        { text },
      ]),
      ...deckThemes(parts).flatMap((theme) =>
        CX_HAND.slice(0, 5).map((text) => ({ text, args: { theme } })),
      ),
    ],
    built: CX_INPUTS,
  },
]
