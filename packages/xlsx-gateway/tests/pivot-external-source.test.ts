import { describe, expect, it } from 'vitest'

import { parsePivotDefinition } from '../src/gateway/xlsx-pivot'

const PIVOT_XML =
  '<pivotTableDefinition name="PivotTable1" cacheId="1">' +
  '<location ref="E3:F5" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>' +
  '<pivotFields count="2"><pivotField axis="axisRow" showAll="0"><items count="2">' +
  '<item x="0"/><item t="default"/></items></pivotField><pivotField dataField="1" showAll="0"/></pivotFields>' +
  '<rowFields count="1"><field x="0"/></rowFields>' +
  '<rowItems count="2"><i><x/></i><i t="grand"><x/></i></rowItems>' +
  '<colItems count="1"><i/></colItems>' +
  '<dataFields count="1"><dataField name="Sum of Amount" fld="1"/></dataFields>' +
  '</pivotTableDefinition>'

const cache = (source: string): string =>
  `<pivotCacheDefinition xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<cacheSource type="worksheet">${source}</cacheSource>` +
  '<cacheFields count="2">' +
  '<cacheField name="Region"><sharedItems count="1"><s v="East"/></sharedItems></cacheField>' +
  '<cacheField name="Amount"><sharedItems containsString="0" containsNumber="1"/></cacheField>' +
  '</cacheFields></pivotCacheDefinition>'

describe('a pivot whose data is a range of another workbook', () => {
  it('is not given a source in this workbook, and cannot be refreshed from one', () => {
    // The sheet and range are those of the other workbook; this one may well
    // have a sheet of the same name, with other data on it.
    const definition = parsePivotDefinition(
      PIVOT_XML,
      cache('<worksheetSource ref="A1:B7" sheet="Data" r:id="rId1"/>'),
    )
    expect(definition.sourceSheet).toBe('')
    expect(definition.sourceRef).toBe('')
    expect(definition.unsupported).toEqual(['the data source is a range of another workbook'])
  })

  it('keeps the source of a pivot over a sheet of this workbook', () => {
    const definition = parsePivotDefinition(
      PIVOT_XML,
      cache('<worksheetSource ref="A1:B7" sheet="Data"/>'),
    )
    expect(definition.sourceSheet).toBe('Data')
    expect(definition.sourceRef).toBe('A1:B7')
    expect(definition.unsupported).toEqual([])
  })
})
