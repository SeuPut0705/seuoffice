import { createHash } from 'node:crypto'

/** Gate form only. Unlike JSON.stringify alone, Maps and bytes retain their contents. */
export function modelJson(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: Record<string, unknown>, key, inner: unknown): unknown {
      const original = this[key]
      if (original instanceof Map) return [...original.entries()]
      if (original instanceof Uint8Array) {
        return {
          $bytes: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString(
            'base64',
          ),
        }
      }
      if (typeof inner === 'function') throw new TypeError('a model contains a function')
      return inner
    },
  )
}

export function modelDigest(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

export interface ModelInput {
  where: string
  population: 'corpus' | 'built' | 'mutated' | 'tests'
  type: string
  json: string
  expect?: 'refuse'
}
