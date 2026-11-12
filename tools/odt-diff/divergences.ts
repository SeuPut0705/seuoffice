import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { callOutcomes, listedClasses } from './calls-run'
import { failGate } from '../docx-diff/harness'
import { keyOrderDifferences, parseKeepingOrder } from '../docx-diff/key-order'
import { registerDifferences, type ObservedDifference } from '../docx-diff/known-differences'

interface DivergenceClass {
  id: string
  reason: string
  cases: ObservedDifference[]
}

const ledger = parseKeepingOrder(
  readFileSync(fileURLToPath(new URL('divergences.json', import.meta.url)), 'utf8'),
) as DivergenceClass[]

export function registerLedger(): void {
  registerDifferences(
    ledger.flatMap(({ id, reason, cases }) =>
      cases.map((input, index) => ({ ...input, id: `${id}:${index}`, reason })),
    ),
  )
}

export async function reportDivergences(): Promise<void> {
  const stale: string[] = []
  for (const entry of ledger) {
    if (!entry.reason || entry.cases.length === 0)
      stale.push(`${entry.id}: missing reason or input`)
    for (const [index, input] of entry.cases.entries()) {
      const now = await callOutcomes(input.fn, input.text, input.args as Record<string, unknown>)
      for (const side of ['typescript', 'rust'] as const) {
        if (
          !isDeepStrictEqual(now[side], input[side]) ||
          keyOrderDifferences(input[side], now[side]).length > 0
        )
          stale.push(
            `${entry.id}:${index}: ${side} now gives ${JSON.stringify(now[side])}, listed ${JSON.stringify(input[side])}`,
          )
      }
      if (
        isDeepStrictEqual(now.typescript, now.rust) &&
        keyOrderDifferences(now.typescript, now.rust).length === 0
      )
        stale.push(`${entry.id}:${index}: both sides now agree`)
    }
  }
  // a class a spec names (`CallSpec.listed`) has its entry here, and an input of it still differs
  for (const [id, { inputs, differ }] of listedClasses) {
    if (!ledger.some((entry) => entry.id === id)) stale.push(`${id}: a spec lists it, no entry`)
    else if (differ === 0) stale.push(`${id}: none of the ${inputs} inputs of the class differs`)
  }
  console.log(
    `divergences.json: ${ledger.length} classes, ${ledger.reduce((n, entry) => n + entry.cases.length, 0)} exact inputs, ${stale.length} no longer reproduce`,
  )
  for (const line of stale) console.log(`    - ${line}`)
  if (stale.length > 0) failGate()
}
