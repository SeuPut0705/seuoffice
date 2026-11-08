/**
 * ODT → docx Save As: the placeholders the editor shows as label boxes become
 * label pictures in the saved docx.
 *
 * The bridge docx gives every placeholder without a preview the engine's
 * neutral grey picture. Saved as docx that grey box would lose the label the
 * editor drew over it, so each such drawing is re-pointed at a picture of its
 * label (one media part per kind and size). Nothing else in the package
 * changes: untouched zip entries are copied byte for byte, only the parts that
 * hold such drawings, their relationships and `[Content_Types].xml` are
 * rewritten.
 */
import { readDocxPartBase64 } from '@genoffice/docx-engine'
import { parseKeepName, type ObjectKind } from '@genoffice/odt-engine'
import { docPrNameOf, odtSession } from './odt-gate'
import { renderLabelPng } from './odt-label-png'

const EMU_PER_PX = 9525
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

// ---- a minimal zip rewriter: copy entries verbatim, replace or add a few ----

interface ZipEntry {
  name: string
  /** the local header + data (+ data descriptor), as stored */
  local: Uint8Array
  /** the central directory record */
  central: Uint8Array
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

function readZip(bytes: Uint8Array): ZipEntry[] | null {
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = u16(bytes, eocd + 10)
  let p = u32(bytes, eocd + 16)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) return null
    const flags = u16(bytes, p + 8)
    const csize = u32(bytes, p + 20)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    const offset = u32(bytes, p + 42)
    // zip64 archives are not rewritten here (a docx never needs them)
    if (csize === 0xffffffff || offset === 0xffffffff) return null
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    const central = bytes.slice(p, p + 46 + nameLen + extraLen + commentLen)
    if (u32(bytes, offset) !== 0x04034b50) return null
    let end = offset + 30 + u16(bytes, offset + 26) + u16(bytes, offset + 28) + csize
    if (flags & 0x08) end += u32(bytes, end) === 0x08074b50 ? 16 : 12
    entries.push({ name, local: bytes.slice(offset, end), central })
    p += central.length
  }
  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** a stored (uncompressed) entry */
function storedEntry(name: string, data: Uint8Array): ZipEntry {
  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(data)
  const header = (central: boolean): Uint8Array => {
    const out = new Uint8Array(central ? 46 : 30)
    const view = new DataView(out.buffer)
    view.setUint32(0, central ? 0x02014b50 : 0x04034b50, true)
    let at = 4
    if (central) {
      view.setUint16(at, 20, true) // version made by
      at += 2
    }
    view.setUint16(at, 20, true) // version needed
    view.setUint16(at + 2, 0x0800, true) // UTF-8 names
    view.setUint16(at + 4, 0, true) // stored
    view.setUint16(at + 6, 0, true) // time
    view.setUint16(at + 8, 0x21, true) // date: 1980-01-01
    view.setUint32(at + 10, crc, true)
    view.setUint32(at + 14, data.length, true)
    view.setUint32(at + 18, data.length, true)
    view.setUint16(at + 22, nameBytes.length, true)
    view.setUint16(at + 24, 0, true) // extra
    return out
  }
  const local = concat([header(false), nameBytes, data])
  const central = concat([header(true), nameBytes])
  return { name, local, central }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function writeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const central = entry.central.slice()
    new DataView(central.buffer).setUint32(42, offset, true)
    locals.push(entry.local)
    centrals.push(central)
    offset += entry.local.length
  }
  const directory = concat(centrals)
  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries.length, true)
  view.setUint16(10, entries.length, true)
  view.setUint32(12, directory.length, true)
  view.setUint32(16, offset, true)
  return concat([...locals, directory, eocd])
}

// ---- the label pictures ----

async function partText(docx: Uint8Array, name: string): Promise<string | null> {
  const b64 = await readDocxPartBase64(docx, name)
  if (b64 === null) return null
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

const EMPTY_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

/**
 * The docx with every neutral placeholder picture replaced by its label
 * picture; the same bytes when there is none (or outside an ODT document).
 */
export async function labelPlaceholdersInDocx(docx: Uint8Array): Promise<Uint8Array> {
  const session = odtSession()
  if (!session) return docx
  const neutral = (name: string | null): { kind: ObjectKind } | null => {
    const keep = name ? parseKeepName(name) : null
    return keep && session.previews.get(keep.id) === false ? keep : null
  }
  const entries = readZip(docx)
  if (!entries) return docx
  const names = new Set(entries.map((e) => e.name))
  const parts = entries
    .map((e) => e.name)
    .filter((n) => /^word\/[^/]+\.xml$/.test(n) && !n.endsWith('.rels'))

  const encoder = new TextEncoder()
  const replaced = new Map<string, Uint8Array>()
  const added: ZipEntry[] = []
  /** kind + size -> media path (one picture per distinct label) */
  const media = new Map<string, string>()
  let mediaSeq = 0

  for (const part of parts) {
    const xml = await partText(docx, part)
    if (xml === null || !xml.includes('odt-keep:')) continue
    const relsPath = relsPathOf(part)
    let rels = (await partText(docx, relsPath)) ?? EMPTY_RELS
    const takenIds = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]))
    /** media path -> relationship id in this part */
    const relOf = new Map<string, string>()
    let relSeq = 0
    let changed = false
    const drawings = [...xml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)]
    let out = ''
    let last = 0
    for (const m of drawings) {
      const drawing = m[0]
      const keep = neutral(docPrNameOf(drawing))
      if (!keep || !/<a:blip\b/.test(drawing)) continue
      const extent = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(drawing)
      const widthPx = extent ? Number(extent[1]) / EMU_PER_PX : 96
      const heightPx = extent ? Number(extent[2]) / EMU_PER_PX : 48
      const key = `${keep.kind}:${Math.round(widthPx)}x${Math.round(heightPx)}`
      let path = media.get(key)
      if (!path) {
        do path = `word/media/odt-label-${++mediaSeq}.png`
        while (names.has(path))
        names.add(path)
        media.set(key, path)
        added.push(storedEntry(path, await renderLabelPng(keep.kind, widthPx, heightPx)))
      }
      let rId = relOf.get(path)
      if (!rId) {
        do rId = `rIdOdtLabel${++relSeq}`
        while (takenIds.has(rId))
        takenIds.add(rId)
        relOf.set(path, rId)
        const target = path.slice('word/'.length)
        rels = rels.replace(
          /<\/Relationships>\s*$/,
          `<Relationship Id="${rId}" Type="${IMAGE_REL_TYPE}" Target="${target}"/></Relationships>`,
        )
      }
      const retargeted = drawing.replace(/(<a:blip\b[^>]*?\br:embed=")[^"]*(")/, `$1${rId}$2`)
      out += xml.slice(last, m.index) + retargeted
      last = m.index + drawing.length
      changed = true
    }
    if (!changed) continue
    out += xml.slice(last)
    replaced.set(part, encoder.encode(out))
    replaced.set(relsPath, encoder.encode(rels))
  }
  if (replaced.size === 0) return docx

  const types = await partText(docx, '[Content_Types].xml')
  if (types !== null && !/<Default\b[^>]*\bExtension="png"/i.test(types)) {
    replaced.set(
      '[Content_Types].xml',
      encoder.encode(
        types.replace(
          /<Types\b[^>]*>/,
          (open) => `${open}<Default Extension="png" ContentType="image/png"/>`,
        ),
      ),
    )
  }

  const next: ZipEntry[] = entries.map((entry) => {
    const data = replaced.get(entry.name)
    return data ? storedEntry(entry.name, data) : entry
  })
  for (const [name, data] of replaced) {
    if (!entries.some((e) => e.name === name)) next.push(storedEntry(name, data))
  }
  return writeZip([...next, ...added])
}
