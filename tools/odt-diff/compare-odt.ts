// Comparisons (a) to (d): the four wire commands of crates/office-wasm/src/odt.rs
// against the public functions of packages/odt-engine, over the same inputs.
//
//   odtToDocx   in: blob 0 the ODT; { now }.   out: { report }, blob 0 the docx, blob 1 the bridge JSON
//   saveOdt     in: blobs the ODT, the bridge JSON, the edited docx; { now }.
//                                     out: { unchanged }, blob 0 the ODT unless unchanged
//   docxToOdt   in: blob 0 the docx; { rendered: [[key, { widthEmu, heightEmu, blob }]], now }, the PNGs as blobs 1...
//                                     out: { report }, blob 0 the ODT
//   odtToText   in: blob 0 the ODT.   out: { text }
//   a failure is { error: { code, message } }
//
// What is compared. A zip is read entry by entry (zip-compare.ts): names, order,
// every header field, the CRC and the inflated bytes; only the deflated bytes
// of an entry the writer deflated itself, and what follows from their length,
// may differ. The bridge is compared as the JSON text Rust wrote against
// `JSON.stringify` of the TypeScript map, then by value and key order, to say
// what differs. A report is compared by value and key order. An open error is
// compared by its code.
import { isDeepStrictEqual } from 'node:util'
import { failed, type EngineFailure } from '../docx-diff/engine'
import { Comparison, engine } from '../docx-diff/harness'
import { keyOrderDifferences, parseKeepingOrder } from '../docx-diff/key-order'
import { NOW } from './clock'
import { compareZips, copiedEntries } from './zip-compare'
import {
  isFailure,
  type RenderedList,
  tsDocxToOdt,
  tsOdtToDocx,
  tsOdtToText,
  tsSaveOdt,
  type TsOpened,
  type WireError,
} from './ts-side'

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

interface Reply<Header> {
  header: Header
  blobs: Uint8Array[]
}

/**
 * The positive control (`ODT_DIFF_CONTROL=1`, run by faults.mjs): every reply
 * of the Rust side is changed before it is compared, each compared value on its
 * own, so that every comparison line must show differences. A refusal gets
 * another code; a text, a report, and each blob (its last byte) are altered;
 * the `unchanged` flag of a save is flipped on some of the calls and the saved
 * ODT altered on the others (the flag would otherwise end the comparison of
 * the ODT). The (f) outcomes are altered in main.ts (`controlProps`).
 */
export const CONTROL = process.env.ODT_DIFF_CONTROL === '1'

let controlCalls = 0

function perturbed<Header extends object>(reply: Reply<Header>, command: object): Reply<Header> {
  const header = { ...(reply.header as Record<string, unknown>) }
  if (typeof header.text === 'string') header.text += '!'
  if (Array.isArray(header.report))
    header.report = [...header.report, { kind: 'control', feature: 'control', count: 1 }]
  // a save: the flag on one call in three, the bytes on the others
  const flipFlag =
    cmd(command) !== 'saveOdt' || (Math.imul(++controlCalls, 2654435761) >>> 0) % 3 === 0
  if (typeof header.unchanged === 'boolean' && cmd(command) === 'saveOdt' && flipFlag)
    header.unchanged = !header.unchanged
  const blobs = reply.blobs.map((blob) => {
    const copy = blob.slice()
    if (copy.length > 0 && !(cmd(command) === 'saveOdt' && flipFlag))
      copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff
    return copy
  })
  return { header: header as Header, blobs }
}

const cmd = (command: object): string => (command as { cmd: string }).cmd

/** One wire call; a trap of the module is an error like any other, with the code `trap`. */
function rustCall<Header extends object>(
  command: object,
  blobs: Uint8Array[],
): Reply<Header> | WireError {
  try {
    const reply = engine.call<Header>(command, blobs)
    if (failed(reply.header)) {
      const error = (reply.header as EngineFailure).error
      return { error: CONTROL ? { ...error, code: 'control' } : error }
    }
    const ok = { header: reply.header as Header, blobs: reply.blobs }
    return CONTROL ? perturbed(ok, command) : ok
  } catch (error) {
    return { error: { code: 'trap', message: String(error) } }
  }
}

const isError = (reply: Reply<unknown> | WireError): reply is WireError => 'error' in reply

/** The text around the first code unit where two texts differ. */
function firstDifference(typescript: string, rust: string): string {
  const shared = Math.min(typescript.length, rust.length)
  let at = 0
  while (at < shared && typescript.charCodeAt(at) === rust.charCodeAt(at)) at += 1
  const around = (text: string): string => JSON.stringify(text.slice(Math.max(0, at - 60), at + 60))
  return (
    `first difference at code unit ${at} (lengths ${typescript.length} and ${rust.length})\n` +
    `      typescript ${around(typescript)}\n      rust       ${around(rust)}`
  )
}

/** `null` where the code of the two errors is the same. */
function errorDifference(typescript: WireError, rust: WireError): string | null {
  return typescript.error.code === rust.error.code
    ? null
    : `TypeScript refuses with ${typescript.error.code} (${typescript.error.message.slice(0, 120)}), Rust with ${rust.error.code} (${rust.error.message.slice(0, 120)})`
}

/** A value from the TypeScript side, as the Rust reply has it: through JSON. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** `null` where the two values are equal with the same key order, else what differs. */
function valueDifference(what: string, typescript: unknown, rust: unknown): string | null {
  const same = asJson(typescript)
  if (!isDeepStrictEqual(same, rust))
    return `${what} differs\n      typescript ${JSON.stringify(same).slice(0, 400)}\n      rust       ${JSON.stringify(rust).slice(0, 400)}`
  const order = keyOrderDifferences(same, rust)
  return order.length === 0
    ? null
    : `${what}: key order differs at ${order[0]!.path}: TypeScript ${order[0]!.typescript.join()}, Rust ${order[0]!.rust.join()}`
}

export interface Comparisons {
  /** the open errors and the opened ODTs, by code or by what follows */
  open: Comparison
  docx: Comparison
  /** the docx of the mutated ODTs that open */
  docxMutated: Comparison
  bridge: Comparison
  report: Comparison
  saveResult: Comparison
  saveEntries: Comparison
  exportRendered: Comparison
  text: Comparison
}

export function makeComparisons(): Comparisons {
  return {
    open: new Comparison('(a) odtToDocx: opens or refuses alike', 'open'),
    docx: new Comparison('(a) odtToDocx: the bridge docx, entries', 'openDocx'),
    docxMutated: new Comparison('(a+) odtToDocx: mutated ODTs, docx entries', 'openMutatedDocx'),
    bridge: new Comparison('(a) odtToDocx: the bridge JSON as written', 'openBridge'),
    report: new Comparison('(a) odtToDocx: the report', 'openReport'),
    saveResult: new Comparison('(b) saveOdt: unchanged or not, or the refusal', 'saveResult'),
    saveEntries: new Comparison('(b) saveOdt: the saved ODT, entries', 'saveEntries'),
    exportRendered: new Comparison('(c) docxToOdt: with rendered objects', 'exportRendered'),
    text: new Comparison('(d) odtToText: the text, or the refusal', 'text'),
  }
}

/** (a) and (d) over one ODT. Returns what the TypeScript side opened, for the edits. */
export async function compareOpen(
  c: Comparisons,
  where: string,
  odt: Uint8Array,
  mutated = false,
): Promise<TsOpened | null> {
  const typescript = await tsOdtToDocx(odt)
  const rust = rustCall<{ report: unknown }>({ cmd: 'odtToDocx', now: NOW }, [odt])
  if (isFailure(typescript) || isError(rust)) {
    let difference: string | null
    if (isFailure(typescript) && isError(rust)) difference = errorDifference(typescript, rust)
    else if (isFailure(typescript))
      difference = `TypeScript refuses (${typescript.error.code}: ${typescript.error.message.slice(0, 120)}), Rust opens it`
    else
      difference = `Rust refuses (${(rust as WireError).error.code}: ${(rust as WireError).error.message.slice(0, 120)}), TypeScript opens it`
    c.open.record(difference === null ? null : `${where}: ${difference}`)
    await compareText(c, where, odt)
    return null
  }
  c.open.record(null)
  const { docx, bridgeJson, bridge, report } = typescript.value
  const rustDocx = rust.blobs[0]
  const rustBridge = rust.blobs[1]
  if (!rustDocx || !rustBridge) {
    ;(mutated ? c.docxMutated : c.docx).record(
      `${where}: the reply has ${rust.blobs.length} blobs, expected 2`,
    )
  } else {
    const zip = compareZips(docx, rustDocx)
    ;(mutated ? c.docxMutated : c.docx).record(zip === null ? null : `${where}: ${zip}`)
    const rustText = decoder.decode(rustBridge)
    if (rustText === bridgeJson) c.bridge.record(null)
    else {
      let rustValue: unknown
      try {
        rustValue = parseKeepingOrder(rustText)
      } catch (error) {
        rustValue = undefined
        c.bridge.record(`${where}: the bridge JSON of Rust does not parse (${String(error)})`)
      }
      if (rustValue !== undefined) {
        const same = asJson(bridge)
        const order = isDeepStrictEqual(same, rustValue) ? keyOrderDifferences(same, rustValue) : []
        const detail = !isDeepStrictEqual(same, rustValue)
          ? `the maps differ\n      ${firstDifference(bridgeJson, rustText)}`
          : order.length > 0
            ? `key order differs at ${order[0]!.path}: TypeScript ${order[0]!.typescript.join()}, Rust ${order[0]!.rust.join()}`
            : `equal as values, written differently\n      ${firstDifference(bridgeJson, rustText)}`
        c.bridge.record(
          `${where}: ${detail}`,
          order.length > 0 && isDeepStrictEqual(same, rustValue),
        )
      }
    }
  }
  const reportDifference = valueDifference('report', report, rust.header.report)
  c.report.record(reportDifference === null ? null : `${where}: ${reportDifference}`)
  await compareText(c, where, odt)
  return typescript.value
}

/** (d) `odtToText`. */
async function compareText(c: Comparisons, where: string, odt: Uint8Array): Promise<void> {
  const typescript = await tsOdtToText(odt)
  const rust = rustCall<{ text: string }>({ cmd: 'odtToText' }, [odt])
  let difference: string | null = null
  if (isFailure(typescript) && isError(rust)) difference = errorDifference(typescript, rust)
  else if (isFailure(typescript))
    difference = `TypeScript refuses (${typescript.error.code}), Rust reads it`
  else if (isError(rust))
    difference = `Rust refuses (${rust.error.code}: ${rust.error.message.slice(0, 120)}), TypeScript reads it`
  else if (typescript.value !== rust.header.text)
    difference = firstDifference(typescript.value, rust.header.text)
  c.text.record(difference === null ? null : `${where}: ${difference}`)
}

/** (b) `saveOdt`: both engines save the same edited docx over the same bridge. */
export async function compareSave(
  c: Comparisons,
  where: string,
  odt: Uint8Array,
  bridgeJson: string,
  edited: Uint8Array,
): Promise<void> {
  const typescript = await tsSaveOdt(odt, bridgeJson, edited)
  const encoder = new TextEncoder()
  const rust = rustCall<{ unchanged: boolean }>({ cmd: 'saveOdt', now: NOW }, [
    odt,
    encoder.encode(bridgeJson),
    edited,
  ])
  if (isFailure(typescript) || isError(rust)) {
    let difference: string
    if (isFailure(typescript) && isError(rust)) difference = errorDifference(typescript, rust) ?? ''
    else if (isFailure(typescript))
      difference = `TypeScript refuses (${typescript.error.code}: ${typescript.error.message.slice(0, 160)}), Rust saves`
    else
      difference = `Rust refuses (${(rust as WireError).error.code}: ${(rust as WireError).error.message.slice(0, 160)}), TypeScript saves`
    c.saveResult.record(difference === '' ? null : `${where}: ${difference}`)
    return
  }
  const { unchanged, bytes } = typescript.value
  if (unchanged !== rust.header.unchanged) {
    c.saveResult.record(
      `${where}: TypeScript ${unchanged ? 'returns the original' : 'saves'}, Rust ${rust.header.unchanged ? 'returns the original' : 'saves'}`,
    )
    return
  }
  c.saveResult.record(null)
  if (unchanged || bytes === null) return
  const rustBytes = rust.blobs[0]
  if (!rustBytes) {
    c.saveEntries.record(`${where}: Rust saved but sent no ODT`)
    return
  }
  const zip = compareZips(bytes, rustBytes, copiedEntries(bytes, odt))
  c.saveEntries.record(zip === null ? null : `${where}: ${zip}`)
}

/** (c) `docxToOdt`, plain or with rendered objects. */
export async function compareExport(
  comparison: Comparison,
  where: string,
  docx: Uint8Array,
  rendered?: RenderedList,
): Promise<Uint8Array | null> {
  const typescript = await tsDocxToOdt(docx, rendered)
  const blobs = [docx, ...(rendered ?? []).map(([, object]) => object.png)]
  const rust = rustCall<{ report: unknown }>(
    {
      cmd: 'docxToOdt',
      now: NOW,
      rendered: (rendered ?? []).map(([key, object], index) => [
        key,
        { widthEmu: object.widthEmu, heightEmu: object.heightEmu, blob: index + 1 },
      ]),
    },
    blobs,
  )
  if (isFailure(typescript) || isError(rust)) {
    let difference: string | null
    if (isFailure(typescript) && isError(rust)) difference = errorDifference(typescript, rust)
    else if (isFailure(typescript))
      difference = `TypeScript refuses (${typescript.error.code}: ${typescript.error.message.slice(0, 160)}), Rust converts`
    else
      difference = `Rust refuses (${(rust as WireError).error.code}: ${(rust as WireError).error.message.slice(0, 160)}), TypeScript converts`
    comparison.record(difference === null ? null : `${where}: ${difference}`)
    return null
  }
  const rustOdt = rust.blobs[0]
  let difference: string | null
  if (!rustOdt) difference = 'Rust converted but sent no ODT'
  else
    difference =
      compareZips(typescript.value.odt, rustOdt) ??
      valueDifference('report', typescript.value.report, rust.header.report)
  comparison.record(difference === null ? null : `${where}: ${difference}`)
  return typescript.value.odt
}
