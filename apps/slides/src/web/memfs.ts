// An in-memory `node:fs` for the slides web build. The font code (src/main/fonts.ts and
// shaped-metrics.ts) is written against synchronous file reads of font files and writes the deck's
// embedded fonts to a temp directory. Files here live in a Map keyed by path; the web session
// preloads the bundled fonts under their asset URLs and the embedded fonts land through
// writeFileSync, so that code runs unchanged. Everything else in the shim stays unsupported.
import { Buffer } from 'buffer'
import * as shim from '@seuoffice/web-platform/shims/fs'

export * from '@seuoffice/web-platform/shims/fs'

const files = new Map<string, Uint8Array>()
const directories = new Set<string>()
const handles = new Map<number, Uint8Array>()
let nextHandle = 3

const missing = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })

/** Make a file readable at `path` */
export function putFile(path: string, bytes: Uint8Array): void {
  files.set(path, bytes)
}

export function existsSync(path: string): boolean {
  return files.has(path) || directories.has(path)
}

export function mkdirSync(path: string): undefined {
  directories.add(path)
  return undefined
}

export function writeFileSync(path: string, data: Uint8Array): void {
  files.set(path, data)
}

export function readFileSync(path: string): Buffer {
  const bytes = files.get(path)
  if (!bytes) throw missing(path)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function readdirSync(path: string): string[] {
  throw missing(path)
}

export function openSync(path: string): number {
  const bytes = files.get(path)
  if (!bytes) throw missing(path)
  const handle = nextHandle++
  handles.set(handle, bytes)
  return handle
}

export function readSync(
  handle: number,
  target: Uint8Array,
  offset: number,
  length: number,
  position: number,
): number {
  const bytes = handles.get(handle)
  if (!bytes) throw Object.assign(new Error('EBADF: bad file descriptor'), { code: 'EBADF' })
  const chunk = bytes.subarray(position, position + length)
  target.set(chunk, offset)
  return chunk.length
}

export function closeSync(handle: number): void {
  handles.delete(handle)
}

export default {
  ...shim.default,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
}
