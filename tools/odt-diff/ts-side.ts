// The TypeScript side of the four wire commands (comparisons (a) to (d)): each
// public function of packages/odt-engine under the frozen clock, with what it
// throws read as the wire reads it: `{ error: { code, message } }`, where the
// code is an open error's own and `thrown` for any other Error.
import { withClock } from './clock'
import * as ts from './ts'

export interface WireError {
  error: { code: string; message: string }
}

export interface TsOpened {
  docx: Uint8Array
  bridge: ts.BridgeMap
  /** the bridge as the wire carries it: `JSON.stringify` of the map */
  bridgeJson: string
  report: ts.ConversionReport
}

export interface TsSaved {
  unchanged: boolean
  bytes: Uint8Array | null
  report: unknown
}

export interface TsExported {
  odt: Uint8Array
  report: ts.ConversionReport
}

export type Outcome<T> = { value: T } | WireError

export const isFailure = <T>(outcome: Outcome<T>): outcome is WireError => 'error' in outcome

function failure(error: unknown): WireError {
  if (ts.isOdtOpenError(error)) return { error: { code: error.code, message: error.message } }
  return {
    error: { code: 'thrown', message: error instanceof Error ? error.message : String(error) },
  }
}

async function guarded<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  // the engine warns about what it degrades; on mutated input that is thousands of lines
  const { warn, error: logError } = console
  console.warn = console.error = () => {}
  try {
    return { value: await withClock(run) }
  } catch (error) {
    return failure(error)
  } finally {
    console.warn = warn
    console.error = logError
  }
}

export const tsOdtToDocx = (odt: Uint8Array): Promise<Outcome<TsOpened>> =>
  guarded(async () => {
    const { docxBytes, bridge, report } = await ts.odtToDocx(odt)
    return { docx: docxBytes, bridge, bridgeJson: JSON.stringify(bridge), report }
  })

export const tsSaveOdt = (
  originalOdt: Uint8Array,
  bridgeJson: string,
  editedDocx: Uint8Array,
): Promise<Outcome<TsSaved>> =>
  guarded(async () => {
    const { odtBytes, report } = await ts.saveOdt({
      originalOdt,
      bridge: JSON.parse(bridgeJson) as ts.BridgeMap,
      editedDocx,
    })
    return odtBytes === originalOdt
      ? { unchanged: true, bytes: null, report }
      : { unchanged: false, bytes: odtBytes, report }
  })

export type RenderedList = Array<
  [key: string, object: { png: Uint8Array; widthEmu: number; heightEmu: number }]
>

export const tsDocxToOdt = (
  docx: Uint8Array,
  rendered?: RenderedList,
): Promise<Outcome<TsExported>> =>
  guarded(async () => {
    const { odtBytes, report } = await ts.docxToOdt(
      docx,
      rendered ? { renderedObjects: new Map(rendered) } : {},
    )
    return { odt: odtBytes, report }
  })

export const tsOdtToText = (odt: Uint8Array): Promise<Outcome<string>> =>
  guarded(() => ts.odtToText(odt))
