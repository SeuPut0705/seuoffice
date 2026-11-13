/**
 * Part `index-core` of group `b3b4-rest`: the shared `text-marks`, the file
 * index's `snippet`, `tokenize`, `scan`, `extract` and `extract-worker`, and
 * `folder-tree`. The Rust side is calls/b3b4_rest/index_core.rs.
 *
 * - A case may end its arguments with `{ $links: [[link, target], ...] }`:
 *   the symbolic links to make before the call (a case's files cannot be
 *   links). Both sides strip it and make the links.
 * - `@seuoffice/file-parse` is a fake (a resolve hook for extract.ts only):
 *   the `world` argument is `{ redact?, parse? }`. `redact` is "mark" (every
 *   `SECRET` becomes `{{private}}`) or `{ throw }` / `{ throwValue }`; `parse`
 *   is the `ParsedFile` to answer, or `{ throw }` / `{ throwValue }` (an
 *   `Error`, or a string thrown as it is). Each call is one log line.
 * - `extract-worker.message`: the worker's `parentPort` is a fake that hands
 *   the module's message handler over, and the answer is what it posts.
 * - `folder-tree.FolderWatcher` is a scenario: `fs.watch`, `setTimeout` and
 *   `clearTimeout` are fakes for its duration, each call one log line; the
 *   Rust plays the caller that owns the handle and the timer.
 * - `folder-tree.moveOnDisk` with mode "xdev" (or "xdev-eacces") makes
 *   `renameSync` fail with EXDEV (EACCES), the one error a single volume
 *   cannot give.
 */
import '../../electron-fake.ts'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../../types.ts'
import type { QueryTerm } from '../../../../apps/shell/src/main/file-index/tokenize.ts'

const BOX = Symbol.for('main-diff.index-core')

interface Box {
  redact: (source: string) => string
  parse: (path: string) => unknown
  handler?: (request: unknown) => Promise<void>
  posted: unknown[]
  port: {
    on: (event: string, handler: (request: unknown) => Promise<void>) => void
    postMessage: (message: unknown) => void
  }
}
const box: Box = {
  redact: (source) => source,
  parse: () => ({ ok: true, kind: 'text', text: '' }),
  posted: [],
  port: {
    on(_event, handler) {
      box.handler = handler
    },
    postMessage(message) {
      box.posted.push(message)
    },
  },
}
;(globalThis as Record<symbol, unknown>)[BOX] = box

const FILE_PARSE_URL = 'main-diff:index-core-file-parse'
const WORKER_URL = 'main-diff:index-core-worker-threads'
const SOURCES: Record<string, string> = {
  [FILE_PARSE_URL]: [
    `const box = globalThis[Symbol.for('main-diff.index-core')]`,
    `module.exports = { redactHtmlSource: (s) => box.redact(s), parseFileToText: async (p) => box.parse(p) }`,
  ].join('\n'),
  // the real module with `parentPort` replaced. indexer.ts asks the same
  // folder for the same specifier, and Node's CommonJS resolve cache may hand
  // it this module: `Worker` is index-store's fake when that part has set it
  [WORKER_URL]: [
    `const real = require('node:worker_threads')`,
    `const box = globalThis[Symbol.for('main-diff.index-core')]`,
    `const worker = () => globalThis[Symbol.for('main-diff.indexer-worker')] ?? real.Worker`,
    `module.exports = new Proxy(real, { get: (target, key) => (key === 'parentPort' ? box.port : key === 'Worker' ? worker() : target[key]) })`,
  ].join('\n'),
}

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (/\/file-index\/extract(-worker)?\.ts/.test(parent)) {
      if (specifier === '@seuoffice/file-parse') return { url: FILE_PARSE_URL, shortCircuit: true }
      if (specifier === 'node:worker_threads' && /\/extract-worker\.ts/.test(parent))
        return { url: WORKER_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = SOURCES[url]
    if (source !== undefined) return { format: 'commonjs', source, shortCircuit: true }
    return next(url, context)
  },
})

// loaded after electron-fake.ts and the hooks above have been registered
const marks = await import('../../../../apps/shell/src/shared/text-marks.ts')
const snippet = await import('../../../../apps/shell/src/main/file-index/snippet.ts')
const tk = await import('../../../../apps/shell/src/main/file-index/tokenize.ts')
const scan = await import('../../../../apps/shell/src/main/file-index/scan.ts')
const extract = await import('../../../../apps/shell/src/main/file-index/extract.ts')
await import('../../../../apps/shell/src/main/file-index/extract-worker.ts')
const tree = await import('../../../../apps/shell/src/main/folder-tree.ts')

const str = (a: unknown[], i: number): string => a[i] as string
/** the module object, whose functions a scenario replaces for its duration */
const fsMut = fs as unknown as Record<string, unknown>

/** a constant has one answer */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    cases: [{ args: [] }],
    single: 'a constant',
  }
}

// ---------------------------------------------------------------------------
// links, mtimes
// ---------------------------------------------------------------------------

interface Links {
  $links: [string, string][]
}

/** the arguments without the trailing `$links`, whose links are made first */
function takeLinks(args: unknown[]): unknown[] {
  const last = args[args.length - 1] as Partial<Links> | null | undefined
  if (last && typeof last === 'object' && Array.isArray(last.$links)) {
    for (const [link, target] of last.$links) fs.symlinkSync(target, link)
    return args.slice(0, -1)
  }
  return args
}

const links = (...pairs: [string, string][]): Links => ({ $links: pairs })

const T = (n: number): number => 1_700_000_000_000 + n * 1000
const file = (n: number, text = 'x'): FileSpec => ({ text, mtimeMs: T(n) })
const dirAt = (n: number): FileSpec => ({ dir: true, mtimeMs: T(n) })

// ---------------------------------------------------------------------------
// text-marks and snippet
// ---------------------------------------------------------------------------

const filler = 'lorem ipsum dolor sit amet '
const longText = filler.repeat(20) + 'needle ' + filler.repeat(20)

const foldTexts = [
  'ABC',
  'abc',
  '\uFF21\uFF22\uFF23 \uFF12\uFF10\uFF12\uFF16',
  '\u0130stanbul',
  '\uFB01nance',
  '\u3231',
  '\u039F\u0394\u039F\u03A3',
  '\u039F\u0394\u039F\u03A3 \u03A3',
  '',
  '\uD55C\uAE00',
  '\u{1F600}',
  'e\u0301',
  '\u2460',
  '\u01C5',
  '\u1E9E',
  '\u212B',
  '\u0344',
]

const findRangesCases: Case[] = [
  { args: ['minneapolis is', ['is']] },
  { args: ['minneapolis is', ['is'], [3]] },
  { args: ['\uC548\uB155\uD558\uC138\uC694 \uC138\uACC4', ['\uD558\uC138']] },
  { args: ['\u6771\u4EAC\u90FD\u5E81', ['\u6771\u4EAC', '\u4EAC\u90FD']] },
  { args: ['abc', ['', 'b']] },
  { args: ['abc', ['']] },
  { args: ['abc', []] },
  { args: ['', ['a']] },
  { args: ['\u{20000}abc', ['abc']], note: 'half of a pair is no word character' },
  { args: ['\u{1F600}abc', ['abc']] },
  { args: ['\u{20000}\u{20001}', ['\u{20001}']] },
  { args: ['abc', ['bc'], [1]] },
  { args: ['abc', ['bc'], []] },
  { args: ['x12 12', ['12']] },
  { args: ['a-b', ['-b']] },
  { args: ['e\u0301x', ['\u0301x']] },
  { args: ['b a', ['b', 'a']] },
  { args: ['\u30AB\u30BF\u30AB\u30CA', ['\u30AB\u30CA']] },
  { args: ['\u3105\u3106 a', ['\u3106']] },
  { args: ['aaa aaa', ['aa']] },
  { args: ['aaaa', ['aa']], note: 'no word start inside' },
  { args: ['\uD55C\uAD6D\uC5B4 abc', ['abc', '\uAD6D']] },
  { args: ['foo foo foo', ['foo', 'oo f']] },
  { args: ['ab', ['abc']] },
  { args: ['ab ab', ['ab', 'b a']] },
  { args: ['\u65E5\u65E5\u65E5', ['\u65E5\u65E5']], note: 'a needle that overlaps itself' },
  { args: ['\u6771\u4EAC', ['\u6771', '\u4EAC']], note: 'two hits that touch' },
  {
    args: ['\u6771\u4EAC\u90FD', ['\u6771\u4EAC\u90FD', '\u4EAC']],
    note: 'a hit inside a longer one',
  },
  { args: ['b a', ['a', 'b']], note: 'needles in the reverse order of the text' },
]

const textRangeCases: Case[] = [
  { args: ['Hello World', ['world']] },
  { args: ['hello', ['xyz']] },
  { args: ['', ['a']] },
  { args: ['abc', []] },
  { args: ['\u0130stanbul city', ['i\u0307stanbul']] },
  { args: ['\u0130stanbul city', ['istanbul']] },
  { args: ['\uFF21\uFF22\uFF23 def', ['abc']] },
  { args: ['\u3231ABC', ['\u682A']] },
  { args: ['\u3231ABC', ['abc']] },
  { args: ['\uFB01nance', ['finance']] },
  { args: ['\uFB01nance', ['nance']] },
  { args: ['\uFB01nance', ['inance']] },
  { args: ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467} abc', ['abc']] },
  { args: ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467} abc', ['\u{1F469}']] },
  { args: ['\u{1F1F0}\u{1F1F7}\u{1F1EF}\u{1F1F5} korea', ['korea']] },
  { args: ['\u{1F1F0}\u{1F1F7}\u{1F1EF}\u{1F1F5} korea', ['\u{1F1F7}']] },
  { args: ['\u1112\u1161\u11AB', ['\uD55C']], note: 'conjoining jamo fold into one syllable' },
  { args: ['\u1112\u1161\u11AB x', ['x']] },
  { args: ['e\u0301 caf\u00E9', ['caf\u00E9']] },
  { args: ['e\u0301', ['\u00E9']] },
  { args: ['\u1100\u314F', ['\u1100']], note: 'the folded length differs from the pieces' },
  { args: ['\u6771\u4EAC\u30BF\u30EF\u30FC', ['\u30BF\u30EF']] },
  { args: ['\u{20000}\u6771\u4EAC', ['\u6771\u4EAC']] },
  { args: ['\uD55C\uAE00 \uAC80\uC0C9 \uD55C\uAE00', ['\uD55C\uAE00']] },
  { args: ['\u0391\u0392 \u03A3', ['\u03C3']] },
  { args: ['\u0344x', ['x']] },
  { args: ['\u{1F44D}\u{1F3FD} thumbs', ['thumbs']] },
  { args: ['\u0E01\u0E33 x', ['\u0E01']] },
  {
    args: ['a\u0301b', ['b']],
    note: 'a combining mark makes the previous character a word character',
  },
  { args: ['\u2460\u2461', ['12']] },
  { args: ['\u00C5ngstr\u00F6m \u212B', ['\u00E5']] },
]

const markCases: Case[] = [
  { args: ['nothing here', ['zzz']] },
  { args: ['Hello world hello', ['hello']] },
  { args: ['hello', ['hello']] },
  { args: ['', ['']] },
  { args: ['', ['a']] },
  { args: ['\uD55C\uAD6D\uC5B4 \uAC80\uC0C9', ['\uAC80\uC0C9']] },
  { args: ['\u6771\u4EAC\u90FD\u5E81', ['\u6771\u4EAC', '\u4EAC\u90FD']] },
  { args: ['\u3231ABC end', ['\u682A', 'abc']] },
  { args: ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family', ['family']] },
  { args: ['  lead', ['lead']] },
  { args: ['a b c', ['a', 'c']] },
  { args: ['ab', ['a', 'b']] },
  { args: ['\u6771\u4EAC', ['\u6771', '\u4EAC']] },
  { args: ['\u1100\u314F', ['\u1100']] },
  { args: ['\u{1F600} x \u{1F600}', ['x']] },
]

const snippetCases: Case[] = [
  { args: ['', ['a']] },
  { args: ['text', []] },
  { args: ['text', ['']] },
  { args: ['text', ['zzz']] },
  { args: ['needle at the start of a short text', ['needle']] },
  { args: [longText, ['needle']] },
  { args: [longText, ['needle', 'lorem']] },
  { args: [filler.repeat(8) + 'needle', ['needle']] },
  { args: ['a\n\n b\t\tneedle \u00A0 \u3000 end', ['needle']] },
  { args: ['x'.repeat(30) + ' needle ' + 'y'.repeat(100), ['needle']] },
  { args: ['x'.repeat(39) + ' needle ' + 'y'.repeat(80), ['needle']], note: 'the hit sits 40 in' },
  {
    args: ['x'.repeat(40) + ' needle ' + 'y'.repeat(80), ['needle']],
    note: 'one more than the lead',
  },
  { args: ['needle ' + 'y'.repeat(143), ['needle']], note: 'the window ends at the text end' },
  { args: ['needle ' + 'y'.repeat(144), ['needle']], note: 'one past it' },
  {
    args: ['needle ' + 'y'.repeat(142) + ' needle', ['needle']],
    note: 'a second hit that starts where the window ends',
  },
  {
    args: ['needle ' + 'y'.repeat(139) + ' needle z', ['needle']],
    note: 'a hit that straddles the window end',
  },
  {
    args: ['needle ' + 'y'.repeat(136) + ' needle', ['needle']],
    note: 'a hit that ends where the window ends',
  },
  { args: [filler.repeat(10) + 'needle ' + 'a b c needle', ['needle']] },
  {
    args: [
      '\u6771\u4EAC\u30BF\u30EF\u30FC'.repeat(40) +
        '\u5927\u962A\u57CE' +
        '\u6771\u4EAC'.repeat(10),
      ['\u5927\u962A'],
    ],
  },
  { args: ['\uD55C\uAD6D\uC5B4 \uAC80\uC0C9 \uC5D4\uC9C4 \uAC80\uC0C9', ['\uAC80\uC0C9']] },
  { args: ['\u3231ABC and \uFB01nance', ['abc', 'finance']] },
  { args: ['Needle NEEDLE needle', ['needle']] },
  {
    args: ['x needle ' + 'z '.repeat(100) + 'needle', ['needle']],
    note: 'a second hit beyond the window',
  },
  { args: ['  needle', ['needle']] },
]

const excerptCases: Case[] = [
  { args: ['  the quick brown fox  ', ['zzz'], 10] },
  { args: ['the quick brown fox jumps over', ['jumps'], 12] },
  { args: ['the quick brown fox jumps over', ['jumps'], 40] },
  { args: ['the quick brown fox jumps over', ['the'], 8] },
  { args: ['the quick brown fox', ['fox'], 0] },
  { args: ['the quick brown fox', ['fox'], 3] },
  { args: ['the quick brown fox', ['fox'], -2] },
  { args: ['the quick brown fox', ['fox'], 1.5] },
  { args: ['the quick brown fox', ['fox'], 100] },
  { args: ['a\n\nb  c', [], 20] },
  { args: ['', ['a'], 5] },
  { args: ['\u6771\u4EAC\u30BF\u30EF\u30FC\u306F\u9AD8\u3044\u5854\u3067\u3059', ['\u9AD8'], 8] },
  { args: ['the quick', ['quick'], null] },
]

const containsCases: Case[] = [
  { args: ['Hello', ['HELL']] },
  { args: ['Hello', ['xyz']] },
  { args: ['Hello', ['']] },
  { args: ['Hello', []] },
  { args: ['\u65E5\u672C\u8A9E', ['\u672C']] },
  { args: ['\uFF21\uFF22\uFF23', ['abc']] },
  { args: ['xhello', ['hello']] },
  { args: ['hello world', ['', 'world']] },
  { args: ['\u212Bngstr\u00F6m', ['\u00E5ngstr\u00F6m']] },
]

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

const tokenizeTexts = [
  '',
  'Hello World',
  '\uD55C\uAD6D\uC5B4 \uAC80\uC0C9 engine',
  '\u6771\u4EAC\u30BF\u30EF\u30FC2026',
  '\uFF21\uFF22\uFF23\uFF11\uFF12\uFF13',
  '\u{1F600} text',
  'a-b_c',
  '\u{20000}\u{20001}\u{20002}',
  'abc\u6771\u4EAC def',
  '\u304C',
  'a \u65E5 b',
  'e\u0301',
  'x\u200Dy',
  '!!! ???',
  '\uFF71\uFF72\uFF73',
  '\u3231',
  '\u1112\u1161\u11AB',
  '\u00DF',
  '\u0130',
  '\u3005\u3006\u3007',
  '\u2E80\u2FDF',
  'caf\u00E9 na\u00EFve',
  '12\u5E7411\u670825\u65E5',
  '\u0E01\u0E33',
]

const parseQueries = [
  '',
  'hello',
  'hello world',
  '"hello world"',
  '-foo bar',
  '-"quoted phrase"',
  'a "unterminated',
  '\uD55C\uAD6D\uC5B4 \uAC80\uC0C9',
  '\uAC80 \uC0C9',
  '"" x',
  '   ',
  '- x',
  'x -',
  '"a" "b"',
  '\u65E5\u672C\u8A9E abc',
  '!!! ??',
  'hello-world',
  '-x-y',
  'ab',
  'a',
  '"ab"',
  '\uFF21\uFF22 cd',
  'abc\uD55C',
  '"\uD55C abc"',
  '-"" y',
  '\u201Cquoted\u201D',
  '"  spaced  phrase "',
]

const termQueries: [string, number][] = [
  ['hello', 0],
  ['"hello"', 0],
  ['hello world', 1],
  ['a', 0],
  ['\uD55C\uAD6D\uC5B4', 0],
  ['\uD55C', 0],
  ['\u65E5\u672C abc', 0],
  ['"\uD55C\uAD6D\uC5B4 \uAC80\uC0C9"', 0],
  ['abc\uD55C', 0],
  ['"\uD55C abc"', 0],
  ['"abc abc"', 0],
  ['"\u6771\u4EAC\u6771\u4EAC"', 0],
  ['"\u6771\u4EAC \u4EAC\u90FD"', 0],
  ['x -\uAC80\uC0C9', 1],
  ['\u30AB', 0],
  ['\uFF21\uFF22', 0],
  ['"ab cd"', 0],
  ['abc\u65E5\u672Cxyz', 0],
  ['"\u{20000}\u{20001}x"', 0],
]

const termAt = (a: unknown[]): QueryTerm => {
  const parsed = tk.parseQuery(str(a, 0))
  return [...parsed.include, ...parsed.exclude][a[1] as number]!
}

const matchQueries: [string, string | undefined][] = [
  ['a b', undefined],
  ['a b', 'OR'],
  ['a b', 'AND'],
  ['-x y', undefined],
  ['-x', undefined],
  ['', undefined],
  ['a -b -c', undefined],
  ['a -b -c', 'OR'],
  ['\uD55C x', undefined],
  ['"a b"', undefined],
  ['hello \uD55C\uAD6D\uC5B4 -\uAC80', 'OR'],
  ['x', 'XOR'],
]

// ---------------------------------------------------------------------------
// scan, folder-tree: folders
// ---------------------------------------------------------------------------

const treeFiles: Record<string, FileSpec> = {
  'a.docx': file(1),
  'b.txt': file(2),
  'c.png': file(3),
  'sub/d.pdf': file(4),
  'sub/deeper/e.md': file(5),
  '.hidden/f.docx': file(6),
  'node_modules/g.docx': file(7),
  '~$lock.docx': file(8),
  '.dotfile.docx': file(9),
  'Thumbs.db': file(10),
  '__MACOSX/h.docx': file(11),
  'x.drawio.svg': file(12),
  'X.DOCX': file(13),
  'assets/img.docx': file(14),
  'owned/assets/y.docx': file(15),
  'owned/assets/.seuoffice-assets.json': file(16, '{}'),
  'old/assets/.genoffice-assets.json': file(17, '{}'),
  'old/assets/z.docx': file(18),
  'plain/assets/.other.json': file(19, '{}'),
  'plain/assets/w.docx': file(20),
}

const deepFiles: Record<string, FileSpec> = {
  'top.docx': file(1),
  'a/one.docx': file(2),
  'a/b/two.docx': file(3),
  'a/b/c/three.docx': file(4),
  'a/b/c/d/four.docx': file(5),
}

const manyFiles: Record<string, FileSpec> = {
  'f1.docx': file(1),
  'f2.docx': file(2),
  'f3.docx': file(3),
  'f4.docx': file(4),
  'f5.docx': file(5),
}

const orderFiles: Record<string, FileSpec> = {
  'b.docx': file(1),
  'a.docx': file(2),
  '10.docx': file(3),
  '2.docx': file(4),
  'B.docx': file(5),
  '\uD55C.docx': file(6),
  '\u00E9.docx': file(7),
  'z.docx': file(8),
}

const scanCases: Case[] = [
  { args: ['$DIR'], files: treeFiles },
  { args: ['$DIR', {}], files: treeFiles },
  { args: ['$DIR', { maxDepth: 0 }], files: deepFiles },
  { args: ['$DIR', { maxDepth: 1 }], files: deepFiles },
  { args: ['$DIR', { maxDepth: 2 }], files: deepFiles },
  { args: ['$DIR', { maxDepth: 4 }], files: deepFiles, note: 'depth 4 is the deepest folder' },
  { args: ['$DIR', { maxDepth: 3 }], files: deepFiles },
  { args: ['$DIR', { maxDepth: -1 }], files: deepFiles },
  { args: ['$DIR'], files: deepFiles },
  { args: ['$DIR', { maxFiles: 3 }], files: manyFiles },
  { args: ['$DIR', { maxFiles: 5 }], files: manyFiles, note: 'the budget is the count: not cut' },
  { args: ['$DIR', { maxFiles: 6 }], files: manyFiles },
  { args: ['$DIR', { maxFiles: 0 }], files: manyFiles },
  {
    args: ['$DIR', { maxFiles: 5 }],
    files: { ...manyFiles, 'zz.png': file(9) },
    note: 'an unsupported entry after the last file still sees the full budget',
  },
  { args: ['$DIR', { maxFiles: 2, maxDepth: 1 }], files: { ...manyFiles, 'q/r.docx': file(7) } },
  { args: ['$DIR'], files: {} },
  { args: ['$DIR/missing'], files: {} },
  { args: ['$DIR/plain.docx'], files: { 'plain.docx': file(1) }, note: 'the root is a file' },
  { args: ['$DIR'], files: orderFiles },
  {
    args: ['$DIR', links(['$DIR/ln.docx', '$DIR/real.docx'], ['$DIR/lndir', '$DIR/dir'])],
    files: { 'real.docx': file(1), 'dir/in.docx': file(2) },
    note: 'a symlinked file and a symlinked folder are not followed',
  },
  { args: ['$DIR'], files: { 'empty.docx': file(1, ''), 'e/.keep': file(2) } },
]

const statCases: Case[] = [
  { args: ['$DIR/a.docx'], files: { 'a.docx': file(1, 'hello') } },
  { args: ['$DIR/a.docx'], files: { 'a.docx': file(2, '') } },
  { args: ['$DIR/d'], files: { 'd/x': file(1) } },
  { args: ['$DIR/missing'] },
  {
    args: ['$DIR/ln', links(['$DIR/ln', '$DIR/a.docx'])],
    files: { 'a.docx': file(3, 'abc') },
    note: 'stat follows a link to a file',
  },
  {
    args: ['$DIR/lnd', links(['$DIR/lnd', '$DIR/d'])],
    files: { 'd/x': file(1) },
    note: 'a link to a folder is no file',
  },
  { args: ['$DIR/\uD55C \u{1F600}.txt'], files: { '\uD55C \u{1F600}.txt': file(4, '\u00E9') } },
]

const E = {
  badArgs: 'E_ARGS',
  badName: 'E_NAME',
  missing: 'E_MISSING',
  exists: 'E_EXISTS',
  failed: 'E_FAILED',
}

const hiddenCases: Case[] = [
  { args: ['$DIR', '.git', true] },
  { args: ['$DIR', '.env', false] },
  { args: ['$DIR', '~$doc.docx', false] },
  { args: ['$DIR', '~$dir', true] },
  { args: ['$DIR', 'node_modules', true] },
  { args: ['$DIR', 'NODE_MODULES', true] },
  { args: ['$DIR', 'node_modules', false] },
  { args: ['$DIR', '__MACOSX', true] },
  { args: ['$DIR', '__macosx', true] },
  { args: ['$DIR', 'Thumbs.db', false] },
  { args: ['$DIR', 'thumbs.db', true] },
  { args: ['$DIR', 'Desktop.ini', false] },
  { args: ['$DIR', 'readme.md', false] },
  { args: ['$DIR', 'docs', true] },
  { args: ['$DIR', 'assets', true], files: {} },
  { args: ['$DIR', 'assets', true], files: { 'assets/.seuoffice-assets.json': file(1, '{}') } },
  { args: ['$DIR', 'Assets', true], files: { 'Assets/.genoffice-assets.json': file(1, '{}') } },
  { args: ['$DIR', 'assets', true], files: { 'assets/other.json': file(1, '{}') } },
  { args: ['$DIR', 'assets', false], files: { 'assets/.seuoffice-assets.json': file(1, '{}') } },
  { args: ['$DIR', 'images', true], files: { 'images/.seuoffice-assets.json': file(1, '{}') } },
]

const rootFiles: Record<string, FileSpec> = {
  'root/in.docx': file(1),
  'root/sub/deep.docx': file(2),
  'root2/x.docx': file(3),
  'out/o.docx': file(4),
  root: dirAt(5),
}

const insideCases: Case[] = [
  { args: ['$DIR/root', '$DIR/root/in.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root/'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root/new/deeper/file.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root2/x.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/out/o.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root/../out/o.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/root/sub/../in.docx'], files: rootFiles },
  { args: ['$DIR/root', '$DIR/rooted/new.docx'], files: rootFiles },
  { args: ['$DIR/missing', '$DIR/missing/x.docx'], files: rootFiles },
  { args: ['$DIR/missing', '$DIR/root/in.docx'], files: rootFiles },
  {
    args: ['$DIR/root', '$DIR/root/ln/o.docx', links(['$DIR/root/ln', '$DIR/out'])],
    files: rootFiles,
    note: 'a link inside the root that points outside',
  },
  {
    args: ['$DIR/root', '$DIR/root/lnin/deep.docx', links(['$DIR/root/lnin', '$DIR/root/sub'])],
    files: rootFiles,
    note: 'a link inside the root that points inside',
  },
  {
    args: ['$DIR/rootln', '$DIR/root/in.docx', links(['$DIR/rootln', '$DIR/root'])],
    files: rootFiles,
    note: 'the root itself is a link',
  },
  { args: ['/', '/'] },
  { args: ['/', '$DIR/x'] },
]

const describeCases: Case[] = [
  { args: ['$DIR/root'], files: { 'root/a.docx': file(1) } },
  { args: ['$DIR/new/nested/root'], files: {} },
  { args: ['$DIR/file.txt'], files: { 'file.txt': file(1) }, note: 'the root is a file' },
  { args: ['$DIR/file.txt/under'], files: { 'file.txt': file(1) } },
  { args: ['$DIR/ro'], files: { ro: { dir: true, mode: 0o555 } } },
  { args: ['$DIR/ro/new'], files: { ro: { dir: true, mode: 0o555 } } },
  { args: ['$DIR/\uD55C\uAE00 \u{1F600}'], files: {} },
  { args: ['/'], files: {} },
  { args: ['$DIR/trailing/'], files: {} },
]

const listFiles: Record<string, FileSpec> = {
  'a.docx': file(1, 'aa'),
  'b.pdf': file(5, 'bbbb'),
  'c.png': file(9),
  'd.txt': file(5, 'd'),
  '.hidden.docx': file(6),
  '~$lock.docx': file(7),
  'e.drawio.svg': file(3),
  'sub10/f.docx': file(1),
  'sub2/f.docx': file(1),
  'Sub1/g.docx': file(1),
  'alpha/inner/h.docx': file(1),
  'alpha/z.docx': file(1),
  'beta/z.docx': file(1),
  'gamma/.hidden/x': file(1),
  'node_modules/m.js': file(1),
  'assets/.seuoffice-assets.json': file(1, '{}'),
  'plain/assets/p.docx': file(1),
  sub10: dirAt(10),
  sub2: dirAt(20),
  Sub1: dirAt(30),
  'alpha/inner': dirAt(40),
  alpha: dirAt(50),
  beta: dirAt(60),
  gamma: dirAt(70),
  'plain/assets': dirAt(75),
  plain: dirAt(80),
  node_modules: dirAt(90),
  assets: dirAt(95),
}

const listCases: Case[] = [
  { args: ['$DIR', []], files: listFiles },
  { args: ['$DIR', ['$DIR/a.docx', '$DIR/b.pdf', '$DIR/gone.docx']], files: listFiles },
  { args: ['$DIR/missing', []], files: {} },
  { args: ['$DIR/file.docx', []], files: { 'file.docx': file(1) }, note: 'the folder is a file' },
  { args: ['$DIR', []], files: {} },
  { args: ['$DIR/alpha', []], files: listFiles },
  { args: ['$DIR/gamma', []], files: listFiles },
  {
    args: ['$DIR', [], links(['$DIR/lnd', '$DIR/real'], ['$DIR/lnf.docx', '$DIR/real.docx'])],
    files: { real: dirAt(5), 'real.docx': file(1) },
    note: 'links are neither folders nor files of the listing',
  },
  {
    args: ['$DIR', []],
    files: { 'ab.docx': file(1), 'ac.docx': file(1), 'aa.docx': file(1) },
    note: 'equal mtimes keep the folder order',
  },
  {
    args: ['$DIR', []],
    files: {
      a10: dirAt(1),
      a9: dirAt(1),
      a010: dirAt(1),
      A1: dirAt(1),
      'a-1': dirAt(1),
      b: dirAt(1),
      '\uD55C': dirAt(1),
      '\u00E9': dirAt(1),
      e: dirAt(1),
      E: dirAt(1),
    },
  },
]

const pathsUnderCases: Case[] = [
  { args: ['/w/src', ['/w/src', '/w/src/a', '/w/src/b/c', '/w/src2/f', '/w', '/x/w/src/a']] },
  { args: ['/w/src/', ['/w/src/a', '/w/src/']] },
  { args: ['/w/src', ['/w/src/a', '/w/src/a', '/w/src/../src/a', '/w/src/x/..']] },
  { args: ['/w/src', []] },
  { args: ['/', ['/a', '/', '/b/c']] },
  { args: ['/w/src', ['/w/src/./a/', '/w/src//b']] },
  { args: ['/w/\uD55C\uAE00', ['/w/\uD55C\uAE00/\u{1F600}.docx', '/w/\uD55C\uAE00x']] },
  {
    args: ['/w/src', ['/w/src/a', '/w/src/a/../a']],
    note: 'the same path twice, written two ways',
  },
]

const createCases: Case[] = [
  { args: ['$DIR', 'New', E], files: {} },
  { args: ['$DIR', '  Padded  ', E], files: {} },
  { args: ['$DIR', 'a/b', E], files: {} },
  { args: ['$DIR', '', E], files: {} },
  { args: ['$DIR', '   ', E], files: {} },
  { args: ['$DIR', 'CON', E], files: {} },
  { args: ['$DIR', 'dots.', E], files: {} },
  { args: ['$DIR', 'name', E], files: { name: { dir: true } } },
  { args: ['$DIR', 'name', E], files: { name: 'a file' } },
  { args: ['$DIR/missing', 'x', E], files: {} },
  { args: ['$DIR/f.txt', 'x', E], files: { 'f.txt': 'a file' }, note: 'the parent is a file' },
  { args: ['$DIR/ro', 'x', E], files: { ro: { dir: true, mode: 0o555 } } },
  {
    args: ['$DIR', '\uD55C'.repeat(100), E],
    files: {},
    note: 'short in characters, over 255 bytes',
  },
  { args: ['$DIR', '\uD55C\uAE00 \u{1F600}', E], files: {} },
  { args: ['$DIR', 'x'.repeat(255), E], files: {} },
  { args: ['$DIR', 'x'.repeat(256), E], files: {} },
]

const uniqueCases: Case[] = [
  { args: ['$DIR', 'free.docx'], files: {} },
  { args: ['$DIR', 'a.docx'], files: { 'a.docx': 'x' } },
  { args: ['$DIR', 'a.docx'], files: { 'a.docx': 'x', 'a (2).docx': 'x' } },
  { args: ['$DIR', 'a.docx'], files: { 'a.docx': 'x', 'a (3).docx': 'x' }, note: 'a gap at 2' },
  { args: ['$DIR', 'flow.drawio.svg'], files: { 'flow.drawio.svg': 'x' } },
  { args: ['$DIR', 'FLOW.DRAWIO.PNG'], files: { 'FLOW.DRAWIO.PNG': 'x' } },
  {
    args: ['$DIR', 'flow.drawio.svg'],
    files: { 'flow.drawio.svg': 'x', 'flow (2).drawio.svg': 'x' },
  },
  { args: ['$DIR', 'v1.0', true], files: { 'v1.0': { dir: true } } },
  { args: ['$DIR', 'v1.0', false], files: { 'v1.0': 'x' } },
  { args: ['$DIR', 'v1.0'], files: { 'v1.0': 'x' } },
  { args: ['$DIR', 'noext'], files: { noext: 'x' } },
  { args: ['$DIR', '.hidden'], files: { '.hidden': 'x' } },
  { args: ['$DIR', 'a.b.c'], files: { 'a.b.c': 'x' } },
  { args: ['$DIR', 'a.tar.gz'], files: { 'a.tar.gz': 'x' } },
  { args: ['$DIR', '\u{1F600}.docx'], files: { '\u{1F600}.docx': 'x' } },
  { args: ['$DIR', '\uD55C\uAE00.docx'], files: { '\uD55C\uAE00.docx': 'x' } },
  { args: ['$DIR', 'folder', true], files: { folder: { dir: true }, 'folder (2)': { dir: true } } },
  { args: ['$DIR', 'x.drawio.svg', true], files: { 'x.drawio.svg': { dir: true } } },
  { args: ['$DIR', 'trail.'], files: { 'trail.': 'x' } },
]

const treeLayout: Record<string, FileSpec> = {
  'src/a.docx': { text: 'a' },
  'src/dir/inner.txt': { text: 'inner' },
  'src/dir/sub/deep.txt': { text: 'deep', mode: 0o600 },
  'src/empty': { dir: true },
  'dst/other.txt': { text: 'other' },
}

const moveOnDiskCases: Case[] = [
  { args: ['$DIR/src/a.docx', '$DIR/dst/a.docx'], files: treeLayout },
  { args: ['$DIR/src/dir', '$DIR/dst/dir'], files: treeLayout },
  { args: ['$DIR/src/nope', '$DIR/dst/nope'], files: treeLayout, note: 'a missing source' },
  { args: ['$DIR/src/a.docx', '$DIR/dst/none/a.docx'], files: treeLayout },
  {
    args: ['$DIR/src/a.docx', '$DIR/dst/other.txt'],
    files: treeLayout,
    note: 'a file onto a file replaces it',
  },
  { args: ['$DIR/src/dir', '$DIR/dst/other.txt'], files: treeLayout },
  { args: ['$DIR/src/a.docx', '$DIR/src/dir'], files: treeLayout },
  { args: ['$DIR/src/a.docx', '$DIR/dst/a.docx', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/dir', '$DIR/dst/dir', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/empty', '$DIR/dst/empty', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/nope', '$DIR/dst/nope', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/a.docx', '$DIR/dst/other.txt', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/a.docx', '$DIR/dst/deep/er/a.docx', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/dir', '$DIR/dst/other.txt', 'xdev'], files: treeLayout },
  { args: ['$DIR/src/a.docx', '$DIR/src/dir', 'xdev'], files: treeLayout },
  {
    args: ['$DIR/src/dir', '$DIR/dst/dir', 'xdev'],
    files: { ...treeLayout, 'dst/dir/inner.txt': { text: 'there' } },
    note: 'a folder merged into one that holds the same file',
  },
  {
    args: ['$DIR/src/dir', '$DIR/dst/dir', 'xdev'],
    files: { ...treeLayout, 'dst/dir/keep.txt': { text: 'keep' } },
    note: 'a folder merged into one that holds other files',
  },
  { args: ['$DIR/src/a.docx', '$DIR/dst/a.docx', 'xdev-eacces'], files: treeLayout },
  { args: ['$DIR/src/dir', '$DIR/dst/dir', 'xdev-eacces'], files: treeLayout },
]

const selfCases: Case[] = [
  { args: ['/w/a', '/w/a'] },
  { args: ['/w/a', '/w/a/b'] },
  { args: ['/w/a', '/w/ab'] },
  { args: ['/w/a/b', '/w/a'] },
  { args: ['/w/a/', '/w/a/b/c'] },
  { args: ['/', '/anything'] },
  { args: ['/w/a', '/w/a/../a/x'] },
  { args: ['/w/a', '/w/b'] },
]

const moveLayout: Record<string, FileSpec> = {
  'from/a.docx': { text: 'a-from' },
  'from/b.docx': { text: 'b-from' },
  'from/dir/in.txt': { text: 'in' },
  'from/v1.0/x.txt': { text: 'v' },
  'to/v1.0': { dir: true },
  'to/a.docx': { text: 'a-to' },
  'to/dir/old.txt': { text: 'old' },
  'to/dir (2)': { dir: true },
  'to/c.docx': { text: 'c-to' },
  'other/d.docx': { text: 'd' },
  'other/e.docx': { text: 'e' },
}

const moveCase = (
  paths: string[],
  policy: string,
  mode?: string,
  files: Record<string, FileSpec> = moveLayout,
  target = '$DIR/to',
  note?: string,
): Case => ({
  args: [paths.map((p) => `$DIR/${p}`), target, policy, E, mode],
  files,
  note,
})

const movesCases: Case[] = [
  moveCase(['from/b.docx'], 'ask'),
  moveCase(['from/a.docx'], 'ask'),
  moveCase(['from/a.docx'], 'skip'),
  moveCase(['from/a.docx'], 'keepBoth'),
  moveCase(['from/a.docx', 'from/b.docx'], 'keepBoth'),
  moveCase(['from/dir'], 'keepBoth'),
  moveCase(['from/v1.0'], 'keepBoth'),
  moveCase(['from/dir'], 'ask'),
  moveCase(['from/a.docx'], 'replace'),
  moveCase(['from/dir'], 'replace'),
  moveCase(['from/a.docx'], 'replace', 'throw'),
  moveCase(['from/a.docx'], 'replace', 'throwValue'),
  moveCase(['from/a.docx'], 'replace', 'commitThrows'),
  moveCase(['from/a.docx'], 'replace', 'rollbackThrows'),
  moveCase(['from/a.docx'], 'bogus'),
  moveCase(['from/nope.docx', 'from/b.docx'], 'ask'),
  moveCase(['from/b.docx'], 'ask', undefined, moveLayout, '$DIR/missing'),
  moveCase(['from/nope.docx', 'other/d.docx'], 'replace', undefined, moveLayout, '$DIR/missing'),
  moveCase(['to/c.docx'], 'ask', undefined, moveLayout, '$DIR/to', 'already inside the target'),
  moveCase(['to/../to/c.docx'], 'ask', undefined, moveLayout, '$DIR/to/'),
  moveCase(['from'], 'ask', undefined, moveLayout, '$DIR/from/dir', 'a folder into itself'),
  moveCase(
    ['from'],
    'ask',
    undefined,
    moveLayout,
    '$DIR/from',
    'a folder into its own parent is a no-op',
  ),
  moveCase(['from/dir'], 'ask', undefined, moveLayout, '$DIR/from/dir'),
  moveCase(['from', 'other/d.docx'], 'ask', undefined, moveLayout, '$DIR/from/dir/deeper'),
  moveCase(['other/d.docx', 'other/e.docx'], 'ask', undefined, moveLayout, '$DIR/to'),
  moveCase([], 'ask'),
  moveCase(['from/a.docx'], 'ask', undefined, { ...moveLayout, to: { dir: true, mode: 0o555 } }),
  moveCase(
    ['from/b.docx'],
    'ask',
    undefined,
    { ...moveLayout, to: { dir: true, mode: 0o555 } },
    '$DIR/to',
    'the target is read-only',
  ),
  moveCase(['from/a.docx'], 'keepBoth', undefined, {
    ...moveLayout,
    'to/a (2).docx': { text: 'x' },
  }),
  moveCase(['from/dir'], 'keepBoth', undefined, { ...moveLayout, 'to/dir (3)': { dir: true } }),
  moveCase(
    ['to/dir'],
    'ask',
    undefined,
    { ...moveLayout },
    '$DIR/to/dir/new',
    'the target does not exist',
  ),
]

const renameCases: Case[] = [
  { args: ['$DIR/old', 'new', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', '  new  ', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', 'old', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', ' old ', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', 'Old', E], files: { 'old/x.txt': 'x' }, note: 'a change of case only' },
  {
    args: ['$DIR/a.txt', 'b.txt', E],
    files: { 'a.txt': 'x', 'b.txt': { link: 'a.txt' } },
    note: 'the target is the same entry as the source',
  },
  { args: ['$DIR/old', 'taken', E], files: { 'old/x.txt': 'x', taken: { dir: true } } },
  { args: ['$DIR/old', 'taken', E], files: { 'old/x.txt': 'x', taken: 'file' } },
  { args: ['$DIR/old', 'a/b', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', '', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/old', 'NUL', E], files: { 'old/x.txt': 'x' } },
  { args: ['$DIR/missing', 'new', E], files: {} },
  { args: ['$DIR/old', '\uD55C\uAE00 \u{1F600}', E], files: { 'old/x.txt': 'x' } },
  {
    args: ['$DIR/lock/old', 'new', E],
    files: { 'lock/old/x': 'x', lock: { dir: true, mode: 0o555 } },
  },
  { args: ['$DIR/file.txt', 'renamed.txt', E], files: { 'file.txt': 'x' } },
  { args: ['$DIR/old', '\uD55C'.repeat(100), E], files: { 'old/x.txt': 'x' } },
]

const rebaseCases: Case[] = [
  { args: ['/w/src/a/f.docx', '/w/src', '/w/dst'] },
  { args: ['/w/src', '/w/src', '/w/dst'] },
  { args: ['/w/src2/f', '/w/src', '/w/dst'] },
  { args: ['/w/other/f', '/w/src', '/w/dst'] },
  { args: ['/w/src/a/../b/f', '/w/src', '/w/dst'] },
  { args: ['/w/src/f', '/w/src/', '/w/dst/'] },
  { args: ['/w/src/f', '/w/src', '/'] },
  { args: ['/f', '/', '/new'] },
  { args: ['/w/\uD55C\uAE00/\u{1F600}.docx', '/w/\uD55C\uAE00', '/x/\uC0C8'] },
  { args: ['/w/src/a/f', '/w/src', '/w/dst/../x'] },
]

// ---------------------------------------------------------------------------
// the watcher scenario
// ---------------------------------------------------------------------------

interface WatcherOp {
  op: 'event' | 'fire' | 'error' | 'close' | 'active'
  filename?: string | null
}
interface WatcherWorld {
  root: string
  watchOk?: boolean
  ops: WatcherOp[]
}

function watcherRun(world: WatcherWorld, cx: TsContext): unknown {
  const TOKEN = { timer: true }
  let pending: (() => void) | null = null
  let errorHandler: (() => void) | undefined
  let listener: ((event: string, filename: string | null) => void) | undefined
  const realWatch = fs.watch
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  fsMut.watch = ((root: string, _options: unknown, callback: typeof listener) => {
    cx.log('watch', root)
    if (world.watchOk === false) throw new Error('watch failed')
    listener = callback
    return {
      on(event: string, handler: () => void) {
        if (event === 'error') errorHandler = handler
      },
      close() {
        cx.log('watcher.close')
      },
    }
  }) as never
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    cx.log('setTimeout', ms)
    pending = callback
    return TOKEN
  }) as never
  globalThis.clearTimeout = ((token: unknown) => {
    cx.log('clearTimeout')
    if (token === TOKEN) pending = null
  }) as never
  try {
    const watcher = new tree.FolderWatcher(world.root, (dirs) => cx.log('onChange', dirs))
    const results: unknown[] = []
    for (const op of world.ops) {
      let result: unknown = null
      if (op.op === 'event') listener?.('change', op.filename ?? null)
      else if (op.op === 'fire') {
        const callback = pending as (() => void) | null
        pending = null
        callback?.()
      } else if (op.op === 'error') errorHandler?.()
      else if (op.op === 'close') watcher.close()
      else result = watcher.active
      results.push(result)
    }
    return results
  } finally {
    fsMut.watch = realWatch
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
}

const wc = (world: WatcherWorld, files: Record<string, FileSpec> = watcherFiles): Case => ({
  args: [world],
  files,
})
const watcherFiles: Record<string, FileSpec> = {
  'root/a.txt': 'a',
  'root/sub/inner.txt': 'i',
  'root/sub/deeper/x': 'x',
}
const ev = (filename: string | null): WatcherOp => ({ op: 'event', filename })
const fire: WatcherOp = { op: 'fire' }
const active: WatcherOp = { op: 'active' }

const watcherCases: Case[] = [
  wc({ root: '$DIR/root', ops: [ev('a.txt'), ev('sub'), fire, active] }),
  wc({ root: '$DIR/root', ops: [ev(null), ev('ghost/x'), fire] }),
  wc({ root: '$DIR/root', ops: [ev('a.txt'), ev('sub/inner.txt'), { op: 'close' }, fire, active] }),
  wc({ root: '$DIR/root', ops: [ev('a.txt'), { op: 'error' }, active, fire] }),
  wc({ root: '$DIR/root', watchOk: false, ops: [active, { op: 'close' }, { op: 'error' }, fire] }),
  wc({ root: '$DIR/root', ops: [ev('a.txt'), ev('a.txt'), ev('a.txt'), fire, fire] }),
  wc({ root: '$DIR/root', ops: [fire, active] }),
  wc({ root: '$DIR/root', ops: [{ op: 'close' }, { op: 'close' }, ev('sub'), fire, active] }),
  wc({ root: '$DIR/root', ops: [ev('sub/deeper'), fire, ev('sub/deeper/x'), fire] }),
  wc({ root: '$DIR/root', ops: [ev(''), fire] }),
  wc({ root: '$DIR/root/', ops: [ev('a.txt'), fire] }),
  wc({ root: '$DIR/root', ops: [ev('sub'), ev('a.txt'), ev('sub'), fire] }),
]

// ---------------------------------------------------------------------------
// extract and the worker
// ---------------------------------------------------------------------------

interface ParseWorld {
  redact?: 'mark' | { throw: string } | { throwValue: string }
  parse?:
    | { kind?: string; ok?: boolean; text?: string; error?: string }
    | { throw: string }
    | { throwValue: string }
}

function throwing(thrown: { throw?: string; throwValue?: string }): never {
  if (thrown.throw !== undefined) throw new Error(thrown.throw)
  throw thrown.throwValue
}

function useWorld(world: ParseWorld | null | undefined, cx: TsContext): void {
  box.redact = (source) => {
    cx.log('redactHtmlSource', source.length)
    const redact = world?.redact
    if (redact === 'mark') return source.split('SECRET').join('{{private}}')
    if (redact && typeof redact === 'object') throwing(redact)
    return source
  }
  box.parse = (path) => {
    cx.log('parseFileToText', path)
    const parse = world?.parse
    if (!parse) return { ok: true, kind: 'text', text: '' }
    if ('throw' in parse || 'throwValue' in parse) throwing(parse)
    return parse
  }
}

const okText = (text: string): ParseWorld => ({ parse: { kind: 'text', ok: true, text } })
const htmlPage =
  '<html><head><style>p { color: red }</style><script>var x = "<b>";</script></head>' +
  '<body><p>Hello&nbsp;&amp;&lt;b&gt; &quot;q&quot; it&#39;s</p><SCRIPT type="x">drop</SCRIPT>tail</body></html>'

const extractCases: Case[] = [
  { args: ['$DIR/p.html', {}], files: { 'p.html': htmlPage } },
  { args: ['$DIR/p.htm', {}], files: { 'p.htm': '<b>x</b>' } },
  { args: ['$DIR/P.HTML', {}], files: { 'P.HTML': '<b>upper</b>' } },
  { args: ['$DIR/p.html', { redact: 'mark' }], files: { 'p.html': '<p>SECRET one</p> SECRET' } },
  { args: ['$DIR/p.html', { redact: { throw: 'bad mark' } }], files: { 'p.html': '<p>x</p>' } },
  {
    args: ['$DIR/p.html', { redact: { throwValue: 'bad value' } }],
    files: { 'p.html': '<p>x</p>' },
  },
  { args: ['$DIR/p.html', {}], files: { 'p.html': '<script>unclosed <b>x</b>' } },
  { args: ['$DIR/p.html', {}], files: { 'p.html': '&amp;lt; &amp;amp; &nbsp;&nbsp;x' } },
  { args: ['$DIR/p.html', {}], files: { 'p.html': '<STYLE>a{}</STYLE>one<style>b{}</Style>two' } },
  {
    args: ['$DIR/p.html', {}],
    files: { 'p.html': '\uD55C\uAD6D\uC5B4 <b>\u6771\u4EAC</b> \u{1F600}' },
  },
  {
    args: ['$DIR/p.html', {}],
    files: { 'p.html': 'a'.repeat(1_100_000) },
    note: 'cut at 1,000,000',
  },
  {
    args: ['$DIR/p.html', {}],
    files: { 'p.html': 'a'.repeat(1_000_000) },
    note: 'exactly the cut',
  },
  { args: ['$DIR/p.html', {}], files: { 'p.html': '<p>' + 'b'.repeat(1_100_000) + '</p>' } },
  { args: ['$DIR/p.html', {}], files: { 'p.html': '' } },
  {
    args: ['$DIR/p.html', {}],
    files: { 'p.html': { hex: 'ff3c623e78' + '3c2f623e' } },
    note: 'ill-formed bytes',
  },
  {
    args: ['$DIR/p.html', {}],
    files: { 'p.html': { dir: true } },
    note: 'a folder named like a page',
  },
  { args: ['$DIR/a.txt', okText('hello')], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', {}], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', { parse: { kind: 'unsupported', ok: true } }], files: { 'a.txt': 'x' } },
  {
    args: ['$DIR/a.txt', { parse: { kind: 'unsupported', ok: false, error: 'e' } }],
    files: { 'a.txt': 'x' },
  },
  { args: ['$DIR/a.png', { parse: { kind: 'image', ok: true } }], files: { 'a.png': 'x' } },
  {
    args: ['$DIR/a.png', { parse: { kind: 'image', ok: true, error: 'img' } }],
    files: { 'a.png': 'x' },
  },
  {
    args: ['$DIR/a.txt', { parse: { kind: 'text', ok: false, error: 'boom' } }],
    files: { 'a.txt': 'x' },
  },
  { args: ['$DIR/a.txt', { parse: { kind: 'text', ok: false } }], files: { 'a.txt': 'x' } },
  {
    args: ['$DIR/a.txt', { parse: { kind: 'text', ok: false, error: '' } }],
    files: { 'a.txt': 'x' },
  },
  { args: ['$DIR/a.txt', { parse: { kind: 'text', ok: true } }], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', okText('z'.repeat(1_000_001))], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', okText('\uD55C'.repeat(1_000_001))], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', { parse: { throw: 'parser blew up' } }], files: { 'a.txt': 'x' } },
  { args: ['$DIR/a.txt', { parse: { throwValue: 'not an error' } }], files: { 'a.txt': 'x' } },
  { args: ['$DIR/missing.txt', okText('x')], files: {} },
  { args: ['$DIR/missing.html', {}], files: {} },
  { args: ['$DIR/a.txt', okText('big'), 67_108_864], note: 'exactly the limit' },
  { args: ['$DIR/a.txt', okText('big'), 67_108_865], note: 'one past the limit' },
  { args: ['$DIR/a.html', {}, 67_108_865], note: 'a page past the limit is name only' },
  { args: ['$DIR/a', okText('noext')], files: { a: 'x' } },
  { args: ['$DIR/.html', okText('dot only')], files: { '.html': '<b>x</b>' } },
  { args: ['$DIR/page.xhtml', okText('xhtml')], files: { 'page.xhtml': '<b>x</b>' } },
  { args: ['$DIR/d.txt', okText('dir')], files: { 'd.txt': { dir: true } } },
]

const worldCases = (a: ParseWorld, files: Record<string, FileSpec>, request: unknown): Case => ({
  args: [request, a],
  files,
})

const workerCases: Case[] = [
  worldCases(okText('body'), { 'a.txt': 'x' }, { id: 1, type: 'extract', path: '$DIR/a.txt' }),
  worldCases({}, { 'p.html': '<b>x</b>' }, { id: 0, type: 'extract', path: '$DIR/p.html' }),
  worldCases({}, {}, { id: 7, type: 'extract', path: '$DIR/missing.txt' }),
  worldCases(
    { parse: { kind: 'unsupported' } },
    { 'a.bin': 'x' },
    { id: 2, type: 'extract', path: '$DIR/a.bin' },
  ),
  worldCases({}, treeFiles, { id: 3, type: 'scan', root: '$DIR' }),
  worldCases({}, {}, { id: 4, type: 'scan', root: '$DIR' }),
  worldCases({}, {}, { id: 5, type: 'scan', root: '$DIR/missing' }),
  worldCases(
    {},
    { 'a.docx': file(1), 'sub/b.pdf': file(2) },
    { id: 99, type: 'scan', root: '$DIR' },
  ),
  worldCases(
    { parse: { throw: 'died' } },
    { 'a.txt': 'x' },
    { id: 6, type: 'extract', path: '$DIR/a.txt' },
  ),
]

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

/** a spec whose first extra argument is stripped of its links before the call */
const linked = (ts: (a: unknown[], cx: TsContext) => unknown) => (a: unknown[], cx: TsContext) =>
  ts(takeLinks(a), cx)

function withRename(mode: unknown, run: () => unknown): unknown {
  if (mode !== 'xdev' && mode !== 'xdev-eacces') return run()
  const real = fs.renameSync
  const code = mode === 'xdev' ? 'EXDEV' : 'EACCES'
  const text = mode === 'xdev' ? 'cross-device link not permitted' : 'permission denied'
  fsMut.renameSync = ((from: string, to: string) => {
    throw Object.assign(new Error(`${code}: ${text}, rename '${from}' -> '${to}'`), { code })
  }) as never
  try {
    return run()
  } finally {
    fsMut.renameSync = real
  }
}

function parkOptions(mode: string, cx: TsContext) {
  return {
    replaceExisting(path: string) {
      cx.log('replaceExisting', path)
      if (mode === 'throw') throw new Error('park failed')
      if (mode === 'throwValue') throw 'park refused'
      const parked = `${path}.parked`
      fs.renameSync(path, parked)
      return {
        commit() {
          cx.log('commit')
          if (mode === 'commitThrows' || mode === 'rollbackThrows') throw new Error('commit failed')
          fs.rmSync(parked, { recursive: true, force: true })
        },
        rollback() {
          cx.log('rollback')
          if (mode === 'rollbackThrows') throw new Error('rollback failed')
          fs.renameSync(parked, path)
        },
      }
    },
  }
}

export const part: Group = {
  'text-marks.foldText': {
    ts: (a) => marks.foldText(str(a, 0)),
    cases: foldTexts.map((t): Case => ({ args: [t] })),
  },
  'text-marks.findRanges': {
    ts: (a) => {
      const allowed = a[2] as number[] | null | undefined
      return marks.findRanges(
        str(a, 0),
        a[1] as string[],
        allowed ? (at: number) => allowed.includes(at) : undefined,
      )
    },
    cases: findRangesCases,
  },
  'text-marks.findTextRanges': {
    ts: (a) => marks.findTextRanges(str(a, 0), a[1] as string[]),
    cases: textRangeCases,
  },
  'text-marks.markText': {
    ts: (a) => marks.markText(str(a, 0), a[1] as string[]),
    cases: markCases,
  },

  'snippet.buildSnippet': {
    ts: (a) => snippet.buildSnippet(str(a, 0), a[1] as string[]),
    cases: snippetCases,
  },
  'snippet.excerpt': {
    ts: (a) => snippet.excerpt(str(a, 0), a[1] as string[], a[2] as number),
    cases: excerptCases,
  },
  'snippet.containsAny': {
    ts: (a) => snippet.containsAny(str(a, 0), a[1] as string[]),
    cases: containsCases,
  },

  'tokenize.isCjk': {
    ts: (a) => tk.isCjk(a[0] as number),
    cases: [
      0x2e7f, 0x2e80, 0x2fdf, 0x2fe0, 0x3004, 0x3005, 0x3007, 0x3008, 0x303f, 0x3040, 0x30ff,
      0x3100, 0x312f, 0x3130, 0x318f, 0x3190, 0x31a0, 0x31ff, 0x33ff, 0x3400, 0x4dbf, 0x4dc0,
      0x4e00, 0x9fff, 0xa000, 0xa960, 0xa97f, 0xabff, 0xac00, 0xd7ff, 0xd800, 0xf900, 0xfaff,
      0xfb00, 0xff66, 0xff9f, 0xffa0, 0x1100, 0x11ff, 0x1200, 0x41, 0x20, 0x1ffff, 0x20000, 0x323af,
      0x323b0,
    ].map((cp): Case => ({ args: [cp] })),
  },
  'tokenize.tokenize': {
    ts: (a) => tk.tokenize(str(a, 0)),
    cases: tokenizeTexts.map((t): Case => ({ args: [t] })),
  },
  'tokenize.toIndexText': {
    ts: (a) => tk.toIndexText(a[0] as string[]),
    cases: [[], ['a'], ['a', 'b'], ['\uD55C\uAD6D', '\uC5B4'], ['a b', ''], ['', '']].map(
      (t): Case => ({ args: [t] }),
    ),
  },
  'tokenize.parseQuery': {
    ts: (a) => tk.parseQuery(str(a, 0)),
    cases: parseQueries.map((q): Case => ({ args: [q] })),
  },
  'tokenize.termExpr': {
    ts: (a) => tk.termExpr(termAt(a)),
    cases: termQueries.map(([q, i]): Case => ({ args: [q, i] })),
  },
  'tokenize.toMatchExpression': {
    ts: (a) => tk.toMatchExpression(tk.parseQuery(str(a, 0)), a[1] as 'AND' | 'OR' | undefined),
    cases: matchQueries.map(([q, j]): Case => ({ args: j === undefined ? [q] : [q, j] })),
  },
  'tokenize.tokenExprs': {
    ts: (a) => tk.tokenExprs(termAt(a)),
    cases: termQueries.map(([q, i]): Case => ({ args: [q, i] })),
  },
  'tokenize.termChars': {
    ts: (a) => tk.termChars(termAt(a)),
    cases: termQueries.map(([q, i]): Case => ({ args: [q, i] })),
  },
  'tokenize.foldText': {
    ts: (a) => tk.foldText(str(a, 0)),
    cases: foldTexts.map((t): Case => ({ args: [t] })),
  },

  'scan.SCAN_MAX_DEPTH': constant(scan.SCAN_MAX_DEPTH),
  'scan.SCAN_MAX_FILES': constant(scan.SCAN_MAX_FILES),
  'scan.scanFiles': {
    ts: linked((a) => scan.scanFiles(str(a, 0), a[1] as { maxDepth?: number; maxFiles?: number })),
    cases: scanCases,
  },
  'scan.statOrNull': {
    ts: linked((a) => scan.statOrNull(str(a, 0))),
    cases: statCases,
  },

  'folder-tree.TREE_FILE_EXTENSIONS': constant([...tree.TREE_FILE_EXTENSIONS]),
  'folder-tree.isSupportedTreeFile': {
    ts: (a) => tree.isSupportedTreeFile(str(a, 0)),
    cases: [
      'a.docx',
      'A.DOCX',
      'a.drawio.svg',
      'a.drawio.png',
      'A.Drawio.SVG',
      'a.svg',
      'a',
      '.docx',
      'a.tar.gz',
      'a.md',
      'a.Markdown',
      'x.html',
      'archive.zip',
      'a.drawio',
      'a.hwpx',
      'a.dot',
      'a.xlsm',
      'a.epub',
      'a.vsdx',
      'a.docx ',
      '\uD55C\uAE00.hwp',
      'a.\u{1F600}',
      '',
    ].map((n): Case => ({ args: [n] })),
  },
  'folder-tree.isHiddenEntry': {
    ts: (a) => tree.isHiddenEntry(str(a, 0), str(a, 1), a[2] as boolean),
    cases: hiddenCases,
  },
  'folder-tree.isInsideRoot': {
    ts: linked((a) => tree.isInsideRoot(str(a, 0), str(a, 1))),
    cases: insideCases,
  },
  'folder-tree.describeRoot': {
    ts: (a) => tree.describeRoot(str(a, 0)),
    cases: describeCases,
  },
  'folder-tree.listFolder': {
    ts: linked((a) => tree.listFolder(str(a, 0), new Set(a[1] as string[]))),
    cases: listCases,
  },
  'folder-tree.pathsUnder': {
    ts: (a) => tree.pathsUnder(str(a, 0), a[1] as string[]),
    cases: pathsUnderCases,
  },
  'folder-tree.createFolder': {
    ts: (a) => tree.createFolder(str(a, 0), str(a, 1), a[2] as typeof E),
    cases: createCases,
  },
  'folder-tree.uniqueNameIn': {
    ts: (a) => tree.uniqueNameIn(str(a, 0), str(a, 1), a[2] as boolean | undefined),
    cases: uniqueCases,
  },
  'folder-tree.moveOnDisk': {
    ts: (a) => withRename(a[2], () => tree.moveOnDisk(str(a, 0), str(a, 1))),
    cases: moveOnDiskCases,
  },
  'folder-tree.isSelfOrDescendant': {
    ts: (a) => tree.isSelfOrDescendant(str(a, 0), str(a, 1)),
    cases: selfCases,
  },
  'folder-tree.movePathsInto': {
    ts: (a, cx) =>
      tree.movePathsInto(
        a[0] as string[],
        str(a, 1),
        str(a, 2) as 'ask',
        a[3] as typeof E,
        parkOptions((a[4] as string | undefined) ?? 'park', cx),
      ),
    cases: movesCases,
  },
  'folder-tree.renameFolder': {
    ts: (a) => tree.renameFolder(str(a, 0), str(a, 1), a[2] as typeof E),
    cases: renameCases,
  },
  'folder-tree.rebasePath': {
    ts: (a) => tree.rebasePath(str(a, 0), str(a, 1), str(a, 2)),
    cases: rebaseCases,
  },
  'folder-tree.FolderWatcher': {
    ts: (a, cx) => watcherRun(a[0] as WatcherWorld, cx),
    cases: watcherCases,
  },

  'extract.MAX_EXTRACT_BYTES': constant(extract.MAX_EXTRACT_BYTES),
  'extract.MAX_BODY_CHARS': constant(extract.MAX_BODY_CHARS),
  'extract.extractText': {
    ts: async (a, cx) => {
      useWorld(a[1] as ParseWorld, cx)
      const path = str(a, 0)
      const sparse = a[2] as number | undefined
      if (sparse !== undefined) {
        fs.writeFileSync(path, '')
        fs.truncateSync(path, sparse)
      }
      try {
        return await extract.extractText(path)
      } finally {
        if (sparse !== undefined) fs.rmSync(path, { force: true })
      }
    },
    cases: extractCases,
  },
  'extract-worker.message': {
    ts: async (a, cx) => {
      useWorld(a[1] as ParseWorld, cx)
      box.posted.length = 0
      await box.handler!(a[0])
      return box.posted.pop()
    },
    cases: workerCases,
  },
}
