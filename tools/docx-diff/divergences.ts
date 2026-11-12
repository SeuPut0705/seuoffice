import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import JSZip from 'jszip'
import { callOutcomes, listedClasses } from './calls-run'
import { openOnce } from './compare-package'
import { rustRoundTrip, typescriptRoundTrip } from './compare-xml'
import { rustEntries, textWithoutBuffer } from './compare-zip'
import { toolDir } from './harness'
import { oddContainers } from './package-zips'

/** A known difference, with what each side returns for the input. */
type Divergence = { id: string; typescript: unknown; rust: unknown; reason: string } & (
  | { comparison: 'roundTripXml'; fragment: string }
  | { comparison: 'zipTextWithoutBuffer'; entryHex: string }
  /**
   * A container of package-zips.ts by name: what loading it gives. With
   * `host: node` the TypeScript side is the loader on Node as it is.
   */
  | { comparison: 'loadDocx'; container: string; host?: 'node' }
  /**
   * A function of comparison (f), by the name of its spec. With `zone` the
   * TypeScript side runs in that time zone; the gate itself runs in UTC.
   */
  | {
      comparison: 'call'
      fn: string
      text: string
      args?: Record<string, unknown>
      zone?: string
    }
)

async function outcomes(entry: Divergence): Promise<{ typescript: unknown; rust: unknown }> {
  if (entry.comparison === 'roundTripXml') {
    return {
      typescript: typescriptRoundTrip(entry.fragment),
      rust: rustRoundTrip([entry.fragment])[0],
    }
  }
  if (entry.comparison === 'call') {
    const zone = process.env.TZ
    if (entry.zone) process.env.TZ = entry.zone
    try {
      return await callOutcomes(entry.fn, entry.text, entry.args ?? {})
    } finally {
      process.env.TZ = zone ?? 'UTC'
    }
  }
  if (entry.comparison === 'loadDocx') {
    const docx = oddContainers().find(([name]) => name === entry.container)?.[1]
    if (!docx) return { typescript: 'no such container', rust: 'no such container' }
    return {
      typescript: openOnce('typescript', docx, entry.host ?? 'product'),
      rust: openOnce('rust', docx),
    }
  }
  const zip = new JSZip()
  zip.file('entry', Buffer.from(entry.entryHex, 'hex'))
  const container = await zip.generateAsync({ type: 'uint8array' })
  const entries = rustEntries(container)
  return {
    typescript: await textWithoutBuffer((await JSZip.loadAsync(container)).file('entry')!),
    rust: 'error' in entries ? entries : entries.get('entry')?.text,
  }
}

/** Entries of divergences.json that no longer reproduce as listed: the ledger must not go stale. */
export async function staleDivergences(): Promise<{ listed: number; stale: string[] }> {
  const ledger = JSON.parse(
    readFileSync(resolve(toolDir, 'divergences.json'), 'utf8'),
  ) as Divergence[]
  const stale: string[] = []
  for (const entry of ledger) {
    const now = await outcomes(entry)
    for (const side of ['typescript', 'rust'] as const) {
      if (!isDeepStrictEqual(now[side], entry[side])) {
        stale.push(
          `${entry.id}: ${side} now gives ${JSON.stringify(now[side])}, listed ${JSON.stringify(entry[side])}`,
        )
      }
    }
    if (isDeepStrictEqual(now.typescript, now.rust)) stale.push(`${entry.id}: both sides now agree`)
  }
  // a class a spec names has its entry here, and still has an input that differs
  for (const [id, { inputs, differ }] of listedClasses) {
    if (!ledger.some((entry) => entry.id === id)) stale.push(`${id}: a spec lists it, no entry`)
    else if (differ === 0) stale.push(`${id}: none of the ${inputs} inputs of the class differs`)
  }
  return { listed: ledger.length, stale }
}
