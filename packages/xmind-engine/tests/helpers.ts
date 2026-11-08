import JSZip from 'jszip'
import type { XmindDocument } from '../src/document'
import { openXmind } from '../src/open'

/**
 * Everything the tests open is built here, by hand: no archive, tree, theme or
 * picture produced by another program is checked into the repository.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (text: string): Uint8Array => encoder.encode(text)
export const text = (bytes: Uint8Array): string => decoder.decode(bytes)

export const CONTENT = 'content.json'
export const LEGACY_CONTENT = 'content.xml'
export const MANIFEST = 'manifest.json'
export const METADATA = 'metadata.json'
export const THUMBNAIL = 'Thumbnails/thumbnail.png'

/** The eight bytes every PNG starts with, followed by a marker byte per picture. */
export function fakePng(marker: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, marker, marker])
}

export interface ZipEntrySpec {
  name: string
  data: Uint8Array | string
  /** how the entry is stored; DEFLATE unless said otherwise */
  store?: boolean
}

/** A zip with exactly these entries, in this order, at a fixed timestamp. */
export async function buildZip(entries: readonly ZipEntrySpec[]): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const entry of entries) {
    zip.file(entry.name, entry.data, {
      compression: entry.store ? 'STORE' : 'DEFLATE',
      createFolders: false,
      date: new Date(Date.UTC(2020, 0, 2, 3, 4, 6)),
    })
  }
  return zip.generateAsync({ type: 'uint8array' })
}

export interface MapFileOptions {
  /** the parsed tree, or the literal text to put into content.json */
  content?: unknown
  contentText?: string
  manifest?: unknown
  thumbnail?: Uint8Array | null
  legacy?: boolean
  extra?: readonly ZipEntrySpec[]
  omit?: readonly string[]
}

/** A mind map archive laid out the way the format expects, built from parts. */
export async function buildMapFile(options: MapFileOptions = {}): Promise<Uint8Array> {
  const omit = new Set(options.omit ?? [])
  const entries: ZipEntrySpec[] = []
  const listed: Record<string, unknown> = {}
  if (!omit.has(CONTENT)) {
    entries.push({
      name: CONTENT,
      data: options.contentText ?? JSON.stringify(options.content ?? sampleSheets()),
      store: true,
    })
    listed[CONTENT] = {}
  }
  if (!omit.has(METADATA)) {
    entries.push({
      name: METADATA,
      data: JSON.stringify({ creator: { name: 'test-suite', version: '1.2.3' } }),
    })
    listed[METADATA] = {}
  }
  if (options.thumbnail !== null) {
    entries.push({ name: THUMBNAIL, data: options.thumbnail ?? fakePng(1), store: true })
    listed[THUMBNAIL] = {}
  }
  for (const entry of options.extra ?? []) entries.push(entry)
  if (!omit.has(MANIFEST)) {
    entries.push({
      name: MANIFEST,
      data: JSON.stringify(options.manifest ?? { 'file-entries': listed }),
    })
  }
  if (options.legacy) entries.push({ name: LEGACY_CONTENT, data: '<xmap-content/>' })
  return buildZip(entries)
}

/**
 * One sheet that touches everything the engine reads, plus keys it has never
 * heard of at every level, so "unknown values survive" has something to bite on.
 */
export function sampleSheets(): unknown[] {
  return [
    {
      id: 'sheet-1',
      futureSheetKey: { nested: [1, 2.5, -1e-7, 'x'] },
      class: 'sheet',
      rootTopic: {
        id: 'root',
        class: 'topic',
        title: 'Centre',
        structureClass: 'org.xmind.ui.logic.right',
        children: {
          attached: [
            {
              id: 'a',
              title: 'Alpha',
              futureTopicKey: 'kept',
              labels: ['one', 'two'],
              href: 'https://example.com/a?x=1&y=2',
              markers: [{ markerId: 'priority-1' }, { markerId: 'task-half', futureMarkerKey: 7 }],
              notes: {
                plain: { content: 'first line\nsecond <b>line</b> & more\n' },
                realHTML: { content: '<div>first line</div><div>second line</div>' },
              },
              children: {
                attached: [
                  { id: 'a1', title: 'A one' },
                  { id: 'a2', title: 'A two', branch: 'folded', children: { attached: [] } },
                  { id: 'a3', title: 'A three' },
                ],
                summary: [
                  {
                    id: 'sum-topic',
                    title: 'Sums up',
                    children: { attached: [{ id: 'under-summary', title: 'kept only' }] },
                  },
                ],
                callout: [{ id: 'callout-1', title: 'Says' }],
              },
              boundaries: [{ id: 'bound-1', range: '(0,1)', title: 'Group' }],
              summaries: [{ id: 'sum-rec', range: '(1,2)', topicId: 'sum-topic' }],
            },
            {
              id: 'b',
              title: 'Beta \u{1F600} 한글',
              image: { src: 'xap:resources/picture.png', width: 120.5, height: 80 },
              style: {
                id: 'style-1',
                properties: {
                  'fo:color': '#112233',
                  'svg:fill': '#445566',
                  'fo:font-weight': '700',
                  'fo:font-size': '18pt',
                  'fo:font-family': 'Some Family',
                  'line-width': '2pt',
                },
              },
              position: { x: 229.99999999999994, y: -12.5 },
            },
            { id: 'c', href: 'xmind:#a' },
          ],
          detached: [{ id: 'float', title: 'Floating', position: { x: 10, y: 20 } }],
        },
      },
      relationships: [
        {
          id: 'rel-1',
          end1Id: 'a1',
          end2Id: 'b',
          title: 'leads to',
          controlPoints: { '0': { x: 1.5, y: 2 }, '1': { x: 3, y: 4 } },
        },
        { id: 'rel-2', end1Id: 'float', end2Id: 'b' },
      ],
      title: 'Sheet one',
      extensions: [{ provider: 'someone.else', content: { keep: true } }],
      theme: { map: { id: 'theme-map', properties: { 'svg:fill': '#ffffff' } } },
    },
  ]
}

/** Opens bytes that the test expects to be a readable map. */
export async function openOk(bytes: Uint8Array): Promise<XmindDocument> {
  const result = await openXmind(bytes)
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}: ${result.detail}`)
  return result.document
}

export interface RawZipEntry {
  name: string
  method: number
  /** the entry's bytes exactly as they sit in the archive (still compressed) */
  raw: Uint8Array
}

/** The central directory as written: entry names in order, method and raw data. */
export function listZip(bytes: Uint8Array): RawZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.byteLength - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  const entries: RawZipEntry[] = []
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(pos + 10, true)
    const csize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const local = view.getUint32(pos + 42, true)
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    entries.push({ name, method, raw: bytes.slice(start, start + csize) })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Every entry's uncompressed bytes by name, read back with an independent reader. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, Uint8Array>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out.set(name, await file.async('uint8array'))
  }
  return out
}

/** Offset of an entry's central directory record, for tests that forge a field. */
export function centralRecordOffset(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.byteLength - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(pos + 28, true)
    if (decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)) === name) return pos
    pos += 46 + nameLen + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true)
  }
  throw new Error(`no entry ${name}`)
}
