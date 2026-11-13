import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The engine run as CommonJS (a script whose entry tsx compiles to CommonJS,
 * as a developer's tool may be) decodes a legacy multi-byte chunk as the
 * Encoding Standard says. There `require` and `import()` load two instances
 * of the decoder package, and the charset tables register on the one
 * `import()` returned: decoding with the other gave windows-1252 text.
 */

const ALT_CHUNK = resolve(__dirname, '../src/alt-chunk.ts')
// what the package's `node` entries import first: the engine, started from the build
const ENGINE_NODE = resolve(__dirname, '../../engine-wasm/src/node.ts')
const TSX = createRequire(__filename).resolve('tsx/cjs')

describe('a legacy multi-byte chunk read by the engine running as CommonJS', () => {
  it('decodes as the Encoding Standard says', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seuoffice-alt-chunk-cjs-'))
    try {
      const script = join(dir, 'decode.cts')
      writeFileSync(
        script,
        `require(${JSON.stringify(ENGINE_NODE)})\n` +
          `const { decodeHtmlBytes } = require(${JSON.stringify(ALT_CHUNK)})\n` +
          'const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))\n' +
          'const html = ascii(\'<html><head><meta charset="euc-kr"></head><body><p>\')\n' +
          "const bytes = Uint8Array.from([...html, 0x8c, 0x63, ...ascii('</p></body></html>')])\n" +
          'decodeHtmlBytes(bytes).then((out) => process.stdout.write(/<p>(.*)<\\/p>/.exec(out)[1]))\n',
      )
      const out = execFileSync(process.execPath, ['--require', TSX, script], {
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(out).toBe('\uB620')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
