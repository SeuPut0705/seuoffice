/**
 * A chart's on/off settings are CT_Boolean elements (`<c:delete val="1"/>`), whose val is an
 * xsd:boolean: "1" and "true" are true, "0" and "false" are false, and an element written
 * without val is true, the schema's default for every CT_Boolean. The reader took "1" for the
 * only true at some sites and "0" for the only false at others, so another producer's
 * val="true", val="false" or bare element read the other way round. The attributes that are
 * xsd:boolean in DrawingML (b, i, rtl) read the same.
 * (Inputs from the Rust port's divergence ledger: chart-xsd-boolean.)
 */
import { describe, expect, it } from 'vitest'
import { parseChartXml, type ChartModel } from '../src/chart'

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"'
const CAT =
  '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$9</c:f><c:strCache><c:ptCount val="4"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt><c:pt idx="3"><c:v>Q4</c:v></c:pt></c:strCache></c:strRef></c:cat>'
const VAL =
  '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$9</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt><c:pt idx="2"><c:v>30</c:v></c:pt><c:pt idx="3"><c:v>40</c:v></c:pt></c:numCache></c:numRef></c:val>'
const NAME =
  '<c:tx><c:strRef><c:f>Sheet1!$A$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>S1</c:v></c:pt></c:strCache></c:strRef></c:tx>'
const axes = (cat = '', val = '') =>
  `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${cat}<c:crossAx val="2"/></c:catAx>` +
  `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>${val || '<c:delete val="0"/>'}<c:axPos val="l"/><c:crossAx val="1"/></c:valAx>`

interface Parts {
  head?: string
  plot?: 'barChart' | 'lineChart' | 'bar3DChart'
  ser?: string
  plotTail?: string
  cat?: string
  val?: string
  area?: string
  legend?: string
}

const chart = (p: Parts): ChartModel => {
  const plot = p.plot ?? 'barChart'
  const dir = plot === 'lineChart' ? '' : '<c:barDir val="col"/>'
  const xml =
    `<c:chartSpace ${NS}><c:chart>${p.head ?? '<c:autoTitleDeleted val="0"/>'}<c:plotArea><c:layout/>` +
    `<c:${plot}>${dir}<c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>${NAME}${p.ser ?? ''}${CAT}${VAL}</c:ser>` +
    `${p.plotTail ?? ''}<c:axId val="1"/><c:axId val="2"/></c:${plot}>${axes(p.cat, p.val)}${p.area ?? ''}</c:plotArea>` +
    `<c:legend><c:legendPos val="r"/>${p.legend ?? ''}</c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`
  return parseChartXml(xml, undefined)!
}

/** The forms of a true and of a false CT_Boolean; `el('c:x', form)` writes one. */
const TRUE = ['val="1"', 'val="true"', '']
const FALSE = ['val="0"', 'val="false"']
const el = (name: string, form: string) => (form ? `<${name} ${form}/>` : `<${name}/>`)

/** One CT_Boolean of the chart: where it is written, and what the model reads of it. */
const CASES: Array<[string, (form: string) => unknown, unknown, unknown]> = [
  [
    'c:dLbls/c:delete of a series',
    (f) =>
      chart({ ser: `<c:dLbls>${el('c:delete', f)}<c:showVal val="1"/></c:dLbls>` }).series[0]!
        .dataLabels,
    false,
    true,
  ],
  [
    'c:dLbls/c:showVal of a series',
    (f) => chart({ ser: `<c:dLbls>${el('c:showVal', f)}</c:dLbls>` }).series[0]!.dataLabels,
    true,
    false,
  ],
  [
    'c:dLbls/c:showCatName of a plot',
    (f) =>
      chart({ plot: 'lineChart', plotTail: `<c:dLbls>${el('c:showCatName', f)}</c:dLbls>` })
        .dataLabelCatName === true,
    true,
    false,
  ],
  [
    'c:dLbl/c:delete of a point',
    (f) =>
      chart({
        ser: `<c:dLbls><c:dLbl><c:idx val="1"/>${el('c:delete', f)}</c:dLbl><c:showVal val="1"/></c:dLbls>`,
      }).series[0]!.dLblOverrides?.[0]?.hidden === true,
    true,
    false,
  ],
  [
    'c:smooth of a line series',
    (f) => chart({ plot: 'lineChart', ser: el('c:smooth', f) }).series[0]!.smooth === true,
    true,
    false,
  ],
  [
    'c:marker of a line plot',
    (f) => chart({ plot: 'lineChart', plotTail: el('c:marker', f) }).series[0]!.marker,
    true,
    false,
  ],
  [
    'c:delete of the value axis',
    (f) => chart({ val: el('c:delete', f) }).valAxis?.hidden === true,
    true,
    false,
  ],
  [
    'c:overlay of an axis title',
    (f) =>
      chart({
        cat: `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Axis</a:t></a:r></a:p></c:rich></c:tx>${el('c:overlay', f)}</c:title>`,
      }).catAxis?.titleOverlay === true,
    true,
    false,
  ],
  [
    'c:overlay of the legend',
    (f) => chart({ legend: el('c:overlay', f) }).legendOverlay === true,
    true,
    false,
  ],
  [
    'c:delete of a legend entry',
    (f) =>
      chart({ legend: `<c:legendEntry><c:idx val="0"/>${el('c:delete', f)}</c:legendEntry>` })
        .legendOrder,
    [],
    undefined,
  ],
  [
    'c:overlay of the chart title',
    (f) =>
      chart({
        head: `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>T</a:t></a:r></a:p></c:rich></c:tx>${el('c:overlay', f)}</c:title><c:autoTitleDeleted val="0"/>`,
      }).titleOverlay === true,
    true,
    false,
  ],
  [
    'c:autoTitleDeleted under a title without text',
    (f) =>
      chart({
        head: `<c:title>${el('c:overlay', 'val="0"')}</c:title>${el('c:autoTitleDeleted', f)}`,
      }).title,
    undefined,
    'S1',
  ],
  [
    'c:showKeys of the data table',
    (f) => chart({ area: `<c:dTable>${el('c:showKeys', f)}</c:dTable>` }).dataTable?.showKeys,
    true,
    false,
  ],
  [
    'c:rAngAx of a 3-D bar chart',
    (f) =>
      chart({
        plot: 'bar3DChart',
        head: `<c:autoTitleDeleted val="0"/><c:view3D>${el('c:rAngAx', f)}</c:view3D>`,
      }).bar3D?.rAngAx,
    true,
    false,
  ],
  [
    'c:delete of a 3-D series axis',
    (f) =>
      chart({
        plot: 'bar3DChart',
        area: `<c:serAx><c:axId val="3"/>${el('c:delete', f)}</c:serAx>`,
      }).bar3D?.serAxLabels,
    false,
    true,
  ],
]

describe.each(CASES)('%s', (_name, read, whenTrue, whenFalse) => {
  it.each(TRUE)('<… %s/> is true', (form) => {
    expect(read(form)).toEqual(whenTrue)
  })
  it.each(FALSE)('<… %s/> is false', (form) => {
    expect(read(form)).toEqual(whenFalse)
  })
})

describe('xsd:boolean attributes of the chart text', () => {
  const axisLabel = (b: string) =>
    chart({
      cat: `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr ${b}/></a:pPr><a:endParaRPr/></a:p></c:txPr>`,
    }).catAxis?.labelBold === true

  it.each(['b="1"', 'b="true"'])('an axis label with %s is bold', (b) => {
    expect(axisLabel(b)).toBe(true)
  })
  it.each(['b="0"', 'b="false"'])('an axis label with %s is not bold', (b) => {
    expect(axisLabel(b)).toBe(false)
  })
})
