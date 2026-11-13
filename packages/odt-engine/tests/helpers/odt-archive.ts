/**
 * Reads an ODT the way a consumer can: unzip it with JSZip and look at the
 * parts. Entries come in local-header order with their stored/deflated method,
 * so a test can tell whether a save kept the original package layout.
 */
import JSZip from 'jszip'

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

export interface OdtEntry {
  name: string
  /** uncompressed bytes */
  bytes: Uint8Array
  /** zip method: 0 stored, 8 deflated */
  method: number
}

export interface OdtArchive {
  entries: OdtEntry[]
  mimetypeFirst: boolean
  mimetypeStored: boolean
  get(name: string): OdtEntry | undefined
  /** the entry's text, a UTF-8 byte order mark kept as U+FEFF (the bridge map's ranges count it) */
  text(name: string): string | undefined
}

interface CentralEntry {
  name: string
  method: number
  localOffset: number
}

function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('no end of central directory')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)
  const out: CentralEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('bad central directory')
    const nameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    out.push({
      name: decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)),
      method: view.getUint16(pos + 10, true),
      localOffset: view.getUint32(pos + 42, true),
    })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return out
}

export async function readArchive(bytes: Uint8Array): Promise<OdtArchive> {
  const zip = await JSZip.loadAsync(bytes)
  const central = centralDirectory(bytes).sort((a, b) => a.localOffset - b.localOffset)
  const entries: OdtEntry[] = []
  for (const c of central) {
    const file = zip.files[c.name]
    const data = file && !file.dir ? await file.async('uint8array') : new Uint8Array()
    entries.push({ name: c.name, bytes: data, method: c.method })
  }
  const first = entries[0]
  const mimetype = entries.find((e) => e.name === 'mimetype')
  return {
    entries,
    mimetypeFirst: first?.name === 'mimetype',
    mimetypeStored: mimetype?.method === 0,
    get: (name) => entries.find((e) => e.name === name),
    text: (name) => {
      const entry = entries.find((e) => e.name === name)
      return entry ? decoder.decode(entry.bytes) : undefined
    },
  }
}
