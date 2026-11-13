import type { DocProtection } from './types'
import { invoke, invokeAsync } from './engine'

/**
 * w:documentProtection password hash (Word 2013+ scheme, ECMA-376 iterated hash):
 *   h0 = H(salt || UTF-16LE(password))
 *   hi = H(h(i-1) || LE32(i))   i = 0..spinCount-1
 * sid 14 = SHA-512 (the only implemented algorithm). Uses WebCrypto, so it works in
 * both the renderer process and Node 20+.
 */

// Word's default iteration count for newly generated hashes.
export const DEFAULT_SPIN_COUNT = 100000
// Upper bound for untrusted spinCount values read from document XML.
// Each iteration costs one Subtle.digest call, so an unbounded value
// from a hostile file would stall the opener (CPU DoS). Both the pure
// helper below and the verify path clamp to this limit before any
// hashing starts, so there is exactly one policy for untrusted counts.
export const MAX_SPIN_COUNT = 1000000
/**
 * Validate and normalize an untrusted spinCount value.
 * Returns DEFAULT_SPIN_COUNT when the value is absent, returns the value
 * itself when it is a safe non-negative integer, and clamps values above
 * MAX_SPIN_COUNT down to MAX_SPIN_COUNT so callers never loop millions
 * of times on attacker-controlled input. Throws on negative, non-integer,
 * or non-numeric values so bad input fails fast without any hashing.
 */
export function resolveSpinCount(raw: unknown): number {
  return invoke('resolveSpinCount', [raw]) as never
}
/** Generate the protection password hash (random 16-byte salt, 100000 iterations by default) */
export async function hashProtectionPassword(
  password: string,
  spinCount = DEFAULT_SPIN_COUNT,
): Promise<{ hash: string; salt: string; spinCount: number; algorithmSid: number }> {
  return invokeAsync('hashProtectionPassword', [
    password,
    spinCount,
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
  ]) as never
}
/** Check whether the password matches the hash in documentProtection (no hash = no password, always true) */
export async function verifyProtectionPassword(
  password: string,
  protection: Pick<DocProtection, 'hash' | 'salt' | 'spinCount' | 'algorithmSid'>,
): Promise<boolean> {
  return invokeAsync('verifyProtectionPassword', [password, protection]) as never
}
