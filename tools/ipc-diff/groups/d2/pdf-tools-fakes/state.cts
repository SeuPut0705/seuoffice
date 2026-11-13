/**
 * The case the PDF tools' fakes answer from, as crates/shell-ipc/d2's
 * `pdf::tools::hosts::fake` reads it (`hosts.d2.pdf.tools`): `case[method]`
 * answers every call, an array answers one element per call and then the
 * neutral default; `{"$u8": [..]}` is a Uint8Array. Every fake with an effect
 * writes the same log line as the Rust fake. Kept on `globalThis` so the
 * CommonJS fakes and the ESM groups share one copy.
 */
export interface ToolsState {
  answers: Map<string, unknown>
  log: unknown[]
  /** `allowedByWc` of the pdf editor (pdf-main.cts) */
  grants: Map<number, Set<string>>
  uuids: number
  /** the shell entry's `importPdf` for the Hangul editor (hwp-main.cts) */
  importPdf?: () => void
}

const KEY = Symbol.for('ipc-diff.d2.pdf-tools')

function holder(): Record<symbol, ToolsState | undefined> {
  return globalThis as unknown as Record<symbol, ToolsState | undefined>
}

export function startCase(tools: unknown, log: unknown[]): ToolsState {
  const answers = new Map<string, unknown>()
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    for (const [k, v] of Object.entries(tools)) answers.set(k, structuredClone(v))
  }
  const state: ToolsState = { answers, log, grants: new Map(), uuids: 0 }
  holder()[KEY] = state
  return state
}

export function state(): ToolsState {
  const s = holder()[KEY]
  if (!s) throw new Error('pdf-tools fakes used before a case started')
  return s
}

/** The next answer of `method`, undefined when the case gives none */
export function answer(method: string): unknown {
  const answers = state().answers
  if (!answers.has(method)) return undefined
  const a = answers.get(method)
  if (Array.isArray(a)) return a.length === 0 ? undefined : a.shift()
  return a
}

export function log(line: unknown[]): void {
  state().log.push(line)
}

/** a case value as the renderer would get it */
export function ipc(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ipc)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && keys[0] === '$u8') return bytes(o)
    return Object.fromEntries(keys.map((k) => [k, ipc(o[k])]))
  }
  return v
}

export function bytes(v: unknown): Uint8Array {
  const list: unknown = v && typeof v === 'object' && '$u8' in v ? v.$u8 : v
  return Uint8Array.from(Array.isArray(list) ? list.map(Number) : [])
}
