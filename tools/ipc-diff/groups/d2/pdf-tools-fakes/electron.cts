/**
 * `electron` for `pdf-structure-ipc.ts`: main-diff's stub exports a fixed
 * list of names, and `utilityProcess` is not among them. This reads every
 * name from the case's Electron (main-diff/electron-fake.ts keeps it on
 * `globalThis`), so the job runner reaches the case's `utilityProcess.fork`.
 */
const box = (globalThis as unknown as Record<symbol, { fake: Record<string, unknown> }>)[
  Symbol.for('main-diff.electron')
]

export = new Proxy({}, { get: (_t, key) => box.fake[String(key)] })
