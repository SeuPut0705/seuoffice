/**
 * Run by stream-inflate.test.ts in a process of its own: one reader reads one HWP file, and the
 * process prints what the reader gave back, how long it took and how far the most memory the
 * process ever held rose while it ran.
 *
 * It has to be a new process for every reader. The figure the system keeps is the most the
 * process has held since it started, so a reader that runs after another one in the same
 * process can stay under the mark the first one left and seem to hold nothing.
 *
 *   node --import tsx inflate-probe.ts <reader> <file>
 */
import { readFileSync } from 'node:fs'
import { fieldKindsOf } from '../../src/main/field-kinds'
import { SECTION, openHwp, streamOf } from '../../src/main/hwp5-file'
import { sectionTailsOf } from '../../src/main/section-tails'
import { newTabsOf } from '../../src/main/tab-widths'

export interface ProbeReport {
  /** what the reader returned, or `refused` when it threw */
  result: unknown
  ms: number
  riseBytes: number
}

const READERS = new Map<string, (bytes: Uint8Array) => unknown>([
  ['fieldKinds', fieldKindsOf],
  ['sectionTails', sectionTailsOf],
  ['newTabs', (bytes) => newTabsOf(bytes, 'hwp')],
  // the length only: the section itself would not fit in what the process prints
  ['section', (bytes) => streamOf(openHwp(bytes)!, SECTION(0))?.length ?? null],
])

const [, , name, path] = process.argv
const reader = READERS.get(name)
if (!reader || !path)
  throw new Error(`usage: inflate-probe <${[...READERS.keys()].join('|')}> <file>`)

const bytes = new Uint8Array(readFileSync(path))
const before = process.resourceUsage().maxRSS
const started = performance.now()
let result: unknown
try {
  result = reader(bytes)
} catch {
  result = 'refused'
}
const report: ProbeReport = {
  result,
  ms: performance.now() - started,
  riseBytes: (process.resourceUsage().maxRSS - before) * 1024,
}
process.stdout.write(JSON.stringify(report))
