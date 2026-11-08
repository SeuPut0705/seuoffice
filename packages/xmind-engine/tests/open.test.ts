import { describe, expect, it } from 'vitest'
import { openXmind } from '../src/open'
import { MAX_TOPIC_DEPTH } from '../src/structure-check'
import {
  buildMapFile,
  buildZip,
  centralRecordOffset,
  CONTENT,
  LEGACY_CONTENT,
  MANIFEST,
  METADATA,
  sampleSheets,
  utf8,
} from './helpers'

const sheet = (id: string, rootTopic: unknown): unknown => ({ id, class: 'sheet', rootTopic })

async function statusOf(content: unknown): Promise<string> {
  return (await openXmind(await buildMapFile({ contentText: JSON.stringify(content) }))).status
}

describe('openXmind: ok', () => {
  it('opens a map and keeps the parsed tree as the source tree', async () => {
    const result = await openXmind(await buildMapFile())
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.document.sheets).toEqual(sampleSheets())
    expect(result.document.entryNames).toEqual([
      CONTENT,
      METADATA,
      'Thumbnails/thumbnail.png',
      MANIFEST,
    ])
  })

  it('opens content.json when the legacy content.xml sits next to it', async () => {
    const result = await openXmind(await buildMapFile({ legacy: true }))
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.document.entryNames).toContain(LEGACY_CONTENT)
    expect(result.document.sheets).toHaveLength(1)
  })

  it('reads a content.json that starts with a byte order mark', async () => {
    const withBom = '﻿' + JSON.stringify(sampleSheets())
    expect((await openXmind(await buildMapFile({ contentText: withBom }))).status).toBe('ok')
  })

  it('does not refuse a file for carrying a newer format version or unknown keys', async () => {
    const bytes = await buildZip([
      { name: CONTENT, data: JSON.stringify(sampleSheets()) },
      {
        name: METADATA,
        data: JSON.stringify({ dataStructureVersion: '99', layoutEngineVersion: '99', later: [] }),
      },
      { name: MANIFEST, data: JSON.stringify({ 'file-entries': {}, later: 1 }) },
    ])
    expect((await openXmind(bytes)).status).toBe('ok')
  })

  it('opens without metadata.json or manifest.json: only content.json decides', async () => {
    const bytes = await buildMapFile({ omit: [METADATA, MANIFEST], thumbnail: null })
    expect((await openXmind(bytes)).status).toBe('ok')
  })

  it('opens when two different sheets reuse the same topic ids', async () => {
    const root = { id: 'same', children: { attached: [{ id: 'kid' }] } }
    expect(await statusOf([sheet('s1', root), sheet('s2', root)])).toBe('ok')
  })

  it('hands back the bytes of any entry, and null for one that is not there', async () => {
    const result = await openXmind(
      await buildMapFile({ extra: [{ name: 'resources/picture.png', data: utf8('picture') }] }),
    )
    if (result.status !== 'ok') throw new Error(result.status)
    expect(await result.document.readEntry('resources/picture.png')).toEqual(utf8('picture'))
    expect(await result.document.readEntry('resources/missing.png')).toBeNull()
  })
})

describe('openXmind: legacy-format', () => {
  it('reports a file that only has content.xml', async () => {
    const result = await openXmind(await buildMapFile({ omit: [CONTENT], legacy: true }))
    expect(result.status).toBe('legacy-format')
    expect(result).not.toHaveProperty('document')
  })
})

describe('openXmind: encrypted', () => {
  const encryption = { 'iteration-count': 1024, size: 128, salt: 'c2FsdA==', iv: 'aXY=' }

  it('reports a file whose manifest marks an entry as encrypted', async () => {
    const result = await openXmind(
      await buildMapFile({
        contentText: 'not json: this would be ciphertext',
        manifest: {
          'file-entries': { [CONTENT]: { 'encryption-data': encryption }, [METADATA]: {} },
          'password-hint': 'hint',
        },
      }),
    )
    expect(result.status).toBe('encrypted')
    expect(result).not.toHaveProperty('document')
  })

  it('goes by any entry of the manifest, not only content.json', async () => {
    const result = await openXmind(
      await buildMapFile({
        manifest: { 'file-entries': { [METADATA]: { 'encryption-data': encryption } } },
      }),
    )
    expect(result.status).toBe('encrypted')
  })

  it('ignores a manifest that cannot be read: the content then decides', async () => {
    const bytes = await buildZip([
      { name: CONTENT, data: JSON.stringify(sampleSheets()) },
      { name: MANIFEST, data: '{ broken' },
    ])
    expect((await openXmind(bytes)).status).toBe('ok')
    for (const manifest of [null, [], 'text', { 'file-entries': null }, { 'file-entries': [1] }]) {
      expect((await openXmind(await buildMapFile({ manifest }))).status).toBe('ok')
    }
  })
})

describe('openXmind: unreadable', () => {
  it('reports bytes that are not a zip at all', async () => {
    for (const bytes of [
      new Uint8Array(0),
      utf8('just some text, long enough to hold an end record'),
      new Uint8Array(4096).fill(7),
    ]) {
      expect((await openXmind(bytes)).status).toBe('unreadable')
    }
  })

  it('reports a zip that has neither content.json nor content.xml', async () => {
    const bytes = await buildZip([{ name: METADATA, data: '{}' }])
    expect((await openXmind(bytes)).status).toBe('unreadable')
  })

  it('does not take a folder named content.json for the content', async () => {
    const bytes = await buildZip([{ name: `${CONTENT}/inner.txt`, data: 'x' }])
    expect((await openXmind(bytes)).status).toBe('unreadable')
  })

  it('reports content.json that is not JSON, or not valid UTF-8', async () => {
    expect((await openXmind(await buildMapFile({ contentText: '[{"id":' }))).status).toBe(
      'unreadable',
    )
    const bad = await buildZip([{ name: CONTENT, data: new Uint8Array([0x5b, 0x22, 0xff, 0x22]) }])
    expect((await openXmind(bad)).status).toBe('unreadable')
  })

  it('reports a top level that is not a list of sheets', async () => {
    for (const content of [{}, null, 'sheets', 3, [], [null], [[]], ['sheet'], [{ id: 's' }]]) {
      expect(await statusOf(content), JSON.stringify(content)).toBe('unreadable')
    }
  })

  it('reports a sheet whose central topic is missing or malformed', async () => {
    for (const rootTopic of [
      undefined,
      null,
      'root',
      [],
      {},
      { id: 7 },
      { id: '' },
      { id: null },
    ]) {
      expect(await statusOf([sheet('s', rootTopic)]), JSON.stringify(rootTopic)).toBe('unreadable')
    }
  })

  it('reports odd shapes below the central topic instead of throwing', async () => {
    const odd: unknown[] = [
      { id: 'r', children: null },
      { id: 'r', children: [] },
      { id: 'r', children: 'kids' },
      { id: 'r', children: { attached: {} } },
      { id: 'r', children: { attached: [null] } },
      { id: 'r', children: { attached: ['kid'] } },
      { id: 'r', children: { attached: [{ title: 'no id' }] } },
      { id: 'r', children: { attached: [{ id: 5 }] } },
      { id: 'r', children: { summary: 'x' } },
      { id: 'r', children: { detached: [{}] } },
    ]
    for (const rootTopic of odd) {
      expect(await statusOf([sheet('s', rootTopic)]), JSON.stringify(rootTopic)).toBe('unreadable')
    }
  })

  it('reports the same topic id used twice inside one sheet', async () => {
    const twins = { id: 'r', children: { attached: [{ id: 'twin' }, { id: 'twin' }] } }
    expect(await statusOf([sheet('s', twins)])).toBe('unreadable')
    const acrossKinds = {
      id: 'r',
      children: {
        attached: [{ id: 'x', children: { summary: [{ id: 'deep' }] } }],
        detached: [{ id: 'deep' }],
      },
    }
    expect(await statusOf([sheet('s', acrossKinds)])).toBe('unreadable')
    const asRoot = { id: 'r', children: { attached: [{ id: 'r' }] } }
    expect(await statusOf([sheet('s', asRoot)])).toBe('unreadable')
  })

  it('reports a tree nested deeper than the engine walks, without overflowing', async () => {
    const chain = (levels: number): string =>
      '{"id":"r","children":{"attached":[' +
      Array.from({ length: levels }, (_, i) => `{"id":"t${i}","children":{"attached":[`).join('') +
      ']}}'.repeat(levels) +
      ']}}'
    const file = (levels: number): Promise<Uint8Array> =>
      buildMapFile({ contentText: `[{"id":"s","rootTopic":${chain(levels)}}]` })
    expect((await openXmind(await file(MAX_TOPIC_DEPTH - 1))).status).toBe('ok')
    expect((await openXmind(await file(MAX_TOPIC_DEPTH + 1))).status).toBe('unreadable')
    expect((await openXmind(await file(60000))).status).toBe('unreadable')
  })

  it('reports values nested too deep to be written back, wherever they sit', async () => {
    const deep = '['.repeat(100000) + ']'.repeat(100000)
    const contentText = `[{"id":"s","rootTopic":{"id":"r","future":${deep}}}]`
    expect((await openXmind(await buildMapFile({ contentText }))).status).toBe('unreadable')
  })
})

describe('openXmind: unreadable, because a save could not carry the archive over', () => {
  /** Overwrites an entry's name, in its local header and in the directory. */
  function rename(bytes: Uint8Array, from: string, to: Uint8Array): void {
    const needle = utf8(from)
    if (to.length !== needle.length) throw new Error('the new name must be as long as the old')
    let hits = 0
    for (let at = 0; at <= bytes.length - needle.length; at++) {
      if (needle.every((byte, index) => bytes[at + index] === byte)) {
        bytes.set(to, at)
        hits++
      }
    }
    if (hits !== 2) throw new Error(`expected the name twice, found it ${hits} times`)
  }

  it('reports an archive that holds two entries under one name', async () => {
    const twice = await buildMapFile({
      extra: [
        { name: 'resources/a.png', data: 'first' },
        { name: 'resources/b.png', data: 'second' },
      ],
    })
    rename(twice, 'resources/b.png', utf8('resources/a.png'))
    expect((await openXmind(twice)).status).toBe('unreadable')
  })

  it('reports an entry whose name climbs out of the archive', async () => {
    const bytes = await buildMapFile({ extra: [{ name: 'xx/yy/evil.txt', data: 'x' }] })
    rename(bytes, 'xx/yy/evil.txt', utf8('../../evil.txt'))
    expect((await openXmind(bytes)).status).toBe('unreadable')
  })

  it('reports an entry whose name is not UTF-8', async () => {
    const bytes = await buildMapFile({ extra: [{ name: 'resources/ab.png', data: 'x' }] })
    rename(
      bytes,
      'resources/ab.png',
      new Uint8Array([...utf8('resources/'), 0xc7, 0xd1, ...utf8('.png')]),
    )
    expect((await openXmind(bytes)).status).toBe('unreadable')
  })

  it('still names the older format when such an archive is a legacy file', async () => {
    const bytes = await buildMapFile({
      omit: [CONTENT],
      legacy: true,
      extra: [{ name: 'xx/yy/evil.txt', data: 'x' }],
    })
    rename(bytes, 'xx/yy/evil.txt', utf8('../../evil.txt'))
    expect((await openXmind(bytes)).status).toBe('legacy-format')
  })
})

describe('openXmind: rejected', () => {
  it('reports an archive over the limits it was opened with', async () => {
    const bytes = await buildMapFile()
    const limits = { maxParts: 2, maxPartBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }
    const result = await openXmind(bytes, { limits })
    expect(result.status).toBe('rejected')
    expect(result).not.toHaveProperty('document')
    const tiny = { maxParts: 100, maxPartBytes: 16, maxTotalBytes: 1024 * 1024 }
    expect((await openXmind(bytes, { limits: tiny })).status).toBe('rejected')
  })

  it('reports a part that inflates past the size it declares', async () => {
    const bytes = await buildZip([
      { name: CONTENT, data: JSON.stringify(sampleSheets()) + ' '.repeat(200000) },
    ])
    const record = centralRecordOffset(bytes, CONTENT)
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(record + 24, 300, true)
    expect((await openXmind(bytes)).status).toBe('rejected')
  })

  it('reports zip-level encryption as rejected, not as an encrypted map', async () => {
    const bytes = await buildMapFile()
    const record = centralRecordOffset(bytes, CONTENT)
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    view.setUint16(record + 8, view.getUint16(record + 8, true) | 0x1, true)
    expect((await openXmind(bytes)).status).toBe('rejected')
  })

  it('reports a compression method the gate cannot check', async () => {
    const bytes = await buildMapFile()
    const record = centralRecordOffset(bytes, METADATA)
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(record + 10, 99, true)
    expect((await openXmind(bytes)).status).toBe('rejected')
  })

  it('reports a zip whose directory points outside the file', async () => {
    const bytes = await buildMapFile()
    const record = centralRecordOffset(bytes, CONTENT)
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(record + 42, 0x7fffffff, true)
    expect((await openXmind(bytes)).status).toBe('rejected')
  })
})

describe('openXmind: the caller keeps its bytes', () => {
  it('does not change the bytes it was given, and is not changed through them', async () => {
    const bytes = await buildMapFile()
    const before = bytes.slice()
    const result = await openXmind(bytes)
    expect(bytes).toEqual(before)
    if (result.status !== 'ok') throw new Error(result.status)
    bytes.fill(0)
    expect(await result.document.save()).toEqual(before)
  })

  it('copies a Node byte buffer too, whose slices are only views', async () => {
    const before = await buildMapFile()
    const buffer = Buffer.from(before)
    const result = await openXmind(buffer)
    if (result.status !== 'ok') throw new Error(result.status)
    buffer.fill(0)
    const saved = await result.document.save()
    expect(saved).toEqual(before)
    saved.fill(0)
    expect(await result.document.save()).toEqual(before)
  })
})
