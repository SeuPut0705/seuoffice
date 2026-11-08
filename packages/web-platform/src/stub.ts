import { WebUnsupportedError } from './errors'

/** A Node function that exists for imports and throws when called or constructed */
export function nodeStub(feature: string): (...args: unknown[]) => never {
  return function stub(): never {
    throw new WebUnsupportedError(`node:${feature}`)
  }
}
