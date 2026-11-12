// Group pptxRoundtrip: the model the binding of @seuoffice/pptx-engine sends
// (JSON.stringify of a deck, a slide or an element of the TypeScript), read as
// the Rust model and written again, against crates/office-wasm/src/calls/
// pptx_roundtrip.rs. The TypeScript side answers the value it was given, so a
// difference is a key the Rust model loses, adds, reorders or reprints.
//
// The inputs are every deck the gate has, opened by the frozen TypeScript, its
// slides and their elements (decorations included), anchors and ranges as they
// are: what the binding crosses on a call. A mutated text is not a model, and
// the Rust refuses what the TypeScript would read, so the text is not mutated.
import { openPptx } from './reference/index'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { DECKS } from './deck-ops'

const decks = await Promise.all(DECKS.map(async ([, base64]) => (await openPptx(Buffer.from(base64, 'base64'))).deck))

const inputs = (kind: 'deck' | 'slide' | 'element'): Input[] => {
  const values =
    kind === 'deck'
      ? decks
      : kind === 'slide'
        ? decks.flatMap((deck) => deck.slides)
        : decks.flatMap((deck) => deck.slides.flatMap((slide) => [...slide.elements, ...(slide.decorations ?? [])]))
  return values.map((value) => ({ text: JSON.stringify(value) }))
}

export const ROUNDTRIP: CallSpec[] = (['deck', 'slide', 'element'] as const).map((kind) => ({
  fn: `pptxRoundtrip.${kind}`,
  call: (text: string): unknown => JSON.parse(text),
  built: inputs(kind),
  mutation: 'none',
}))
