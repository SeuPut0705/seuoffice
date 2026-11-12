import { isDeepStrictEqual } from 'node:util'
import { type BodyScan, scanBody } from './reference/scan'
import { failed } from './engine'
import { engine, excerpt } from './harness'
import { keyOrderDifference } from './key-order'

export type ScanOutcome = { scan: BodyScan } | { error: string }

const encoder = new TextEncoder()

export function rustScan(documentXml: Uint8Array): ScanOutcome {
  const { header } = engine.call<{ scan: BodyScan }>({ cmd: 'scanBody' }, [documentXml])
  return failed(header) ? { error: header.error.message } : header
}

/** Offsets on both sides are JavaScript string indices; error messages must match too. */
export function compareScan(
  where: string,
  documentXml: string,
): { typescript: ScanOutcome; difference: string | null; keyOrderOnly?: boolean } {
  let typescript: ScanOutcome
  try {
    typescript = { scan: scanBody(documentXml) }
  } catch (error) {
    typescript = { error: (error as Error).message }
  }
  const rust = rustScan(encoder.encode(documentXml))
  if (isDeepStrictEqual(typescript, rust)) {
    const order = keyOrderDifference('scanBody', typescript, rust)
    return order === null
      ? { typescript, difference: null }
      : { typescript, difference: `${where}\n      ${order}`, keyOrderOnly: true }
  }

  let detail = `typescript ${JSON.stringify(typescript).slice(0, 300)}\n      rust       ${JSON.stringify(rust).slice(0, 300)}`
  if ('scan' in typescript && 'scan' in rust) {
    const index = typescript.scan.elements.findIndex(
      (element, i) => !isDeepStrictEqual(element, rust.scan.elements[i]),
    )
    if (index !== -1) {
      const element = typescript.scan.elements[index]!
      detail =
        `element ${index}: typescript ${JSON.stringify(element)}, rust ${JSON.stringify(rust.scan.elements[index])}\n` +
        `      near ${excerpt(documentXml, element.start)}`
    }
  }
  return { typescript, difference: `${where}\n      ${detail}` }
}
