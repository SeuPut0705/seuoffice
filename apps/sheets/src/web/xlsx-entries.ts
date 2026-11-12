// What a page reads out of the engine's copy of a workbook without saving it:
// one entry's text, and the cells hidden from the model. A view-only page runs
// this on every open, so nothing here may import the save planner (xlsx-save)
// or the gateway modules behind it; the planner imports this, not the reverse.
import { normalizeOoxmlPartPrefix } from '@seuoffice/xlsx-gateway/gateway/xlsx-namespace'
import type { File } from '@seuoffice/web-platform/wasi'
import { readRedactionEntries, type RedactionPartRead } from '../main/workbook-redaction-entries'

/** The worker's engine: one protocol command, and the files behind /work and /save */
export interface EngineFiles {
  command(name: string, fields: Record<string, unknown>): Promise<unknown>
  /** /work: workbooks the engine opens; the saved package lands here too */
  readonly work: Map<string, File>
  /** /save: one save's extracted entries and planned contents, emptied after it */
  readonly scratch: Map<string, File>
}

// Node's utf8 read keeps a leading BOM; the planner must see the same text the desktop does
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

/** The text of one entry of the engine's copy at `sourcePath`, extracted through /save */
export async function readEntryText(
  engine: EngineFiles,
  sourcePath: string,
  path: string,
): Promise<string> {
  const { entries } = (await engine.command('read_entries', {
    path: sourcePath,
    entries: [path],
    outputDir: '/save',
  })) as { entries: { name: string; path: string }[] }
  const name = entries[0]?.path.replace(/^\/save\//, '')
  const extracted = name === undefined ? undefined : engine.scratch.get(name)
  if (name === undefined || !extracted) throw new Error(`The xlsx engine did not extract ${path}.`)
  engine.scratch.delete(name)
  return normalizeOoxmlPartPrefix(decoder.decode(extracted.data))
}

/** The cells the reader withheld from the model in /work/<source>, read as the desktop open reads them */
export async function readRedactions(
  engine: EngineFiles,
  source: string,
): Promise<RedactionPartRead> {
  const sourcePath = `/work/${source}`
  const { entries } = (await engine.command('archive_manifest', { path: sourcePath })) as {
    entries: { name: string }[]
  }
  const names = new Set(entries.map((entry) => entry.name))
  return readRedactionEntries({
    has: async (path) => names.has(path),
    readText: async (path) => {
      if (!names.has(path)) throw new Error(`Workbook is missing ${path}.`)
      return readEntryText(engine, sourcePath, path)
    },
  })
}
