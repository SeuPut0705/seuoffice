/**
 * Report filters sit above a pivot's output, outside the range its `location` names. How many
 * rows and columns of them there are is in the same element: a reader that has to know which
 * cells belong to the pivot (the cells hidden from the AI, edit protection) needs both.
 */
import { describe, expect, it } from 'vitest'

import { parsePivotDefinition } from '../src/gateway/xlsx-pivot'

const pivot = (location: string, pageFields: number): string =>
  '<pivotTableDefinition name="PivotTable1" cacheId="1">' +
  `<location ref="E5:F7" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"${location}/>` +
  '<pivotFields count="2"><pivotField axis="axisRow" showAll="0"><items count="2">' +
  '<item x="0"/><item t="default"/></items></pivotField><pivotField dataField="1" showAll="0"/></pivotFields>' +
  '<rowFields count="1"><field x="0"/></rowFields>' +
  '<rowItems count="2"><i><x/></i><i t="grand"><x/></i></rowItems>' +
  (pageFields > 0
    ? `<pageFields count="${pageFields}">${'<pageField fld="0" hier="-1"/>'.repeat(pageFields)}</pageFields>`
    : '') +
  '<colItems count="1"><i/></colItems>' +
  '<dataFields count="1"><dataField name="Sum of Amount" fld="1"/></dataFields>' +
  '</pivotTableDefinition>'

const CACHE =
  '<pivotCacheDefinition><cacheSource type="worksheet"><worksheetSource ref="A1:B7" sheet="Data"/></cacheSource>' +
  '<cacheFields count="2">' +
  '<cacheField name="Region"><sharedItems count="1"><s v="East"/></sharedItems></cacheField>' +
  '<cacheField name="Amount"><sharedItems containsString="0" containsNumber="1"/></cacheField>' +
  '</cacheFields></pivotCacheDefinition>'

const layoutOf = (location: string, pageFields: number) => {
  const { pageRows, pageColumns } = parsePivotDefinition(pivot(location, pageFields), CACHE)
  return { pageRows, pageColumns }
}

describe('the extent of a pivot’s report filters', () => {
  it('is none for a pivot without filters', () => {
    expect(layoutOf('', 0)).toEqual({ pageRows: 0, pageColumns: 0 })
  })

  it('is what the location says: filters one below the other, or wrapped side by side', () => {
    expect(layoutOf(' rowPageCount="2" colPageCount="1"', 2)).toEqual({
      pageRows: 2,
      pageColumns: 1,
    })
    expect(layoutOf(' rowPageCount="1" colPageCount="3"', 3)).toEqual({
      pageRows: 1,
      pageColumns: 3,
    })
  })

  it.each([
    ['says nothing', ''],
    ['gives no number', ' rowPageCount="x" colPageCount=""'],
    ['gives none or less', ' rowPageCount="0" colPageCount="-1"'],
    ['gives a fraction', ' rowPageCount="1.5" colPageCount="1"'],
  ])('is not known when a pivot with filters %s about it', (_what, location) => {
    expect(layoutOf(location, 2)).toEqual({ pageRows: undefined, pageColumns: undefined })
  })

  it('is what the location declares even when the part lists no filter', () => {
    expect(layoutOf(' rowPageCount="1" colPageCount="2"', 0)).toEqual({
      pageRows: 1,
      pageColumns: 2,
    })
    // half a layout is none
    expect(layoutOf(' rowPageCount="1"', 0)).toEqual({
      pageRows: undefined,
      pageColumns: undefined,
    })
  })
})
