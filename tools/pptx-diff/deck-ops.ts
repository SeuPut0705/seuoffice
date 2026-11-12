// The harness of every comparison that runs an operation on an opened deck
// (index.ts and the modules that take an OpenedPptx). The Rust side is
// crates/office-wasm/src/calls/pptx_deck.rs, which reads the same arguments.
//
// An input: `args.deck`, the zip of a deck in base64 (`DECKS` names the decks
// the gate has), and where `args.textPart` names a part, `text` written into
// that part before the deck is parsed: that part is what mutations change.
// Both sides open the same entries with the original hash 'gate', run the
// operation, and answer
//
//   { value, deck, parts, paths }
//
// `value` what the operation returned, `deck` the SlideDeck after it (every
// `anchor.range` left out: byte offsets into a slide text are proven by the
// group `parse`, and an operation leaves them stale on both sides), `parts`
// every entry it added, changed or removed as `[path, text]` (text for .xml
// and .rels, `bytes <length> <sha-256>` for others, null when removed) in
// path order, and `paths` the entry names in archive order.
//
// Ids: element ids are rebased as the group `parse` does (calls-parse.ts,
// `fromZero`): the Rust counts from 0 for each call. An input names an
// element by its slide and element indexes (`at.element(s, e)`), never by id.
import './stable-zip'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { type OpenedPptx, openPptx } from '../../packages/pptx-engine/src/index'
import { parseSlide } from '../../packages/pptx-engine/src/parse'
import type { Slide } from '../../packages/pptx-engine/src/types'
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import { repoRoot } from '../docx-diff/harness'
import { builtDecks } from './built'

/** Every deck the gate has: the tracked .pptx files, then the built decks. */
export const DECKS: Array<[string, string]> = await (async () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '*.pptx'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((path): [string, string] => [
      path,
      readFileSync(resolve(repoRoot, path)).toString('base64'),
    ])
  const built = (await builtDecks()).map(([name, bytes]): [string, string] => [
    name,
    Buffer.from(bytes).toString('base64'),
  ])
  return [...tracked, ...built]
})()

/** The deck of `DECKS` named `name`, as `args.deck`. */
export function deckNamed(name: string): string {
  const deck = DECKS.find(([n]) => n === name)
  if (!deck) throw new Error(`no deck named ${name}`)
  return deck[1]
}

/** What an operation is given beside the opened deck. */
export interface At {
  /** The slide at `index` of the deck as it is now. */
  slide(index: number): Slide
  /** The id of element `element` of slide `slide`, as it is now; '' when there is none. */
  element(slide: number, element: number): string
}

const PROBE = '<p:sld><p:cSld><p:spTree><p:sp><p:spPr/></p:sp></p:spTree></p:cSld></p:sld>'

/** The counter of parse.ts after a probe that takes exactly one id. */
function nextId(): number {
  const probe = parseSlide({ path: 'probe', slideXml: PROBE, ctx: {} }).elements[0]!
  return parseInt(probe.id.slice(probe.id.lastIndexOf('_') + 1), 36) + 1
}

const XML_PART = /\.(?:xml|rels)$/i

function partValue(path: string, bytes: Uint8Array | undefined): string | null {
  if (bytes === undefined) return null
  if (XML_PART.test(path)) return new TextDecoder().decode(bytes)
  return `bytes ${bytes.length} ${createHash('sha256').update(bytes).digest('hex')}`
}

/** A value as it crosses JSON, with Maps as their entries, Sets as their values and bytes as lists. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Map) return [...v]
      if (v instanceof Set) return [...v]
      if (v instanceof Uint8Array) return [...v]
      return v
    }),
  ) as unknown
}

/**
 * Every element id `<prefix>_<k>` rebased to a counter from 0, and every anchor's range left out.
 * The ids insert.ts mints (`spnew_<counter>_<clock>`, `picnew_<counter>_<clock>`) carry no uid
 * counter: their clock is the stopped one of the spec, the same on both sides.
 */
function rebase(node: unknown, next: number, ids: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) rebase(item, next, ids)
    return
  }
  if (node === null || typeof node !== 'object') return
  const object = node as Record<string, unknown>
  if ('anchor' in object && typeof object.id === 'string' && !/^(?:spnew|picnew)_[0-9a-z]+_[0-9a-z]+$/.test(object.id)) {
    const m = /^(.*)_([0-9a-z]+)$/.exec(object.id)
    if (m) {
      const id = `${m[1]}_${(parseInt(m[2]!, 36) - next).toString(36)}`
      ids.set(object.id, id)
      object.id = id
    }
  }
  if (object.anchor && typeof object.anchor === 'object') {
    delete (object.anchor as Record<string, unknown>).range
  }
  for (const value of Object.values(object)) rebase(value, next, ids)
}

/** Every string equal to an id `rebase` rewrote, rewritten the same way (an id returned as a value). */
function renameIds(node: unknown, ids: Map<string, string>): unknown {
  if (typeof node === 'string') return ids.get(node) ?? node
  if (Array.isArray(node)) return node.map((item) => renameIds(item, ids))
  if (node === null || typeof node !== 'object') return node
  const object = node as Record<string, unknown>
  for (const [key, value] of Object.entries(object)) object[key] = renameIds(value, ids)
  return object
}

/** The archive of `args.deck` with `text` under `args.textPart`, as a zip `openPptx` reads. */
async function deckBytes(text: string, args: Record<string, unknown>): Promise<Uint8Array> {
  const archive = await PackageArchive.open(Buffer.from(args.deck as string, 'base64'))
  if (typeof args.textPart === 'string') {
    archive.entries.set(args.textPart, new TextEncoder().encode(text))
  }
  const zip = new JSZip()
  for (const [path, bytes] of archive.entries) zip.file(path, bytes)
  return zip.generateAsync({ type: 'uint8array' })
}

/**
 * What `crypto.randomUUID` answers while an operation runs: patching an element's
 * bytes mints its creationId, which must be the same on both sides (the Rust side
 * is DECK_UUID of crates/office-wasm/src/calls/pptx_deck.rs).
 */
const DECK_UUID = '0b8f1c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'

/** `run` with `crypto.randomUUID` answering `uuid` until its promise settles. */
async function withUuid<T>(uuid: string, run: () => Promise<T> | T): Promise<T> {
  const host = globalThis.crypto
  const own = Object.getOwnPropertyDescriptor(host, 'randomUUID')
  Object.defineProperty(host, 'randomUUID', { value: () => uuid, configurable: true, writable: true })
  try {
    return await run()
  } finally {
    if (own) Object.defineProperty(host, 'randomUUID', own)
    else Reflect.deleteProperty(host, 'randomUUID')
  }
}

/**
 * Open the deck of an input, run `op` on it, and answer what both sides
 * compare. What `op` throws is thrown.
 */
export async function deckOp(
  text: string,
  args: Record<string, unknown>,
  op: (opened: OpenedPptx, at: At) => unknown,
): Promise<unknown> {
  const bytes = await deckBytes(text, args)
  const next = nextId()
  const opened = await openPptx(bytes)
  opened.deck.originalHash = 'gate'
  // the archive keeps the hash it was opened with in a field nothing sets: both sides say 'gate'
  const hashed = opened.archive as unknown as { originalHash: string }
  hashed.originalHash = 'gate'
  const before = new Map(opened.archive.entries)
  const at: At = {
    slide: (index) => opened.deck.slides[index]!,
    element: (slide, element) => opened.deck.slides[slide]?.elements[element]?.id ?? '',
  }
  const value = await withUuid(DECK_UUID, () => op(opened, at))
  const after = opened.archive.entries
  const parts: Array<[string, string | null]> = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path)
    const now = after.get(path)
    if (was === now || (was && now && Buffer.from(was).equals(Buffer.from(now)))) continue
    parts.push([path, partValue(path, now)])
  }
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const result = plain({ value, deck: opened.deck, parts, paths: [...after.keys()] }) as Record<
    string,
    unknown
  >
  const ids = new Map<string, string>()
  rebase(result, next, ids)
  result.value = renameIds(result.value, ids)
  return result
}

/** An input of `deckOp`: the deck `name`, and the other arguments of the operation. */
export function deckInput(
  name: string,
  rest: Record<string, unknown> = {},
  textPart?: { part: string; text: string },
): { text?: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = { deck: deckNamed(name), ...rest }
  if (!textPart) return { args }
  return { text: textPart.text, args: { ...args, textPart: textPart.part } }
}
