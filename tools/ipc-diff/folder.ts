/**
 * A case's folder: made before a side runs, read after, then removed. The
 * same rules as tools/main-diff (its FileSpec), so a case reads the same.
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { FileSpec } from './types.ts'

export function setUp(dir: string, files: Record<string, FileSpec> | undefined): void {
  const modes: [string, number][] = []
  for (const [rel, spec] of Object.entries(files ?? {})) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    const s = typeof spec === 'string' ? { text: spec } : spec
    if (s.dir) mkdirSync(path, { recursive: true })
    else if (s.link !== undefined) linkSync(join(dir, s.link), path)
    else writeFileSync(path, s.hex !== undefined ? Buffer.from(s.hex, 'hex') : (s.text ?? ''))
    if (s.mtimeMs !== undefined) utimesSync(path, s.mtimeMs / 1000, s.mtimeMs / 1000)
    if (s.mode !== undefined) modes.push([path, s.mode])
  }
  // modes last, so a read-only folder still received its files
  for (const [path, mode] of modes.reverse()) chmodSync(path, mode)
}

/**
 * Each entry with its kind, mode and contents. Not the modification time: a
 * file either side writes gets the clock of the moment, which differs.
 */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const readable = <T>(path: string, mode: number, read: () => T): T => {
    if ((mode & 0o500) === 0o500) return read()
    chmodSync(path, mode | 0o700)
    try {
      return read()
    } finally {
      chmodSync(path, mode)
    }
  }
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const rel = relative(dir, path)
      const st = statSync(path)
      const mode = st.mode & 0o777
      if (st.isDirectory()) {
        out[rel] = `dir ${mode.toString(8)}`
        readable(path, mode, () => walk(path))
      } else {
        const bytes = readable(path, mode, () => readFileSync(path))
        const text = bytes.toString('utf8')
        const body = Buffer.from(text, 'utf8').equals(bytes)
          ? JSON.stringify(text)
          : `hex:${bytes.toString('hex')}`
        out[rel] = `file ${mode.toString(8)} ${body}`
      }
    }
  }
  walk(dir)
  return out
}

export function cleanUp(dir: string): void {
  const open = (at: string): void => {
    try {
      chmodSync(at, 0o755)
    } catch {
      return
    }
    if (statSync(at).isDirectory()) for (const name of readdirSync(at)) open(join(at, name))
  }
  open(dir)
  rmSync(dir, { recursive: true, force: true })
}

export function substitute<T>(value: T, dir: string): T {
  if (typeof value === 'string') return value.split('$DIR').join(dir) as T
  if (Array.isArray(value)) return value.map((v) => substitute(v, dir)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, dir)])) as T
  }
  return value
}

/** `dir` written as `$DIR`, also inside JSON strings where a Windows path's backslashes are escaped */
export function unsubstitute(text: string, dir: string): string {
  // also the folder in lower case: a path key folds case on macOS and Windows
  for (const folder of [dir, dir.toLowerCase()]) {
    const once = JSON.stringify(folder).slice(1, -1)
    const twice = JSON.stringify(once).slice(1, -1)
    for (const form of [twice, once, folder]) text = text.split(form).join('$DIR')
  }
  return text
}
