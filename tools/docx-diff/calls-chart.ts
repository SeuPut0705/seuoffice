// Group `chart` of comparison (f): the read side of chart.ts. parseChartPartXml
// takes the part text, `args.partPath` and `args.theme`; the colour helpers
// take `args.hex` and their factors, a null factor standing for NaN.
import { lumHex, parseChartPartXml, shadeHex, tintHex } from './reference/chart'
import { readThemeColors } from './reference/theme'
import type { ThemeColors } from './reference/types'
import type { CallSpec, Input } from './calls-spec'

// chart.ts does not export these: the values are its literals
const CONSTANTS: Record<string, unknown> = {
  DEFAULT_FRAME_LINE: '868686',
  MAX_CHART_CACHE_POINTS: 1_048_576,
  MAX_CHART_SERIES: 256,
  LEGEND_POSITIONS: ['b', 'l', 'r', 't', 'tr'],
  GRAYSCALE_PALETTE: ['595959', 'D9D9D9', 'A6A6A6', '404040', 'BFBFBF', '8C8C8C'],
}

const num = (value: unknown): number => (value === null ? NaN : (value as number))

// ---------------------------------------------------------------- themes

const THEME_CUSTOM: ThemeColors = {
  name: 'custom',
  dk1: '102030',
  lt1: 'fefefe',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: 'ff0000',
  accent2: '00FF00',
  accent3: '0000ff',
  accent4: '808080',
  accent5: '7F7F7F',
  accent6: 'C0FFEE',
  hlink: '123ABC',
  folHlink: 'abcdef',
}

/** Slots that do not read as six hex digits, and missing slots. */
const THEME_BROKEN: ThemeColors = {
  dk1: 'GGGGGG',
  lt1: ' abcdef ',
  dk2: '12345',
  lt2: '1234567',
  accent1: '4472C4',
  accent2: '\u3000a1b2c3',
  accent3: '',
}

/** Accents all valid, dk1 empty. */
const THEME_ACCENTS: ThemeColors = {
  dk1: '',
  accent1: '4472c4',
  accent2: 'ED7D31',
  accent3: 'a5a5a5',
  accent4: 'FFC000',
  accent5: '5b9bd5',
  accent6: '70AD47',
}

const THEMES: Array<ThemeColors | undefined> = [
  undefined,
  THEME_CUSTOM,
  THEME_BROKEN,
  THEME_ACCENTS,
]

// ---------------------------------------------------------------- chart parts

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

const space = (inner: string, outer = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${NS}>${outer}<c:chart>${inner}</c:chart></c:chartSpace>`

const pts = (values: Array<string | [string, string] | null>): string =>
  values
    .map((v, i) =>
      v === null
        ? ''
        : Array.isArray(v)
          ? `<c:pt idx="${v[0]}"><c:v>${v[1]}</c:v></c:pt>`
          : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`,
    )
    .join('')

const strRef = (values: Array<string | [string, string] | null>, count = values.length): string =>
  `<c:strRef><c:f>S!A1</c:f><c:strCache><c:ptCount val="${count}"/>${pts(values)}</c:strCache></c:strRef>`

const numRef = (
  values: Array<string | [string, string] | null>,
  count: number | string = values.length,
  format = 'General',
): string =>
  `<c:numRef><c:f>S!B1</c:f><c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="${count}"/>${pts(values)}</c:numCache></c:numRef>`

interface Ser {
  name?: string
  cat?: string
  val?: string
  extra?: string
  tag?: 'val' | 'yVal'
  catTag?: 'cat' | 'xVal'
}

const ser = (s: Ser, i = 0): string =>
  `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
  (s.name ?? `<c:tx>${strRef([`Series ${i + 1}`])}</c:tx>`) +
  (s.extra ?? '') +
  (s.cat !== undefined ? `<c:${s.catTag ?? 'cat'}>${s.cat}</c:${s.catTag ?? 'cat'}>` : '') +
  (s.val !== undefined ? `<c:${s.tag ?? 'val'}>${s.val}</c:${s.tag ?? 'val'}>` : '') +
  `</c:ser>`

const CATS = strRef(['North', 'South', 'East'])
const VALS = numRef(['1', '2.5', '3'])
const BASIC: Ser = { cat: CATS, val: VALS }

const AXES =
  '<c:catAx><c:axId val="1"/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
  '<c:valAx><c:axId val="2"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>'

/** A chart part of one plot. */
const part = (
  plot: string,
  plotInner: string,
  opts: { axes?: string; chart?: string; after?: string; outer?: string; legend?: string } = {},
): string =>
  space(
    (opts.chart ?? '<c:autoTitleDeleted val="1"/>') +
      `<c:plotArea><c:layout/><${plot}>${plotInner}</${plot}>${opts.axes ?? AXES}${opts.after ?? ''}</c:plotArea>` +
      (opts.legend ?? '<c:legend><c:legendPos val="r"/></c:legend>') +
      '<c:plotVisOnly val="1"/>',
    opts.outer,
  )

const bar = (inner: string, opts?: Parameters<typeof part>[2]): string =>
  part('c:barChart', `<c:barDir val="col"/><c:grouping val="clustered"/>${inner}`, opts)

const PLOTS = [
  'c:barChart',
  'c:bar3DChart',
  'c:lineChart',
  'c:line3DChart',
  'c:pieChart',
  'c:pie3DChart',
  'c:doughnutChart',
  'c:areaChart',
  'c:area3DChart',
  'c:scatterChart',
  'c:bubbleChart',
  'c:radarChart',
  'c:surfaceChart',
  'c:ofPieChart',
  'c:stockChart',
]

const solid = (clr: string): string => `<a:solidFill>${clr}</a:solidFill>`
const spPr = (inner: string): string => `<c:spPr>${inner}</c:spPr>`
const lnOf = (inner: string): string => spPr(`<a:ln w="9525">${inner}</a:ln>`)
const txPr = (rPr: string): string =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rPr}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`

/** Colour nodes: literal, system, scheme (every slot), broken, and each modifier. */
const COLORS: string[] = [
  '<a:srgbClr val="1f4e79"/>',
  '<a:srgbClr val=" 1F4E79\u00a0"/>',
  '<a:srgbClr val="1F4E7"/>',
  '<a:srgbClr val=""/>',
  '<a:sysClr val="windowText" lastClr="000000"/>',
  '<a:sysClr val="window"/>',
  ...[
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'tx1',
    'bg1',
    'tx2',
    'bg2',
    'phClr',
    'constructor',
    'hlink',
    '',
  ].map((val) => `<a:schemeClr val="${val}"/>`),
  '<a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr>',
  '<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>',
  '<a:schemeClr val="tx1"><a:lumOff val="50000"/></a:schemeClr>',
  '<a:srgbClr val="808080"><a:lumMod val="200000"/><a:lumOff val="100000"/></a:srgbClr>',
  '<a:srgbClr val="808080"><a:lumOff val="-100000"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:shade val="50000"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:shade val="0"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:tint val="0"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:tint val="100000"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:tint val="40000"/><a:shade val="90000"/><a:lumMod val="50000"/></a:srgbClr>',
  '<a:srgbClr val="4472C4"><a:tint val="abc"/><a:shade val=" 60000x"/><a:alpha val="50000"/></a:srgbClr>',
  '<a:srgbClr val="ED7D31"><a:lumMod val="50000"/><a:lumMod val="150000"/></a:srgbClr>',
  '<a:srgbClr val="70AD47"><a:shade val="-50000"/></a:srgbClr>',
  '<a:srgbClr val="70AD47"><a:tint val="150000"/></a:srgbClr>',
  // the first usable child wins
  '<a:srgbClr val="zz"/><a:srgbClr val="00B050"/>',
  '<a:prstClr val="red"/><a:schemeClr val="accent2"/>',
]

/** Parts that each reach a branch the corpus may not. */
function builtParts(): string[] {
  const out: string[] = []
  // every plot name, one series
  for (const plot of PLOTS) out.push(part(plot, ser(BASIC)))
  // the part is not a chart
  out.push(
    '',
    '<c:chartSpace/>',
    `<c:chartSpace ${NS}><c:chart/></c:chartSpace>`,
    `<c:chartSpace ${NS}><c:chart><c:plotArea><c:layout/>${AXES}</c:plotArea></c:chart></c:chartSpace>`,
    `<c:userShapes ${NS}/>`,
    '<w:document/>',
    `<c:chartSpace ${NS}><c:chart><c:plotArea>`,
  )
  // no series with values
  out.push(bar(''), bar(ser({ cat: CATS })), bar(ser({ cat: CATS, val: numRef([]) })))
  out.push(bar(ser({ cat: CATS, val: '<c:numRef><c:f>S!B1</c:f></c:numRef>' })))
  // bar direction and grouping on every kind
  for (const dir of ['bar', 'col', 'BAR', '']) {
    out.push(part('c:barChart', `<c:barDir val="${dir}"/>${ser(BASIC)}`))
    out.push(part('c:lineChart', `<c:barDir val="${dir}"/>${ser(BASIC)}`))
  }
  for (const grouping of ['stacked', 'percentStacked', 'clustered', 'standard', 'Stacked']) {
    for (const plot of ['c:barChart', 'c:areaChart', 'c:lineChart', 'c:pieChart', 'c:radarChart']) {
      out.push(part(plot, `<c:grouping val="${grouping}"/>${ser(BASIC)}`))
    }
  }
  // markers: line, scatter styles, radar styles, every series switching symbols off
  const symbolNone = '<c:marker><c:symbol val="none"/></c:marker>'
  for (const marker of ['1', '0', 'true', '']) {
    out.push(
      part('c:lineChart', `<c:grouping val="standard"/>${ser(BASIC)}<c:marker val="${marker}"/>`),
    )
    out.push(
      part(
        'c:lineChart',
        `${ser({ ...BASIC, extra: symbolNone })}${ser({ ...BASIC, extra: symbolNone }, 1)}<c:marker val="${marker}"/>`,
      ),
    )
    out.push(
      part(
        'c:lineChart',
        `${ser({ ...BASIC, extra: symbolNone })}${ser(BASIC, 1)}<c:marker val="${marker}"/>`,
      ),
    )
  }
  const xy: Ser = {
    cat: numRef(
      ['0.70000000000000062', '1e21', '-0.00005', ' ', 'abc', '', '2.00005'],
      7,
      'General',
    ),
    catTag: 'xVal',
    val: numRef(['1', '2', '3', '4', '5', '6', '7']),
    tag: 'yVal',
  }
  for (const style of [
    undefined,
    'lineMarker',
    'smoothMarker',
    'line',
    'smooth',
    'marker',
    'none',
    'LINE',
    'MAR\u212AER',
    '\u017Fmooth',
    'l\u0131ne',
    'SMOOTH',
  ]) {
    const styleXml = style === undefined ? '' : `<c:scatterStyle val="${style}"/>`
    out.push(part('c:scatterChart', `${styleXml}<c:varyColors val="0"/>${ser(xy)}`))
    out.push(
      part(
        'c:scatterChart',
        `${styleXml}${ser({ ...xy, extra: symbolNone + lnOf('<a:noFill/>') })}`,
      ),
    )
  }
  out.push(
    part(
      'c:scatterChart',
      `<c:scatterStyle val="lineMarker"/>${ser({ ...xy, extra: lnOf('<a:noFill/>') })}${ser({ ...xy, extra: lnOf(solid('<a:srgbClr val="FF0000"/>')) }, 1)}${ser({ ...xy, extra: spPr('<a:noFill/>') }, 2)}`,
    ),
  )
  // x values with no number, a date-formatted x cache
  out.push(
    part(
      'c:scatterChart',
      ser({ ...xy, cat: numRef(['', ' ', 'x']) }) +
        ser({ ...xy, cat: numRef(['45000', '45001'], 2, 'm/d/yyyy') }, 1),
    ),
  )
  out.push(part('c:scatterChart', ser({ ...xy, cat: undefined })))
  // bubble sizes
  out.push(
    part(
      'c:bubbleChart',
      ser({
        ...xy,
        extra: '',
        val: numRef(['1', '2']),
      }).replace('</c:ser>', `<c:bubbleSize>${numRef(['3', '', 'x'])}</c:bubbleSize></c:ser>`),
    ),
    part(
      'c:bubbleChart',
      ser({ ...xy }).replace(
        '</c:ser>',
        `<c:bubbleSize>${numRef(['', 'x'])}</c:bubbleSize></c:ser>`,
      ),
    ),
  )
  for (const radar of [undefined, 'filled', 'marker', 'standard', 'Marker', '']) {
    const style = radar === undefined ? '' : `<c:radarStyle val="${radar}"/>`
    out.push(part('c:radarChart', `${style}${ser(BASIC)}`))
    out.push(part('c:radarChart', `${style}${ser({ ...BASIC, extra: symbolNone })}`))
  }
  // doughnut hole, pie explosion
  for (const hole of [undefined, '75', 'abc', '0', '-5', '12.9pt', ' 10', '']) {
    const xml = hole === undefined ? '' : `<c:holeSize val="${hole}"/>`
    out.push(part('c:doughnutChart', `${ser(BASIC)}<c:firstSliceAng val="0"/>${xml}`))
  }
  out.push(part('c:pieChart', `${ser(BASIC)}<c:holeSize val="50"/>`))
  for (const expl of ['25', '0', '-3', 'x', '7.5']) {
    out.push(part('c:pieChart', ser({ ...BASIC, extra: `<c:explosion val="${expl}"/>` })))
    out.push(part('c:barChart', ser({ ...BASIC, extra: `<c:explosion val="${expl}"/>` })))
  }
  out.push(
    part('c:pieChart', ser(BASIC) + ser({ ...BASIC, extra: '<c:explosion val="40"/>' }, 1)),
    part('c:pieChart', ser({ cat: CATS }) + ser({ ...BASIC, extra: '<c:explosion val="40"/>' }, 1)),
  )
  // data labels
  const dLbls = (inner: string): string => `<c:dLbls>${inner}</c:dLbls>`
  const flags = (v: string, p: string, c: string): string =>
    `<c:showLegendKey val="0"/><c:showVal val="${v}"/><c:showCatName val="${c}"/><c:showSerName val="0"/><c:showPercent val="${p}"/>`
  const dLbl = (idx: number, inner: string): string =>
    `<c:dLbl><c:idx val="${idx}"/>${inner}</c:dLbl>`
  const labelSets = [
    flags('1', '0', '0'),
    flags('0', '1', '0'),
    flags('0', '0', '1'),
    flags('true', '1', '1'),
    flags('0', '0', '0'),
    '<c:showVal/>',
    '<c:showVal val="false"/>',
    flags('1', '0', '0') + '<c:delete val="1"/>',
    '<c:delete/>' + flags('1', '1', '1'),
    '<c:delete val="0"/>' + flags('1', '1', '1'),
    `<c:numFmt formatCode="0.0%" sourceLinked="0"/>${txPr('<a:defRPr sz="1200" b="1">' + solid('<a:schemeClr val="tx1"><a:lumMod val="65000"/></a:schemeClr>') + '</a:defRPr>')}${flags('1', '0', '0')}`,
    `<c:numFmt formatCode="" sourceLinked="0"/>${txPr('<a:defRPr sz="-5"/>')}${flags('1', '0', '0')}`,
    `${txPr('<a:defRPr sz="x">' + solid('<a:srgbClr val="nothex"/>') + '</a:defRPr>')}${flags('1', '0', '0')}`,
    // per-point blocks covering every point, and some
    dLbl(0, flags('0', '1', '0')) +
      dLbl(1, flags('0', '0', '1')) +
      dLbl(2, `<c:numFmt formatCode="#,##0"/>${txPr('<a:rPr sz="900"/>')}${flags('0', '0', '0')}`) +
      flags('1', '0', '0'),
    dLbl(0, `${txPr('<a:defRPr sz="1400"/>')}${flags('0', '0', '0')}`) +
      dLbl(1, flags('0', '0', '0')) +
      dLbl(2, flags('0', '0', '0')) +
      `<c:numFmt formatCode="0"/>${txPr('<a:defRPr sz="800"/>')}` +
      flags('1', '1', '1'),
    dLbl(0, flags('0', '1', '0')) + dLbl(1, flags('0', '1', '0')) + flags('1', '0', '0'),
    dLbl(0, flags('0', '1', '0')) +
      dLbl(1, flags('0', '1', '0')) +
      dLbl(2, '<c:delete val="1"/>') +
      flags('1', '0', '0'),
  ]
  for (const set of labelSets) {
    out.push(bar(ser({ ...BASIC, extra: dLbls(set) })))
    out.push(bar(ser(BASIC) + dLbls(set)))
  }
  out.push(
    bar(ser({ ...BASIC, extra: dLbls(flags('0', '0', '0')) }) + dLbls(flags('1', '1', '1'))),
    bar(ser({ cat: CATS }) + dLbls(dLbl(0, flags('0', '1', '0')) + flags('1', '0', '0'))),
    bar(
      ser({ cat: CATS, val: numRef(['1'], 1), tag: 'yVal' }) +
        dLbls(dLbl(0, flags('0', '1', '0')) + flags('0', '0', '0')),
    ),
    bar(dLbls(flags('1', '0', '0'))),
  )
  // legend
  for (const pos of ['b', 'l', 'r', 't', 'tr', 'x', '', 'B']) {
    out.push(bar(ser(BASIC), { legend: `<c:legend><c:legendPos val="${pos}"/></c:legend>` }))
  }
  out.push(
    bar(ser(BASIC), { legend: '' }),
    bar(ser(BASIC), { legend: '<c:legend><c:overlay val="0"/></c:legend>' }),
    bar(ser(BASIC), {
      legend: `<c:legend><c:legendPos val="t"/>${txPr('<a:defRPr sz="1050">' + solid('<a:srgbClr val="FF0000"/>') + '</a:defRPr>')}</c:legend>`,
    }),
    bar(ser(BASIC), {
      legend: `<c:legend><c:legendPos val="b"/><c:txPr><a:p><a:r><a:rPr sz="0"/></a:r><a:pPr><a:defRPr sz="1300"/></a:pPr></a:p></c:txPr></c:legend>`,
    }),
  )
  // frame line on c:chartSpace
  const frames = [
    spPr('<a:noFill/><a:ln><a:noFill/></a:ln>'),
    spPr(
      `<a:ln w="9525">${solid('<a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr>')}</a:ln>`,
    ),
    spPr(`<a:ln>${solid('<a:srgbClr val="00ff00"/>')}</a:ln>`),
    spPr('<a:ln w="9525"/>'),
    spPr(solid('<a:srgbClr val="FFFFFF"/>')),
    spPr(''),
  ]
  for (const frame of frames) {
    out.push(
      space(
        `<c:autoTitleDeleted val="1"/><c:plotArea><c:barChart>${ser(BASIC)}</c:barChart>${AXES}</c:plotArea>`,
      ).replace('</c:chart>', `</c:chart>${frame}`),
    )
  }
  // axes
  const ax = (tag: string, pos: string | undefined, inner = ''): string =>
    `<c:${tag}><c:axId val="9"/>${pos === undefined ? '' : `<c:axPos val="${pos}"/>`}${inner}</c:${tag}>`
  const title = (inner: string): string => `<c:title>${inner}</c:title>`
  const richTitle = (text: string): string =>
    title(
      `<c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r><a:r><a:t>!</a:t></a:r></a:p></c:rich></c:tx>`,
    )
  const axisSets = [
    ax('catAx', 'l', richTitle('Region \u00e9\u{1F600}')) + ax('valAx', 'b', '<c:delete val="1"/>'),
    ax('valAx', 'b', title(`<c:tx>${strRef(['From cell'])}</c:tx>`)) +
      ax('valAx', 'l', title('<c:overlay val="0"/>')),
    ax(
      'dateAx',
      't',
      lnOf('<a:noFill/>') +
        txPr('<a:defRPr sz="900">' + solid('<a:schemeClr val="tx1"/>') + '</a:defRPr>'),
    ) + ax('serAx', 'r', lnOf(solid('<a:srgbClr val="ABCDEF"/>')) + '<c:delete/>'),
    ax('catAx', undefined) +
      ax('valAx', 'z') +
      ax('catAx', 'b') +
      ax('valAx', 'b', '<c:delete val="1"/>'),
    ax('valAx', 'l', '<c:majorGridlines/>') +
      ax(
        'catAx',
        'b',
        '<c:majorGridlines><c:spPr><a:ln><a:noFill/></a:ln></c:spPr></c:majorGridlines>',
      ),
    ax(
      'valAx',
      'l',
      `<c:majorGridlines>${lnOf(solid('<a:srgbClr val="D9D9D9"/>'))}</c:majorGridlines>`,
    ) + ax('catAx', 'b', `<c:majorGridlines>${spPr('')}</c:majorGridlines>${lnOf('')}`),
    ax('surfaceAx', 'b') + ax('valAx', 'l', '<c:delete val="true"/>' + txPr('<a:defRPr/>')),
    '',
  ]
  for (const axes of axisSets) out.push(bar(ser(BASIC), { axes }))
  // data table
  const dTables = [
    '<c:dTable><c:showHorzBorder val="1"/><c:showVertBorder val="0"/><c:showOutline/><c:showKeys val="true"/></c:dTable>',
    '<c:dTable/>',
    `<c:dTable><c:showKeys val="1"/>${lnOf(solid('<a:schemeClr val="accent1"/>'))}</c:dTable>`,
    `<c:dTable><c:showOutline val="false"/>${lnOf('<a:noFill/>')}</c:dTable>`,
  ]
  for (const dTable of dTables) out.push(bar(ser(BASIC), { after: dTable }))
  // the caches: ptCount above and below the points, holes, odd idx, odd values
  out.push(
    bar(ser({ cat: strRef(['a', 'b'], 5), val: numRef(['1', '2'], 5) })),
    bar(ser({ cat: strRef(['a', 'b', 'c'], 1), val: numRef(['1', '2', '3'], 1) })),
    bar(ser({ cat: strRef(['a'], -3), val: numRef(['1'], 'x') })),
    bar(
      ser({
        cat: strRef(
          [
            ['2', 'c'],
            ['0', 'a'],
          ],
          0,
        ),
        val: numRef([['3', '9']], ''),
      }),
    ),
    bar(
      ser({
        cat: strRef([
          ['x', 'bad'],
          ['-1', 'neg'],
          ['1.9', 'one'],
          [' 2', 'two'],
          ['-0', 'zero'],
        ]),
        val: numRef(
          [
            ['0', '1'],
            ['1', ''],
            ['2', ' '],
            ['3', 'abc'],
            ['4', '1e3'],
            ['5', '0x10'],
            ['6', '-0'],
            ['7', 'Infinity'],
            ['8', '\u00a05\u00a0'],
          ],
          10,
        ),
      }),
    ),
    bar(
      ser({
        cat: '<c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"/><c:pt idx="1"><c:v></c:v></c:pt></c:strCache></c:strRef>',
        val: '<c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"/><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef>',
      }),
    ),
    // literal caches
    bar(
      ser({
        cat: '<c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>\u4e2d\u6587</c:v></c:pt><c:pt idx="1"><c:v>\u{1F4C8} up</c:v></c:pt></c:strLit>',
        val: '<c:numLit><c:formatCode>0</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>5</c:v></c:pt><c:pt idx="1"><c:v>6</c:v></c:pt></c:numLit>',
      }),
    ),
    // a cache whose ref holds a numCache under c:strRef
    bar(
      ser({
        cat: '<c:strRef><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>7</c:v></c:pt></c:numCache></c:strRef>',
        val: VALS,
      }),
    ),
    // the first series without categories: the next one gives them
    bar(
      ser({ val: VALS }) +
        ser({ cat: strRef([]), val: VALS }, 1) +
        ser({ cat: strRef(['late']), val: VALS }, 2),
    ),
  )
  // date categories
  const serials = [
    '45000',
    '60',
    '61',
    '59.5',
    '60.5',
    '0',
    '-1',
    '80000',
    '80001',
    '1.5',
    '',
    'abc',
    '0.4',
    '1e4',
  ]
  for (const format of [
    'm/d/yyyy',
    'General',
    'yyyy',
    'D',
    'mmm-yy',
    'hh:mm',
    '[$-409]d\\-mmm',
    '',
  ]) {
    out.push(bar(ser({ cat: numRef(serials, serials.length, format), val: numRef(['1']) })))
  }
  out.push(
    bar(
      ser({
        cat: `<c:numLit><c:formatCode>d-mmm</c:formatCode><c:ptCount val="2"/>${pts(['45292', '1'])}</c:numLit>`,
        val: VALS,
      }),
    ),
    bar(ser({ cat: `<c:numLit><c:ptCount val="1"/>${pts(['45292'])}</c:numLit>`, val: VALS })),
  )
  // series names
  const names = [
    '<c:tx><c:v>Literal \u00fc\u{1D11E}</c:v></c:tx>',
    '<c:tx><c:v></c:v></c:tx>',
    `<c:tx>${strRef([])}</c:tx>`,
    `<c:tx>${strRef([['1', 'second']], 2)}</c:tx>`,
    `<c:tx>${strRef([''])}</c:tx>`,
    '<c:tx/>',
    '',
  ]
  for (const name of names) {
    out.push(bar(ser({ ...BASIC, name }), { chart: '<c:title><c:overlay val="0"/></c:title>' }))
  }
  // series and point colours
  for (const clr of COLORS) {
    out.push(bar(ser({ ...BASIC, extra: spPr(solid(clr)) })))
  }
  const dPt = (idx: string, fill?: string): string =>
    `<c:dPt><c:idx val="${idx}"/><c:bubble3D val="0"/>${fill === undefined ? '' : spPr(solid(fill))}</c:dPt>`
  out.push(
    part(
      'c:pieChart',
      ser({
        ...BASIC,
        extra:
          dPt('0', '<a:schemeClr val="accent2"/>') +
          dPt('2', '<a:srgbClr val="00ff00"><a:lumMod val="50000"/></a:srgbClr>') +
          dPt('x', '<a:srgbClr val="0000FF"/>') +
          dPt('-1', '<a:srgbClr val="0000FF"/>') +
          dPt('5') +
          dPt('4', '<a:srgbClr val="bad"/>'),
      }),
    ),
    part('c:pieChart', ser({ ...BASIC, extra: dPt('1') + dPt('3', '<a:srgbClr val="ABCDEF"/>') })),
    part('c:pieChart', ser({ ...BASIC, extra: dPt('1048576', '<a:srgbClr val="ABCDEF"/>') })),
    part('c:pieChart', ser({ ...BASIC, extra: dPt('0', '<a:schemeClr val="accent6"/>') })),
  )
  // chart titles
  const titles = [
    { chart: '<c:title><c:overlay val="0"/></c:title>' },
    { chart: '<c:title/><c:autoTitleDeleted val="0"/>' },
    { chart: '<c:title/><c:autoTitleDeleted val="1"/>' },
    { chart: '<c:title/><c:autoTitleDeleted/>' },
    { chart: '<c:title/><c:autoTitleDeleted val="true"/>' },
    { chart: '<c:title/><c:autoTitleDeleted val="false"/>' },
    { chart: '' },
    { chart: richTitle('Sales \u00e9\u{1F680}') },
    {
      chart: `<c:title><c:tx>${strRef(['Cached title'])}</c:tx>${txPr('<a:defRPr sz="1400"/>')}</c:title>`,
    },
    {
      chart: `<c:title><c:tx><c:rich><a:p><a:r><a:t>Chart Title</a:t></a:r></a:p></c:rich></c:tx></c:title>`,
    },
    { chart: `<c:title>${txPr('<a:defRPr sz="1862"/>')}</c:title>` },
  ]
  for (const opts of titles) {
    out.push(bar(ser(BASIC), opts))
    out.push(bar(ser(BASIC) + ser(BASIC, 1), opts))
    out.push(bar(ser({ ...BASIC, name: '' }), opts))
  }
  // chart styles: c:style, the Word 2010 wrapper, its fallback
  const styleOf = (val: string): string => `<c:style val="${val}"/>`
  const alt = (choice: string, fallback: string): string =>
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="c14" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`
  const styles = [
    ...[
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '17',
      '42',
      '48',
      '49',
      '0',
      '-1',
      'x',
      '101',
      '148',
      '149',
    ].map(styleOf),
    alt('<c14:style val="102"/>', styleOf('2')),
    alt('<c14:style val="105"/>', styleOf('5')),
    alt('<c14:style val="150"/>', styleOf('3')),
    alt('<c14:other val="1"/>', styleOf('4')),
    alt('', styleOf('9')),
    alt('<c14:style val="101"/>', ''),
    '',
  ]
  for (const style of styles) out.push(bar(ser(BASIC), { outer: style }))
  // more series than the cap; one cache asks more points than the share allows
  const many: string[] = []
  for (let i = 0; i < 258; i++) {
    many.push(
      ser(
        i === 0
          ? {
              cat: strRef(['a'], 100000),
              val: numRef(
                [
                  ['0', '1'],
                  ['5000', '2'],
                ],
                1000000,
              ),
            }
          : { val: numRef([String(i)]) },
        i,
      ),
    )
  }
  out.push(bar(many.join('')))
  // a text mentioning the chart extension inside a classic part
  out.push(bar(ser(BASIC)).replace('<c:chart>', '<!-- <cx:chartSpace --><c:chart>'))
  // non-ASCII and astral text
  out.push(
    bar(
      ser({
        name: `<c:tx>${strRef(['\u0130stanbul \u212A\u{1F30D}'])}</c:tx>`,
        cat: strRef(['\u00c5', '\u{20BB7}', '&lt;&amp;&gt;']),
        val: VALS,
      }),
    ),
  )
  return out
}

// ---------------------------------------------------------------- chartex

const CX_NS =
  'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

const cxPts = (values: Array<[string, string]>): string =>
  values.map(([idx, v]) => `<cx:pt idx="${idx}">${v}</cx:pt>`).join('')

const cxData = (
  id: string,
  cats: Array<[string, string]> | null,
  vals: Array<[string, string]> | null,
): string =>
  `<cx:data id="${id}">` +
  (cats
    ? `<cx:strDim type="cat"><cx:f>S!A2</cx:f><cx:lvl ptCount="${cats.length}">${cxPts(cats)}</cx:lvl></cx:strDim>`
    : '') +
  (vals
    ? `<cx:numDim type="val"><cx:f>S!B2</cx:f><cx:lvl ptCount="${vals.length}" formatCode="General">${cxPts(vals)}</cx:lvl></cx:numDim>`
    : '') +
  '</cx:data>'

const cxSeries = (layout: string, dataId: string | null, name?: string): string =>
  `<cx:series layoutId="${layout}" uniqueId="{1}">` +
  (name === undefined
    ? ''
    : `<cx:tx><cx:txData><cx:f>S!B1</cx:f><cx:v>${name}</cx:v></cx:txData></cx:tx>`) +
  (dataId === null ? '' : `<cx:dataId val="${dataId}"/>`) +
  '</cx:series>'

const cxSpace = (data: string, series: string, title = '', dataTag = 'cx:chartData'): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cx:chartSpace ${CX_NS}><${dataTag}>${data}</${dataTag}>` +
  `<cx:chart>${title}<cx:plotArea><cx:plotAreaRegion>${series}</cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`

const CX_CATS: Array<[string, string]> = [
  ['0', 'Q1'],
  ['1', 'Q2'],
  ['2', '\u00e9t\u00e9 \u{1F31E}'],
]
const CX_VALS: Array<[string, string]> = [
  ['0', '10'],
  ['1', ' '],
  ['2', 'abc'],
  ['3', '1e2'],
]
const cxTitle = (text: string): string =>
  `<cx:title pos="t"><cx:tx><cx:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></cx:rich></cx:tx></cx:title>`

function builtChartex(): string[] {
  const out: string[] = []
  for (const layout of [
    'clusteredColumn',
    'boxWhisker',
    'waterfall',
    'funnel',
    'paretoLine',
    'sunburst',
    'treemap',
    'regionMap',
    'constructor',
    '',
  ]) {
    out.push(
      cxSpace(
        cxData('0', CX_CATS, CX_VALS),
        cxSeries(layout, '0', 'Series \u00fc'),
        cxTitle('Title \u{1F4CA}'),
      ),
    )
  }
  out.push(
    // the data under another element name
    cxSpace(cxData('0', CX_CATS, CX_VALS), cxSeries('sunburst', '0'), '', 'cx:renamedData'),
    // no data, no series with values, a missing id
    cxSpace('', cxSeries('treemap', '0')),
    cxSpace(cxData('0', CX_CATS, null), cxSeries('treemap', '0')),
    cxSpace(cxData('0', CX_CATS, CX_VALS), cxSeries('treemap', null)),
    cxSpace(cxData('1', CX_CATS, CX_VALS), cxSeries('treemap', '0')),
    // the first series without data sets no categories; the kind comes from it anyway
    cxSpace(
      cxData('0', [['0', 'only']], CX_VALS) + cxData('1', null, [['0', '5']]),
      cxSeries('waterfall', '9') + cxSeries('funnel', '1', '') + cxSeries('paretoLine', '0', 'P'),
      cxTitle(''),
    ),
    // a later cx:data of the same id replaces the earlier
    cxSpace(
      cxData('0', CX_CATS, CX_VALS) + cxData('0', [['0', 'later']], [['0', '7']]),
      cxSeries('funnel', '0'),
    ),
    // holes and odd idx in the values
    cxSpace(
      cxData(
        '0',
        [
          ['0', 'a'],
          ['1', 'b'],
        ],
        [
          ['3', '4'],
          ['x', '1'],
          ['-1', '2'],
          ['1048576', '3'],
          ['0', '-0'],
        ],
      ),
      cxSeries('boxWhisker', '0'),
    ),
    // title without text, title absent
    cxSpace(cxData('0', CX_CATS, CX_VALS), cxSeries('sunburst', '0'), '<cx:title/>'),
    // no top-level cx:chartSpace
    `<cx:other ${CX_NS}><cx:chartSpace/></cx:other>`,
    `<c:chartSpace><!-- <cx:chartSpace --></c:chartSpace>`,
    `<cx:chartSpace ${CX_NS}><cx:chartData>${cxData('0', CX_CATS, CX_VALS)}</cx:chartData></cx:chartSpace>`,
  )
  return out
}

/** A category hole of a chartex strDim: listed as chartex-category-hole-written-as-null. */
const CHARTEX_CATEGORY_HOLE = cxSpace(
  cxData(
    '0',
    [
      ['0', 'a'],
      ['2', 'c'],
    ],
    [
      ['0', '1'],
      ['1', '2'],
      ['2', '3'],
    ],
  ),
  cxSeries('treemap', '0'),
)

// ---------------------------------------------------------------- colours

const HEXES = [
  '4472C4',
  'ffffff',
  '000000',
  '808080',
  'FF0000',
  'FFFF00',
  '00FF00',
  '00FFFF',
  '0000FF',
  'FF00FF',
  'FF8000',
  '8000FF',
  '00FF80',
  'abc',
  'zz1234',
  '0x1234',
  '-10203',
  '+f0000',
  '\u{1F600}a1b2',
  '',
  ' 12345',
  '\u00e912345',
  '1\u{1F600}2345',
]

const FACTORS: unknown[] = [0, 0.5, 1, 1.5, -0.5, 0.15, 0.75, 0.6, 0.3, 0.8, null, 1e9, -0]

const LUMS: Array<[unknown, unknown]> = [
  [1, 0],
  [0.5, 0],
  [0.75, 0.25],
  [1, 1],
  [0, -1],
  [2, 0.5],
  [null, 0],
  [0.6, 0.4],
  [0.85, 0.15],
  [1, -0.5],
]

// ---------------------------------------------------------------- specs

const CHART_PART = /^word\/charts\/[^/]+\.xml$/

function partInputs(parts: ReadonlyMap<string, string>): Input[] {
  const theme = readThemeColors(parts.get('word/theme/theme1.xml') ?? '')
  return [...parts]
    .filter(([name]) => CHART_PART.test(name))
    .flatMap(([partPath, text]) => [
      { text, args: { partPath } },
      { text, args: { partPath, theme } },
    ])
}

export const CHART: CallSpec[] = [
  {
    fn: 'chart.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'chart.parseChartPartXml',
    call: (text, args) =>
      parseChartPartXml(text, String(args.partPath), args.theme as ThemeColors | null | undefined),
    fromDocument: partInputs,
    built: [
      ...builtParts().flatMap((text, i) =>
        THEMES.map((theme) => ({
          text,
          args: theme
            ? { partPath: `word/charts/chart${i + 1}.xml`, theme }
            : { partPath: `word/charts/chart${i + 1}.xml` },
        })),
      ),
      ...builtChartex().flatMap((text, i) =>
        THEMES.slice(0, 2).map((theme) => ({
          text,
          args: theme ? { partPath: `word/charts/chartEx${i + 1}.xml`, theme } : { partPath: 'p' },
        })),
      ),
      { text: CHARTEX_CATEGORY_HOLE, args: { partPath: 'word/charts/chartEx99.xml' } },
      { text: bar(ser(BASIC)), args: { partPath: '', theme: null } },
    ],
    argMutation: true,
  },
  {
    fn: 'chart.shadeHex',
    call: (_text, args) => shadeHex(String(args.hex), num(args.factor)),
    built: HEXES.flatMap((hex) => FACTORS.map((factor) => ({ args: { hex, factor } }))),
    argMutation: true,
    mutation: 'none',
  },
  {
    fn: 'chart.tintHex',
    call: (_text, args) => tintHex(String(args.hex), num(args.factor)),
    built: HEXES.flatMap((hex) => FACTORS.map((factor) => ({ args: { hex, factor } }))),
    argMutation: true,
    mutation: 'none',
  },
  {
    fn: 'chart.lumHex',
    call: (_text, args) => lumHex(String(args.hex), num(args.mod), num(args.off)),
    built: HEXES.flatMap((hex) => LUMS.map(([mod, off]) => ({ args: { hex, mod, off } }))),
    argMutation: true,
    mutation: 'none',
  },
]
