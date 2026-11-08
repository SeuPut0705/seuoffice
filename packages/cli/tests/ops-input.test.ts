import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_TRANSFER_BYTES } from '../src/mcp/files'
import { MAX_OPS_BYTES, readOpsInput, readOpsStream } from '../src/ops-input'
import { EXIT } from '../src/result'

/** Small cap so the over-limit paths run without writing MAX_OPS_BYTES to disk. */
const TEST_CAP = 1024
/** readOpsStream reads 1 MiB at a time; a cap just past one chunk makes the second read overflow. */
const PAST_ONE_CHUNK_CAP = 1024 * 1024 + 1024

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-ops-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ctx(cwd: string) {
  return { cwd, env: { ...process.env, GENOFFICE_ALLOWED_ROOTS: '' } }
}

function fileOf(dir: string, name: string, text: string): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

function readStreamFile(file: string, cap?: number): string {
  const fd = openSync(file, 'r')
  try {
    return readOpsStream(fd, 'stdin', cap)
  } finally {
    closeSync(fd)
  }
}

describe('readOpsInput size cap', () => {
  it('shares the MCP transfer ceiling so base64 pictures in ops fit', () => {
    expect(MAX_OPS_BYTES).toBe(MAX_TRANSFER_BYTES)
    expect(MAX_OPS_BYTES).toBe(256 * 1024 * 1024)
  })

  it('rejects oversized ops files with resource_limit', () => {
    const dir = tempDir()
    const file = fileOf(dir, 'big.json', 'x'.repeat(TEST_CAP + 1))
    let err: unknown
    try {
      readOpsInput({ positionals: [], flags: { ops: file } }, ctx(dir), TEST_CAP)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({
      code: EXIT.file,
      reason: 'resource_limit',
      detail: { source: file, bytes: TEST_CAP + 1, cap: TEST_CAP },
    })
  })

  it('accepts an ops file exactly at the cap', () => {
    const dir = tempDir()
    const file = fileOf(dir, 'edge.json', 'x'.repeat(TEST_CAP))
    const r = readOpsInput({ positionals: [], flags: { ops: file } }, ctx(dir), TEST_CAP)
    expect(r.text).toHaveLength(TEST_CAP)
  })

  it('stops an oversized stream at the cap while accumulating', () => {
    const dir = tempDir()
    const file = fileOf(dir, 'stream.json', 'x'.repeat(PAST_ONE_CHUNK_CAP + 1))
    expect(() => readStreamFile(file, PAST_ONE_CHUNK_CAP)).toThrow(/ops input too large: stdin/)
  })

  it('reads a small stream to its end', () => {
    const dir = tempDir()
    const file = fileOf(dir, 'stream.json', '{"ops":[]}')
    expect(readStreamFile(file)).toBe('{"ops":[]}')
  })

  it('keeps every chunk intact when the stream spans several reads', () => {
    const dir = tempDir()
    const text = 'a'.repeat(1024 * 1024) + 'b'.repeat(1024 * 1024) + 'c'.repeat(512 * 1024)
    const file = fileOf(dir, 'stream.json', text)
    expect(readStreamFile(file)).toBe(text)
  })

  it('accepts small ops files', () => {
    const dir = tempDir()
    const file = fileOf(dir, 'small.json', '{"ops":[]}')
    const r = readOpsInput({ positionals: [], flags: { ops: file } }, ctx(dir))
    expect(r.text).toBe('{"ops":[]}')
    expect(r.source).toBe(file)
  })
})
