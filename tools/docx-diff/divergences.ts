import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import JSZip from 'jszip'
import { rustRoundTrip, typescriptRoundTrip } from './compare-xml'
import { rustEntries, textWithoutBuffer } from './compare-zip'
import { toolDir } from './harness'

/** A known difference, with what each side returns for the input. */
type Divergence = { id: string; typescript: unknown; rust: unknown; reason: string } & (
  | { comparison: 'roundTripXml'; fragment: string }
  | { comparison: 'zipTextWithoutBuffer'; entryHex: string }
)

async function outcomes(entry: Divergence): Promise<{ typescript: unknown; rust: unknown }> {
  if (entry.comparison === 'roundTripXml') {
    return {
      typescript: typescriptRoundTrip(entry.fragment),
      rust: rustRoundTrip([entry.fragment])[0],
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
  return { listed: ledger.length, stale }
}
