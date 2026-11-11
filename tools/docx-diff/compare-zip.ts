import JSZip from 'jszip'
import jszipSupport from 'jszip/lib/support.js'
import { failed } from './engine'
import { describeTextDifference, engine } from './harness'

interface RustEntry {
  dir: boolean
  text: string
  error?: string
}

/** Rust's entries keyed the way JSZip names them: raw bytes as UTF-8, last one wins. */
export function rustEntries(container: Uint8Array): Map<string, RustEntry> | { error: string } {
  const { header, blobs } = engine.call<{
    entries: Array<{ rawName: string; dir: boolean; error?: string }>
  }>({ cmd: 'zipEntries' }, [container])
  if (failed(header)) return { error: header.error.message }
  return new Map(
    header.entries.map((entry, index) => {
      const blob = blobs[index]!
      return [
        Buffer.from(entry.rawName, 'hex').toString('utf8'),
        {
          dir: entry.dir,
          text: Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('utf16le'),
          error: entry.error,
        },
      ]
    }),
  )
}

/** JSZip's decoder where there is no global Buffer (a browser, a sandboxed renderer). */
export async function textWithoutBuffer(file: JSZip.JSZipObject): Promise<string> {
  jszipSupport.nodebuffer = false
  try {
    return await file.async('string')
  } finally {
    jszipSupport.nodebuffer = true
  }
}

export interface EntryResult {
  /** Empty for a result about the container as a whole. */
  name: string
  difference: string | null
  /** The JSZip side, when both sides read the entry as text. */
  read?: { file: JSZip.JSZipObject; text: string }
}

/** JSZip `async('string')` of every entry against the Rust decode, as UTF-16 code units. */
export async function compareZipText(where: string, container: Uint8Array): Promise<EntryResult[]> {
  const rust = rustEntries(container)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(container)
  } catch (error) {
    const difference =
      'error' in rust ? null : `${where}: JSZip refuses (${String(error)}), Rust reads it`
    return [{ name: '', difference }]
  }
  if ('error' in rust) {
    return [{ name: '', difference: `${where}: Rust refuses (${rust.error}), JSZip reads it` }]
  }

  const names = Object.keys(zip.files)
  const results: EntryResult[] = [...rust.keys()]
    .filter((name) => !names.includes(name))
    .map((name) => ({ name, difference: `${where}: entry ${JSON.stringify(name)} only in Rust` }))
  for (const name of names) {
    const file = zip.files[name]!
    const entry = rust.get(name)
    let difference: string | null = null
    let read: EntryResult['read']
    if (!entry) {
      difference = 'only in JSZip'
    } else if (file.dir !== entry.dir) {
      difference = `directory flag: JSZip ${file.dir}, Rust ${entry.dir}`
    } else if (!file.dir) {
      const typescript = await file.async('string').catch((error) => ({ error: String(error) }))
      if (typeof typescript !== 'string') {
        difference = entry.error ? null : `JSZip fails (${typescript.error}), Rust reads it`
      } else if (entry.error) {
        difference = `Rust fails (${entry.error}), JSZip reads it`
      } else {
        if (typescript !== entry.text) difference = describeTextDifference(typescript, entry.text)
        read = { file, text: typescript }
      }
    }
    results.push({
      name,
      difference: difference === null ? null : `${where}: ${JSON.stringify(name)}: ${difference}`,
      read,
    })
  }
  return results
}
