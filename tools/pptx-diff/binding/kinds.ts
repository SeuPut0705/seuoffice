// How a Rust parameter of a pptx port crosses the wire (crates/pptx-engine/C2-PLAN.md,
// "What pptx adds"). The wrapper and the Rust row both read the signature through
// this one table, so they cannot disagree on which argument is which.

/** What the engine fills itself, with no wire argument. */
export type Host = 'uuid' | 'uuid-source' | 'uuid-source-impl' | 'now' | 'uids'

export type Kind =
  | { kind: 'host'; host: Host }
  /** an `OpenedPptx`: the deck, the archive and the save snapshot; `mut` is written back */
  | { kind: 'opened'; mut: boolean }
  /** a `PackageArchive`: entries and the original hash; `mut` is written back */
  | { kind: 'archive'; mut: boolean }
  /** any other `&mut T`: read from JSON and answered as JSON, written into the caller's object */
  | { kind: 'json-mut'; type: string }
  /** an argument read from JSON, nothing written back */
  | { kind: 'value'; type: string }

const SPLIT = /^(?:mut )?(?:r#)?(_?[a-z][a-z_0-9]*)\s*:\s*([\s\S]*)$/

export function nameOf(raw: string): string {
  return SPLIT.exec(raw.trim())?.[1] ?? ''
}

export function typeOf(raw: string): string {
  return (SPLIT.exec(raw.trim())?.[2] ?? raw).replace(/'[a-z_]+\s*/g, '').replace(/\s+/g, ' ').trim()
}

export function classify(raw: string): Kind {
  const name = nameOf(raw)
  const type = typeOf(raw)
  if (name === 'uuid' && type === '&str') return { kind: 'host', host: 'uuid' }
  if (type === '&mut dyn FnMut() -> String') return { kind: 'host', host: 'uuid-source' }
  if (type === 'impl FnMut() -> String') return { kind: 'host', host: 'uuid-source-impl' }
  if ((name === 'now_ms' || name === 'now') && type === 'f64') return { kind: 'host', host: 'now' }
  if (name === 'uids' && type === '&Uids') return { kind: 'host', host: 'uids' }
  if (type === '&mut OpenedPptx') return { kind: 'opened', mut: true }
  if (type === '&OpenedPptx') return { kind: 'opened', mut: false }
  if (type === '&mut PackageArchive') return { kind: 'archive', mut: true }
  if (type === '&PackageArchive') return { kind: 'archive', mut: false }
  if (/^&mut /.test(type)) return { kind: 'json-mut', type: type.slice('&mut '.length) }
  return { kind: 'value', type }
}

/** The Rust parameters that have a wire argument, in order. */
export function wireParams(params: string[]): string[] {
  return params.filter((p) => classify(p).kind !== 'host')
}

/** A `&mut` type the engine answers back whole, as JSON. */
const WRITTEN_JSON = /^(?:Slide|SlideDeck|SlideElement|GroupElement|\[Paragraph\]|JsObject<[^>]+>)$/

/** The model types the binding writes back by their shape (packages/pptx-engine/src/engine.ts, `ModelType`). */
export const MODEL_TYPES = ['SlideDeck', 'Slide', 'SlideElement', 'GroupElement', 'Paragraph'] as const

/** How engine.ts writes a `&mut` JSON argument back: a model type by its TypeScript name, other JSON as `json`. */
export function writtenAs(type: string): string {
  const list = /^\[(.+)\]$/.exec(type)
  const name = list ? list[1]! : type
  if (!(MODEL_TYPES as readonly string[]).includes(name)) return 'json'
  return list ? `${name}[]` : name
}

/** A parameter type the row can read, the name stripped. */
export function decodable(type: string): boolean {
  const t = type
    .replace(/^(?:mut )?(?:r#)?_?[a-z][a-z_0-9]*\s*:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  // a struct that borrows its strings cannot be read from owned JSON
  if (/[A-Za-z]<'[a-z_]+>/.test(t)) return false
  const plain = t.replace(/'[a-z_]+\s*/g, '')
  const c = classify(`x: ${plain}`)
  if (c.kind === 'opened' || c.kind === 'archive') return true
  if (c.kind === 'json-mut') return WRITTEN_JSON.test(c.type)
  if (/&mut|dyn |impl |\bSelf\b|\bFnMut\b|\bFnOnce\b|\bFn\(/.test(plain)) return false
  if (/^[A-Z]$/.test(plain)) return false
  return true
}
