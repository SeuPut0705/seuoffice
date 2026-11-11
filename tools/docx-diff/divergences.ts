import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import JSZip from 'jszip'
import { type Outcome, rustOpen, rustParts, typescriptParts } from './compare-package'
import { outcomeOf, rustOutcome } from './compare-props'
import { rustRoundTrip, typescriptRoundTrip } from './compare-xml'
import { rustEntries, textWithoutBuffer } from './compare-zip'
import { toolDir } from './harness'
import { hostileContainers, oddContainers } from './package-zips'
import { READERS } from './props-registry'

/** A known difference, with what each side returns for the input. */
type Divergence = { id: string; typescript: unknown; rust: unknown; reason: string } & (
  | { comparison: 'roundTripXml'; fragment: string }
  | { comparison: 'zipTextWithoutBuffer'; entryHex: string }
  | { comparison: 'props'; fn: string; text: string }
  /** A container of package-zips.ts by name: what loading it gives. */
  | { comparison: 'loadDocx'; container: string }
  /** A styles part: the docDefaults read from it. */
  | { comparison: 'docDefaults'; stylesXml: string }
)

const NEVER_RETURNS = 'does not return within 5 s'

/** The docDefaults of a styles outcome, which is the one value of it the ledger lists. */
function docDefaultsOf(styles: Outcome): unknown {
  const value = 'value' in styles ? styles.value : undefined
  return value !== null && typeof value === 'object' && 'docDefaults' in value
    ? value.docDefaults
    : styles
}

/**
 * `loadDocxZip` in a child process: the only way to see that it does not
 * return, and the same path for a container it refuses.
 */
function typescriptLoadOnce(docx: Uint8Array): unknown {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'load-once.ts'], {
    cwd: toolDir,
    input: docx,
    timeout: 5_000,
    encoding: 'utf8',
  })
  if (child.error || child.signal) return NEVER_RETURNS
  return JSON.parse(child.stdout) as unknown
}

async function outcomes(entry: Divergence): Promise<{ typescript: unknown; rust: unknown }> {
  if (entry.comparison === 'roundTripXml') {
    return {
      typescript: typescriptRoundTrip(entry.fragment),
      rust: rustRoundTrip([entry.fragment])[0],
    }
  }
  if (entry.comparison === 'props') {
    const reader = READERS.find((candidate) => candidate.fn === entry.fn)!
    return {
      typescript: outcomeOf(() => reader.call(entry.text, {})),
      rust: rustOutcome(entry.fn, entry.text, {}),
    }
  }
  if (entry.comparison === 'loadDocx') {
    const docx =
      hostileContainers()[entry.container] ??
      oddContainers().find(([name]) => name === entry.container)?.[1]
    if (!docx) return { typescript: 'no such container', rust: 'no such container' }
    const rust = rustOpen(docx)
    return {
      typescript: typescriptLoadOnce(docx),
      rust: 'refused' in rust ? { refused: rust.refused } : 'opens',
    }
  }
  if (entry.comparison === 'docDefaults') {
    const parts: Array<[string, string]> = [['word/styles.xml', entry.stylesXml]]
    return {
      typescript: docDefaultsOf((await typescriptParts(parts)).styles),
      rust: docDefaultsOf(rustParts(parts).styles),
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
