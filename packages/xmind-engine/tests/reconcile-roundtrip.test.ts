import { describe, expect, it } from 'vitest'
import { reconcileSheet } from '../src/reconcile'
import { addSheet, deleteSheet, renameSheet } from '../src/sheets'
import type { ViewSheet } from '../src/view'
import { buildMapFile, CONTENT, openOk, sampleSheets, text, unzip } from './helpers'
import { detach, inView } from './reconcile-helpers'

const NOW = new Date(Date.UTC(2031, 4, 6, 7, 8, 10))

/**
 * Whether a file is written again is decided by the tree: one that is again
 * what the file holds saves as the file's own bytes, however it got there.
 */
describe('an edit and its reversal', () => {
  async function thereAndBack(there: (view: ViewSheet) => void, back: (view: ViewSheet) => void) {
    const original = await buildMapFile()
    const document = await openOk(original)
    for (const change of [there, back]) {
      const view = document.viewSheets()[0]!
      change(view)
      const result = reconcileSheet(document, 0, view)
      expect(result).toMatchObject({ ok: true, changed: true })
      if (change === there) expect(document.changed).toBe(true)
    }
    expect(document.changed).toBe(false)
    expect(await document.save({ now: NOW })).toEqual(original)
  }

  it('saves byte for byte after a title was edited and put back', async () => {
    await thereAndBack(
      (view) => {
        inView(view, 'b').title = 'Something else'
      },
      (view) => {
        inView(view, 'b').title = 'Beta \u{1F600} 한글'
      },
    )
  })

  it('saves byte for byte after a branch was moved and moved back', async () => {
    await thereAndBack(
      (view) => {
        inView(view, 'c').children.push(detach(view, 'a'))
      },
      (view) => {
        view.root.children.unshift(detach(view, 'a'))
      },
    )
  })

  it('saves byte for byte after a sheet was renamed and renamed back', async () => {
    const original = await buildMapFile()
    const document = await openOk(original)
    expect(renameSheet(document, 0, 'Another name')).toEqual({ ok: true })
    expect(document.changed).toBe(true)
    expect(renameSheet(document, 0, 'Sheet one')).toEqual({ ok: true })
    expect(document.changed).toBe(false)
    expect(await document.save({ now: NOW })).toEqual(original)
  })

  it('saves byte for byte after a sheet was added and deleted again', async () => {
    const original = await buildMapFile()
    const document = await openOk(original)
    const index = addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' })
    expect(document.changed).toBe(true)
    expect(deleteSheet(document, index)).toEqual({ ok: true })
    expect(document.changed).toBe(false)
    expect(await document.save({ now: NOW })).toEqual(original)
  })

  it('still writes a changed file for an edit that stays', async () => {
    const original = await buildMapFile()
    const document = await openOk(original)
    const view = document.viewSheets()[0]!
    inView(view, 'b').title = 'Stays'
    reconcileSheet(document, 0, view)
    expect(renameSheet(document, 0, 'Renamed')).toEqual({ ok: true })
    addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' })
    expect(document.changed).toBe(true)
    const saved = await document.save({ now: NOW })
    expect(saved).not.toEqual(original)
    const reopened = await openOk(saved)
    expect(reopened.viewSheets().map((sheet) => sheet.title)).toEqual(['Renamed', 'Sheet 2'])
    expect(inView(reopened.viewSheets()[0]!, 'b').title).toBe('Stays')
    // and that file is the new baseline: nothing further to write
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(saved)
  })

  it('writes each of the three sheet edits on its own', async () => {
    const edits: ((document: Awaited<ReturnType<typeof openOk>>) => void)[] = [
      (document) => void addSheet(document, { title: 'Sheet 2', rootTitle: 'Central' }),
      (document) => void renameSheet(document, 0, 'Renamed'),
      (document) => void deleteSheet(document, 0),
    ]
    for (const change of edits) {
      const second = { id: 'sheet-2', title: 'Second', rootTopic: { id: 'root' } }
      const original = await buildMapFile({ content: [...sampleSheets(), second] })
      const document = await openOk(original)
      change(document)
      expect(document.changed).toBe(true)
      const saved = await document.save({ now: NOW })
      expect(saved).not.toEqual(original)
      const written = JSON.parse(text((await unzip(saved)).get(CONTENT)!))
      expect(written).toEqual(document.sheets)
    }
  })
})

describe('a sheet key named like the prototype', () => {
  const content =
    '[{"id":"s","__proto__":{"own":1},"rootTopic":{"id":"r","title":"T","__proto__":{"own":2}},"title":"S"}]'

  it('stays an own key through a reconcile that changes the sheet', async () => {
    const document = await openOk(await buildMapFile({ contentText: content }))
    const live = document.sheets[0]!
    const view = document.viewSheets()[0]!
    view.root.title = 'Edited'
    expect(reconcileSheet(document, 0, view)).toMatchObject({ ok: true, changed: true })
    expect(document.sheets[0]).toBe(live)
    expect(Object.getPrototypeOf(live)).toBe(Object.prototype)
    expect(Object.keys(live)).toEqual(['id', '__proto__', 'rootTopic', 'title'])
    const written = text((await unzip(await document.save({ now: NOW }))).get(CONTENT)!)
    expect(written).toBe(content.replace('"title":"T"', '"title":"Edited"'))
  })

  it('saves byte for byte when nothing changed', async () => {
    const original = await buildMapFile({ contentText: content })
    const document = await openOk(original)
    const result = reconcileSheet(document, 0, document.viewSheets()[0]!)
    expect(result).toMatchObject({ ok: true, changed: false })
    expect(await document.save()).toEqual(original)
  })
})
