// The public functions of the package over the Rust engine (crates/odt-engine,
// through the wasm of crates/office-wasm): the commands `odtToDocx`,
// `saveOdt`, `docxToOdt`, `odtToText` (crates/odt-engine/C3-PLAN.md, "The
// wire") and `invoke` of `odt.<name>` for the small exports. The engine is
// started by the host (engine-init of @seuoffice/docx-engine, or the `node`
// export condition); this module only refuses to call one that is not.
import {
  EngineError,
  engineCall,
  engineErrorOf,
  engineInvoke,
  engineReady,
  type EngineReply,
} from '@seuoffice/engine-wasm'
import { OdtEncryptedError, OdtNotTextError, OdtOpenError } from './errors'
import type {
  BridgeMap,
  ConversionReport,
  DocxToOdtOptions,
  DocxToOdtResult,
  NestedStep,
  ObjectKind,
  OdtToDocxResult,
  ProtectedCellRef,
  RenderedObject,
  SaveOdtInput,
  SaveOdtResult,
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function ensureEngine(): void {
  if (!engineReady()) {
    throw new Error(
      'the odt engine is not started: await initDocxEngine(url) (a page or worker) or initDocxEngineSync(bytes) once before the first call; under the `node` export condition it starts itself',
    )
  }
}

/** `OdtNotTextError`'s media type, from the message the engine writes: `(media type missing)` or `(media type "...")`. */
function mediaTypeOf(message: string): string | null {
  const found = /\(media type (missing|".*")\)$/.exec(message)
  return found === null || found[1] === 'missing' ? null : (JSON.parse(found[1]!) as string)
}

/** The error the TypeScript engine threw where the Rust one refuses: the open errors by their code. */
function odtErrorOf(error: EngineError): Error {
  switch (error.code) {
    case 'encrypted':
      return new OdtEncryptedError(error.message)
    case 'not-odt-text':
      return new OdtNotTextError(mediaTypeOf(error.message))
    case 'zip-rejected':
    case 'corrupt':
      return new OdtOpenError(error.code, error.message)
    default:
      return engineErrorOf(error)
  }
}

function call<Header extends object>(
  command: object,
  blobs: readonly Uint8Array[],
): EngineReply<Header> {
  ensureEngine()
  try {
    return engineCall<Header>(command, blobs)
  } catch (error) {
    throw error instanceof EngineError ? odtErrorOf(error) : error
  }
}

/** The host's clock: the zip entries the engine writes are dated with it, in local time. */
function now(): { ms: number; offsetMinutes: number } {
  const date = new Date()
  return { ms: date.getTime(), offsetMinutes: date.getTimezoneOffset() }
}

export async function odtToDocx(odtBytes: Uint8Array): Promise<OdtToDocxResult> {
  const reply = call<{ report: ConversionReport }>({ cmd: 'odtToDocx', now: now() }, [odtBytes])
  return {
    docxBytes: reply.blobs[0]!,
    bridge: JSON.parse(decoder.decode(reply.blobs[1]!)) as BridgeMap,
    report: reply.header.report,
  }
}

export async function saveOdt({
  originalOdt,
  bridge,
  editedDocx,
}: SaveOdtInput): Promise<SaveOdtResult> {
  const reply = call<{ unchanged: boolean; report: ConversionReport }>(
    { cmd: 'saveOdt', now: now() },
    [originalOdt, encoder.encode(JSON.stringify(bridge)), editedDocx],
  )
  // no edit: the very bytes it was given
  return {
    odtBytes: reply.header.unchanged ? originalOdt : reply.blobs[0]!,
    report: reply.header.report,
  }
}

export async function docxToOdt(
  docxBytes: Uint8Array,
  options: DocxToOdtOptions = {},
): Promise<DocxToOdtResult> {
  const given = options.renderedObjects
  const objects: Array<[string, RenderedObject]> =
    given === undefined ? [] : given instanceof Map ? [...given] : Object.entries(given)
  const rendered = objects.map(([key, object], index) => [
    key,
    { widthEmu: object.widthEmu, heightEmu: object.heightEmu, blob: index + 1 },
  ])
  const reply = call<{ report: ConversionReport }>({ cmd: 'docxToOdt', rendered, now: now() }, [
    docxBytes,
    ...objects.map(([, object]) => object.png),
  ])
  return { odtBytes: reply.blobs[0]!, report: reply.header.report }
}

export async function odtToText(odtBytes: Uint8Array): Promise<string> {
  return call<{ text: string }>({ cmd: 'odtToText' }, [odtBytes]).header.text
}

/** `odt.<name>` of `invoke`, with the TypeScript arguments. */
function invoke(name: string, args: readonly unknown[]): unknown {
  ensureEngine()
  return engineInvoke(name, args, { fnPrefix: 'odt.' })
}

/** Of a bridge map, what the protected-cell readers read: `ext.table`. */
const tableExtOf = (map: Pick<BridgeMap, 'ext'>): { ext: { table?: unknown } } => ({
  ext: map.ext.table === undefined ? {} : { table: map.ext.table },
})

/** Every cell Hancom locked, as published by the table layer (empty when none). */
export function protectedCellsOf(map: Pick<BridgeMap, 'ext'>): ProtectedCellRef[] {
  return invoke('protectedCellsOf', [tableExtOf(map)]) as ProtectedCellRef[]
}

/**
 * Whether a cell is locked. Address it by grid position (`col`) or by its
 * `w:tc` index in the row (`tc`), in the top-level table whose `w:tbl` is
 * bridge element `table`, through `path` for nested tables.
 */
export function isProtectedCell(
  map: Pick<BridgeMap, 'ext'>,
  cell: { table: number; path?: readonly NestedStep[]; row: number } & (
    { col: number } | { tc: number }
  ),
): boolean {
  return invoke('isProtectedCell', [tableExtOf(map), cell]) as boolean
}

/** `{ id, kind }` of a placeholder `wp:docPr` name, or null. */
export function parseKeepName(name: string): { id: string; kind: ObjectKind } | null {
  return invoke('parseKeepName', [name]) as { id: string; kind: ObjectKind } | null
}
