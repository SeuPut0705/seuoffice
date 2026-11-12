/**
 * Group `node-path`: Node's `path.posix` and `path.win32` (lib/path.js) against
 * crates/jscompat/src/node_path.rs, through the dispatcher
 * crates/main-core/src/calls/node_path.rs.
 *
 * The functions that read process.cwd() get it as their first argument (the
 * TypeScript side replaces `process.cwd` for the call); the win32 ones get the
 * per-drive variables `=C:` next, as an object from "C:" to the value (the
 * TypeScript side replaces `process.env`). Wrong types for `resolve` are only
 * given where no absolute string follows them, because Node stops validating
 * at an absolute one.
 */
import path from 'node:path'
import type { Case, FnSpec, Group } from '../types.ts'

// ---- deterministic inputs ---------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [
  '/',
  '/',
  '\\',
  '\\',
  '.',
  '.',
  '..',
  ':',
  'C',
  'c',
  'a',
  'b',
  ' ',
  '\u0131',
  '\u017F',
  '\u212A',
  '\u0130',
  '\u{1F600}',
  '//server/share',
  '\\\\?\\',
  '\\\\.\\',
  'UNC',
  'COM1',
  'CON',
  'nul',
  'LPT\u00b9',
  'x.y',
  'D:',
]

const EDGE = [
  '',
  '/',
  '//',
  '///',
  '\\',
  '\\\\',
  '\\\\\\',
  '.',
  '..',
  '...',
  './',
  '../',
  'a',
  'a/',
  '/a',
  'a/b',
  '/a/b/',
  './a',
  '../a',
  'a/../b',
  'a/./b',
  '/..',
  '/../a',
  'a//b',
  'a\\b',
  'a\\..\\b',
  '\\a\\b\\',
  'C:',
  'C:\\',
  'C:/',
  'C:foo',
  'C:\\foo',
  'c:\\Foo\\bar',
  'C:..\\x',
  'C:\\..\\..',
  'C:\\foo\\..\\..\\bar',
  'c:',
  'D:\\x',
  'd:y',
  '\\\\server\\share',
  '\\\\server\\share\\',
  '\\\\server\\share\\a',
  '\\\\server\\share\\a\\b\\',
  '\\\\server\\',
  '\\\\server',
  '//server/share',
  '//server/share/x/',
  '\\\\.\\PHYSICALDRIVE0',
  '\\\\.\\',
  '\\\\?\\C:\\x',
  '\\\\?\\UNC\\s\\h\\x',
  '\\\\?\\COM1:\\a',
  '\\\\?\\COM1:',
  '\\\\?\\',
  'COM1:',
  'CON:',
  'nul:foo',
  'com1:\\x',
  'COM\u00b9:',
  'LPT3:/a',
  'CON',
  'CON1',
  'NUL',
  'AUX',
  'LPT\u00b9:x',
  'a:b',
  'a:b:c',
  'foo:',
  '1:',
  ':',
  ':a',
  'a/b:',
  'a/b:c',
  'a\\b:\\c',
  'file.txt',
  '.bashrc',
  'a.b.c',
  'a.',
  '.a.',
  'a/b.',
  'a..',
  'x.tar.gz',
  'dir.d/file',
  'a/.b',
  'a/..b',
  'a/b..',
  '.a/b.',
  'a b/ c ',
  ' ',
  '\u0131.txt',
  '\u{1F600}/\u{1F600}.x',
  'K\u212a',
  '\u017F',
  '\u0130',
  '\u0130\\a',
  'C:\\\u0130\\x',
  'c:\\\u0130',
  'SS',
  '\u00df',
  '\u{1F600}',
  'a\u{1F600}b',
  '/\u{1F600}/',
]

function gen(rng: () => number, maxTokens = 7): string {
  const n = Math.floor(rng() * (maxTokens + 1))
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)]
  return s
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!
}

/** random strings and the edge cases, as inputs of one string */
function strings(seed: number, count = 400): string[] {
  const rng = mulberry32(seed)
  const out = [...EDGE]
  for (let i = 0; i < count; i++) out.push(rng() < 0.15 ? pick(rng, EDGE) + gen(rng, 3) : gen(rng))
  return out
}

/** pairs where one is derived from the other, so the common-prefix branches are reached */
function pairs(seed: number, count = 500): [string, string][] {
  const rng = mulberry32(seed)
  const out: [string, string][] = []
  const small = EDGE.filter((_, i) => i % 5 === 0)
  for (const a of small) for (const b of small.filter((_, i) => i % 3 === 0)) out.push([a, b])
  for (let i = 0; i < count; i++) {
    const a = rng() < 0.3 ? pick(rng, EDGE) : gen(rng)
    const sep = pick(rng, ['/', '\\', '/', '\\', '//', ''])
    switch (Math.floor(rng() * 7)) {
      case 0:
        out.push([a, a + sep + gen(rng, 3)])
        break
      case 1:
        out.push([a + sep + gen(rng, 3), a])
        break
      case 2:
        out.push([a, a.toUpperCase()])
        break
      case 3:
        out.push([a + sep + gen(rng, 2), a.toUpperCase() + sep + gen(rng, 2)])
        break
      case 4:
        out.push([a, a + sep])
        break
      case 5:
        out.push([gen(rng), gen(rng)])
        break
      default:
        out.push([a, gen(rng)])
        break
    }
  }
  return out
}

/** the characters of a string by code point, so a cut never splits a surrogate pair */
function tail(rng: () => number, s: string): string {
  const cs = Array.from(s)
  return cs.slice(Math.floor(rng() * (cs.length + 1))).join('')
}

const POSIX_CWDS = [
  '/',
  '/work/dir',
  '/a/b/c',
  '$DIR',
  '/a//b/',
  '/..',
  '',
  'rel/x',
  '/\u{1F600}/\u0131',
]
const WIN_CWDS = [
  'C:\\work',
  'c:\\w\\x',
  'C:\\',
  '\\\\srv\\share\\d',
  '\\\\srv\\share',
  '\\',
  '/unix/path',
  'D:',
  'D:\\x\\',
  '',
  'C:\\a\\..\\b',
  '\\\\?\\C:\\x',
  'rel',
  '/Users/x',
  'C:\\\u0130',
]
const WIN_ENVS: (Record<string, string> | null)[] = [
  null,
  null,
  { 'C:': 'C:\\drive\\c' },
  { 'c:': 'c:/lower' },
  { 'C:': '' },
  { 'D:': 'C:\\other', 'C:': 'D:\\x' },
  { 'C:': 'C:foo' },
  { 'C:': 'c:\\Case\\x' },
  { 'D:': 'D:\\dd\\' },
]

// ---- the TypeScript side ----------------------------------------------------

const posix = path.posix
const win32 = path.win32

/** runs `fn` with process.cwd() answering `cwd` and the environment being `env` */
function withProcess<T>(cwd: unknown, env: unknown, fn: () => T): T {
  const p = process as unknown as { cwd: () => unknown; env: unknown }
  const savedCwd = p.cwd
  const savedEnv = p.env
  p.cwd = () => cwd
  p.env = Object.fromEntries(
    Object.entries((env as Record<string, string> | null) ?? {}).map(([k, v]) => [`=${k}`, v]),
  )
  try {
    return fn()
  } finally {
    p.cwd = savedCwd
    p.env = savedEnv
  }
}

type Fn = (...a: any[]) => unknown

function spec(ts: FnSpec['ts'], cases: Case[]): FnSpec {
  return { ts, cases }
}

function one(strs: string[]): Case[] {
  return strs.map((s) => ({ args: [s] }))
}

const WRONG: unknown[] = [1, -0.5, 1e21, null, true, {}, [], ['a']]

function wrong(): Case[] {
  return [
    ...WRONG.map((v) => ({ args: [v], note: 'wrong type' })),
    { args: [], note: 'no argument' },
  ]
}

function flavour(name: 'posix' | 'win32'): Group {
  const p = (name === 'posix' ? posix : win32) as unknown as Record<string, Fn>
  const seed = name === 'posix' ? 11 : 23
  const isWin = name === 'win32'
  const cwds = isWin ? WIN_CWDS : POSIX_CWDS
  const g: Group = {}
  const key = (f: string) => `path.${name}.${f}`

  g[key('sep')] = { ...spec(() => p.sep, [{ args: [] }]), single: 'a constant' }
  g[key('delimiter')] = { ...spec(() => p.delimiter, [{ args: [] }]), single: 'a constant' }

  // cwd-dependent: [cwd, (env,) ...]
  const ctx = (rng: () => number): unknown[] =>
    isWin ? [pick(rng, cwds), pick(rng, WIN_ENVS)] : [pick(rng, cwds)]
  const nctx = isWin ? 2 : 1
  const withCtx = (f: string) => (a: unknown[]) =>
    withProcess(a[0], isWin ? a[1] : null, () => p[f]!(...a.slice(nctx)))

  {
    const rng = mulberry32(seed + 1)
    const cases: Case[] = []
    for (const s of strings(seed + 2, 200)) cases.push({ args: [...ctx(rng), s] })
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rng() * 5)
      const parts = Array.from({ length: n }, () => (rng() < 0.25 ? pick(rng, EDGE) : gen(rng, 4)))
      cases.push({ args: [...ctx(rng), ...parts] })
    }
    // no part, empty parts, dots: the fast paths
    for (const cwd of cwds) {
      for (const parts of [[], [''], ['.'], [''.padEnd(0), ''], ['.', '.'], ['a'], ['..']]) {
        cases.push({ args: [cwd, ...(isWin ? [null] : []), ...parts] })
        if (isWin) cases.push({ args: [cwd, { 'C:': 'C:\\drive\\c' }, ...parts] })
      }
    }
    for (const env of WIN_ENVS) {
      if (!isWin) break
      for (const parts of [
        ['C:'],
        ['C:foo'],
        ['c:foo', 'd:bar'],
        ['D:x', 'C:y'],
        ['C:..\\a'],
        ['d:'],
        ['C:', 'D:\\z'],
      ]) {
        for (const cwd of WIN_CWDS.slice(0, 7)) cases.push({ args: [cwd, env, ...parts] })
      }
    }
    // wrong types: last argument, or before relative strings only
    for (const w of WRONG) {
      cases.push({ args: [cwds[1], ...(isWin ? [null] : []), w], note: 'wrong type last' })
      cases.push({ args: [cwds[1], ...(isWin ? [null] : []), 'a', w], note: 'wrong type last' })
      cases.push({
        args: [cwds[1], ...(isWin ? [null] : []), w, 'a'],
        note: 'wrong type before relative',
      })
    }
    g[key('resolve')] = spec(withCtx('resolve'), cases)
  }

  for (const f of ['normalize', 'isAbsolute', 'dirname', 'extname', 'parse']) {
    g[key(f)] = spec((a) => p[f]!(...a), [...one(strings(seed + 3 + f.length)), ...wrong()])
  }
  // appended last: divergences.json keys by case index. A relative path whose tail reads as a
  // drive ("C:x") must get the ".\\" guard of CVE-2024-36139: the tail check, not the colon scan
  // of the original path, is what catches a colon followed by a letter.
  g[key('normalize')]!.cases.push(
    ...one(['./C:x', '.\\C:x', 'a/../C:x', 'x\\..\\C:y\\z', 'ab:c/../C:x', 'ab:', 'ab:c', 'ab:c:']),
  )

  {
    const rng = mulberry32(seed + 4)
    const cases: Case[] = [{ args: [], note: 'no argument' }]
    for (const s of strings(seed + 5, 150)) cases.push({ args: [s] })
    for (let i = 0; i < 350; i++) {
      const n = 1 + Math.floor(rng() * 4)
      cases.push({
        args: Array.from({ length: n }, () => (rng() < 0.3 ? pick(rng, EDGE) : gen(rng, 4))),
      })
    }
    for (const [a, b] of pairs(seed + 6, 150)) cases.push({ args: [a, b] })
    cases.push(
      { args: ['', ''] },
      { args: ['', '', ''] },
      { args: ['a', 1] },
      { args: [null, 'a'] },
      { args: ['a', 'b', {}] },
    )
    cases.push(
      { args: ['//server', 'share'] },
      { args: ['\\\\server', 'share', 'x'] },
      { args: ['/', '/a'] },
    )
    cases.push(
      { args: ['/', '', '//a'] },
      { args: ['', '//server/share'] },
      { args: ['C:', 'foo'] },
      { args: ['C:', '..', 'x:y'] },
    )
    cases.push(
      { args: ['a', 'COM1:b'] },
      { args: ['a/b', 'CON:', '..'] },
      { args: ['\\\\?\\COM1:', 'x/y'] },
    )
    g[key('join')] = spec((a) => p.join!(...a), cases)
  }

  {
    const rng = mulberry32(seed + 7)
    const cases: Case[] = []
    for (const [a, b] of pairs(seed + 8)) cases.push({ args: [...ctx(rng), a, b] })
    for (const cwd of cwds) {
      for (const [a, b] of [
        ['', ''],
        ['', 'a'],
        ['a', ''],
        ['.', 'a'],
        ['/', '/a'],
        ['/a', '/'],
        ['a', 'a'],
        ['/a/b', '/a/c'],
      ]) {
        cases.push({ args: [cwd, ...(isWin ? [null] : []), a, b] })
      }
    }
    for (const w of WRONG) {
      cases.push({ args: [cwds[1], ...(isWin ? [null] : []), w, 'a'], note: 'wrong from' })
      cases.push({ args: [cwds[1], ...(isWin ? [null] : []), 'a', w], note: 'wrong to' })
    }
    cases.push({ args: [cwds[1], ...(isWin ? [null] : [])], note: 'no argument' })
    g[key('relative')] = spec(withCtx('relative'), cases)
  }

  {
    const rng = mulberry32(seed + 9)
    const cases: Case[] = []
    if (isWin) {
      for (const s of strings(seed + 10, 250)) cases.push({ args: [...ctx(rng), s] })
      for (const w of [1, null, true, {}, [], undefined])
        cases.push({ args: [WIN_CWDS[0], null, w], note: 'returned as given' })
      cases.push({ args: [WIN_CWDS[0], null], note: 'no argument' })
    } else {
      for (const s of strings(seed + 10, 100)) cases.push({ args: [s] })
      for (const w of [1, null, true, {}, [], 'x'])
        cases.push({ args: [w], note: 'returned as given' })
      cases.push({ args: [], note: 'no argument' })
    }
    g[key('toNamespacedPath')] = spec(
      isWin
        ? (a) => withProcess(a[0], a[1], () => p.toNamespacedPath!(a[2]))
        : (a) => p.toNamespacedPath!(a[0]),
      cases,
    )
  }

  {
    const rng = mulberry32(seed + 11)
    const cases: Case[] = []
    const edges = [
      ...EDGE,
      'a.txt',
      'a.TXT',
      '.txt',
      'txt',
      '.',
      '..',
      'C:a.txt',
      'C:.txt',
      'C:\\a.txt',
      'a.txt/',
      'a.txt//',
    ]
    for (const s of edges) {
      cases.push({ args: [s] })
      for (const ext of [
        '.txt',
        'txt',
        '.',
        '',
        'a',
        s,
        'xt',
        '.TXT',
        '\u0131',
        '\u{1F600}',
        '.\u{1F600}',
      ]) {
        cases.push({ args: [s, ext] })
      }
    }
    for (let i = 0; i < 400; i++) {
      const s = gen(rng)
      const r = rng()
      const ext = r < 0.1 ? undefined : r < 0.7 ? tail(rng, s) : gen(rng, 2)
      cases.push({ args: ext === undefined ? [s] : [s, ext] })
    }
    for (const w of WRONG) {
      cases.push(
        { args: ['a', w], note: 'wrong suffix' },
        { args: [w, 'a'], note: 'wrong path' },
        { args: [w, w], note: 'both wrong' },
      )
    }
    cases.push({ args: [], note: 'no argument' }, { args: ['a', null], note: 'null suffix' })
    g[key('basename')] = spec((a) => p.basename!(...a), cases)
  }

  {
    const rng = mulberry32(seed + 12)
    const cases: Case[] = []
    const field = (): unknown => {
      const r = rng()
      if (r < 0.2) return undefined
      if (r < 0.3) return ''
      if (r < 0.35) return null
      if (r < 0.4) return pick(rng, [0, 5, true, false, 1.5])
      if (r < 0.5) return pick(rng, ['.txt', 'txt', '.', '..', 'a.b'])
      return rng() < 0.3 ? pick(rng, EDGE) : gen(rng, 3)
    }
    for (let i = 0; i < 500; i++) {
      const o: Record<string, unknown> = {}
      for (const k of ['dir', 'root', 'base', 'name', 'ext']) {
        const v = field()
        if (v !== undefined) o[k] = v
      }
      cases.push({ args: [o] })
    }
    // objects from parse itself, so root, dir, base, name and ext agree
    for (const s of strings(seed + 13, 100)) {
      const o = p.parse!(s)
      cases.push({ args: [o] })
      cases.push({ args: [{ ...(o as object), base: '' }] })
      cases.push({
        args: [
          {
            dir: (o as { dir: string }).dir,
            root: (o as { root: string }).root,
            name: 'n',
            ext: 'e',
          },
        ],
      })
    }
    cases.push(
      { args: [{}] },
      { args: [{ root: '/' }] },
      { args: [{ root: '/', dir: '/', base: 'a' }] },
    )
    cases.push(
      { args: [{ root: 'C:\\', dir: 'C:\\x', base: 'a' }] },
      { args: [{ dir: 'd', ext: 'e' }] },
    )
    for (const w of [1, 'a', null, true, [], [{ dir: 'a' }]])
      cases.push({ args: [w], note: 'wrong type' })
    cases.push({ args: [], note: 'no argument' })
    g[key('format')] = spec((a) => p.format!(...a), cases)
  }

  return g
}

export const group: Group = { ...flavour('posix'), ...flavour('win32') }
