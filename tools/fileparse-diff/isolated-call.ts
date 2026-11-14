import { readFileSync } from 'node:fs'
import { Engine, failed } from '../docx-diff/engine'
import { SPECS as COMPOUND } from './compound-cases'
import { SPECS as DOCX } from './docx-cases'
import { SPECS as EPUB } from './epub-cases'
import { SPECS as LEGACY } from './legacy-cases'
import { SPECS as PARSE } from './parse-cases'
import { stringifyAsWritten, typescriptOutcome } from './outcome'
import { SPECS as PPTX } from './pptx-cases'
import { SPECS as XLSX } from './xlsx-cases'
import { SPECS as ZIP_TEXT } from './zip-text-cases'
import type { Input } from './spec'
import { HOST_STEPS } from './host-steps'

const [side, fn, wasmPath, engineFn] = process.argv.slice(2)
const wire = JSON.parse(readFileSync(0, 'utf8')) as {
  text?: string
  bytesBase64?: string
  args?: Record<string, unknown>
}
const input: Input = {
  label: 'isolated child',
  text: wire.text,
  args: wire.args,
  ...(wire.bytesBase64 === undefined ? {} : { bytes: Buffer.from(wire.bytesBase64, 'base64') }),
}
if (side === 'rust') {
  const { header } = Engine.load(wasmPath!, HOST_STEPS).call(
    { cmd: 'fileParse', function: engineFn, text: input.text ?? '', args: input.args ?? {} },
    input.bytes === undefined ? [] : [input.bytes],
  )
  // a host failure is a reader that did not answer, as in the parent
  if (failed(header) && 'code' in header.error)
    throw new Error(`WASM command failed: ${header.error.message}`)
  // not JSON.stringify: an object moves its integer keys first, and the order Rust wrote is compared
  console.log(stringifyAsWritten(header))
} else if (side === 'typescript') {
  const spec = [
    ...DOCX,
    ...PPTX,
    ...XLSX,
    ...ZIP_TEXT,
    ...COMPOUND,
    ...LEGACY,
    ...PARSE,
    ...EPUB,
  ].find((spec) => spec.fn === fn)
  if (!spec) throw new Error(`No isolated reference function ${fn}`)
  console.log(JSON.stringify(await typescriptOutcome(spec, input)))
} else {
  throw new Error(`Unknown isolated side ${side}`)
}
