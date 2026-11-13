/**
 * `node:crypto` as the recovery store imports it, for the hwp groups: the
 * UUIDs of untitled recovery copies count up per case as the Rust fake
 * `HwpShell::random_uuid` does, so both sides name the copy alike.
 */
import { nextUuid } from './common.ts'

export * from 'node:crypto'
export const randomUUID = (): string => nextUuid()
