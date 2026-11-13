// The host the TypeScript engine runs on in this gate. Imported before
// anything of the engine, by harness.ts.
//
// The engine answers with its host in a few places: the text of a failed
// inflate, Intl.Locale, and what the zip gate's DecompressionStream does with
// bytes that follow the end of a deflate stream. The fixtures, the ledger and
// the Rust hold the answers of one Node major, so the gate stops on another.
import { createInflateRaw } from 'node:zlib'

// `Date.parse` reads a date-time without a zone as local time, so the engine
// answers with the zone of its host there: the gate runs in UTC, as the
// runners do, and an entry of divergences.json names another zone itself.
process.env.TZ = 'UTC'

const NODE_MAJOR = 22
if (Number(process.versions.node.split('.')[0]) !== NODE_MAJOR) {
  console.error(
    `docx-diff runs on Node ${NODE_MAJOR}, the host its answers were taken on; this is ${process.version}. ` +
      'tools/docx-diff/heavy.sh puts it on the PATH.',
  )
  process.exit(2)
}

/** Set to `1`, the engine runs on Node as it is: what divergences.json lists under `host: node`. */
export const RAW_HOST_ENV = 'DOCX_DIFF_RAW_HOST'

const Native = globalThis.DecompressionStream

/**
 * `DecompressionStream` as the product's hosts have it for bytes after the
 * end of a deflate stream. The Compression Streams standard makes them an
 * error and Chromium 151 rejects with this TypeError; Node 22 reads past them
 * (Node 26 rejects too). The product runs in Chromium, and the decision is
 * that the port gives the product's result, so the comparison needs a host
 * that does.
 *
 * Everything else is Node's own stream, untouched: its output, its chunks and
 * its errors pass through. A second inflater reads the same input only to
 * learn how much of it the stream took, and the rejection comes once Node's
 * stream has ended without one of its own, so what the stream held is
 * delivered first. Chromium may reject before all of it arrived; that order is
 * not mirrored.
 */
class RefusingBytesAfterTheStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(format: CompressionFormat) {
    const native = new Native(format) as unknown as TransformStream<Uint8Array, Uint8Array>
    if (format !== 'deflate-raw') {
      this.readable = native.readable
      this.writable = native.writable
      return
    }
    const probe = createInflateRaw()
    // the executor form: this tsconfig's lib has no Promise.withResolvers
    const closed = new Promise<void>((resolve) => probe.once('close', resolve))
    probe.on('data', () => {})
    // damaged data is Node's stream to report
    probe.on('error', () => {})
    let fed = 0
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        fed += chunk.byteLength
        if (!probe.destroyed && !probe.writableEnded) probe.write(chunk)
        controller.enqueue(chunk)
      },
    })
    // a failure of Node's stream reaches the reader through `readable`
    counted.readable.pipeTo(native.writable).catch(() => {})
    this.writable = counted.writable
    this.readable = native.readable.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async flush() {
          probe.end()
          await closed
          // bytesWritten: the input the inflater took before its stream ended
          if (probe.bytesWritten < fed) {
            throw new TypeError('Junk found after end of compressed data.')
          }
        },
      }),
    )
  }
}

if (process.env[RAW_HOST_ENV] !== '1') {
  globalThis.DecompressionStream =
    RefusingBytesAfterTheStream as unknown as typeof DecompressionStream
}
