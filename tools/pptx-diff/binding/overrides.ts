// What the manifest cannot read from the two signatures of a pptx export: the
// hand decisions of the pptx binding (crates/pptx-engine/C2-PLAN.md). The
// shape of an entry is B4's `Override` (tools/docx-diff/binding/overrides.ts).
// An export in none of these tables whose Rust port takes its arguments one to
// one gets a generated wrapper and row without a word here; where the Rust
// signature differs, tools/pptx-diff/binding/inventory/mismatch.md says how.
//
// In `body`, `$call(a, b, ...)` is the engine call of this export with those
// wire arguments, and a bare `$call` the call with the TypeScript parameters; the generator writes the arguments the engine changes
// (from the Rust `&mut` parameters) and the reply shape into it. Helpers of
// packages/pptx-engine/src/engine.ts: `slideIndex(opened, slide)` is the index
// of a slide of the opened deck.
//
// Rust parameters the TypeScript has not are filled by the row by name, not
// here: `uuid: &str` is `jscompat::random_uuid()`, a `&mut dyn FnMut() ->
// String` uuid source draws the same, `now_ms`/`now: f64` is the host's clock,
// `uids: &Uids` the instance's id counter.
import type { Override } from '../../docx-diff/binding/overrides'

/** The exports that stay TypeScript: no engine call, the module keeps them as they are. */
export const PPTX_TS_ONLY: Readonly<Record<string, string>> = {
  savePptxToFile:
    'the engine has no file system: savePptx gives the bytes and the host streams them to the file (written in APPEND)',
  ownValue: 'a JavaScript-object helper the host code of pptx-ops calls on its own tables; Rust has its own over JsMap',
  setOwn: 'the same, writing a key of a JavaScript object',
  xmlParser: 'answers a fast-xml-parser instance the host parses with; the engine parses inside each call',
  sfntCmapLookup: 'answers a function (cp) => boolean, which cannot cross; only tests call it',
}

const slideOf = (opened: string): string => `const i = $call as number | null\n  return i === null ? null : ${opened}.deck.slides[i]!`
const withSlide = (index: string, key: string): string =>
  `const v = $call; return v === null ? null : { slide: opened.deck.slides[${index}]!, ${key}: v }`

export const PPTX_OVERRIDES: Record<string, Override> = {
  // ---- the deck as a whole: async in TypeScript, sync in Rust
  openPptx: { body: 'return $call(bytes)' },
  savePptx: { body: 'return $call(opened)' },
  reparseDeck: { body: '$call(opened)\n  return opened' },
  createBlankPptx: { body: 'return $call($now)' },

  // ---- a Slide of the opened deck: the engine takes its index
  setSlideBackground: { body: '$call(opened, slideIndex(opened, slide), fill)' },
  setSlideBackgroundImage: { body: 'return $call(opened, slideIndex(opened, slide), source, tile)' },
  resetSlideBackground: { body: '$call(opened, slideIndex(opened, slide))' },
  setSlideBgGraphicsHidden: { body: '$call(opened, slideIndex(opened, slide), hidden)' },
  setElementFill: { body: 'return $call(opened, slideIndex(opened, slide), elementId, fill, opts)' },
  setElementImageFill: { body: 'return $call(opened, slideIndex(opened, slide), elementId, source, opts)' },
  replacePictureBytes: {
    body: 'return $call(opened, slideIndex(opened, slide), sourceId, bytes, ext, opts?.keepSrcRect ?? false)',
  },
  copyElementData: {
    body: 'const at = slideIndex(opened, slide)\n  return $call(opened, at, opened.deck.slides[at]!.elements.indexOf(el))',
  },
  addImageMediaAndRel: { body: 'return $call(opened, slideIndex(opened, slide), bytes, extRaw)' },
  deleteElement: { body: 'return $call(opened, slideIndex(opened, slide), elementId)' },
  setModel3dView: { body: 'return $call(opened, slideIndex(opened, slide), elementId, view)' },
  cleanupSupersededSlideResources: {
    body: 'return $call(opened, slideIndex(opened as OpenedPptx, slide), previousXml, currentXml)',
  },
  addPicture: {
    body: 'const at = slideIndex(opened, slide)\n  return $call(opened, at, opts) === null ? null : (opened.deck.slides[at]!.elements.at(-1) as PictureElement)',
  },

  // ---- the engine answers an index or an id; the TypeScript answered the object in the deck
  duplicateSlide: { body: slideOf('opened') },
  pasteSlide: { body: slideOf('opened') },
  insertBlankSlide: { body: slideOf('opened') },
  insertSlideWithLayout: { body: slideOf('opened') },
  setSlideLayout: { body: slideOf('opened') },
  resetSlideLayout: { body: slideOf('opened') },
  mergeSlideFromSource: { body: slideOf('target') },
  mergeSlideFromPptx: { body: slideOf('target') },
  materializeSlide: { body: 'return $call(opened, slideIndex) ? opened.deck.slides[slideIndex]! : null' },
  ungroupElement: { body: 'return $call(opened, slideIndex, sourceId) ? opened.deck.slides[slideIndex]! : null' },
  setElementLink: {
    body: 'return $call(opened, slideIndex, elementId, target) ? opened.deck.slides[slideIndex]! : null',
  },
  appendRawElements: { body: withSlide('slideIndex', 'elementIds') },
  addTable: { body: withSlide('slideIndex', 'elementId') },
  editTableStructure: { body: withSlide('slideIndex', 'elementId') },
  mergeTableCells: { body: withSlide('slideIndex', 'elementId') },
  pasteElements: { body: withSlide('slideIndex', 'elementIds') },
  groupElements: { body: withSlide('slideIndex', 'groupId') },
  addChart: { body: withSlide('slideIndex', 'elementId') },
  addMedia: { body: withSlide('slideIndex', 'elementId') },
  addModel3d: { body: withSlide('slideIndex', 'elementId') },
  addNarration: { body: withSlide('slideIndex', 'elementId') },
  addSmartArt: {
    body: 'const v = $call as { elementId?: string } | null\n  return v === null || v.elementId === undefined ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v.elementId }',
  },
  addElement: { body: '$call(slide, opts)\n  return slide.elements.at(-1) as TextElement' },
  findGroupChild: {
    body: 'const at = $call as [number, number] | null\n  if (at === null) return null\n  const grp = slide.elements[at[0]] as GroupElement\n  return { grp, child: grp.children[at[1]]! }',
  },

  // ---- the clock the engine has not
  addSlideComment: { body: 'return $call(opened, slideIndex, opts, $nowIso)' },

  // ---- the TypeScript takes the opened deck, the Rust the parts it needs
  applyThemeToArchive: { body: 'return $call(opened.archive, spec)' },
  remapDeckColors: { body: 'return $call(opened.archive, opened.deck, spec)' },
}
