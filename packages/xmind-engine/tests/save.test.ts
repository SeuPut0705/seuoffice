import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import * as engine from '../src/index'
import { openXmind } from '../src/open'
import type { XmindSheet } from '../src/types'
import {
  buildMapFile,
  buildZip,
  CONTENT,
  fakePng,
  listZip,
  MANIFEST,
  METADATA,
  openOk,
  sampleSheets,
  text,
  THUMBNAIL,
  unzip,
  utf8,
} from './helpers'

const NOW = new Date(Date.UTC(2031, 4, 6, 7, 8, 10))

/** A file with every kind of neighbour the save must carry along untouched. */
function richFile(overrides: Parameters<typeof buildMapFile>[0] = {}): Promise<Uint8Array> {
  return buildMapFile({
    legacy: true,
    extra: [
      { name: 'cache.json', data: '{}' },
      { name: 'resources/', data: '' },
      { name: 'resources/picture.png', data: fakePng(9), store: true },
      { name: 'resources/notes.txt', data: 'attached text '.repeat(200) },
      { name: 'unknown/future.bin', data: new Uint8Array([0, 255, 1, 254]) },
    ],
    ...overrides,
  })
}

describe('save: nothing changed', () => {
  it('returns the original file byte for byte', async () => {
    const original = await richFile()
    const document = await openOk(original)
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(original)
  })

  it('stays byte-identical when content.json was not written the way the engine writes', async () => {
    const pretty = JSON.stringify(sampleSheets(), null, 2) + '\n'
    const original = await richFile({ contentText: '﻿' + pretty })
    expect(await (await openOk(original)).save()).toEqual(original)
  })

  it('stays byte-identical after the view was read and entries were looked at', async () => {
    const original = await richFile()
    const document = await openOk(original)
    document.viewSheets()
    await document.readEntry(THUMBNAIL)
    void document.sheets[0]!.rootTopic.children?.attached?.length
    expect(await document.save()).toEqual(original)
  })

  it('keeps the old picture and the old bytes even when handed a new thumbnail', async () => {
    const original = await richFile()
    const document = await openOk(original)
    expect(await document.save({ thumbnail: fakePng(2), now: NOW })).toEqual(original)
  })

  it('hands out a copy: writing into the result does not reach the document', async () => {
    const original = await richFile()
    const document = await openOk(original)
    ;(await document.save()).fill(0)
    expect(await document.save()).toEqual(original)
  })
})

describe('save: the tree changed', () => {
  it('rewrites content.json only: other entries keep name, order, method and bytes', async () => {
    const original = await richFile()
    const document = await openOk(original)
    document.sheets[0]!.rootTopic.title = 'Edited'
    document.markChanged()
    const saved = await document.save({ now: NOW })

    const before = listZip(original)
    const after = listZip(saved)
    expect(after.map((entry) => entry.name)).toEqual(before.map((entry) => entry.name))
    for (const [index, entry] of before.entries()) {
      expect(after[index]!.method, entry.name).toBe(entry.method)
      if (entry.name !== CONTENT) expect(after[index]!.raw, entry.name).toEqual(entry.raw)
    }
    const beforeFiles = await unzip(original)
    const afterFiles = await unzip(saved)
    expect([...afterFiles.keys()]).toEqual([...beforeFiles.keys()])
    for (const [name, bytes] of beforeFiles) {
      if (name !== CONTENT) expect(afterFiles.get(name), name).toEqual(bytes)
    }

    const expected = sampleSheets() as XmindSheet[]
    expected[0]!.rootTopic.title = 'Edited'
    expect(JSON.parse(text(afterFiles.get(CONTENT)!))).toEqual(expected)
  })

  it('notices an edit made in place even if nobody marked the document', async () => {
    const document = await openOk(await richFile())
    document.sheets[0]!.rootTopic.children!.attached![0]!.title = 'Silently edited'
    expect(document.changed).toBe(true)
    const files = await unzip(await document.save({ now: NOW }))
    expect(text(files.get(CONTENT)!)).toContain('Silently edited')
  })

  it('writes content.json as one line of JSON without a byte order mark', async () => {
    const pretty = '﻿' + JSON.stringify(sampleSheets(), null, 2)
    const document = await openOk(await richFile({ contentText: pretty }))
    document.sheets[0]!.title = 'Renamed'
    const bytes = (await unzip(await document.save({ now: NOW }))).get(CONTENT)!
    expect(bytes[0]).toBe(0x5b)
    const written = text(bytes)
    expect(written).not.toMatch(/[\n\r]/)
    expect(written).toBe(JSON.stringify(JSON.parse(written)))
  })

  it('leaves what it does not model exactly as it was: keys, order, numbers, unicode', async () => {
    const sheets = sampleSheets()
    const originalText = JSON.stringify(sheets)
    const document = await openOk(await richFile({ contentText: originalText }))
    document.sheets[0]!.rootTopic.children!.attached![2]!.title = 'now titled'
    const written = text((await unzip(await document.save({ now: NOW }))).get(CONTENT)!)

    // The only difference in the text is the one key that was added.
    expect(written).toBe(
      originalText.replace(
        '{"id":"c","href":"xmind:#a"}',
        '{"id":"c","href":"xmind:#a","title":"now titled"}',
      ),
    )
    expect(written).toContain('"futureSheetKey":{"nested":[1,2.5,-1e-7,"x"]}')
    expect(written).toContain('"x":229.99999999999994')
    expect(written).toContain('Beta \u{1F600} 한글')
  })

  it('carries over preserve-only parts of the tree when a sheet is replaced', async () => {
    const document = await openOk(await richFile())
    const replacement = structuredClone(document.sheets[0]!)
    replacement.title = 'Replaced'
    document.replaceSheet(0, replacement)
    expect(document.changed).toBe(true)
    expect(document.sheets[0]).toBe(replacement)
    const written = JSON.parse(text((await unzip(await document.save({ now: NOW }))).get(CONTENT)!))
    const expected = sampleSheets() as XmindSheet[]
    expected[0]!.title = 'Replaced'
    expect(written).toEqual(expected)
  })

  it('keeps the archive around the entries: comment, dates, permissions', async () => {
    const zip = new JSZip()
    const made = new Date(Date.UTC(2011, 2, 4, 5, 6, 8))
    zip.file(CONTENT, JSON.stringify(sampleSheets()), { date: made, comment: 'the content' })
    zip.file('resources/', null, { dir: true, date: made })
    zip.file('resources/tool.sh', 'echo', { date: made, unixPermissions: 0o755 })
    const original = await zip.generateAsync({
      type: 'uint8array',
      platform: 'UNIX',
      comment: 'archive comment',
    })
    const document = await openOk(original)
    document.sheets[0]!.title = 'Edited'
    const saved = await JSZip.loadAsync(await document.save({ now: NOW }))
    expect((saved as unknown as { comment: string }).comment).toBe('archive comment')
    expect(Object.keys(saved.files)).toEqual([CONTENT, 'resources/', 'resources/tool.sh'])
    expect(saved.files[CONTENT]).toMatchObject({ date: NOW, comment: 'the content' })
    expect(saved.files['resources/']).toMatchObject({ dir: true, date: made })
    expect(saved.files['resources/tool.sh']).toMatchObject({ date: made, unixPermissions: 0o755 })
  })

  it('opens its own output again, and that output then saves byte for byte', async () => {
    const document = await openOk(await richFile())
    document.sheets[0]!.title = 'Second life'
    const saved = await document.save({ now: NOW })
    const reopened = await openOk(saved)
    expect(reopened.sheets[0]!.title).toBe('Second life')
    expect(await reopened.save()).toEqual(saved)
  })

  it('makes each save the new baseline for the next one', async () => {
    const document = await openOk(await richFile())
    document.sheets[0]!.title = 'Once'
    document.markChanged()
    const first = await document.save({ now: NOW })
    expect(document.changed).toBe(false)
    expect(await document.save({ thumbnail: fakePng(5) })).toEqual(first)
  })

  it('refuses to write a tree that would not open again', async () => {
    const original = await richFile()
    const document = await openOk(original)
    const kids = document.sheets[0]!.rootTopic.children!.attached!
    kids.push({ id: kids[0]!.id, title: 'duplicate id' })
    document.markChanged()
    await expect(document.save()).rejects.toThrow(/xmind:/)
    kids.pop()
    document.sheets.length = 0
    await expect(document.save()).rejects.toThrow(/xmind:/)
    expect(() => document.replaceSheet(0, { rootTopic: {} } as unknown as XmindSheet)).toThrow(
      /xmind:/,
    )
    expect(() => document.replaceSheet(7, sampleSheets()[0] as XmindSheet)).toThrow(/xmind:/)
  })
})

describe('save: the thumbnail', () => {
  async function edited(file: Uint8Array) {
    const document = await openOk(file)
    document.sheets[0]!.title = 'Edited sheet'
    return document
  }

  it('keeps the old picture when none is passed', async () => {
    const original = await richFile({ thumbnail: fakePng(1) })
    const document = await edited(original)
    const saved = await document.save({ now: NOW })
    expect((await unzip(saved)).get(THUMBNAIL)).toEqual(fakePng(1))
    const index = listZip(original).findIndex((entry) => entry.name === THUMBNAIL)
    expect(listZip(saved)[index]!.raw).toEqual(listZip(original)[index]!.raw)
  })

  it('keeps the old picture when the new one could not be made', async () => {
    for (const thumbnail of [null, undefined, new Uint8Array(0), utf8('not a png at all')]) {
      const document = await edited(await richFile({ thumbnail: fakePng(1) }))
      const saved = await document.save({ thumbnail, now: NOW })
      expect((await unzip(saved)).get(THUMBNAIL)).toEqual(fakePng(1))
    }
  })

  it('replaces the picture when one is passed, and nothing else', async () => {
    const original = await richFile({ thumbnail: fakePng(1) })
    const document = await edited(original)
    const saved = await document.save({ thumbnail: fakePng(2), now: NOW })
    const before = await unzip(original)
    const after = await unzip(saved)
    expect(after.get(THUMBNAIL)).toEqual(fakePng(2))
    expect(listZip(saved).map((entry) => entry.name)).toEqual(
      listZip(original).map((entry) => entry.name),
    )
    for (const [name, bytes] of before) {
      if (name !== CONTENT && name !== THUMBNAIL) expect(after.get(name), name).toEqual(bytes)
    }
    expect(after.get(MANIFEST)).toEqual(before.get(MANIFEST))
  })

  it('adds the picture to a file that had none, leaving the manifest alone', async () => {
    const original = await richFile({ thumbnail: null })
    const document = await edited(original)
    const saved = await document.save({ thumbnail: fakePng(3), now: NOW })
    const names = listZip(saved).map((entry) => entry.name)
    expect(names).toEqual([...listZip(original).map((entry) => entry.name), THUMBNAIL])
    const after = await unzip(saved)
    expect(after.get(THUMBNAIL)).toEqual(fakePng(3))
    expect(after.get(MANIFEST)).toEqual((await unzip(original)).get(MANIFEST))
    expect((await openXmind(saved)).status).toBe('ok')
  })
})

describe('save: only a map that opened can be saved', () => {
  it('gives no document, and so no way to save, for any other result', async () => {
    const notOk: Record<string, Uint8Array> = {
      'legacy-format': await buildMapFile({ omit: [CONTENT], legacy: true }),
      encrypted: await buildMapFile({
        manifest: { 'file-entries': { [CONTENT]: { 'encryption-data': {} } } },
      }),
      unreadable: await buildZip([{ name: METADATA, data: '{}' }]),
      rejected: await buildMapFile(),
    }
    for (const [status, bytes] of Object.entries(notOk)) {
      const options =
        status === 'rejected'
          ? { limits: { maxParts: 1, maxPartBytes: 1, maxTotalBytes: 1 } }
          : undefined
      const result = await openXmind(bytes, options)
      expect(result.status).toBe(status)
      // Nothing on the result holds the file, a tree or anything callable.
      expect(Object.keys(result).sort()).toEqual(['detail', 'status'])
      expect(typeof (result as { detail: unknown }).detail).toBe('string')
    }
  })

  it('does not export the document class: a document only comes from open or create', async () => {
    const document = await openOk(await buildMapFile())
    expect(Object.values(engine)).not.toContain(document.constructor)
    expect(engine).not.toHaveProperty('XmindDocument')
  })
})
