import { callEngine } from './engine'

/**
 * A relationship target resolved against the part that names it: `..` stops
 * at the zip root, backslashes are separators, and a target with a scheme or
 * one that does not decode is the empty string.
 */
export function resolveTarget(basePart: string, target: string): string {
  return callEngine<string>('resolveTarget', [basePart, target])
}
