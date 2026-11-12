import { statSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { parseDocx } from './reference/index'
import { scanBody } from './reference/scan'
import { rustScan } from './compare-scan'
import { WASM_PATH } from './harness'

const WARM_UP_ROUNDS = 5
const ROUNDS = 31
const PARSE_PASSES = 5

function line(label: string, samples: number[], digits: number, work: string): string {
  samples.sort((a, b) => a - b)
  return (
    `  ${label.padEnd(48)} median ${samples[samples.length >> 1]!.toFixed(digits)} ms  ` +
    `range ${samples[0]!.toFixed(digits)} to ${samples.at(-1)!.toFixed(digits)} ms  ${work}`
  )
}

/**
 * Times scanBody over every main part, one round = every part once. Rounds
 * alternate between the sides so drift and other load on the machine reach all
 * of them alike. Each side returns the number of elements it found, which shows
 * the work was done and done alike.
 */
export async function bench(mainParts: string[], documents: Uint8Array[]): Promise<void> {
  const encoder = new TextEncoder()
  const encoded = mainParts.map((xml) => encoder.encode(xml))
  const rustElements = (xml: Uint8Array): number => {
    const outcome = rustScan(xml)
    return 'scan' in outcome ? outcome.scan.elements.length : 0
  }
  const sides: Record<string, () => number> = {
    'typescript scanBody': () =>
      mainParts.reduce((sum, xml) => sum + scanBody(xml).elements.length, 0),
    'rust: encode, copy in, scan, JSON reply, parse': () =>
      mainParts.reduce((sum, xml) => sum + rustElements(encoder.encode(xml)), 0),
    'rust: the same with the text already UTF-8': () =>
      encoded.reduce((sum, xml) => sum + rustElements(xml), 0),
  }
  const samples = new Map(Object.keys(sides).map((label) => [label, [] as number[]]))
  const elements = new Map<string, number>()
  for (let round = 0; round < WARM_UP_ROUNDS + ROUNDS; round++) {
    for (const [label, run] of Object.entries(sides)) {
      const start = performance.now()
      elements.set(label, run())
      const elapsed = performance.now() - start
      if (round >= WARM_UP_ROUNDS) samples.get(label)!.push(elapsed)
    }
  }
  const units = mainParts.reduce((sum, xml) => sum + xml.length, 0)
  console.log(
    `bench scanBody: ${mainParts.length} main parts, ${units} UTF-16 units, ${ROUNDS} alternating rounds; ` +
      `wasm ${statSync(WASM_PATH).size} bytes; load average ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores`,
  )
  for (const [label, times] of samples) {
    console.log(line(label, times, 3, `elements found ${elements.get(label)}`))
  }

  const passes: number[] = []
  let parsed = 0
  for (let pass = 0; pass < 1 + PARSE_PASSES; pass++) {
    const start = performance.now()
    parsed = 0
    for (const bytes of documents) {
      await parseDocx(bytes).then(
        () => (parsed += 1),
        () => undefined,
      )
    }
    if (pass >= 1) passes.push(performance.now() - start)
  }
  console.log(
    line(
      'typescript parseDocx, whole documents',
      passes,
      1,
      `documents parsed ${parsed} of ${documents.length}`,
    ),
  )
}
