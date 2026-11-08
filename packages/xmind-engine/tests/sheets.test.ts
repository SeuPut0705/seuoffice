import { afterEach, describe, expect, it } from 'vitest'
import { setDefaultSheetTheme } from '../src/create'
import { addSheet, deleteSheet, renameSheet } from '../src/sheets'
import type { XmindSheet } from '../src/types'
import { buildMapFile, CONTENT, openOk, sampleSheets, text, unzip } from './helpers'
import { copyOf, openSheets, UUID_V4 } from './reconcile-helpers'

const NOW = new Date(Date.UTC(2031, 4, 6, 7, 8, 10))

afterEach(() => setDefaultSheetTheme(null))

function twoSheets(): unknown[] {
  const second = { id: 'sheet-2', title: 'Second', rootTopic: { id: 'root', title: 'Other' } }
  return [...sampleSheets(), second]
}

describe('addSheet', () => {
  it('adds a sheet with one central topic after the others', async () => {
    const document = await openSheets(sampleSheets())
    const before = copyOf(document.sheets[0])
    expect(addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' })).toBe(1)
    expect(document.sheets).toHaveLength(2)
    expect(document.sheets[0]).toEqual(before)
    expect(document.sheets[1]).toEqual({
      id: expect.stringMatching(UUID_V4),
      class: 'sheet',
      rootTopic: { id: expect.stringMatching(UUID_V4), class: 'topic', title: 'Central' },
      title: 'Sheet 2',
    })
    expect(document.changed).toBe(true)
    expect(document.viewSheets()[1]).toMatchObject({
      index: 1,
      title: 'Sheet 2',
      root: { title: 'Central', children: [] },
    })
  })

  it('dresses the new sheet in the default theme when one is registered', async () => {
    setDefaultSheetTheme((sheet) => {
      sheet.theme = { map: { properties: { 'svg:fill': '#fefefe' } } }
    })
    const document = await openSheets(sampleSheets())
    const index = addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' })
    expect(document.sheets[index]!.theme).toEqual({
      map: { properties: { 'svg:fill': '#fefefe' } },
    })
    expect((document.sheets[0] as XmindSheet).theme).toEqual(
      (sampleSheets()[0] as XmindSheet).theme,
    )
  })

  it('writes a file that opens again with both sheets', async () => {
    const document = await openSheets(sampleSheets())
    addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' })
    const reopened = await openOk(await document.save({ now: NOW }))
    expect(reopened.viewSheets().map((view) => view.title)).toEqual(['Sheet one', 'Sheet 2'])
    expect(reopened.sheets[0]).toEqual(sampleSheets()[0])
  })
})

describe('renameSheet', () => {
  it('writes the new title and nothing else', async () => {
    const original = await buildMapFile({ content: twoSheets() })
    const document = await openOk(original)
    expect(renameSheet(document, 1, 'Renamed')).toEqual({ ok: true })
    expect(document.changed).toBe(true)
    const saved = JSON.parse(text((await unzip(await document.save({ now: NOW }))).get(CONTENT)!))
    const expected = twoSheets() as XmindSheet[]
    expected[1]!.title = 'Renamed'
    expect(JSON.stringify(saved)).toBe(JSON.stringify(expected))
  })

  it('leaves the document unchanged when the title is the one the sheet has', async () => {
    const original = await buildMapFile({ content: twoSheets() })
    const document = await openOk(original)
    expect(renameSheet(document, 0, 'Sheet one')).toEqual({ ok: true })
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(original)
  })

  it('refuses a sheet that is not there and a title that is not text', async () => {
    const document = await openSheets(twoSheets())
    expect(renameSheet(document, 2, 'x')).toEqual({ ok: false, problem: 'no-such-sheet' })
    expect(renameSheet(document, -1, 'x')).toEqual({ ok: false, problem: 'no-such-sheet' })
    expect(renameSheet(document, 0.5, 'x')).toEqual({ ok: false, problem: 'no-such-sheet' })
    expect(renameSheet(document, 0, 5 as unknown as string)).toEqual({
      ok: false,
      problem: 'bad-title',
    })
    expect(document.changed).toBe(false)
  })
})

describe('deleteSheet', () => {
  it('removes the sheet with everything on it, and leaves the others as they were', async () => {
    const document = await openSheets(twoSheets())
    const kept = copyOf(document.sheets[1])
    expect(deleteSheet(document, 0)).toEqual({ ok: true })
    expect(document.sheets).toEqual([kept])
    expect(document.changed).toBe(true)
    const reopened = await openOk(await document.save({ now: NOW }))
    expect(reopened.viewSheets().map((view) => [view.index, view.title])).toEqual([[0, 'Second']])
  })

  it('cannot delete the last sheet', async () => {
    const original = await buildMapFile()
    const document = await openOk(original)
    expect(deleteSheet(document, 0)).toEqual({ ok: false, problem: 'last-sheet' })
    expect(document.sheets).toHaveLength(1)
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(original)
  })

  it('can delete down to one sheet and no further', async () => {
    const document = await openSheets(twoSheets())
    expect(deleteSheet(document, 1)).toEqual({ ok: true })
    expect(deleteSheet(document, 0)).toEqual({ ok: false, problem: 'last-sheet' })
    expect(document.viewSheets().map((view) => view.title)).toEqual(['Sheet one'])
  })

  it('refuses a sheet that is not there', async () => {
    const document = await openSheets(twoSheets())
    for (const index of [2, -1, 0.5, Number.NaN]) {
      expect(deleteSheet(document, index)).toEqual({ ok: false, problem: 'no-such-sheet' })
    }
    expect(document.sheets).toHaveLength(2)
    expect(document.changed).toBe(false)
  })
})
