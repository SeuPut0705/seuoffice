// The clock of the gate. The TypeScript engine reads the host's clock where
// the Rust takes it as an argument (`now`): `new Date()` of assemble/zip.ts
// for the DOS time of new entries, `Date.now()` of docx-engine's saveDocx for
// `docProps/core.xml`. Under `withClock` both answer one fixed instant, and
// the Rust side is given the same instant as `now: { ms, offsetMinutes }`.
// The gate runs in UTC (../docx-diff/host.ts), so the offset is 0. JSZip stamps
// the entries of the bridge docx with `new Date()` as well, so odtToDocx is
// given `now` too.
/** 2026-11-12T03:04:06.000Z: an even second (DOS time keeps two-second steps) after 1980. */
export const FROZEN_MS = Date.UTC(2026, 10, 12, 3, 4, 6, 0)

/** What the Rust side is given: `Date.now()` and `getTimezoneOffset()` of the frozen host. */
export const NOW = { ms: FROZEN_MS, offsetMinutes: 0 } as const

const RealDate = Date

class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FROZEN_MS)
    else super(...(args as [number]))
  }
  static override now(): number {
    return FROZEN_MS
  }
}

let depth = 0

/** Runs `run` with `Date` frozen; the clock is restored when the last running call settles. */
export async function withClock<T>(run: () => T | Promise<T>): Promise<T> {
  if (depth === 0) globalThis.Date = FrozenDate as unknown as DateConstructor
  depth += 1
  try {
    return await run()
  } finally {
    depth -= 1
    if (depth === 0) globalThis.Date = RealDate
  }
}
