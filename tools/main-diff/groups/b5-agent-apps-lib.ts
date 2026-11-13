/**
 * Helpers of the `b5-agent-apps` part: the patched copy of a module (its
 * library imports pointed at stubs the case drives), the clock-free parts of
 * the scenarios, and the small case builders.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Case } from '../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = any

export const g = globalThis as J

const repo = new URL('../../../', import.meta.url)
const scratch = new URL('../out/b5-agent-apps/', import.meta.url)
let scratchCount = 0
let scratchReady = false

function scratchFile(name: string, source: string): string {
  if (!scratchReady) {
    mkdirSync(fileURLToPath(scratch), { recursive: true })
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
    scratchReady = true
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-${name}`, scratch))
  writeFileSync(path, source)
  return pathToFileURL(path).href
}

/** `from` replaced by `to` where the source has it, or an error naming the file */
export function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

/** the absolute address of a file of the repository, for a patched import */
export function repoUrl(file: string): string {
  return pathToFileURL(fileURLToPath(new URL(file, repo))).href
}

/**
 * The module at `file` (from the repository root) as a copy of its source:
 * `patch` first, then every relative import made absolute so the copy can sit
 * in the scratch folder. A fresh copy is a fresh module state.
 */
export async function loadPatched(file: string, patch: (src: string) => string): Promise<J> {
  const original = new URL(file, repo)
  const dir = dirname(fileURLToPath(original))
  const src = patch(readFileSync(original, 'utf8')).replace(
    /(from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g,
    (_m: string, pre: string, spec: string) => {
      const target = resolvePath(dir, spec)
      const withExt = /\.(ts|mts|js|json)$/.test(target) ? target : `${target}.ts`
      return `${pre}'${pathToFileURL(withExt).href}'`
    },
  )
  return import(scratchFile(basename(file).replace(/\.ts$/, '.mts'), src))
}

export const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** lets every promise chain that can finish without the outside world finish */
export const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** `process.env` with these names set (a `null` is deleted) while `run` runs */
export async function withEnv<T>(
  env: Record<string, string | null> | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    saved[key] = process.env[key]
    if (value === null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** the process variables the search backends read, all cleared for a case */
export const NO_SEARCH_ENV: Record<string, null> = {
  SERPER_API_KEY: null,
  SERPLY_API_KEY: null,
  SEARCHAPI_API_KEY: null,
  TAVILY_API_KEY: null,
  PARALLEL_API_KEY: null,
  EXA_API_KEY: null,
  FIRECRAWL_API_KEY: null,
  KEENABLE_API_KEY: null,
}

/** a fake `WebContents` of the media call abort: its id, whether it is destroyed, its listeners */
export function fakeSender(id: number, destroyed: boolean): J {
  const listeners = new Set<() => void>()
  const sender = {
    id,
    destroyed,
    isDestroyed: () => sender.destroyed,
    once: (_event: string, fn: () => void) => listeners.add(fn),
    removeListener: (_event: string, fn: () => void) => listeners.delete(fn),
    destroy: () => {
      sender.destroyed = true
      for (const fn of [...listeners]) fn()
    },
    listenerCount: () => listeners.size,
  }
  return sender
}

/** the answer of a settings text read by the module under test, or none */
export function jsonOrNull(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined
  return JSON.parse(text)
}
