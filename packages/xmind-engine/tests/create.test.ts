import { readFileSync } from 'node:fs'
import { PRODUCT_NAME } from '@genoffice/i18n'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createXmindDocument,
  createXmindDocumentFromSheets,
  XMIND_ENGINE_VERSION,
  newSheet,
  newTopic,
  setDefaultSheetTheme,
} from '../src/create'
import { newXmindId } from '../src/ids'
import { openXmind } from '../src/open'
import type { XmindSheet } from '../src/types'
import { CONTENT, fakePng, listZip, MANIFEST, METADATA, text, THUMBNAIL, unzip } from './helpers'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = new Date(Date.UTC(2031, 4, 6, 7, 8, 10))

afterEach(() => setDefaultSheetTheme(null))

describe('newXmindId', () => {
  it('makes lower-case version 4 UUIDs that do not repeat', () => {
    const ids = Array.from({ length: 2000 }, () => newXmindId())
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('createXmindDocument', () => {
  it('makes one sheet with one central topic', async () => {
    const document = await createXmindDocument({ sheetTitle: 'Sheet 1', rootTitle: 'Central' })
    expect(document.sheets).toHaveLength(1)
    const sheet = document.sheets[0]!
    expect(sheet).toEqual({
      id: expect.stringMatching(UUID_V4),
      class: 'sheet',
      rootTopic: { id: expect.stringMatching(UUID_V4), class: 'topic', title: 'Central' },
      title: 'Sheet 1',
    })
    expect(sheet.id).not.toBe(sheet.rootTopic.id)
    expect(document.viewSheets()[0]).toMatchObject({
      title: 'Sheet 1',
      layout: 'both',
      root: { title: 'Central', children: [] },
    })
  })

  it('writes the three entries the format requires, and opens again', async () => {
    const document = await createXmindDocument({
      sheetTitle: 'Sheet 1',
      rootTitle: 'Central',
      now: NOW,
    })
    const bytes = await document.save()
    expect(listZip(bytes).map((entry) => entry.name)).toEqual([CONTENT, METADATA, MANIFEST])
    const files = await unzip(bytes)
    expect(JSON.parse(text(files.get(MANIFEST)!))).toEqual({
      'file-entries': { [CONTENT]: {}, [METADATA]: {} },
    })
    const written = text(files.get(CONTENT)!)
    expect(written).toBe(JSON.stringify(document.sheets))
    expect(written.charCodeAt(0)).toBe(0x5b)

    const reopened = await openXmind(bytes)
    expect(reopened.status).toBe('ok')
    if (reopened.status !== 'ok') return
    expect(reopened.document.sheets).toEqual(document.sheets)
    expect(await reopened.document.save()).toEqual(bytes)
  })

  it('names the product from the product definition as the creator', async () => {
    const bytes = await (
      await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R', creatorVersion: '9.8.7' })
    ).save()
    expect(JSON.parse(text((await unzip(bytes)).get(METADATA)!))).toEqual({
      creator: { name: PRODUCT_NAME, version: '9.8.7' },
    })
  })

  it('falls back to its own version, which follows the package', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(XMIND_ENGINE_VERSION).toBe(pkg.version)
    const bytes = await (await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R' })).save()
    expect(JSON.parse(text((await unzip(bytes)).get(METADATA)!)).creator.version).toBe(pkg.version)
  })

  it('writes no font name and no theme of its own', async () => {
    const bytes = await (await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R' })).save()
    for (const [name, data] of await unzip(bytes)) {
      expect(text(data), name).not.toMatch(/font-family|fontFamily|"theme"|"style"/)
    }
  })

  it('starts out unchanged, and saves like any opened file once edited', async () => {
    const document = await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R', now: NOW })
    expect(document.changed).toBe(false)
    const first = await document.save()
    document.sheets[0]!.rootTopic.children = { attached: [newTopic('Branch')] }
    document.markChanged()
    const second = await document.save({ thumbnail: fakePng(4), now: NOW })
    expect(second).not.toEqual(first)
    const files = await unzip(second)
    expect(files.get(THUMBNAIL)).toEqual(fakePng(4))
    expect(files.get(METADATA)).toEqual((await unzip(first)).get(METADATA))
    expect((await openXmind(second)).status).toBe('ok')
  })
})

describe('the default theme hook', () => {
  it('lets a theme writer dress every new sheet, last key in the sheet', async () => {
    const seen: XmindSheet[] = []
    setDefaultSheetTheme((sheet) => {
      seen.push(sheet)
      sheet.theme = { marker: 'written by the hook' }
    })
    const sheet = newSheet({ title: 'Later sheet', rootTitle: 'Root' })
    expect(seen).toEqual([sheet])
    expect(Object.keys(sheet)).toEqual(['id', 'class', 'rootTopic', 'title', 'theme'])

    const document = await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R' })
    expect(document.sheets[0]!.theme).toEqual({ marker: 'written by the hook' })
    const written = text((await unzip(await document.save())).get(CONTENT)!)
    expect(written).toContain('"theme":{"marker":"written by the hook"}')
  })

  it('writes no theme once the writer is taken away again', () => {
    setDefaultSheetTheme((sheet) => {
      sheet.theme = {}
    })
    setDefaultSheetTheme(null)
    expect(newSheet({ title: 'S', rootTitle: 'R' })).not.toHaveProperty('theme')
  })
})

describe('createXmindDocumentFromSheets', () => {
  it('builds a document from a tree made elsewhere', async () => {
    const root = newTopic('Plan')
    root.children = {
      attached: Array.from({ length: 300 }, (_, index) => ({
        ...newTopic(`Part ${index}`),
        children: { attached: [newTopic(`Detail ${index}`)] },
      })),
    }
    const sheet = newSheet({ title: 'Outline', rootTitle: 'ignored' })
    sheet.rootTopic = { ...sheet.rootTopic, ...root }
    const document = await createXmindDocumentFromSheets([sheet], { now: NOW })
    const reopened = await openXmind(await document.save())
    if (reopened.status !== 'ok') throw new Error(reopened.status)
    const view = reopened.document.viewSheets()[0]!
    expect(view.root.title).toBe('Plan')
    expect(view.root.children).toHaveLength(300)
    expect(view.root.children[299]!.children[0]!.title).toBe('Detail 299')
  })

  it('refuses a tree that would not open', async () => {
    const twin = newTopic('twin')
    const sheet = newSheet({ title: 'S', rootTitle: 'R' })
    sheet.rootTopic.children = { attached: [twin, { ...twin }] }
    await expect(createXmindDocumentFromSheets([sheet])).rejects.toThrow(/xmind:/)
    await expect(createXmindDocumentFromSheets([])).rejects.toThrow(/xmind:/)
  })
})
