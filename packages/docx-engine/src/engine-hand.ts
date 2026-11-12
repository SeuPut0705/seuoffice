// The exports of this package that the binding does not make with one
// `invoke` of positional arguments: the three whole-document commands (a model
// and bytes), `scanBody`, the two-pass parse that waits for the host's media
// converters, and the functions that read or write a JSZip. The generated
// modules call them as `hand.<name>` / `zipCall`; their TypeScript signatures
// stay where they were declared.
import type JSZip from 'jszip'
import { altChunkHtmlConverter } from './alt-chunk'
import {
  type Answered,
  type Owed,
  callEngine,
  ensureEngine,
  invokeRaw,
  jsonOf,
  modelJson,
  revive,
  sameBytesAs,
  text,
  utf8,
  type InvokeOptions,
} from './engine'
import { SHAPES } from './engine-shapes'
import { metafileToDataUrl } from './metafile'
import { tiffToDataUrlAsync } from './tiff'

interface ParseReply {
  model: boolean
  pending?: Owed[]
  warnings?: string[]
}

interface CommandReply {
  warnings?: string[]
}

function warnAll(warnings: string[] | undefined): void {
  for (const message of warnings ?? []) console.warn(message)
}

/** What a `resolved` entry of the next pass carries: null, a string or a request blob. */
async function converted(item: Owed, input: Uint8Array): Promise<string | Uint8Array | null> {
  if (item.kind === 'metafile') return metafileToDataUrl(input, item.mime ?? '')
  if (item.kind === 'tiff') return tiffToDataUrlAsync(input)
  const convert = altChunkHtmlConverter()
  return convert ? convert(text(input)) : null
}

/**
 * `parseDocx`: the engine parses; where it meets a picture or a chunk the host
 * must convert it answers what it owes, the host converts, and the engine
 * parses again with the answers until it owes nothing.
 */
export async function parseDocx(
  bytes: Uint8Array,
  options: object = {},
): Promise<unknown> {
  ensureEngine()
  const resolved: Record<string, string | null | { $blob: number }> = {}
  const resolvedBlobs: Uint8Array[] = []
  const hostConverts = altChunkHtmlConverter() !== null
  for (;;) {
    const header = {
      cmd: 'parseDocx',
      options,
      altChunkConverter: hostConverts,
      resolved,
      blobRefs: true,
    }
    const reply = callEngine<ParseReply>(header, [bytes, ...resolvedBlobs])
    warnAll(reply.header.warnings)
    const owed = reply.header.pending ?? []
    if (!owed.length)
      return revive(JSON.parse(text(reply.blobs[0]!)), reply.blobs, SHAPES.parseDocx, bytes)
    await answerOwed(owed, reply.blobs, resolved, resolvedBlobs, 1)
  }
}

/** The host's answers to what the engine owes: each one is null, a string, or bytes after the `first` request blobs. */
async function answerOwed(
  owed: readonly Owed[],
  replyBlobs: readonly Uint8Array[],
  resolved: Record<string, string | null | { $blob: number }>,
  resolvedBlobs: Uint8Array[],
  first: number,
): Promise<void> {
  for (const item of owed) {
    const answer = await converted(item, replyBlobs[item.blob]!)
    if (answer === null || typeof answer === 'string') resolved[item.id] = answer
    else {
      resolved[item.id] = { $blob: first + resolvedBlobs.length }
      resolvedBlobs.push(answer)
    }
  }
}

/** `saveDocx(parsed, finalBlocks, options)`: the model and the original docx go as they are, the blocks and options as JSON. */
export async function saveDocx(
  parsed: { internal: { originalBytes: Uint8Array } },
  finalBlocks: unknown[],
  options: unknown = {},
): Promise<Uint8Array> {
  ensureEngine()
  const header = {
    cmd: 'saveDocx',
    blocks: jsonOf(finalBlocks),
    options: jsonOf(options) ?? {},
    nowMs: Date.now(),
  }
  const reply = callEngine<CommandReply>(header, [
    parsed.internal.originalBytes,
    utf8(modelJson(parsed)),
  ])
  warnAll(reply.header.warnings)
  return sameBytesAs(reply.blobs[0]!, [parsed.internal.originalBytes]) as Uint8Array
}

interface ParsedForCompare {
  internal: { originalBytes: Uint8Array }
}

/** `compareDocuments(original, revised, options)`: the redline docx and its summary. */
export async function compareDocuments(
  original: ParsedForCompare,
  revised: ParsedForCompare,
  options: unknown = {},
): Promise<{ bytes: Uint8Array; summary: unknown }> {
  ensureEngine()
  const header = { cmd: 'compareDocuments', options: jsonOf(options) ?? {}, nowMs: Date.now() }
  const reply = callEngine<CommandReply>(header, [
    original.internal.originalBytes,
    utf8(modelJson(original)),
    revised.internal.originalBytes,
    utf8(modelJson(revised)),
  ])
  warnAll(reply.header.warnings)
  return { bytes: reply.blobs[0]!, summary: JSON.parse(text(reply.blobs[1]!)) }
}

/** `scanBody(documentXml)` */
export function scanBody(documentXml: string): unknown {
  ensureEngine()
  return callEngine<{ scan: unknown }>({ cmd: 'scanBody' }, [utf8(documentXml)]).header.scan
}

// ---------------------------------------------------------------- a JSZip argument

const TEXT_PART = /\.(?:xml|rels|vml|txt|json)$/i

/** The parts of a zip as the engine reads them: `[name, text]` for XML, `[name, bytes]` for the rest. */
async function zipParts(zip: JSZip): Promise<Array<[string, string | Uint8Array]>> {
  const out: Array<[string, string | Uint8Array]> = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    out.push([
      name,
      TEXT_PART.test(name) ? await file.async('string') : await file.async('uint8array'),
    ])
  }
  return out
}

/**
 * An export that takes a JSZip: the engine reads the parts it sends, and for a
 * function that writes into the zip answers the parts it changed (`$parts`,
 * null for a part removed) next to its value (`$result`).
 */
export async function zipCall(
  fn: string,
  zip: JSZip,
  args: readonly unknown[],
  mutates: boolean,
  options: InvokeOptions = {},
): Promise<unknown> {
  const parts = await zipParts(zip)
  const { shape, ...rest } = options
  const asked: Answered = {
    resolved: {},
    blobs: [],
    altChunkConverter: altChunkHtmlConverter() !== null,
  }
  for (;;) {
    // the blobs of the arguments come first: how many is known once the arguments are encoded
    const raw = invokeRaw(fn, [parts, ...args], mutates ? rest : options, asked)
    if (!raw.owed.length) {
      if (!mutates) return raw.value
      const done = raw.value as {
        $result: unknown
        $parts: Array<[string, string | Uint8Array | null]>
      }
      for (const [name, content] of done.$parts) {
        if (content === null) zip.remove(name)
        else zip.file(name, content)
      }
      return revive(done.$result, [], shape)
    }
    await answerOwed(raw.owed, raw.blobs, asked.resolved, asked.blobs, 0)
  }
}
