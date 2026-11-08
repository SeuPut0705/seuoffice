import { describe, expect, it } from 'vitest'
import { openXmind } from '../src/open'
import { reconcileSheet } from '../src/reconcile'
import type { XmindSheet } from '../src/types'
import { buildMapFile, fakePng, MANIFEST, openOk, sampleSheets, text } from './helpers'
import { copyOf, inSource, inView, openSheets } from './reconcile-helpers'

/**
 * Pictures a tool brings in: a state sets a topic's picture only to an entry
 * the archive holds under resources/, and a new entry travels with the next
 * save (and is listed in the manifest).
 */

describe('a picture set from the state', () => {
  it('writes an archive entry onto the topic and reports it in the view', async () => {
    const bytes = await buildMapFile({
      content: sampleSheets(),
      extra: [{ name: 'resources/picture.png', data: fakePng(9) }],
    })
    const document = await openOk(bytes)
    const view = document.viewSheets()[0]!
    inView(view, 'a').image = {
      src: 'xap:resources/picture.png',
      entryName: 'resources/picture.png',
      width: 320,
      height: 200,
    }
    const result = reconcileSheet(document, 0, view)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.inSync).toBe(true)

    const topic = inSource(document.sheets[0]!, 'a')
    expect(topic?.image).toEqual({
      src: 'xap:resources/picture.png',
      width: 320,
      height: 200,
    })
    expect(inView(result.view, 'a').image).toEqual({
      src: 'xap:resources/picture.png',
      entryName: 'resources/picture.png',
      width: 320,
      height: 200,
    })
  })

  it('keeps the unknown keys of an unchanged picture (no rewrite of the same one)', async () => {
    const content = sampleSheets() as Record<string, unknown>[]
    const beta = inSource(content[0] as unknown as XmindSheet, 'b')!
    beta.image = { ...(beta.image as Record<string, unknown>), naturalWidth: 999 }
    const document = await openOk(
      await buildMapFile({
        content: [content[0]],
        extra: [{ name: 'resources/picture.png', data: fakePng(9) }],
      }),
    )
    const view = document.viewSheets()[0]!
    const result = reconcileSheet(document, 0, view)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(inSource(document.sheets[0]!, 'b')?.image).toMatchObject({ naturalWidth: 999 })
  })

  it('ignores an entry the file does not hold, changes nothing, and asks for a redraw', async () => {
    const document = await openSheets(sampleSheets())
    const before = copyOf(document.sheets)
    const view = document.viewSheets()[0]!
    inView(view, 'a').image = {
      src: 'xap:resources/missing.png',
      entryName: 'resources/missing.png',
      width: 10,
      height: 10,
    }
    const result = reconcileSheet(document, 0, view)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.inSync).toBe(false)
    expect(document.sheets).toEqual(before)
  })

  it('never writes a picture that is not an archive entry, and never deletes the one it shows', async () => {
    const content = sampleSheets() as Record<string, unknown>[]
    const beta = inSource(content[0] as unknown as XmindSheet, 'b')!
    beta.image = { src: 'https://example.com/p.png' }
    const document = await openSheets([content[0]])
    const view = document.viewSheets()[0]!
    expect(inView(view, 'b').image).toMatchObject({ entryName: null })
    const result = reconcileSheet(document, 0, view)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(inSource(document.sheets[0]!, 'b')?.image).toEqual({ src: 'https://example.com/p.png' })
  })
})

describe('a picture entry added since the last save', () => {
  it('is readable before the save, listed in the manifest, and kept in the file', async () => {
    const document = await openSheets(sampleSheets())
    expect(document.hasEntry('resources/added.png')).toBe(false)
    document.addEntry('resources/added.png', fakePng(4))
    expect(document.changed).toBe(true)
    expect(document.hasEntry('resources/added.png')).toBe(true)
    expect(document.entryNames).toContain('resources/added.png')
    expect(text((await document.readEntry('resources/added.png'))!)).toBe(text(fakePng(4)))

    const saved = await document.save()
    const reopened = await openXmind(saved)
    expect(reopened.status).toBe('ok')
    if (reopened.status !== 'ok') return
    expect(text((await reopened.document.readEntry('resources/added.png'))!)).toBe(text(fakePng(4)))
    const manifest = JSON.parse(text((await reopened.document.readEntry(MANIFEST))!)) as {
      'file-entries': Record<string, unknown>
    }
    expect(manifest['file-entries']).toHaveProperty('resources/added.png')
  })

  it('takes the entry back when the edit that wanted it is refused', async () => {
    const document = await openSheets(sampleSheets())
    const baseline = await document.save()
    document.addEntry('resources/added.png', fakePng(4))
    document.removeAddedEntry('resources/added.png')
    expect(document.entryNames).not.toContain('resources/added.png')
    expect(await document.save()).toEqual(baseline)
  })

  it('refuses names outside resources/ or names already in the archive', async () => {
    const document = await openOk(
      await buildMapFile({
        content: sampleSheets(),
        extra: [{ name: 'resources/picture.png', data: fakePng(9) }],
      }),
    )
    expect(() => document.addEntry('manifest.json', fakePng(1))).toThrow()
    expect(() => document.addEntry('resources/../x.png', fakePng(1))).toThrow()
    expect(() => document.addEntry('resources/picture.png', fakePng(1))).toThrow()
    expect(() => document.addEntry('resources/empty.png', new Uint8Array())).toThrow()
  })
})
