/**
 * Group `b3-projects`, part `foundation`: the path, ignore, memory,
 * folder-files, visibility and trust modules of apps/shell/src/main/projects/,
 * the pieces of packages/project-store they call, and the three functions of
 * other modules they reach (folder-tree, agent-sessions, user-skills sources).
 * The Rust side is crates/main-core/src/calls/b3_projects/foundation.rs.
 *
 * Names that are not an export of their file:
 * - `paths.pathApi` answers `{ sep, normalized, absolute, root, dirname,
 *   relative }` of the `node:path` flavour for the platform, on the path
 *   given and the relative path from it to a second one.
 * - `ignore.compileIgnore` answers `{ patterns, results }`: the matcher's
 *   patterns and `ignores(...probe)` of each probe (`[path]` or `[path, isDir]`).
 * - `memory.localDate` and `memory.memoryBackupName` take the parts of a
 *   local date `[year, month0, day, hours, minutes, seconds]`; the TypeScript
 *   builds the `Date` from them, the Rust gets the parts.
 * - `folder-api.MEMORY_BACKUP_PATTERN` tests one name with the pattern.
 * - `visibility.isAiVisiblePath` takes the text of the `ignore` file and
 *   whether case is folded, and compiles the matcher itself.
 * - `folder-files.realPlainFileIn` takes the project root as `canonicalPath`
 *   writes it (the real path), which both sides compute from the given root.
 *
 * The functions that read a folder take as their first argument a list of
 * links to make before the call, `[[linkPath, target], ...]`: the case's
 * files cannot hold a symbolic link.
 *
 * Which functions need Electron: none, but paths.ts reaches agent-sessions.ts,
 * so the fake of electron-fake.ts is registered first.
 */
import '../electron-fake.ts'
import { mkdirSync, symlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PROJECT_EDITORS,
  PROJECT_FORMAT_VERSION,
  PROJECT_NAME_MAX_CHARS,
  MEMORY_BACKUP_PATTERN,
} from '../../../packages/project-store/src/folder-api.ts'
import type { Case, FnSpec, Group } from '../types.ts'

const paths = await import('../../../apps/shell/src/main/projects/paths.ts')
const ignore = await import('../../../apps/shell/src/main/projects/ignore.ts')
const memory = await import('../../../apps/shell/src/main/projects/memory.ts')
const folderFiles = await import('../../../apps/shell/src/main/projects/folder-files.ts')
const visibility = await import('../../../apps/shell/src/main/projects/visibility.ts')
const trust = await import('../../../apps/shell/src/main/projects/trust.ts')
const folderTree = await import('../../../apps/shell/src/main/folder-tree.ts')
const agentSessions = await import('../../../apps/shell/src/main/agent/agent-sessions.ts')
const userSkills = await import('../../../packages/ai-provider/src/user-skills/sources.ts')
const scan = await import('../../../apps/shell/src/main/file-index/scan.ts')

type Platform = NodeJS.Platform
const platform = (value: unknown): Platform => value as Platform

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** a constant: its second case puts a file in the folder, so the two answers differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    single: 'a constant',
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

/** makes the links a case asks for before the call */
function makeLinks(links: unknown): void {
  for (const [link, target] of links as [string, string][]) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
  }
}

/** a function that reads a folder: its first argument is the list of links to make */
function onFolder(run: (...args: unknown[]) => unknown): FnSpec['ts'] {
  return (args) => {
    makeLinks(args[0])
    return run(...args.slice(1))
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * `folder` of the refusal functions is the canonical path: a POSIX absolute path is
 * canonicalized here (and by the Rust adapter), so the home and protected folders,
 * which the functions canonicalize themselves, compare as they do in the app.
 */
const canonicalFolder = (folder: string): string =>
  folder.startsWith('/') && folder !== '/' ? paths.canonicalPath(folder) : folder

const dateParts = (parts: unknown): Date => {
  const [year, month, day, hours, minutes, seconds] = parts as number[]
  const date = new Date(2000, 0, 1, 0, 0, 0, 0)
  date.setFullYear(year!, month!, day!)
  date.setHours(hours!, minutes!, seconds!, 0)
  return date
}

const refusalCtx = (home: string, data: string, plat: Platform) => ({
  homeDir: home,
  userData: data,
  platform: plat,
})

const refusalFiles: Case['files'] = {
  'home/.claude/x': { dir: true },
  'home/work/p': { dir: true },
  'data/sub': { dir: true },
  'f.txt': 'file',
  'home/.ieumoffice/s': { dir: true },
  'proj/docs': { dir: true },
}

const refusalCases = (extra: Case[] = []): Case[] => [
  {
    args: ['$DIR/home/work/p', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'a plain folder under the home folder',
  },
  {
    args: ['$DIR/home', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'the home folder itself',
  },
  {
    args: ['$DIR/home/.claude/x', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'inside a protected folder',
  },
  {
    args: ['$DIR/home/.ieumoffice', refusalCtx('$DIR/home', '$DIR/data', 'darwin')],
    files: refusalFiles,
    note: 'an earlier name of the app home',
  },
  {
    args: ['$DIR', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'a folder holding the home and the protected folders',
  },
  {
    args: ['$DIR/data', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'the app data folder',
  },
  {
    args: ['$DIR/data/sub', refusalCtx('$DIR/home', '$DIR/data', 'darwin')],
    files: refusalFiles,
    note: 'below the app data folder',
  },
  {
    args: ['$DIR/HOME', refusalCtx('$DIR/home', '$DIR/data', 'darwin')],
    files: refusalFiles,
    note: 'case folded on macOS',
  },
  {
    args: ['/', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'a drive root',
  },
  {
    args: ['$DIR/f.txt', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'a file',
  },
  {
    args: ['$DIR/nowhere', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    files: refusalFiles,
    note: 'absent',
  },
  {
    args: ['rel/folder', refusalCtx('$DIR/home', '$DIR/data', 'linux')],
    note: 'not absolute',
  },
  { args: ['', refusalCtx('$DIR/home', '$DIR/data', 'linux')], note: 'empty' },
  ...extra,
]

const pathsSpec: Group = {
  'paths.pathApi': {
    ts: (a) => {
      const api = paths.pathApi(platform(a[0]))
      const path = a[1] as string
      return {
        sep: api.sep,
        normalized: api.normalize(path),
        absolute: api.isAbsolute(path),
        root: api.parse(path).root,
        dirname: api.dirname(path),
        relative: api.relative(api.normalize(path), api.normalize(a[2] as string)),
      }
    },
    cases: cases(
      ['win32', 'C:\\a\\b\\..\\c', 'C:\\a\\x'],
      ['win32', '\\\\server\\share\\dir', '\\\\server\\share\\dir\\f'],
      ['darwin', '/a/b/../c/', '/a/b'],
      ['linux', '/a//b', '/a/b/c/d'],
      ['linux', '/', '/'],
      ['win32', 'D:\\', 'C:\\x'],
    ),
  },
  'paths.canonicalPath': {
    ts: (a) => paths.canonicalPath(a[0] as string),
    cases: [
      { args: ['$DIR/f.txt'], files: { 'f.txt': 'x' }, note: 'a file that is there' },
      {
        args: ['$DIR/d/new.txt'],
        files: { d: { dir: true } },
        note: 'a leaf that is gone, its folder resolves',
      },
      { args: ['$DIR/nope/x/y'], note: 'a path whose folder does not resolve either' },
      { args: ['$DIR/d/e\u0301'], files: { d: { dir: true } }, note: 'NFC of a missing leaf' },
      { args: ['$DIR/d/../d/f'], files: { d: { dir: true } }, note: 'dots resolved' },
    ],
  },
  'paths.comparablePath': {
    ts: (a) => paths.comparablePath(a[0] as string, platform(a[1])),
    cases: cases(
      ['C:\\Users\\Ab\\', 'win32'],
      ['/Users/Ab//docs/', 'darwin'],
      ['/Users/Ab//docs/', 'linux'],
      ['/', 'linux'],
      ['C:\\', 'win32'],
      ['/a/b/..', 'linux'],
      ['/Cafe\u0301/', 'linux'],
      ['a/b/', 'linux'],
      ['\\\\Server\\Share\\', 'win32'],
      ['/A\u0130B', 'darwin'],
    ),
  },
  'paths.isPlainSegment': {
    ts: (a) => paths.isPlainSegment(a[0] as string),
    cases: cases(
      [''],
      ['.'],
      ['..'],
      ['a:b'],
      ['tab\tx'],
      ['a.'],
      ['a '],
      ['ok.txt'],
      ['\ud55c\uae00'],
      ['\u001f'],
      ['a\u0000b'],
      ['..x'],
    ),
  },
  'paths.samePath': {
    ts: (a) => paths.samePath(a[0] as string, a[1] as string, platform(a[2])),
    cases: cases(
      ['/A/b', '/a/B/', 'darwin'],
      ['/A/b', '/a/B/', 'linux'],
      ['C:\\X', 'c:\\x\\', 'win32'],
      ['/caf\u00e9', '/cafe\u0301', 'linux'],
      ['/a/b', '/a/c', 'linux'],
    ),
  },
  'paths.isInsideFolder': {
    ts: (a) => paths.isInsideFolder(a[0] as string, a[1] as string, platform(a[2])),
    cases: cases(
      ['/a/b/c', '/a/b', 'linux'],
      ['/a/bc', '/a/b', 'linux'],
      ['/a/b', '/a/b/', 'linux'],
      ['/a', '/', 'linux'],
      ['C:\\A\\B', 'c:\\a', 'win32'],
      ['D:\\a', 'C:\\a', 'win32'],
      ['/A/b', '/a', 'darwin'],
      ['/A/b', '/a', 'linux'],
      ['C:\\', 'C:\\', 'win32'],
    ),
  },
  'paths.relativeInside': {
    ts: (a) => paths.relativeInside(a[0] as string, a[1] as string, platform(a[2])),
    cases: cases(
      ['/r', '/r/a/b', 'linux'],
      ['/r', '/r', 'linux'],
      ['/r', '/x/y', 'linux'],
      ['/r', '/r/..x', 'linux'],
      ['/r', '/r/.../y', 'linux'],
      ['C:\\r', 'C:\\r\\a\\B', 'win32'],
      ['C:\\r', 'D:\\r\\a', 'win32'],
      ['c:\\R', 'C:\\r\\Caf\u0065\u0301', 'win32'],
      ['/R', '/r/Sub/f.txt', 'darwin'],
      ['/R', '/r/Sub/f.txt', 'linux'],
      ['/', '/a', 'linux'],
    ),
  },
  'paths.folderRefusal': {
    ts: (a) => paths.folderRefusal(canonicalFolder(a[0] as string), a[1] as never),
    cases: refusalCases(),
  },
  'paths.locationRefusal': {
    ts: (a) => paths.locationRefusal(canonicalFolder(a[0] as string), a[1] as never),
    cases: refusalCases([
      {
        args: ['C:\\', refusalCtx('C:\\Users\\me', 'C:\\Data', 'win32')],
        note: 'a Windows drive',
      },
      {
        args: ['C:\\users\\ME\\x', refusalCtx('C:\\Users\\me', 'C:\\Data', 'win32')],
        note: 'a Windows folder under the user folder, case folded',
      },
    ]),
  },
}

// ---------------------------------------------------------------------------
// ignore
// ---------------------------------------------------------------------------

interface IgnoreCase {
  text: string
  insensitive?: boolean
  probes: unknown[][]
  note: string
}

const IGNORE_CASES: IgnoreCase[] = [
  {
    text: '*.log\nbuild/\n/secret.txt\n',
    probes: [
      ['a.log'],
      ['x/y/a.log'],
      ['build'],
      ['build', true],
      ['src/build/out.js'],
      ['secret.txt'],
      ['sub/secret.txt'],
      ['logs/readme.md'],
    ],
    note: 'extension, folder-only and anchored patterns',
  },
  {
    text: '# comment\n\n!keep.txt\n  spaced  \r\ndocs/**/draft?.md\n**/tmp\na**b\n',
    probes: [
      ['keep.txt'],
      ['spaced'],
      ['docs/draft1.md'],
      ['docs/x/y/draft2.md'],
      ['docs/draft12.md'],
      ['a/tmp'],
      ['tmp'],
      ['ab'],
      ['aXXb'],
      ['a/b'],
    ],
    note: 'comments, re-include lines, spaces, double star in and between segments',
  },
  {
    text: 'Secret.TXT\n/Data/\n',
    insensitive: true,
    probes: [['secret.txt'], ['x/SECRET.txt'], ['data', true], ['data/f.txt'], ['DATA']],
    note: 'case folded',
  },
  {
    text: 'Secret.TXT\n/Data/\n',
    insensitive: false,
    probes: [['secret.txt'], ['x/Secret.TXT'], ['Data', true], ['data', true], ['Data/f.txt']],
    note: 'case kept',
  },
  {
    text: 'a.b\n[x]\n(y)\n{z}\n$HOME\n^caret\n+plus\n|pipe\n\\win\\path\n',
    probes: [
      ['a.b'],
      ['aXb'],
      ['[x]'],
      ['x'],
      ['(y)'],
      ['{z}'],
      ['$HOME'],
      ['^caret'],
      ['+plus'],
      ['|pipe'],
      ['win/path'],
    ],
    note: 'regular expression syntax characters are literal',
  },
  {
    text: '/\n//\n/**\n**\n*\n',
    probes: [['a'], ['a/b'], ['']],
    note: 'lines that name everything or nothing',
  },
  {
    text: 'caf\u00e9/\nna\u0308ive.txt',
    probes: [['cafe\u0301', true], ['caf\u00e9/x.txt'], ['na\u00efve.txt'], ['x\\cafe\u0301\\y']],
    note: 'NFC on both sides, backslash separators',
  },
  { text: '', probes: [['a'], ['']], note: 'no patterns' },
  {
    text: 'data/*/cache\n/a/?/c/',
    probes: [
      ['data/x/cache'],
      ['data/cache'],
      ['data/x/y/cache'],
      ['a/b/c', true],
      ['a/b/c'],
      ['a/bb/c', true],
    ],
    note: 'one star segment and a question mark segment',
  },
  {
    text: 'build/**\n',
    probes: [['build/a'], ['build/a/b.txt'], ['build', true], ['other/build/x'], ['builds/a']],
    note: 'a trailing double star takes the files below its folder',
  },
]

const ignoreSpec: Group = {
  'ignore.ignoreFoldsCase': {
    ts: (a) => ignore.ignoreFoldsCase(platform(a[0])),
    cases: cases(['win32'], ['darwin'], ['linux'], ['freebsd']),
  },
  'ignore.compileIgnore': {
    ts: (a) => {
      const matcher = ignore.compileIgnore(a[0] as string, { caseInsensitive: a[1] as boolean })
      return {
        patterns: matcher.patterns,
        results: (a[2] as unknown[][]).map((probe) =>
          matcher.ignores(probe[0] as string, probe[1] as boolean | undefined),
        ),
      }
    },
    cases: IGNORE_CASES.map((c): Case => ({
      args: [c.text, c.insensitive ?? false, c.probes],
      note: c.note,
    })),
  },
  'ignore.ignoreLineFor': {
    ts: (a) => ignore.ignoreLineFor(a[0] as string),
    cases: cases(['a/b'], ['a\\b'], ['a*b/c'], ['/x/'], [''], ['e\u0301/f'], ['//a///b//']),
  },
  'ignore.addIgnoreLine': {
    ts: (a) => ignore.addIgnoreLine(a[0] as string, a[1] as string),
    cases: cases(
      ['', 'a/b'],
      ['x\n', 'a/b'],
      ['x', 'a/b'],
      ['/a/b\n', 'a/b'],
      ['a/b\n', 'a/b'],
      ['x\r\n/a/b\r\ny\r\n', 'a\\b'],
      [' /a/b \n', 'a/b'],
      ['\n', 'q'],
      ['a*b', 'a*b'],
    ),
  },
  'ignore.removeIgnoreLine': {
    ts: (a) => ignore.removeIgnoreLine(a[0] as string, a[1] as string),
    cases: cases(
      ['/a/b\n', 'a/b'],
      ['a/b\nx\n', 'a/b'],
      ['x\n', 'a/b'],
      ['x\r\n/a/b\r\ny', 'a/b'],
      ['', 'a'],
      ['/a\n/a\n', 'a'],
      ['# c\n/a/b/\n', 'a/b'],
    ),
  },
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

const MEMORY_CTX = { today: '2026-11-12', header: '<!-- header -->' }
const FILE =
  '<!-- header -->\n- likes tea (2026-01-02)\n- plain line without date\nnot an entry\n  -   spaced entry (2025-12-31)  \n'

const memorySpec: Group = {
  'memory.MEMORY_SOFT_LIMIT_CHARS': constant(memory.MEMORY_SOFT_LIMIT_CHARS),
  'memory.memoryHeader': {
    ts: (a) => memory.memoryHeader(a[0] as string),
    cases: cases(['ko'], ['KO-kr'], [' en '], ['ko_KR'], ['fr'], [''], ['kor']),
  },
  'memory.memoryHasContent': {
    ts: (a) => memory.memoryHasContent(a[0] as string | null),
    cases: cases(
      [null],
      [''],
      ['<!-- header -->\n'],
      ['<!-- header -->\n- a\n'],
      ['  <!-- one --> \r\n\r\n<!-- two -->'],
      ['plain'],
      ['<!-- open\nclose -->'],
      ['<!-- a --> tail'],
    ),
  },
  'memory.memoryEntries': {
    ts: (a) => memory.memoryEntries(a[0] as string),
    cases: cases([FILE], [''], ['-x\n- \n-   y  '], ['- a\r\n- b\r\n'], ['\t- tab (2026-01-01)']),
  },
  'memory.applyMemoryOp': {
    ts: (a) =>
      memory.applyMemoryOp(a[0] as string | null, a[1] as never, a[2] as typeof MEMORY_CTX),
    cases: [
      { args: [null, { op: 'add', text: 'new fact' }, MEMORY_CTX], note: 'add to no file' },
      { args: [FILE, { op: 'add', text: '- brand new' }, MEMORY_CTX], note: 'add with a marker' },
      { args: [FILE, { op: 'add', text: 'likes tea' }, MEMORY_CTX], note: 'add one that is there' },
      {
        args: [FILE, { op: 'add', text: 'likes  tea (2020-02-02)' }, MEMORY_CTX],
        note: 'add one that is there by another spelling and date',
      },
      { args: [FILE, { op: 'add', text: 'dated (2024-04-04)' }, MEMORY_CTX], note: 'add dated' },
      { args: [FILE, { op: 'add', text: '   ' }, MEMORY_CTX], note: 'add blank' },
      { args: [FILE, { op: 'add', text: 'two\nlines' }, MEMORY_CTX], note: 'add two lines' },
      { args: [FILE, { op: 'add', text: '-' }, MEMORY_CTX], note: 'add a lone marker' },
      {
        args: [
          FILE,
          { op: 'replace', old: 'plain line without date', new: 'now dated' },
          MEMORY_CTX,
        ],
        note: 'replace',
      },
      {
        args: [FILE, { op: 'replace', old: 'spaced entry', new: 'x (2020-01-01)' }, MEMORY_CTX],
        note: 'replace keeps the new date',
      },
      {
        args: [FILE, { op: 'replace', old: 'absent', new: 'x' }, MEMORY_CTX],
        note: 'replace a missing entry',
      },
      {
        args: [FILE, { op: 'replace', old: 'likes tea', new: '' }, MEMORY_CTX],
        note: 'replace by nothing',
      },
      {
        args: [FILE, { op: 'replace', old: 'a\nb', new: 'x' }, MEMORY_CTX],
        note: 'replace a multi-line old',
      },
      { args: [FILE, { op: 'remove', text: 'likes tea' }, MEMORY_CTX], note: 'remove' },
      {
        args: [
          '<!-- header -->\n- only (2026-01-01)\n',
          { op: 'remove', text: 'only' },
          MEMORY_CTX,
        ],
        note: 'remove the last entry',
      },
      {
        args: [FILE, { op: 'remove', text: 'absent' }, MEMORY_CTX],
        note: 'remove a missing entry',
      },
      { args: [FILE, { op: 'remove', text: '' }, MEMORY_CTX], note: 'remove blank' },
      {
        args: ['- a\r\n- b\r\n', { op: 'remove', text: 'a' }, MEMORY_CTX],
        note: 'CRLF text joins with line feeds',
      },
      {
        args: ['- a\r\n- b\r\n', { op: 'add', text: 'a' }, MEMORY_CTX],
        note: 'add one that is there leaves a CRLF text as it is',
      },
      { args: ['', { op: 'add', text: 'x' }, MEMORY_CTX], note: 'an empty file has no header' },
    ],
  },
  'memory.buildMemoryText': {
    ts: (a) => memory.buildMemoryText(a[0] as string[], a[1] as string, a[2] as string),
    cases: cases(
      [['one', 'two (2020-01-01)'], '<!-- h -->', '2026-11-12'],
      [[], '<!-- h -->', '2026-11-12'],
      [['a\nb\r\n\r\n- c', '   ', '-'], '<!-- h -->', '2026-11-12'],
      [['x'], '', '2026-11-12'],
    ),
  },
  'memory.localDate': {
    ts: (a) => memory.localDate(dateParts(a[0])),
    cases: cases(
      [[2026, 10, 12, 9, 5, 7]],
      [[2026, 0, 1, 0, 0, 0]],
      [[5, 11, 31, 23, 59, 59]],
      [[12345, 6, 15, 13, 0, 0]],
    ),
  },
  'memory.memoryBackupName': {
    ts: (a) => memory.memoryBackupName(dateParts(a[0])),
    cases: cases([[2026, 10, 12, 9, 5, 7]], [[2026, 11, 31, 23, 59, 59]], [[99, 0, 2, 13, 4, 5]]),
  },
}

// ---------------------------------------------------------------------------
// folder-files
// ---------------------------------------------------------------------------

const PROJECT_JSON = JSON.stringify({
  version: 1,
  id: 'p-1',
  name: 'My  Project',
  createdAt: '2026-01-01T00:00:00.000Z',
})

const projectFiles = (extra: Case['files'] = {}): Case['files'] => ({
  'proj/.seuoffice/project.json': PROJECT_JSON,
  'proj/.seuoffice/instructions.md': '\ufeffhello\ufffd',
  'proj/.seuoffice/chats': { dir: true },
  'proj/AGENTS.md': 'agents',
  'proj/CLAUDE.md': 'claude\r\n',
  'proj/docs/a.md': 'a',
  'outside/secret.txt': 'secret',
  'outside/.seuoffice/project.json': PROJECT_JSON,
  ...extra,
})

const LINKS_NONE: unknown[] = []

const folderFilesSpec: Group = {
  'folder-files.hashText': {
    ts: (a) => folderFiles.hashText(a[0] as string),
    cases: cases([''], ['abc'], ['\ud55c\uae00 \u2728'], ['line\r\nbreak']),
  },
  'folder-files.plainFileIn': {
    ts: onFolder((root, segments) => folderFiles.plainFileIn(root as string, segments as string[])),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', ['AGENTS.md']],
        files: projectFiles(),
        note: 'a plain file',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs', 'a.md']],
        files: projectFiles(),
        note: 'one folder down',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs']],
        files: projectFiles(),
        note: 'a folder is not a file',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs', 'a.md', 'x']],
        files: projectFiles(),
        note: 'a file in the middle',
      },
      { args: [LINKS_NONE, '$DIR/proj', ['nope', 'a.md']], files: projectFiles(), note: 'absent' },
      {
        args: [LINKS_NONE, '$DIR/proj', []],
        files: projectFiles(),
        note: 'no segments: the root itself',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['b.txt']],
        files: projectFiles({ 'proj/a.txt': 'x', 'proj/b.txt': { link: 'proj/a.txt' } }),
        note: 'a file with a second hard link',
      },
      {
        args: [[['$DIR/proj/linked.txt', '$DIR/outside/secret.txt']], '$DIR/proj', ['linked.txt']],
        files: projectFiles(),
        note: 'a linked file',
      },
      {
        args: [[['$DIR/proj/lib', '$DIR/outside']], '$DIR/proj', ['lib', 'secret.txt']],
        files: projectFiles(),
        note: 'a linked folder on the way',
      },
    ],
  },
  // the hard-link cases of `plainFileIn` alone: the Windows comparison runs
  // them without the link cases (the Rust side makes links on Unix only)
  'folder-files.plainFileIn.hardLinks': {
    ts: onFolder((root, segments) => folderFiles.plainFileIn(root as string, segments as string[])),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', ['a.txt']],
        files: { 'proj/a.txt': 'x' },
        note: 'a file with one name',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['b.txt']],
        files: { 'proj/a.txt': 'x', 'proj/b.txt': { link: 'proj/a.txt' } },
        note: 'a file with a second hard link',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['a.txt']],
        files: { 'proj/a.txt': 'x', 'other.txt': { link: 'proj/a.txt' } },
        note: 'the second name is outside the folder',
      },
    ],
  },
  'folder-files.realPlainFileIn': {
    ts: onFolder((root, segments, plat) =>
      folderFiles.realPlainFileIn(
        paths.canonicalPath(root as string),
        segments as string[],
        platform(plat),
      ),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs', 'a.md'], 'linux'],
        files: projectFiles(),
        note: 'a plain file',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs', 'a.md'], 'darwin'],
        files: projectFiles(),
        note: 'case folded platform',
      },
      { args: [LINKS_NONE, '$DIR/proj', ['nope'], 'linux'], files: projectFiles(), note: 'absent' },
      {
        args: [LINKS_NONE, '$DIR/proj', ['docs', 'e\u0301.md'], 'linux'],
        files: projectFiles({ 'proj/docs/e\u0301.md': 'x' }),
        note: 'a decomposed name comes back composed (or as stored)',
      },
      {
        args: [
          [['$DIR/proj/linked.txt', '$DIR/outside/secret.txt']],
          '$DIR/proj',
          ['linked.txt'],
          'linux',
        ],
        files: projectFiles(),
        note: 'a link is no plain file',
      },
    ],
  },
  'folder-files.plainFolderEntries': {
    ts: onFolder((root, segments) =>
      folderFiles.plainFolderEntries(root as string, segments as string[]),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', ['.seuoffice']],
        files: projectFiles(),
        note: 'the data folder',
      },
      { args: [LINKS_NONE, '$DIR/proj', []], files: projectFiles(), note: 'the root' },
      {
        args: [LINKS_NONE, '$DIR/proj', ['AGENTS.md']],
        files: projectFiles(),
        note: 'a file is no folder',
      },
      { args: [LINKS_NONE, '$DIR/proj', ['nope']], files: projectFiles(), note: 'absent' },
      {
        args: [LINKS_NONE, '$DIR/proj', ['b', 'a', '\u00e9', 'Z']],
        files: {
          'proj/b/a/\u00e9/Z/z': 'x',
          'proj/b/a/\u00e9/Z/B': 'x',
          'proj/b/a/\u00e9/Z/a': 'x',
          'proj/b/a/\u00e9/Z/\ud83d\ude00': 'x',
          'proj/b/a/\u00e9/Z/\uff5e': 'x',
        },
        note: 'the order of the names',
      },
      {
        args: [[['$DIR/proj/lib', '$DIR/outside']], '$DIR/proj', ['lib']],
        files: projectFiles(),
        note: 'a linked folder',
      },
    ],
  },
  'folder-files.readFolderText': {
    ts: onFolder((root, segments) =>
      folderFiles.readFolderText(root as string, segments as string[]),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', ['.seuoffice', 'instructions.md']],
        files: projectFiles(),
        note: 'BOM dropped, bad bytes replaced',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', ['CLAUDE.md']],
        files: projectFiles(),
        note: 'text as it is',
      },
      { args: [LINKS_NONE, '$DIR/proj', ['nope.md']], files: projectFiles(), note: 'absent' },
      {
        args: [LINKS_NONE, '$DIR/proj', ['bin']],
        files: { 'proj/bin': { hex: 'efbbbfefbbbf61ff62c3' } },
        note: 'two BOMs, a lone byte and a cut sequence',
      },
      {
        args: [[['$DIR/proj/linked.txt', '$DIR/outside/secret.txt']], '$DIR/proj', ['linked.txt']],
        files: projectFiles(),
        note: 'a link reads as absent',
      },
    ],
  },
  'folder-files.isDataDirName': {
    ts: (a) => folderFiles.isDataDirName(a[0] as string),
    cases: cases(
      ['.seuoffice'],
      ['.SeuOffice'],
      ['.ieumoffice'],
      ['.IEUMOFFICE'],
      ['seuoffice'],
      [''],
      ['.seuoffice/'],
    ),
  },
  'folder-files.dataDirName': {
    ts: onFolder((root) => folderFiles.dataDirName(root as string)),
    cases: [
      { args: [LINKS_NONE, '$DIR/proj'], files: { proj: { dir: true } }, note: 'no data folder' },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '{}' },
        note: 'the current name holds data',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.ieumoffice/project.json': '{}' },
        note: 'an earlier name only',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice': { dir: true }, 'proj/.ieumoffice/project.json': '{}' },
        note: 'an empty current folder beside an old one with data',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/.DS_Store': 'x', 'proj/.ieumoffice/project.json': '{}' },
        note: 'only a .DS_Store counts as empty',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/a/b/c/d/e.txt': 'x', 'proj/.ieumoffice/project.json': '{}' },
        note: 'data below the depth looked at',
      },
      {
        args: [[['$DIR/proj/.seuoffice', '$DIR/outside']], '$DIR/proj'],
        files: { 'outside/f': 'x', 'proj/.ieumoffice/project.json': '{}' },
        note: 'a linked current folder is not a folder',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice': 'a file, not a folder' },
        note: 'a file under the current name',
      },
    ],
  },
  'folder-files.readDataText': {
    ts: onFolder((root, name, dataDir) =>
      folderFiles.readDataText(root as string, name as string, dataDir as string | undefined),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', 'instructions.md'],
        files: projectFiles(),
        note: 'the data folder is resolved',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'instructions.md', '.seuoffice'],
        files: projectFiles(),
        note: 'given',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'instructions.md', '.ieumoffice'],
        files: projectFiles(),
        note: 'given, another one',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'memory.md'],
        files: { 'proj/.ieumoffice/memory.md': 'old' },
        note: 'an earlier folder',
      },
      { args: [LINKS_NONE, '$DIR/proj', 'memory.md'], files: projectFiles(), note: 'absent' },
    ],
  },
  'folder-files.cleanProjectName': {
    ts: (a) => folderFiles.cleanProjectName(a[0] as string),
    cases: cases(
      ['  My \t Project\n'],
      ['x'.repeat(200)],
      ['\ud83d\ude00'.repeat(130)],
      [''],
      ['\u00a0 a \u3000 b \ufeff'],
      ['a\u2028b'],
    ),
  },
  'folder-files.readProjectFile': {
    ts: onFolder((root, dataDir) =>
      folderFiles.readProjectFile(root as string, dataDir as string | undefined),
    ),
    cases: [
      { args: [LINKS_NONE, '$DIR/proj'], files: projectFiles(), note: 'a well-formed file' },
      {
        args: [LINKS_NONE, '$DIR/proj', '.ieumoffice'],
        files: projectFiles(),
        note: 'another data folder named',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '{"id":"a b","name":"x"}' },
        note: 'a bad id',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '{"id":"ok","name":"   ","createdAt":5}' },
        note: 'a blank name takes the folder name, a bad time the epoch',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '{"id":"ok","name":42}' },
        note: 'a name that is no string',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '[1]' },
        note: 'an array',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': 'nope' },
        note: 'not JSON',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': 'null' },
        note: 'null',
      },
      { args: [LINKS_NONE, '$DIR/proj'], files: { proj: { dir: true } }, note: 'no file' },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: {
          'proj/.ieumoffice/project.json':
            '{"id":"old1","name":"Old","createdAt":"2020-02-02T00:00:00.000Z"}',
        },
        note: 'an earlier data folder',
      },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.seuoffice/project.json': '\ufeff{"id":"bom"}' },
        note: 'a BOM is dropped before parsing',
      },
    ],
  },
  'folder-files.projectFileText': {
    ts: (a) => folderFiles.projectFileText(a[0] as never),
    cases: cases(
      [{ version: 1, id: 'p-1', name: 'My project', createdAt: '2026-01-01T00:00:00.000Z' }],
      [{ version: 7, id: 'x', name: 'quote " and \\ and \u2028', createdAt: '' }],
    ),
  },
}

// ---------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------

const visibilityFiles: Case['files'] = {
  'proj/docs/a.md': 'a',
  'proj/assets/.seuoffice-assets.json': '{}',
  'proj/assets2/x': 'x',
  'proj/pics/assets/.genoffice-assets.json': '{}',
  'proj/plain/assets/x.png': 'x',
  'proj/.seuoffice/chats/c.jsonl': '',
}

const visibilitySpec: Group = {
  'visibility.isAiVisiblePath': {
    ts: (a) => {
      const matcher = ignore.compileIgnore(a[2] as string, { caseInsensitive: a[3] as boolean })
      return visibility.isAiVisiblePath(a[0] as string, a[1] as string, matcher, a[4] as boolean)
    },
    cases: (
      [
        ['docs/a.md', '', false, false, 'a visible file'],
        ['docs', '', false, true, 'a visible folder'],
        ['', '', false, false, 'empty'],
        ['/docs/a.md', '', false, false, 'leading slash'],
        ['\\docs\\a.md', '', false, false, 'leading backslash'],
        ['C:docs', '', false, false, 'drive letter'],
        ['../x', '', false, false, 'up'],
        ['docs/../x', '', false, false, 'up inside'],
        ['./docs', '', false, false, 'dot'],
        ['///', '', false, false, 'only separators'],
        ['.seuoffice/chats/c.jsonl', '', false, false, 'the data folder'],
        ['.IeumOffice/x', '', false, false, 'an earlier data folder'],
        ['docs/.hidden', '', false, false, 'a dot file'],
        ['docs/~$a.docx', '', false, false, 'an Office lock file'],
        ['node_modules/x/y.js', '', false, false, 'node_modules'],
        ['docs/Thumbs.db', '', false, false, 'OS junk'],
        ['assets/x.png', '', false, false, 'the app-owned assets folder'],
        ['node_modules', '', false, true, 'a node_modules folder'],
        ['assets', '', false, true, 'the assets folder itself'],
        ['plain/assets/x.png', '', false, false, 'an assets folder with no list'],
        ['pics/assets/x.png', '', false, false, 'an assets folder with the old list'],
        ['assets2/x', '', false, false, 'another folder'],
        ['docs/a.docx.0123456789ab.tmp', '', false, false, 'a staging temp'],
        ['docs/a.docx.unsaved.tmp', '', false, false, 'a rescue copy'],
        ['docs/a.tmp.d', '', false, true, 'a folder named like a temp is no temp'],
        ['docs/a.docx.unsaved.tmp', '', false, true, 'a temp name as a folder'],
        ['docs/a.md', 'a.md\n', false, false, 'ignored by name'],
        ['docs/a.md', 'docs/\n', false, false, 'ignored through its folder'],
        ['docs', 'docs/\n', false, true, 'an ignored folder'],
        ['docs', 'docs/\n', false, false, 'a folder-only pattern on a file named like it'],
        ['DOCS/a.md', 'docs/\n', true, false, 'ignore with case folded'],
        ['DOCS/a.md', 'docs/\n', false, false, 'ignore with case kept'],
      ] as [string, string, boolean, boolean, string][]
    ).map(([rel, text, ci, isDir, note]): Case => ({
      args: ['$DIR/proj', rel, text, ci, isDir],
      files: visibilityFiles,
      note,
    })),
  },
}

// ---------------------------------------------------------------------------
// trust
// ---------------------------------------------------------------------------

const INSTALL = 'install-A'
const chatInfo = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    id,
    projectId: 'p-1',
    title: `Chat ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    origin: INSTALL,
    lastEditor: 'docs',
    documents: [],
    ...extra,
  })
const line = (origin: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq: 1, ts: 'x', role: 'user', text: 't', editor: 'docs', origin, ...extra })

const chatFiles: Case['files'] = {
  'proj/.seuoffice/chats/own.json': chatInfo('own'),
  'proj/.seuoffice/chats/own.jsonl': `${line(INSTALL)}\n${line(INSTALL)}\n`,
  'proj/.seuoffice/chats/other.json': chatInfo('other', { origin: 'install-B' }),
  'proj/.seuoffice/chats/other.jsonl': `${line('install-B')}\n`,
  'proj/.seuoffice/chats/mixed.json': chatInfo('mixed'),
  'proj/.seuoffice/chats/mixed.jsonl': `${line(INSTALL)}\nnot json\n\n   \n${line(INSTALL)}\n${line('install-C')}\n`,
  'proj/.seuoffice/chats/nomsg.json': chatInfo('nomsg'),
  'proj/.seuoffice/chats/foreign-project.json': chatInfo('foreign-project', {
    projectId: 'p-2',
    origin: 'install-B',
  }),
  'proj/.seuoffice/chats/bad id.json': chatInfo('bad id'),
  'proj/.seuoffice/chats/wrongid.json': chatInfo('someone-else'),
  'proj/.seuoffice/chats/broken.json': '{',
  'proj/.seuoffice/chats/noorigin.json': chatInfo('noorigin', {
    origin: 5,
    title: 7,
    updatedAt: null,
  }),
  'proj/.seuoffice/chats/notes.txt': 'x',
  'proj/.seuoffice/instructions.md': '  \n',
  'proj/.seuoffice/memory.md': '<!-- header -->\n',
}

const TRUST_BASE: Case['files'] = {
  'proj/.seuoffice/instructions.md': 'Use the house style.\n',
  'proj/.seuoffice/memory.md': '<!-- header -->\n- likes tea (2026-01-02)\n',
  'proj/AGENTS.md': 'agents text',
  'proj/CLAUDE.md': '   \n',
}

const trustSpec: Group = {
  'trust.readHashedTexts': {
    ts: onFolder((root) => trust.readHashedTexts(root as string)),
    cases: [
      { args: [LINKS_NONE, '$DIR/proj'], files: TRUST_BASE, note: 'four texts' },
      { args: [LINKS_NONE, '$DIR/proj'], files: { proj: { dir: true } }, note: 'none' },
      {
        args: [LINKS_NONE, '$DIR/proj'],
        files: { 'proj/.ieumoffice/memory.md': 'old memory', 'proj/AGENTS.md': '' },
        note: 'an earlier data folder, an empty file',
      },
      {
        args: [[['$DIR/proj/AGENTS.md', '$DIR/outside.md']], '$DIR/proj'],
        files: { 'outside.md': 'outside', proj: { dir: true } },
        note: 'a linked file reads as absent',
      },
    ],
  },
  'trust.hashesOf': {
    ts: (a) => trust.hashesOf(a[0] as never),
    cases: cases(
      [{ dataDir: '.seuoffice', instructions: 'i', memory: 'm', agents: 'a', claude: 'c' }],
      [{ dataDir: '.seuoffice', instructions: null, memory: null, agents: null, claude: null }],
      [{ dataDir: '.seuoffice', instructions: '', memory: null, agents: '\ud55c', claude: null }],
    ),
  },
  'trust.hasForeignMessage': {
    ts: onFolder((root, chatId, installId, dataDir) =>
      trust.hasForeignMessage(
        root as string,
        chatId as string,
        installId as string,
        dataDir as string | undefined,
      ),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', 'own', INSTALL],
        files: chatFiles,
        note: 'all lines are ours',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'other', INSTALL],
        files: chatFiles,
        note: 'one foreign line',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'mixed', INSTALL],
        files: chatFiles,
        note: 'a foreign line after unreadable ones',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'nomsg', INSTALL],
        files: chatFiles,
        note: 'no message file',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'own', INSTALL, '.ieumoffice'],
        files: chatFiles,
        note: 'another data folder named',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: {
          'proj/.seuoffice/chats/c.jsonl': `${line(INSTALL)}\r\n${line(INSTALL)}\r${line('install-B')}`,
        },
        note: 'a foreign last line after a lone carriage return',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: { 'proj/.seuoffice/chats/c.jsonl': `${line(INSTALL)}\r\r\n${line(INSTALL)}\n\n` },
        note: 'a lone carriage return, then a pair',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: { 'proj/.seuoffice/chats/c.jsonl': `null\n5\n"s"\ntrue\n[1]\n${line(INSTALL)}\n` },
        note: 'an array is a record with no origin',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: {
          'proj/.seuoffice/chats/c.jsonl': `null\n5\n"s"\ntrue\n${line(INSTALL)}\n{"a":1}\n`,
        },
        note: 'a record with no origin',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: { 'proj/.seuoffice/chats/c.jsonl': `null\n5\n"s"\ntrue\n${line(INSTALL)}\n` },
        note: 'values that are no records are skipped',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: { 'proj/.seuoffice/chats/c.jsonl': `\ufeff${line(INSTALL)}\n${line(INSTALL)}\n` },
        note: 'a BOM makes the first line unreadable',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: {
          'proj/.seuoffice/chats/c.jsonl': {
            hex: Buffer.from(`${line(INSTALL)}\n`).toString('hex') + 'ff',
          },
        },
        note: 'a bad byte at the end',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'c', INSTALL],
        files: { 'proj/.seuoffice/chats/c.jsonl': { text: line(INSTALL), mode: 0o000 } },
        note: 'a file that cannot be read counts as foreign',
      },
      {
        args: [
          [['$DIR/proj/.seuoffice/chats/c.jsonl', '$DIR/outside.jsonl']],
          '$DIR/proj',
          'c',
          INSTALL,
        ],
        files: { 'outside.jsonl': line('install-B'), 'proj/.seuoffice/chats/x': 'x' },
        note: 'a linked file reads as absent',
      },
    ],
  },
  'trust.listForeignChats': {
    ts: onFolder((root, projectId, installId, dataDir) =>
      trust.listForeignChats(
        root as string,
        projectId as string,
        installId as string,
        dataDir as string | undefined,
      ),
    ),
    cases: [
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-1', INSTALL],
        files: chatFiles,
        note: 'foreign by info, by a line, and one of ours',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-2', INSTALL],
        files: chatFiles,
        note: 'another project id',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-1', 'install-B'],
        files: chatFiles,
        note: 'another install id',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-1', INSTALL],
        files: { proj: { dir: true } },
        note: 'no chats',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-1', INSTALL, '.seuoffice'],
        files: chatFiles,
        note: 'the data folder named',
      },
      {
        args: [LINKS_NONE, '$DIR/proj', 'p-1', INSTALL],
        files: {
          'proj/.seuoffice/chats/\ud83d\ude00.json': chatInfo('\ud83d\ude00', { origin: 'x' }),
          'proj/.seuoffice/chats/b.json': chatInfo('b', { origin: 'x' }),
          'proj/.seuoffice/chats/\uff5e.json': chatInfo('\uff5e', { origin: 'x' }),
          'proj/.seuoffice/chats/B.json': chatInfo('B', { origin: 'x' }),
          'proj/.seuoffice/chats/a_1-2.json': chatInfo('a_1-2', { origin: 'x' }),
        },
        note: 'the order of names JavaScript sorts, ids that are not valid dropped',
      },
      {
        args: [[['$DIR/proj/.seuoffice/chats', '$DIR/other-chats']], '$DIR/proj', 'p-1', INSTALL],
        files: { 'other-chats/a.json': chatInfo('a', { origin: 'x' }), 'proj/.seuoffice/x': 'x' },
        note: 'a linked chats folder is empty',
      },
    ],
  },
  'trust.scanForTrust': {
    ts: onFolder((input) => trust.scanForTrust(input as never)),
    cases: [
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'My project', installId: INSTALL },
        ],
        files: {
          ...TRUST_BASE,
          ...chatFiles,
          'proj/.seuoffice/instructions.md': 'Use the house style.\n',
          'proj/.seuoffice/memory.md': '<!-- header -->\n- likes tea (2026-01-02)\n',
        },
        note: 'everything to confirm',
      },
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'Empty', installId: INSTALL },
        ],
        files: { proj: { dir: true } },
        note: 'nothing to confirm',
      },
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'Blank', installId: INSTALL },
        ],
        files: {
          'proj/.seuoffice/instructions.md': '  \n',
          'proj/.seuoffice/memory.md': '<!-- header -->\n\n',
          'proj/AGENTS.md': '\n',
          'proj/CLAUDE.md': '',
        },
        note: 'only blank files and a header',
      },
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'Own', installId: INSTALL },
        ],
        files: {
          'proj/.seuoffice/chats/own.json': chatInfo('own'),
          'proj/.seuoffice/chats/own.jsonl': `${line(INSTALL)}\n`,
        },
        note: 'only chats of this install',
      },
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'Old', installId: INSTALL },
        ],
        files: {
          'proj/.ieumoffice/memory.md': '- remembered (2025-01-01)\n',
          'proj/.ieumoffice/chats/z.json': chatInfo('z', { origin: 'other' }),
        },
        note: 'an earlier data folder',
      },
      {
        args: [
          LINKS_NONE,
          { root: '$DIR/proj', projectId: 'p-1', name: 'Claude only', installId: INSTALL },
        ],
        files: { 'proj/CLAUDE.md': 'claude' },
        note: 'one root file',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// the pieces of other modules
// ---------------------------------------------------------------------------

const externalSpec: Group = {
  'folder-api.PROJECT_EDITORS': constant([...PROJECT_EDITORS]),
  'folder-api.PROJECT_NAME_MAX_CHARS': constant(PROJECT_NAME_MAX_CHARS),
  'folder-api.PROJECT_FORMAT_VERSION': constant(PROJECT_FORMAT_VERSION),
  'folder-api.MEMORY_BACKUP_PATTERN': {
    ts: (a) => MEMORY_BACKUP_PATTERN.test(a[0] as string),
    cases: cases(
      ['memory.20261112-030000.bak.md'],
      ['memory.20261112-030000.bak.md\n'],
      ['memory.2026111-030000.bak.md'],
      ['xmemory.20261112-030000.bak.md'],
      ['memory.md'],
      ['memory.\u0662\u0660261112-030000.bak.md'],
    ),
  },
  'folder-tree.TREE_FILE_EXTENSIONS': constant([...folderTree.TREE_FILE_EXTENSIONS]),
  'folder-tree.isSupportedTreeFile': {
    ts: (a) => folderTree.isSupportedTreeFile(a[0] as string),
    cases: cases(
      ['a.docx'],
      ['A.PDF'],
      ['x.drawio.svg'],
      ['x.DRAWIO.PNG'],
      ['x.svg'],
      ['noext'],
      ['.md'],
      ['a.tar.gz'],
      ['photo.png'],
    ),
  },
  'folder-tree.isHiddenEntry': {
    ts: (a) => folderTree.isHiddenEntry(a[0] as string, a[1] as string, a[2] as boolean),
    cases: [
      { args: ['$DIR', '.git', true], note: 'a dot folder' },
      { args: ['$DIR', '.env', false], note: 'a dot file' },
      { args: ['$DIR', '~$lock.docx', false], note: 'an Office lock file' },
      { args: ['$DIR', 'Node_Modules', true], note: 'node_modules' },
      { args: ['$DIR', 'node_modules', false], note: 'a file named node_modules' },
      { args: ['$DIR', '__MACOSX', true], note: 'OS junk folder' },
      { args: ['$DIR', 'Thumbs.db', false], note: 'OS junk file' },
      { args: ['$DIR', 'Desktop.INI', false], note: 'OS junk file in capitals' },
      { args: ['$DIR', 'thumbs.db', true], note: 'a folder named like junk' },
      { args: ['$DIR', 'readme.md', false], note: 'a plain file' },
      {
        args: ['$DIR', 'assets', true],
        files: { 'assets/.seuoffice-assets.json': '{}' },
        note: 'assets with the list',
      },
      {
        args: ['$DIR', 'Assets', true],
        files: { 'Assets/.genoffice-assets.json': '{}' },
        note: 'assets with the old list',
      },
      {
        args: ['$DIR', 'assets', true],
        files: { 'assets/x.png': 'x' },
        note: 'assets without a list',
      },
      {
        args: ['$DIR', 'assets', false],
        files: { 'assets/.seuoffice-assets.json': '{}' },
        note: 'assets as a file',
      },
    ],
  },
  'agent-sessions.agentProtectedPaths': {
    ts: (a) => agentSessions.agentProtectedPaths(a[0] as string, a[1] as string),
    cases: cases(
      ['/home/u', '/data/app'],
      ['/Users/u/', '/Users/u/Library/App'],
      ['', ''],
      ['/h', '/h/.claude'],
    ),
  },
  'sources.folderHoldsData': {
    ts: onFolder((dir, depth) =>
      userSkills.folderHoldsData(dir as string, depth as number | undefined),
    ),
    cases: [
      { args: [LINKS_NONE, '$DIR/d'], files: { 'd/f.txt': 'x' }, note: 'a file at the top' },
      { args: [LINKS_NONE, '$DIR/d'], files: { d: { dir: true } }, note: 'an empty folder' },
      { args: [LINKS_NONE, '$DIR/d'], files: { 'd/.DS_Store': 'x' }, note: 'only a .DS_Store' },
      { args: [LINKS_NONE, '$DIR/d'], files: { 'd/a/b/f': 'x' }, note: 'a file two levels down' },
      { args: [LINKS_NONE, '$DIR/d'], files: { 'd/a/b/c/f': 'x' }, note: 'a file past the depth' },
      { args: [LINKS_NONE, '$DIR/d', 5], files: { 'd/a/b/c/f': 'x' }, note: 'a deeper look' },
      {
        args: [LINKS_NONE, '$DIR/d', 1],
        files: { 'd/a/f': 'x' },
        note: 'depth one does not enter folders',
      },
      {
        args: [LINKS_NONE, '$DIR/d'],
        files: { 'd/a/.DS_Store': 'x', 'd/b': { dir: true } },
        note: 'folders holding nothing',
      },
      { args: [LINKS_NONE, '$DIR/nope'], note: 'missing' },
      { args: [LINKS_NONE, '$DIR/file'], files: { file: 'x' }, note: 'not a folder' },
      {
        args: [LINKS_NONE, '$DIR/d'],
        files: { 'd/x': { text: 'x' }, d: { dir: true, mode: 0o000 } },
        note: 'unreadable counts as data',
      },
      {
        args: [[['$DIR/d/l', '$DIR/outside']], '$DIR/d'],
        files: { 'd/.DS_Store': 'x', 'outside/f': 'x' },
        note: 'a link is an entry that is not a folder',
      },
    ],
  },
  'scan.SCAN_MAX_DEPTH': constant(scan.SCAN_MAX_DEPTH),
}

export const foundation: Group = {
  ...pathsSpec,
  ...ignoreSpec,
  ...memorySpec,
  ...folderFilesSpec,
  ...visibilitySpec,
  ...trustSpec,
  ...externalSpec,
}
