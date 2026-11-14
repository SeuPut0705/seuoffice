import { keysAsWritten } from '../docx-diff/key-order'
import type { Input, Spec } from './spec'

export type Outcome = { value: unknown } | { error: { name: string; message: string } }

function jsonValue(_key: string, value: unknown): unknown {
  if (value instanceof Map || value instanceof Set) return [...value]
  // JSON.stringify writes null for these: the Rust side encodes them the same way
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  return typeof value === 'function' ? '[function]' : value
}

/** The TypeScript answer as JSON gives it back; throws where the answer is not JSON. */
export async function typescriptOutcome(spec: Spec, input: Input): Promise<Outcome> {
  let value: unknown
  try {
    value = await spec.call(input)
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: typeof error, message: String(error) },
    }
  }
  try {
    return JSON.parse(JSON.stringify({ value }, jsonValue)) as Outcome
  } catch (error) {
    throw new Error(`${spec.fn} ${input.label}: the TypeScript answer is not JSON`, {
      cause: error,
    })
  }
}

/**
 * The zip gate appends the host's own text to "cannot be inflated": Node gives
 * the bare name TypeError, a browser something else, Rust its own sentence.
 * Only what the TypeScript wrote itself is compared, as docx-diff's
 * compare-package.ts does.
 */
export function withoutHostText(outcome: Outcome): Outcome {
  if (!('error' in outcome)) return outcome
  return {
    error: {
      ...outcome.error,
      message: outcome.error.message.replace(/(cannot be inflated:).*$/s, '$1'),
    },
  }
}

/** JSON text of a value read by `parseKeepingOrder`, every object's keys in the order they were written. */
export function stringifyAsWritten(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringifyAsWritten).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${keysAsWritten(value)
    .map((key) => `${JSON.stringify(key)}:${stringifyAsWritten(record[key])}`)
    .join(',')}}`
}
