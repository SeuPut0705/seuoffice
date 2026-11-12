/**
 * Group `b4-markdown`: the Markdown app's main-process modules that hold no
 * Electron object.
 *
 * `asset-lifecycle`, `atomic-write` and `old-names` exist in the html app too,
 * so their names carry the app (`markdown/asset-lifecycle.…`). A constant has
 * one answer. State kept between calls (a class, a module-level map) and a
 * folder changed between two questions are driven by a script of steps, the
 * script being the one argument; the TypeScript runs it on its own state and
 * answers one entry per question. Random names (a UUID, the six characters of
 * `mkdtemp`) are written `<uuid>` / `<tmp>` and the file or folder they name
 * is removed again, so both sides leave the same folder.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ASSET_MANIFEST_FILENAME,
  copyImageIntoOwnedAssets,
  discardPendingOwnedAssets,
  extractMarkdownImageSources,
  isInDocDir,
  pendingOwnedAssetsForDocument,
  prepareAssetsForSaveAs,
  readOwnedAssetManifest,
  reconcileOwnedAssets,
  renameOwnedAssetDocument,
  resolveSafeRelativeImagePath,
  resolveSafeVaultImagePath,
  resolveSourcePendingAfterSaveAs,
  rewriteMarkdownImageSources,
  rollbackPreparedSaveAsAssets,
  writeImageIntoOwnedAssets,
} from '../../../apps/markdown/src/main/asset-lifecycle.ts'
import { atomicWriteFile } from '../../../apps/markdown/src/main/atomic-write.ts'
import {
  MARKDOWN_CONVERSION_TTL_MS,
  cleanupStaleMarkdownConversions,
  createMarkdownConversionSession,
  writeMarkdownConversion,
} from '../../../apps/markdown/src/main/conversion-lifecycle.ts'
import { ImageExportSessions } from '../../../apps/markdown/src/main/image-export.ts'
import {
  imageObjectKey,
  isImageHostUsable,
  normalizeImageHostConfig,
  sigV4,
  uploadImageToHost,
} from '../../../apps/markdown/src/main/image-host.ts'
import {
  OLD_ASSET_MANIFEST_FILENAMES,
  OLD_CONVERSION_SESSION_MARKERS,
} from '../../../apps/markdown/src/main/old-names.ts'
import { createWikiNote } from '../../../apps/markdown/src/main/wiki-create.ts'
import {
  rememberWikiFragment,
  takeWikiFragment,
} from '../../../apps/markdown/src/main/wiki-fragment.ts'
import {
  MAX_HEAD_ENTRIES_PER_KIND,
  parseWikiHeads,
  wikiHeads,
} from '../../../apps/markdown/src/main/wiki-heads.ts'
import {
  MAX_GRAPH_NODES,
  MAX_INDEX_FILES,
  extractTags,
  extractWikiTargets,
  nodeVaultFs,
  warmWikiIndex,
  wikiBacklinks,
  wikiGraph,
  wikiTags,
} from '../../../apps/markdown/src/main/wiki-index.ts'
import { MAX_NOTES, listWikiNotes } from '../../../apps/markdown/src/main/wiki-notes.ts'
import {
  MAX_DEPTH,
  SKIP_DIRS,
  nodeFs,
  resolveWikiLinks,
  splitTarget,
} from '../../../apps/markdown/src/main/wiki-resolve.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'

const str = (a: unknown[], i: number): string => a[i] as string
/** a `null` argument is an argument left out */
const opt = <T>(a: unknown[], i: number): T | undefined => (a[i] == null ? undefined : (a[i] as T))

const j = (value: unknown): string => JSON.stringify(value)

function constant(value: unknown) {
  return { ts: () => value, cases: [{ args: [] }] as Case[], single: 'a constant' }
}

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

/** the call, with a temp file's random name in a thrown message written `<hex>` */
async function masked<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) error.message = maskTmp(error.message)
    throw error
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
const TMP_RE = /-images-[A-Za-z0-9]{6}/g
const maskRandom = (text: string): string =>
  text.replace(UUID_RE, '<uuid>').replace(TMP_RE, '-images-<tmp>')

/** a path with a random name: written masked, and the file or folder removed */
function settleRandomPath(path: string): string {
  const shown = maskRandom(path)
  if (shown !== path) rmSync(path, { recursive: true, force: true })
  return shown
}

/** `Date.now()` answers `clock.now` while `run` runs, awaits included */
async function withNow<T>(clock: { now: number }, run: () => T | Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => clock.now
  try {
    return await run()
  } finally {
    Date.now = real
  }
}

/** `Math.random()` answers the list in turn while `run` runs */
async function withRandoms<T>(values: number[], run: () => T | Promise<T>): Promise<T> {
  const real = Math.random
  let at = 0
  Math.random = () => values[at++ % values.length]!
  try {
    return await run()
  } finally {
    Math.random = real
  }
}

const errorEntry = (error: unknown): { error: { code: unknown; message: string } } => {
  const e = error as { code?: unknown; message?: unknown }
  return {
    error: { code: typeof e?.code === 'string' ? e.code : null, message: String(e?.message) },
  }
}

const NOW = 1_794_452_400_000
const DAY = 86_400_000
const EMOJI = '\u{1F600}'

// ---- conversion-lifecycle ----

const MARKER = '.seuoffice-markdown-conversion.json'
const OLD_MARKER = '.genoffice-markdown-conversion.json'
const marker = (createdAt: unknown, version: unknown = 1): string => j({ version, createdAt })

const cleanupCases: Case[] = [
  { args: ['$DIR/cache', null, null], note: 'the root is made' },
  {
    args: ['$DIR/cache', null, null],
    files: {
      [`cache/session-a/${MARKER}`]: marker(NOW - 8 * DAY),
      'cache/session-a/out.docx': 'bytes',
      [`cache/session-b/${MARKER}`]: marker(NOW - DAY),
      [`cache/session-c/${OLD_MARKER}`]: marker(NOW - 9 * DAY),
      [`cache/notsession/${MARKER}`]: marker(NOW - 9 * DAY),
      'cache/session-file': 'a file, not a folder',
      'cache/session-bad/.seuoffice-markdown-conversion.json': '{not json',
      [`cache/session-v2/${MARKER}`]: marker(NOW - 9 * DAY, 2),
      'cache/session-none/readme.txt': 'no marker',
    },
    note: 'stale ones go, the rest stays',
  },
  {
    args: ['$DIR/cache', null, null],
    files: {
      [`cache/session-10/${MARKER}`]: marker(0),
      [`cache/session-2/${MARKER}`]: marker(0),
      [`cache/session-B/${MARKER}`]: marker(0),
      [`cache/session-a/${MARKER}`]: marker(0),
      [`cache/session-\u00e9/${MARKER}`]: marker(0),
    },
    note: 'removed in the order of the names by bytes',
  },
  {
    args: ['$DIR/cache', NOW, 1000],
    files: {
      [`cache/session-1/${MARKER}`]: marker(NOW - 1000),
      [`cache/session-2/${MARKER}`]: marker(NOW - 999),
      [`cache/session-3/${MARKER}`]: marker(NOW - 1001),
    },
    note: 'the boundary: exactly the ttl is stale',
  },
  {
    args: ['$DIR/cache', 5, 0],
    files: { [`cache/session-1/${MARKER}`]: marker(5), [`cache/session-2/${MARKER}`]: marker(6) },
    note: 'ttl 0',
  },
  {
    args: ['$DIR/cache', NOW, 1000],
    files: {
      [`cache/session-n/${MARKER}`]: 'null',
      [`cache/session-l/${MARKER}`]: '[]',
      [`cache/session-s/${MARKER}`]: j({ version: 1, createdAt: '5' }),
      [`cache/session-neg/${MARKER}`]: j({ version: 1, createdAt: -5 }),
      [`cache/session-inf/${MARKER}`]: '{"version":1,"createdAt":1e999}',
      [`cache/session-nover/${MARKER}`]: j({ createdAt: 0 }),
      [`cache/session-str/${MARKER}`]: j({ version: '1', createdAt: 0 }),
      [`cache/session-frac/${MARKER}`]: j({ version: 1, createdAt: 0.5 }),
      [`cache/session-dir/${MARKER}`]: { dir: true },
      [`cache/session-both/${MARKER}`]: marker('x'),
      [`cache/session-both/${OLD_MARKER}`]: marker(0),
    },
    note: 'markers that are not valid: kept (a bad current marker is not retried under the old name)',
  },
  { args: ['$DIR/f', null, null], files: { f: 'a file' }, note: 'the root is a file' },
]

const sessionCases: Case[] = [
  { args: ['$DIR/c', { now: 1000, id: 'abc' }] },
  {
    args: ['$DIR/c', { now: 1000, id: 'abc' }],
    files: { 'c/session-1000-abc': { dir: true } },
    note: 'the folder is taken',
  },
  { args: ['$DIR/c', { now: 1.5, id: 'x' }], note: 'a fractional clock' },
  { args: ['$DIR/c', { now: -5, id: 'x' }] },
  { args: ['$DIR/c', { now: 0, id: 'x' }] },
  { args: ['$DIR/c', { now: 1e21, id: 'x' }], note: 'a clock past 1e21 prints in exponent form' },
  { args: ['$DIR/c', { now: 7, id: 'a/b..c d_e-f' }], note: 'illegal characters of the id go' },
  { args: ['$DIR/c', { now: 7, id: 'x'.repeat(100) }], note: 'the id is cut at 80' },
  { args: ['$DIR/c', { now: 7, id: '' }], note: 'an empty id becomes a UUID' },
  { args: ['$DIR/c', { now: 7, id: '***' }], note: 'an id that is all illegal becomes a UUID' },
  { args: ['$DIR/c', { now: 7, id: '\u00e9\u0131' }], note: 'non-ASCII is not kept' },
  { args: ['$DIR/c', { now: 7 }], note: 'no id: a UUID' },
  { args: ['$DIR/c', null], note: 'the clock of the call and a UUID' },
  { args: ['$DIR/c', { id: 'k' }], note: 'the clock of the call' },
  {
    args: ['$DIR/c', { now: NOW, id: 'k', ttlMs: DAY }],
    files: {
      [`c/session-1-old/${MARKER}`]: marker(NOW - 2 * DAY),
      [`c/session-2-new/${MARKER}`]: marker(NOW - DAY / 2),
    },
    note: 'stale sessions are removed first, by the ttl given',
  },
  { args: ['$DIR/f', { now: 1, id: 'x' }], files: { f: 'a file' }, note: 'the root is a file' },
]

const SESSION_FILES: Record<string, FileSpec> = { [`s/${MARKER}`]: marker(5) }
const writeCases: Case[] = [
  { args: ['$DIR/s', 'My Doc.md', 'hello', 'id1'], files: SESSION_FILES },
  { args: ['$DIR/s', 'My Doc.md', 'hello', 'id1'], files: { s: { dir: true } }, note: 'no marker' },
  {
    args: ['$DIR/s', 'a.md', 'x', 'id'],
    files: { [`s/${MARKER}`]: marker(5, 2) },
    note: 'a marker of another version',
  },
  {
    args: ['$DIR/s', 'a.md', 'x', 'id'],
    files: { [`s/${OLD_MARKER}`]: marker(5) },
    note: 'the old marker name',
  },
  { args: ['$DIR/none', 'a.md', 'x', 'id'], note: 'no session folder' },
  { args: ['$DIR/s', '', 'x', 'id'], files: SESSION_FILES, note: 'an empty name' },
  {
    args: ['$DIR/s', '...hidden', 'x', 'id'],
    files: SESSION_FILES,
    note: 'dots only: extname swallows the name',
  },
  { args: ['$DIR/s', 'a/b\\c:d*e?.md', 'x', 'id'], files: SESSION_FILES },
  {
    args: ['$DIR/s', '\u0001x\u001f.md', 'x', 'id'],
    files: SESSION_FILES,
    note: 'control characters',
  },
  {
    args: ['$DIR/s', `${'n'.repeat(150)}.md`, 'x', 'id'],
    files: SESSION_FILES,
    note: 'cut at 100',
  },
  {
    args: ['$DIR/s', `${EMOJI.repeat(60)}.md`, 'x', 'id'],
    files: SESSION_FILES,
    note: 'astral, cut at 100 units',
  },
  {
    args: ['$DIR/s', 'doc. . .md', 'x', 'id'],
    files: SESSION_FILES,
    note: 'trailing dots and spaces',
  },
  { args: ['$DIR/s', '  ', 'x', 'id'], files: SESSION_FILES, note: 'white space only' },
  {
    args: ['$DIR/s', 'D.md', 'x', 'id'],
    files: { ...SESSION_FILES, 's/D-id.docx': 'taken' },
    note: 'the name is taken: -1',
  },
  {
    args: ['$DIR/s', 'D.md', 'x', 'id'],
    files: {
      ...SESSION_FILES,
      's/D-id.docx': 'a',
      's/D-id-1.docx': 'b',
      's/D-id-2.docx': { dir: true },
    },
    note: 'taken three times',
  },
  { args: ['$DIR/s', 'D.md', 'x', '../x/y'], files: SESSION_FILES, note: 'the id is cleaned' },
  { args: ['$DIR/s', 'D.md', 'x', ''], files: SESSION_FILES, note: 'an empty id is a UUID' },
  { args: ['$DIR/s', 'D.md', 'x', null], files: SESSION_FILES, note: 'no id: a UUID' },
  {
    args: ['$DIR/s', 'D.md', `${EMOJI}\u00e9`, 'id'],
    files: SESSION_FILES,
    note: 'non-ASCII bytes',
  },
  {
    args: ['$DIR/s', 'D.md', 'x', 'id'],
    files: { [`s/${MARKER}`]: marker(5), 's/D-id.docx': { dir: true } },
    note: 'a folder where the file goes',
  },
]

// ---- image-export ----

interface ExportStep {
  op: string
  owner?: number
  parent?: string
  name?: string
  target?: string
  session?: number
  id?: string
  page?: number | null
  base64?: unknown
  success?: boolean
}

async function runImageExport(a: unknown[]): Promise<unknown> {
  const steps = a[0] as ExportStep[]
  const scan = a[1] as string[]
  const sessions = new ImageExportSessions()
  const ids: string[] = []
  const results: unknown[] = []
  for (const s of steps) {
    const id = typeof s.session === 'number' ? (ids[s.session] ?? '') : (s.id ?? '')
    try {
      let value: unknown = null
      switch (s.op) {
        case 'start':
          ids.push(await sessions.start(s.owner!, s.parent!, s.name!))
          break
        case 'startFiles':
          ids.push(await sessions.startFiles(s.owner!, s.target!))
          break
        case 'write':
          await sessions.write(s.owner!, id, s.page as number, s.base64 as string)
          break
        case 'finish':
          value = await sessions.finish(s.owner!, id, s.success === true)
          break
        case 'finishExport':
          value = await sessions.finishExport(s.owner!, id, s.success === true)
          break
        case 'dispose':
          await sessions.dispose(s.owner!)
          break
        default:
          throw new Error(`no such op ${s.op}`)
      }
      results.push({ ok: value })
    } catch (error) {
      results.push(errorEntry(error))
    }
  }
  const leftovers: unknown[] = []
  for (const dir of scan) {
    for (const name of readdirSync(dir).sort()) {
      if (!/-images-[A-Za-z0-9]{6}$/.test(name)) continue
      const path = `${dir}/${name}`
      leftovers.push({ name: maskRandom(name), files: readdirSync(path).sort() })
      rmSync(path, { recursive: true, force: true })
    }
  }
  return { results: JSON.parse(maskRandom(j(results))), leftovers }
}

const PNG_HEAD = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const png = (rest: string | Buffer = 'data'): string =>
  Buffer.concat([PNG_HEAD, Buffer.from(rest)]).toString('base64')
const SCAN = ['$DIR']
const exportCase = (
  steps: ExportStep[],
  scan: string[] = SCAN,
  files?: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [steps, scan],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})
const startOne: ExportStep = { op: 'start', owner: 1, parent: '$DIR', name: 'Export' }
const page = (n: number | null, base64: unknown = png(), session = 0, owner = 1): ExportStep => ({
  op: 'write',
  owner,
  session,
  page: n,
  base64,
})

const imageExportCases: Case[] = [
  exportCase(
    [startOne, page(1), page(2, png('two')), { op: 'finish', owner: 1, session: 0, success: true }],
    SCAN,
    undefined,
    'two pages kept',
  ),
  exportCase(
    [startOne, page(1), { op: 'finishExport', owner: 1, session: 0, success: true }],
    SCAN,
    undefined,
    'finishExport: dir and first page',
  ),
  exportCase(
    [startOne, page(1), { op: 'finish', owner: 1, session: 0, success: false }],
    SCAN,
    undefined,
    'failed: the folder goes',
  ),
  exportCase(
    [startOne, { op: 'finish', owner: 1, session: 0, success: true }],
    SCAN,
    undefined,
    'an empty export that is reported as done',
  ),
  exportCase(
    [startOne, { op: 'finishExport', owner: 1, session: 0, success: false }],
    SCAN,
    undefined,
    'an empty export that failed: null',
  ),
  exportCase(
    [
      startOne,
      { op: 'finish', owner: 1, session: 0, success: true },
      { op: 'finish', owner: 1, session: 0, success: true },
    ],
    SCAN,
    undefined,
    'finished twice',
  ),
  exportCase(
    [
      startOne,
      page(1, png(), 0, 2),
      { op: 'finish', owner: 2, session: 0, success: true },
      page(1, png(), 5),
    ],
    SCAN,
    undefined,
    'another owner, an unknown session',
  ),
  exportCase(
    [
      startOne,
      page(2),
      page(1.5),
      page(0),
      page(-1),
      page(null),
      page(9007199254740992),
      page(1, 5),
      page(1, null),
      page(1, Buffer.from('hello').toString('base64')),
      page(1, ''),
      page(1, 'iVBORw0K'),
      page(1),
    ],
    SCAN,
    undefined,
    'what a page may be',
  ),
  exportCase([startOne, page(1), page(1)], SCAN, undefined, 'the same page twice'),
  exportCase(
    [
      startOne,
      page(1, png().replace(/(.{8})/g, '$1\n')),
      page(2, `${png('pad')}==`),
      page(3, png('x?y').replace(/\+/g, '-').replace(/\//g, '_')),
      page(4, `${png('q').slice(0, 6)}*${png('q').slice(6)}`),
      page(5, `${png('end')}=trailing`),
      { op: 'finishExport', owner: 1, session: 0, success: true },
    ],
    SCAN,
    undefined,
    'base64 as Node reads it: white space, padding, both alphabets, junk, an end at =',
  ),
  exportCase(
    [
      { op: 'start', owner: 1, parent: '$DIR', name: 'a' },
      { op: 'start', owner: 1, parent: '$DIR', name: 'b' },
      { op: 'start', owner: 2, parent: '$DIR', name: 'c' },
      page(1, png(), 0, 1),
      { op: 'dispose', owner: 1 },
      page(1, png(), 0, 1),
      page(1, png(), 2, 2),
      { op: 'dispose', owner: 3 },
    ],
    SCAN,
    undefined,
    "dispose finishes only the owner's sessions",
  ),
  exportCase(
    [{ op: 'start', owner: 1, parent: '$DIR/none', name: 'x' }],
    SCAN,
    undefined,
    'no parent folder',
  ),
  exportCase(
    [
      { op: 'start', owner: 1, parent: '$DIR', name: 'a/b:c*?"<>|' },
      { op: 'start', owner: 1, parent: '$DIR', name: 'n'.repeat(100) },
      { op: 'start', owner: 1, parent: '$DIR', name: '   ' },
      { op: 'start', owner: 1, parent: '$DIR', name: ` ${EMOJI.repeat(50)} ` },
      { op: 'start', owner: 1, parent: '$DIR', name: '' },
      { op: 'start', owner: 1, parent: '$DIR', name: `${'m'.repeat(79)} z` },
    ],
    SCAN,
    undefined,
    'the folder name from the title',
  ),
  exportCase(
    [
      { op: 'startFiles', owner: 1, target: '$DIR/out/report.png' },
      page(1),
      page(2),
      page(3),
      { op: 'finishExport', owner: 1, session: 0, success: true },
    ],
    ['$DIR/out'],
    { 'out/keep.txt': 'x' },
    'Save As to page images: numbered siblings',
  ),
  exportCase(
    [
      { op: 'startFiles', owner: 1, target: '$DIR/out/report.png' },
      page(1),
      { op: 'finishExport', owner: 1, session: 0, success: true },
    ],
    ['$DIR/out'],
    { 'out/keep.txt': 'x' },
    'one page keeps the typed name',
  ),
  exportCase(
    [
      { op: 'startFiles', owner: 1, target: '$DIR/out/report' },
      page(1),
      page(2),
      { op: 'finish', owner: 1, session: 0, success: true },
    ],
    ['$DIR/out'],
    { 'out/old-1.png': 'x' },
    'no extension; finish answers the folder of the target',
  ),
  exportCase(
    [
      { op: 'startFiles', owner: 1, target: '$DIR/out/r.png' },
      page(1),
      page(2),
      { op: 'finishExport', owner: 1, session: 0, success: true },
    ],
    ['$DIR/out'],
    { 'out/r-01.png': 'old one', 'out/r-02.png': { dir: true } },
    'a numbered name is a folder: the move fails, the staging folder still goes',
  ),
  exportCase(
    [
      { op: 'startFiles', owner: 1, target: '$DIR/out/r.png' },
      page(1),
      page(2),
      { op: 'finishExport', owner: 1, session: 0, success: false },
    ],
    ['$DIR/out'],
    { 'out/keep': 'x' },
    'Save As that failed',
  ),
  exportCase(
    [{ op: 'startFiles', owner: 1, target: '$DIR/none/r.png' }],
    SCAN,
    undefined,
    'Save As into a folder that is not there',
  ),
]

// ---- image-host ----

const S3 = {
  kind: 's3',
  endpoint: 'https://acc.r2.cloudflarestorage.com/',
  region: 'auto',
  bucket: 'bk',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  prefix: 'notes/',
  publicBase: 'https://cdn.example.com/',
}
const SMMS = { kind: 'smms', token: 'tok' }
const GITHUB = { kind: 'github', token: 'ghp', owner: 'o', repo: 'r' }

const configCases: Case[] = [
  null,
  'text',
  5,
  true,
  [],
  ['s3'],
  {},
  { kind: 'S3' },
  { kind: 'ftp' },
  { kind: 5 },
  S3,
  {
    ...S3,
    endpoint: '  https://x.example.com  ',
    region: '',
    bucket: ` ${'b'.repeat(200)} `,
    accessKeyId: 'k'.repeat(300),
    prefix: 'p'.repeat(300),
  },
  { ...S3, region: 'r'.repeat(70), publicBase: '' },
  { ...S3, bucket: '' },
  { ...S3, bucket: '  ' },
  { ...S3, accessKeyId: 5 },
  { ...S3, secretAccessKey: undefined },
  { ...S3, endpoint: 'http://insecure.example.com' },
  { ...S3, endpoint: 'HTTPS://UPPER.example.com' },
  { ...S3, endpoint: 'http\u017F://x.example.com' },
  { ...S3, endpoint: 'https:/x' },
  { ...S3, endpoint: `https://${EMOJI.repeat(300)}`, token: 'ignored' },
  SMMS,
  { kind: 'smms' },
  { kind: 'smms', token: '   ' },
  { kind: 'smms', token: ` ${'t'.repeat(300)} ` },
  { kind: 'smms', token: 5 },
  GITHUB,
  { ...GITHUB, branch: 'dev', dir: 'img', urlPrefix: 'https://cdn.example.com/gh' },
  { ...GITHUB, branch: '  ', dir: '' },
  { ...GITHUB, owner: '' },
  { ...GITHUB, repo: undefined },
  { ...GITHUB, token: '' },
  { ...GITHUB, owner: ` ${'o'.repeat(200)}`, repo: 'r\u00e9' },
].map((raw): Case => ({ args: [raw] }))

const keyCase = (
  prefix: string | null,
  ext: string,
  now: number,
  random: number | null = null,
): Case => ({
  args: [prefix, ext, now, random],
})
const objectKeyCases: Case[] = [
  keyCase(null, 'png', NOW),
  keyCase('notes/', 'jpg', NOW),
  keyCase('/a/b/', 'png', NOW),
  keyCase('///', 'png', NOW),
  keyCase('/', 'png', NOW),
  keyCase('', 'png', NOW),
  keyCase('x', 'PNG', NOW, 0),
  keyCase('x', 'png', NOW, 0.999999),
  keyCase('x', 'png', NOW, 0.5),
  keyCase(null, 'png', 0),
  keyCase(null, 'png', -1),
  keyCase(null, 'png', 1.9),
  keyCase(null, 'png', -62198755200000),
  keyCase(null, 'png', 253402300800000),
  keyCase(null, 'png', 8.64e15),
  keyCase(null, 'png', 1e16),
  keyCase('\u00e9/\u0131', 'png', NOW),
]

const KEY_CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'iam',
}
const sigCase = (
  method: string,
  url: string,
  headers: Record<string, string>,
  payload = '',
  creds = KEY_CREDS,
  amzDate = '20150830T123600Z',
): Case => ({
  args: [method, url, headers, payload, creds, amzDate],
})
const IAM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
  Host: 'iam.amazonaws.com',
  'X-Amz-Date': '20150830T123600Z',
}
const sigV4Cases: Case[] = [
  sigCase('GET', 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', IAM_HEADERS),
  sigCase(
    'PUT',
    'https://bk.example.com:8443/a b/\u00e9/%41/x+y?b=2&a=1&a=0&c=%20&d=a+b',
    { Host: 'bk.example.com:8443', 'x-amz-date': '20240101T000000Z' },
    'payload',
  ),
  sigCase('put', 'https://h.example.com', { host: 'h.example.com' }),
  sigCase('PUT', 'https://h.example.com/', { Host: ' a ', host: 'b', 'X-Y': '\t v  ' }),
  sigCase('PUT', 'https://h.example.com/p?', { Host: 'h' }),
  sigCase('PUT', 'https://h.example.com/p?a&b=&=c&%E4%BD%A0=%F0%9F%98%80', { Host: 'h' }),
  sigCase('PUT', 'https://h.example.com/p?z=1&z=0&y=%C3%A9&y=e', { Host: 'h' }),
  sigCase(
    'PUT',
    'https://h.example.com/p',
    { '\uFF22': 'upper', [EMOJI]: 'astral', a: '1', B: '2' },
    'x',
  ),
  sigCase('PUT', 'https://h.example.com/p', { '\u0130x': '1', '\u212A': '2', Z: '3' }),
  sigCase('PUT', 'https://[::1]:9000/p/q', { Host: '[::1]:9000' }),
  sigCase('PUT', 'https://h.example.com/p', {}, ''),
  sigCase(
    'GET',
    'https://h.example.com/p',
    { Host: 'h' },
    `${EMOJI}\u00e9`,
    { ...KEY_CREDS, secretAccessKey: 'k'.repeat(100) },
    '20240229T235959Z',
  ),
  sigCase(
    'GET',
    'https://h.example.com/p',
    { Host: 'h' },
    '',
    { ...KEY_CREDS, secretAccessKey: '' },
    '2024',
  ),
  sigCase('GET', 'not a url', { Host: 'h' }),
]

interface FakeResponse {
  ok?: boolean
  status?: number
  opaque?: boolean
  headers?: Record<string, string> | 'absent' | 'noGet'
  text?: string | null
  textReject?: string
  throw?: 'error' | 'string'
  message?: string
}

const headHex = (bytes: Uint8Array): string => Buffer.from(bytes.subarray(0, 8)).toString('hex')

async function bodyOf(body: unknown): Promise<unknown[]> {
  if (Buffer.isBuffer(body)) return ['bytes', body.length, headHex(body)]
  if (typeof body === 'string') return ['text', body]
  if (body instanceof FormData) {
    const [[name, file]] = [...body.entries()] as [[string, File]]
    return [
      'form',
      name,
      file.name,
      file.type,
      file.size,
      headHex(new Uint8Array(await file.arrayBuffer())),
    ]
  }
  return ['other']
}

function fakeResponse(spec: FakeResponse): unknown {
  if (spec.throw === 'string') throw 'plain string'
  if (spec.throw === 'error') throw new Error(spec.message ?? 'fetch failed')
  const response: Record<string, unknown> = {
    ok: spec.ok === true,
    status: spec.status ?? 0,
    type: spec.opaque ? 'opaqueredirect' : 'default',
  }
  if (spec.headers === 'noGet') response.headers = {}
  else if (spec.headers !== 'absent') {
    const given = spec.headers ?? {}
    response.headers = { get: (name: string): string | null => given[name.toLowerCase()] ?? null }
  }
  if (spec.textReject !== undefined) {
    response.text = async () => {
      throw new Error(spec.textReject)
    }
  } else if (spec.text !== null) {
    const text = spec.text ?? ''
    response.text = async () => text
  }
  return response
}

type UploadInput = {
  bytes: { hex: string } | { length: number; fill: number }
  ext: string
  now: number | null
}

async function runUpload(a: unknown[], cx: TsContext): Promise<unknown> {
  const config = a[0]
  const input = a[1] as UploadInput
  const responses = [...((a[2] as { responses: FakeResponse[] } | null)?.responses ?? [])]
  const bytes =
    'hex' in input.bytes
      ? Buffer.from(input.bytes.hex, 'hex')
      : Buffer.alloc(input.bytes.length, input.bytes.fill)
  const fetchImpl = async (
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
      signal?: AbortSignal
      redirect?: string
    },
  ) => {
    cx.log(
      url,
      init?.method,
      Object.entries(init?.headers ?? {}),
      await bodyOf(init?.body),
      init?.redirect,
      init?.signal !== undefined,
    )
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return fakeResponse(next) as never
  }
  return withRandoms([0.31, 0.62, 0.93], () =>
    uploadImageToHost(config as never, {
      bytes,
      ext: input.ext,
      fetchImpl,
      now: new Date(input.now ?? cx.now),
    }),
  )
}

const hexOf = (text: string): string => Buffer.from(text).toString('hex')
const PIC = { hex: hexOf('picture') }
const upload = (
  config: unknown,
  responses: FakeResponse[],
  extra: Partial<UploadInput> = {},
  note?: string,
): Case => ({
  args: [config, { bytes: PIC, ext: 'png', now: null, ...extra }, { responses }],
  ...(note ? { note } : {}),
})
const OK200: FakeResponse = { ok: true, status: 200 }
const redirect = (status: number, location: string | null): FakeResponse => ({
  status,
  headers: location === null ? {} : { location },
})
const GH_OK = (url = 'https://raw.githubusercontent.com/o/r/main/images/x.png'): FakeResponse => ({
  ok: true,
  status: 201,
  text: j({ content: { download_url: url } }),
})
const SM_OK = (url = 'https://s2.loli.net/a.png'): FakeResponse => ({
  ok: true,
  status: 200,
  text: j({ success: true, data: { url } }),
})

const uploadCases: Case[] = [
  upload(null, [], {}, 'no host'),
  upload({ kind: 's3' }, [], {}, 'a config that is not usable'),
  upload(S3, [], { bytes: { hex: '' } }, 'empty image'),
  upload(S3, [], { bytes: { length: 25 * 1024 * 1024 + 1, fill: 1 } }, 'past the ceiling'),
  upload(S3, [OK200], { bytes: { length: 25 * 1024 * 1024, fill: 7 } }, 'exactly the ceiling'),
  upload(S3, [OK200], {}, 's3: ok, public base'),
  upload(
    { ...S3, publicBase: '', prefix: '' },
    [OK200],
    { ext: 'webp' },
    's3: no public base, no prefix',
  ),
  upload(
    { ...S3, endpoint: 'https://s3.example.com:9000/base///', region: 'eu-1', publicBase: '   ' },
    [OK200],
    { now: 0 },
    's3: endpoint with port and path',
  ),
  upload(S3, [{ status: 403, text: 'denied' }], {}, 's3: refused'),
  upload(S3, [{ status: 500, text: '' }], {}, 's3: refused, no text'),
  upload(S3, [{ status: 500, text: null }], {}, 's3: refused, no text function'),
  upload(S3, [{ status: 500, textReject: 'gone' }], {}, 's3: refused, the text rejects'),
  upload(
    S3,
    [{ status: 400, text: `${EMOJI.repeat(150)}tail` }],
    {},
    's3: the text is cut at 200 units',
  ),
  upload(
    S3,
    [{ status: 400, text: 'a'.repeat(1024 * 1024) }],
    {},
    's3: the text at the cap is used',
  ),
  upload(
    S3,
    [{ status: 400, text: 'a'.repeat(1024 * 1024 + 1) }],
    {},
    's3: a text past the cap is dropped',
  ),
  upload(
    S3,
    [{ status: 400, headers: { 'content-length': '1048577' }, text: 'big' }],
    {},
    's3: a declared length past the cap',
  ),
  upload(
    S3,
    [{ status: 400, headers: { 'content-length': '1048576' }, text: 'edge' }],
    {},
    's3: a declared length at the cap',
  ),
  upload(
    S3,
    [{ status: 400, headers: { 'content-length': 'abc' }, text: 'nan' }],
    {},
    's3: a length that is no number',
  ),
  upload(
    S3,
    [{ status: 400, headers: { 'content-length': '' }, text: 'blank' }],
    {},
    's3: an empty length',
  ),
  upload(S3, [{ status: 400.5, text: 'frac' }], {}, 's3: a fractional status'),
  upload(S3, [redirect(301, 'https://evil.example/x')], {}, 's3: a redirect is refused'),
  upload(S3, [redirect(307, '/other')], {}, 's3: a relative redirect names the same site'),
  upload(S3, [redirect(302, 'http://[bad')], {}, 's3: an unreadable location'),
  upload(S3, [redirect(302, 'ftp://files.example:2121/a')], {}, 's3: another scheme and a port'),
  upload(S3, [redirect(302, null)], {}, 's3: no location is no redirect'),
  upload(
    S3,
    [redirect(200, 'https://evil.example/x')],
    {},
    's3: a location on a 200 is no redirect',
  ),
  upload(S3, [{ status: 200, opaque: true }], {}, 's3: an opaque redirect'),
  upload(
    S3,
    [redirect(308, `https://${'h'.repeat(120)}.example/x`)],
    {},
    's3: a long host is cut at 100',
  ),
  upload(S3, [{ ok: true, status: 200, headers: 'absent' }], {}, 's3: a response without headers'),
  upload(S3, [{ ok: true, status: 200, headers: 'noGet' }], {}, 's3: headers without get'),
  upload(S3, [{ throw: 'error', message: 'boom' }], {}, 's3: the fetch throws'),
  upload(S3, [{ throw: 'error', message: '' }], {}, 's3: an error with no message'),
  upload(S3, [{ throw: 'string' }], {}, 's3: something that is no Error is thrown'),
  upload(
    S3,
    [{ throw: 'error', message: 'Redirect was cancelled' }],
    {},
    's3: net.fetch refuses a redirect',
  ),
  upload(
    S3,
    [{ throw: 'error', message: 'Redirect was cancelled\n' }],
    {},
    's3: not exactly that message',
  ),
  upload(
    S3,
    [{ throw: 'error', message: 'Attempted to redirect, but redirect policy was manual' }],
    {},
    's3: the other refusal',
  ),
  upload(S3, [], {}, 's3: the fetch has no answer left'),
  upload({ ...S3, endpoint: 'https://[bad' }, [OK200], {}, 's3: an endpoint that is no URL'),
  upload(S3, [OK200], { now: 1e16 }, 's3: an invalid date'),
  upload(S3, [OK200], { now: 253402300800000, ext: 'png' }, 's3: a year past 9999'),
  upload(S3, [OK200], { now: -62198755200000 }, 's3: a negative year'),
  upload(SMMS, [SM_OK()], {}, 'smms: ok'),
  upload(SMMS, [SM_OK()], { ext: 'jpg' }, 'smms: jpg is image/jpeg'),
  upload(SMMS, [SM_OK()], { ext: 'PNG' }, 'smms: the type is lower case'),
  upload(SMMS, [SM_OK()], { ext: 'p\u00e9g' }, 'smms: a non-ASCII type is empty'),
  upload(SMMS, [SM_OK()], { ext: '' }, 'smms: an empty extension'),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: 'true', data: { url: 'https://a/b.png' } }) }],
    {},
    'smms: the string "true"',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: 'false', data: { url: 'https://a/b.png' } }) }],
    {},
    'smms: the string "false"',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: false, message: 'Image upload repeated limit' }) }],
    {},
    'smms: refused with a message',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: false, message: 5 }) }],
    {},
    'smms: a message that is no string',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: false, message: 'm'.repeat(300) }) }],
    {},
    'smms: the message is cut at 200',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: true, data: { quilt_url: 'https://q/a.png' } }) }],
    {},
    'smms: quilt_url',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: true, data: { url: '', quilt_url: 'https://q/a.png' } }) }],
    {},
    'smms: an empty url is kept',
  ),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: true, data: { url: 5 } }) }],
    {},
    'smms: a url that is no string',
  ),
  upload(SMMS, [{ status: 200, text: j({ success: true }) }], {}, 'smms: no data'),
  upload(SMMS, [{ status: 200, text: j({ success: true, data: [] }) }], {}, 'smms: data is a list'),
  upload(
    SMMS,
    [{ status: 200, text: j({ success: true, data: 'x' }) }],
    {},
    'smms: data is a string',
  ),
  upload(SMMS, [{ status: 502, text: '<html>' }], {}, 'smms: not JSON'),
  upload(SMMS, [{ status: 200, text: null }], {}, 'smms: no text'),
  upload(SMMS, [{ status: 200, text: 'null' }], {}, 'smms: null'),
  upload(SMMS, [{ status: 200, text: '[]' }], {}, 'smms: a list'),
  upload(SMMS, [{ status: 200, text: '"str"' }], {}, 'smms: a string'),
  upload(
    SMMS,
    [{ ok: false, status: 500, text: j({ success: true, data: { url: 'https://a/b.png' } }) }],
    {},
    'smms: ok is never read',
  ),
  upload(SMMS, [redirect(302, 'https://evil.example/')], {}, 'smms: a redirect is refused'),
  upload(SMMS, [{ throw: 'error', message: 'down' }], {}, 'smms: the fetch throws'),
  upload(GITHUB, [GH_OK()], {}, 'github: ok'),
  upload(
    { ...GITHUB, branch: 'dev', dir: 'img', urlPrefix: 'https://cdn.example.com/gh/' },
    [GH_OK()],
    { ext: 'gif' },
    'github: a CDN prefix, a branch, a dir',
  ),
  upload(
    { ...GITHUB, owner: 'o w', repo: '../x' },
    [GH_OK()],
    {},
    'github: the address is normalised',
  ),
  upload(
    { ...GITHUB, owner: 'o\u00e9', repo: `r${EMOJI}` },
    [GH_OK()],
    {},
    'github: non-ASCII owner and repo',
  ),
  upload(GITHUB, [{ status: 422, text: j({ message: 'Invalid request' }) }], {}, 'github: refused'),
  upload(GITHUB, [{ status: 422, text: j({ message: 7 }) }], {}, 'github: no message'),
  upload(GITHUB, [{ status: 500, text: 'oops' }], {}, 'github: not JSON'),
  upload(GITHUB, [{ ok: true, status: 201, text: '{}' }], {}, 'github: no download_url'),
  upload(
    GITHUB,
    [{ ok: true, status: 201, text: j({ content: { download_url: '' } }) }],
    {},
    'github: an empty download_url',
  ),
  upload(
    GITHUB,
    [{ ok: true, status: 201, text: j({ content: 'x' }) }],
    {},
    'github: content is a string',
  ),
  upload(
    GITHUB,
    [{ ok: true, status: 201, text: j({ content: null }) }],
    {},
    'github: content is null',
  ),
  upload(
    { ...GITHUB, urlPrefix: 'https://cdn.example.com' },
    [{ ok: true, status: 201, text: j({ content: {} }) }],
    {},
    'github: the prefix does not help without download_url',
  ),
  upload(
    GITHUB,
    [redirect(301, 'https://api.github.com/repositories/1/contents/x')],
    {},
    'github: a renamed repository',
  ),
  upload(
    GITHUB,
    [{ throw: 'error', message: 'Redirect was cancelled' }],
    {},
    'github: net.fetch refuses a redirect',
  ),
  upload(GITHUB, [{ throw: 'error', message: 'offline' }], {}, 'github: the fetch throws'),
  upload(GITHUB, [GH_OK()], { now: 1e16 }, 'github: an invalid date'),
  upload(
    GITHUB,
    [GH_OK()],
    { bytes: { hex: hexOf(`${EMOJI}\u00e9`) } },
    'github: the body carries the picture as base64',
  ),
]

// ---- wiki ----

const splitCases: Case[] = [
  'Note',
  ' Note ',
  'Note#Heading',
  '#Heading',
  'Note#',
  'Note#^abc#x',
  '  #  ',
  '',
  'a#b#c',
  '\u00a0Note\u00a0#\ufeffH\ufeff',
  '\u0085Note\u0085',
  `${EMOJI}#${EMOJI}`,
  'folder/Note # Head ing ',
].map((raw): Case => ({ args: [raw] }))

interface VaultStep {
  op: string
  path?: string
  dir?: string
  root?: string
  text?: string
  mtimeMs?: number | null
  ms?: number
}

type VaultFs = ReturnType<typeof nodeVaultFs>

/** `[steps]`: see the Rust dispatcher; the clock starts at the call's and `tick` moves it */
async function runVault(a: unknown[], cx: TsContext, plain: boolean): Promise<unknown> {
  const clock = { now: cx.now }
  return withNow(clock, async () => {
    let vfs: VaultFs = nodeVaultFs()
    let plainFs = nodeFs()
    const out: unknown[] = []
    const setTime = (path: string, ms?: number | null) => {
      if (ms != null) utimesSync(path, ms / 1000, ms / 1000)
    }
    for (const s of a[0] as VaultStep[]) {
      switch (s.op) {
        case 'write':
          mkdirSync(dirname(s.path!), { recursive: true })
          writeFileSync(s.path!, s.text!)
          setTime(s.path!, s.mtimeMs)
          break
        case 'mkdir':
          mkdirSync(s.path!, { recursive: true })
          setTime(s.path!, s.mtimeMs)
          break
        case 'rm':
          rmSync(s.path!, { recursive: true, force: true })
          break
        case 'touch':
          setTime(s.path!, s.mtimeMs)
          break
        case 'tick':
          clock.now += s.ms ?? 0
          break
        case 'newFs':
          vfs = nodeVaultFs()
          plainFs = nodeFs()
          break
        case 'isFile':
          out.push(await (plain ? plainFs : vfs).isFile(s.path!))
          break
        case 'list':
          try {
            const listing = await (plain ? plainFs : vfs).list(s.dir!)
            out.push({ files: listing.files, dirs: listing.dirs })
          } catch (error) {
            out.push(errorEntry(error))
          }
          break
        case 'read':
          try {
            out.push(await vfs.read(s.path!))
          } catch (error) {
            out.push(errorEntry(error))
          }
          break
        case 'mtime':
          out.push(await vfs.mtimeMs(s.path!))
          break
        case 'backlinks':
          out.push(await wikiBacklinks(s.root!, s.path!, vfs))
          break
        case 'tags':
          out.push(await wikiTags(s.root!, vfs))
          break
        case 'graph':
          out.push(await wikiGraph(s.root!, vfs))
          break
        case 'warm':
          warmWikiIndex(s.root!, vfs)
          await wikiTags(s.root!, vfs)
          out.push(null)
          break
        default:
          throw new Error(`no such op ${s.op}`)
      }
    }
    return out
  })
}

const T = 1_000_000_000
const vault = (steps: VaultStep[], files?: Record<string, FileSpec>, note?: string): Case => ({
  args: [steps],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})
const listD: VaultStep = { op: 'list', dir: '$DIR/d' }

const nodeFsCases: Case[] = [
  vault(
    [
      { op: 'isFile', path: '$DIR/a.md' },
      { op: 'isFile', path: '$DIR/d' },
      { op: 'isFile', path: '$DIR/none' },
      { op: 'isFile', path: '$DIR/a.md/x' },
    ],
    { 'a.md': 'x', d: { dir: true } },
    'files, folders, nothing',
  ),
  vault(
    [
      { op: 'list', dir: '$DIR/d' },
      { op: 'list', dir: '$DIR/none' },
      { op: 'list', dir: '$DIR/a.md' },
      { op: 'list', dir: '$DIR/d/sub' },
    ],
    {
      'd/b': 'x',
      'd/B': 'x',
      'd/a': 'x',
      'd/\u00e9': 'x',
      'd/Z': 'x',
      'd/10': 'x',
      'd/2': 'x',
      'd/sub/f': 'x',
      'd/zdir/f': 'x',
      'a.md': 'x',
    },
    'listing: files and folders apart, sorted by bytes; errors',
  ),
  vault(
    [
      { op: 'touch', path: '$DIR/d', mtimeMs: T },
      listD,
      { op: 'write', path: '$DIR/d/new.md', text: 'n' },
      { op: 'touch', path: '$DIR/d', mtimeMs: T },
      listD,
      { op: 'tick', ms: 1999 },
      listD,
      { op: 'tick', ms: 1 },
      listD,
      { op: 'touch', path: '$DIR/d', mtimeMs: T + 5000 },
      { op: 'tick', ms: 1 },
      listD,
      { op: 'tick', ms: 2000 },
      listD,
    ],
    { 'd/a.md': 'x' },
    'the cache: the ttl, then the mtime of the folder',
  ),
  vault(
    [
      { op: 'touch', path: '$DIR/d', mtimeMs: T },
      listD,
      { op: 'write', path: '$DIR/d/new.md', text: 'n' },
      { op: 'touch', path: '$DIR/d', mtimeMs: T },
      { op: 'tick', ms: 5000 },
      { op: 'newFs' },
      listD,
    ],
    { 'd/a.md': 'x' },
    'a new filesystem has no cache',
  ),
  vault(
    [listD, { op: 'rm', path: '$DIR/d' }, listD, { op: 'tick', ms: 3000 }, listD],
    { 'd/a.md': 'x' },
    'a folder that went: still cached, then an error',
  ),
  vault([listD, listD], { 'd/x': 'x', d: { dir: true, mode: 0o000 } }, 'a folder nobody may read'),
]

const vaultFsCases: Case[] = [
  vault(
    [
      { op: 'read', path: '$DIR/a.md' },
      { op: 'read', path: '$DIR/none.md' },
      { op: 'read', path: '$DIR/d' },
      { op: 'read', path: '$DIR/bom.md' },
      { op: 'read', path: '$DIR/bad.md' },
      { op: 'read', path: '$DIR/empty.md' },
      { op: 'mtime', path: '$DIR/a.md' },
      { op: 'mtime', path: '$DIR/none.md' },
      { op: 'mtime', path: '$DIR/d' },
      { op: 'isFile', path: '$DIR/a.md' },
      { op: 'list', dir: '$DIR/d' },
    ],
    {
      'a.md': { text: `caf\u00e9 ${EMOJI}`, mtimeMs: 1_700_000_000_000 },
      d: { dir: true, mtimeMs: 1_600_000_000_000 },
      'bom.md': '\ufeffbom',
      'bad.md': { hex: '61ff62c328' },
      'empty.md': '',
    },
    'read and mtime',
  ),
  vault(
    [
      { op: 'read', path: '$DIR/secret.md' },
      { op: 'mtime', path: '$DIR/secret.md' },
    ],
    { 'secret.md': { text: 'x', mode: 0o000 } },
    'a file nobody may read',
  ),
]

const resolveCase = (
  targets: string[],
  fromPath: string,
  root: string,
  files: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [targets, { fromPath, root }],
  files,
  ...(note ? { note } : {}),
})
const R = '$DIR/vault'
const resolveCases: Case[] = [
  resolveCase([], '$DIR/vault/a.md', R, { 'vault/a.md': '' }, 'no targets'),
  resolveCase(
    ['b', 'B', 'a', 'missing'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/b.md': '' },
    'beside the document; case matters',
  ),
  resolveCase(
    ['n', 'm', 'x'],
    '$DIR/vault/a.md',
    R,
    {
      'vault/a.md': '',
      'vault/n.markdown': '',
      'vault/n.txt': '',
      'vault/m.txt': '',
      'vault/m.markdown': '',
      'vault/x.md': '',
      'vault/x.markdown': '',
    },
    'md, then markdown, then txt',
  ),
  resolveCase(
    ['pic.png', 'pic', 'x.foo', 'x'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/pic.png': '', 'vault/x.foo': '' },
    'an extension is the file as written',
  ),
  resolveCase(
    ['#Heading', '#', ' #x ', 'Note#H'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/Note.md': '' },
    'a same-file target',
  ),
  resolveCase(
    ['#Heading', '# '],
    '',
    R,
    { 'vault/a.md': '' },
    'a same-file target in an untitled document',
  ),
  resolveCase(
    ['../x', '/etc/passwd', 'a/../b', 'a\\..\\b', '..', 'ok/..', 'ok'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'x.md': '', 'vault/ok.md': '' },
    'a target that climbs out',
  ),
  resolveCase(
    ['Deep', 'Shallow'],
    '',
    R,
    {
      'vault/a/b/Deep.md': '',
      'vault/c/Deep.md': '',
      'vault/c/Shallow.md': '',
      'vault/a/b/c/d/Shallow.md': '',
    },
    'a shallower file beats a deeper one',
  ),
  resolveCase(
    ['f/Note', 'g/h/Note', 'h/Note', 'Note'],
    '',
    R,
    {
      'vault/a/f/Note.md': '',
      'vault/f/Note.md': '',
      'vault/a/g/h/Note.md': '',
      'vault/Note.md': '',
      'vault/zz/Note.markdown': '',
    },
    'a path with a directory matches the end of the path',
  ),
  resolveCase(
    ['f/Note', 'f\\Note', 'f/Note.md'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/f/Note.md': '', 'vault/b/f/Note.md': '' },
    'a directory path is tried at the root first',
  ),
  resolveCase(
    ['Note', 'sub/Note'],
    '$DIR/vault/sub/a.md',
    R,
    { 'vault/sub/a.md': '', 'vault/sub/Note.md': '', 'vault/Note.md': '' },
    'the document directory first',
  ),
  resolveCase(
    ['Note', 'sub/Note'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/sub/Note.md': '' },
    'the document directory is the root',
  ),
  resolveCase(
    ['Hidden', 'Mod', 'Venv', 'Trash', 'Ok'],
    '',
    R,
    {
      'vault/.git/Hidden.md': '',
      'vault/.obsidian/Hidden.md': '',
      'vault/node_modules/Mod.md': '',
      'vault/.venv/Venv.md': '',
      'vault/venv/Venv.md': '',
      'vault/__pycache__/Venv.md': '',
      'vault/.trash/Trash.md': '',
      'vault/.DS_Store/Trash.md': '',
      'vault/sub/Ok.md': '',
    },
    'folders that are never entered',
  ),
  resolveCase(
    ['D6', 'D7'],
    '',
    R,
    { 'vault/1/2/3/4/5/6/D6.md': '', 'vault/1/2/3/4/5/6/7/D7.md': '' },
    'six levels deep, then seven',
  ),
  resolveCase(
    ['A', ' A', 'A ', 'A#x', 'A#y'],
    '',
    R,
    { 'vault/q/A.md': '' },
    'several spellings of one name',
  ),
  resolveCase(
    ['Figure 1.png', 'Figure 1', 'figure 1'],
    '',
    R,
    { 'vault/img/Figure 1.png': '', 'vault/Figure 1.md': '', 'vault/other/figure 1.txt': '' },
    'media by the full name, notes by the stem',
  ),
  resolveCase(
    ['N', 'N.md'],
    '',
    R,
    { 'vault/a/N.md': '', 'vault/a/N.txt': '' },
    'two files of one stem: the first by name',
  ),
  resolveCase(
    ['\u00e9', 'caf\u00e9/\u0131', '\u212A', '\u017F'],
    '',
    R,
    { 'vault/\u00e9.md': '', 'vault/caf\u00e9/\u0131.md': '', 'vault/k.md': '', 'vault/s.md': '' },
    'non-ASCII names',
  ),
  resolveCase(
    ['L', `${EMOJI}/L`],
    '',
    R,
    { [`vault/${EMOJI}/L.md`]: '', 'vault/L.md': { text: '' } },
    'an astral folder',
  ),
  resolveCase(
    ['Secret', 'Open'],
    '',
    R,
    { 'vault/a/Secret.md': '', 'vault/a': { dir: true, mode: 0o000 }, 'vault/b/Open.md': '' },
    'a folder nobody may read reads as empty',
  ),
  resolveCase(['X'], '$DIR/vault/a.md', '', { 'vault/a.md': '', 'vault/X.md': '' }, 'no root'),
  resolveCase(['X', 'Y'], '', '', { 'vault/X.md': '' }, 'no root, no document'),
  resolveCase(
    ['X'],
    '$DIR/vault/a.md',
    '$DIR/missing',
    { 'vault/a.md': '' },
    'a root that is not there',
  ),
  resolveCase(
    ['dup', 'dup', 'dup#a', 'dup'],
    '',
    R,
    { 'vault/dup.md': '' },
    'a target twice keeps its place',
  ),
  resolveCase(
    ['1', '2', '10', '__proto__', 'constructor'],
    '',
    R,
    { 'vault/1.md': '', 'vault/10.md': '', 'vault/__proto__.md': '' },
    'integer-like and prototype names',
  ),
  resolveCase(
    ['Dir', 'dir.md', 'F'],
    '',
    R,
    { 'vault/Dir/x': '', 'vault/F/f.md': '' },
    'a folder is no file',
  ),
  resolveCase(
    ['Note'],
    '$DIR/vault/a.md',
    R,
    { 'vault/a.md': '', 'vault/Note.md': { dir: true } },
    'a folder named like the note',
  ),
]

const notesCase = (
  root: string,
  cap: number | string | null,
  files: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [root, cap],
  files,
  ...(note ? { note } : {}),
})
const NOTES_TREE: Record<string, FileSpec> = {
  'v/a.md': '',
  'v/b.txt': '',
  'v/c.markdown': '',
  'v/d.PNG': '',
  'v/e.JpEg': '',
  'v/f.pdf': '',
  'v/g.docx': '',
  'v/.md': '',
  'v/noext': '',
  'v/h.svg': '',
  'v/i.avif': '',
  'v/j.ico': '',
  'v/k.bmp': '',
  'v/l.gif': '',
  'v/m.webp': '',
  'v/n.jpg': '',
  'v/sub/o.md': '',
  'v/sub/deeper/p.md': '',
  'v/.git/q.md': '',
  'v/node_modules/r.md': '',
  'v/\u00e9.md': '',
  'v/\u0130.MD': '',
  'v/x.\u212Amd': '',
}
const notesCases: Case[] = [
  notesCase('', null, NOTES_TREE, 'no root'),
  notesCase('$DIR/v', null, NOTES_TREE, 'every kind of file'),
  notesCase('$DIR/none', null, NOTES_TREE, 'a root that is not there'),
  notesCase('$DIR/v', 3, NOTES_TREE, 'a cap'),
  notesCase('$DIR/v', 0, NOTES_TREE, 'cap 0'),
  notesCase('$DIR/v', 1.5, NOTES_TREE, 'a fractional cap'),
  notesCase('$DIR/v', -1, NOTES_TREE, 'a negative cap'),
  notesCase('$DIR/v', 'NaN', NOTES_TREE, 'NaN'),
  notesCase('$DIR/v', 'Infinity', NOTES_TREE, 'no cap'),
  notesCase(
    '$DIR/v',
    2,
    { 'v/a/1.md': '', 'v/a/2.md': '', 'v/b/3.md': '', 'v/b/4.md': '', 'v/c/5.md': '' },
    'the cap is passed by the first file of a later folder',
  ),
  notesCase(
    '$DIR/v',
    1,
    { 'v/a.md': '', 'v/b.md': '', 'v/sub/c.md': '' },
    'the cap is met in the root',
  ),
  notesCase(
    '$DIR/v',
    1,
    { 'v/a/x.md': '', 'v/b/y.md': '', 'v/c/z.md': '' },
    'cap 1 over three folders',
  ),
  notesCase(
    '$DIR/v',
    null,
    { 'v/1/2/3/4/5/6/ok.md': '', 'v/1/2/3/4/5/6/7/no.md': '' },
    'six levels, not seven',
  ),
  notesCase(
    '$DIR/v',
    'Infinity',
    { 'v/f/g.md': '', 'v/f': { dir: true, mode: 0o000 }, 'v/ok.md': '' },
    'a folder nobody may read',
  ),
  notesCase(
    '$DIR/v',
    3,
    { 'v/a.md': '', 'v/b.md': '', 'v/c.md': '', 'v/d.md': '' },
    'a cap met by the last file of the folder',
  ),
  notesCase('$DIR/v', 1, { [`v/${EMOJI}/n.md`]: '', 'v/a.md': '' }, 'astral folder'),
]

const createCase = (
  target: string,
  root: string,
  fromDir: string,
  files?: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [target, { root, fromDir }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})
const CR = '$DIR/vault'
const createCases: Case[] = [
  createCase(
    'Note',
    CR,
    '$DIR/vault/doc',
    { 'vault/doc': { dir: true } },
    'a bare name beside the document',
  ),
  createCase('Note', CR, '', { vault: { dir: true } }, 'an untitled document: the root'),
  createCase('Note', '', '$DIR/loose', undefined, 'no root, a document folder'),
  createCase('Note', '', '', undefined, 'neither'),
  createCase(
    'folder/Note',
    CR,
    '$DIR/vault/doc',
    { 'vault/doc': { dir: true } },
    'a directory path is vault-rooted',
  ),
  createCase('folder/Note', '', '$DIR/vault/doc', undefined, 'a directory path with no root'),
  createCase('a/b/c/Deep#Head', CR, '', undefined, 'nested, with a fragment'),
  createCase('Note#Heading', CR, '', undefined, 'a fragment'),
  createCase('#Heading', CR, '', undefined, 'same-file target'),
  createCase('', CR, '', undefined, 'empty'),
  createCase('   #x', CR, '', undefined, 'blank name'),
  createCase('Note', CR, '', { 'vault/Note.md': 'keep me' }, 'already there'),
  createCase('Note.md', CR, '', { 'vault/Note.md': 'keep me' }, 'already there, extension given'),
  createCase('Note', CR, '', { 'vault/Note.md': { dir: true } }, 'a folder where the note goes'),
  createCase('x/Note', CR, '', { 'vault/x': 'a file' }, 'a file where the folder goes'),
  createCase('x/y/Note', CR, '', { 'vault/x': 'a file' }, 'a file higher up'),
  createCase('../Note', CR, '', undefined, 'climbing'),
  createCase('a/../Note', CR, '', undefined, 'climbing inside'),
  createCase('a\\..\\Note', CR, '', undefined, 'climbing with backslashes'),
  createCase('/abs/Note', CR, '', undefined, 'absolute'),
  createCase('./Note', CR, '', undefined, 'a dot segment goes'),
  createCase('.//a//./Note', CR, '', undefined, 'empty and dot segments go'),
  createCase('.', CR, '', undefined, 'only a dot'),
  createCase('./.', CR, '', undefined, 'only dots'),
  createCase('tool.exe', CR, '', undefined, 'not a note type'),
  createCase('Figure 1.png', CR, '', undefined, 'media is no note'),
  createCase('Note.TXT', CR, '', undefined, 'an upper-case extension is kept as written'),
  createCase('Note.Markdown', CR, '', undefined, 'markdown'),
  createCase('v1.2', CR, '', undefined, 'a dot that is not an extension'),
  createCase('Note.', CR, '', undefined, 'a trailing dot'),
  createCase('Note. . ', CR, '', undefined, 'trailing dots and spaces'),
  createCase('a.b.md', CR, '', undefined, 'two dots'),
  createCase('.hidden', CR, '', undefined, 'a dot file'),
  createCase('...', CR, '', undefined, 'dots only'),
  createCase('a:b*c?d"e<f>g|h', CR, '', undefined, 'characters no name can carry'),
  createCase('x. /Note', CR, '', undefined, 'a folder segment with a trailing dot and space'),
  createCase('CON', CR, '', undefined, 'a device name'),
  createCase('nul.md', CR, '', undefined, 'a device name with an extension'),
  createCase('COM1.txt', CR, '', undefined, 'COM1'),
  createCase('Lpt9', CR, '', undefined, 'LPT9'),
  createCase('folder/aux.v2', CR, '', undefined, 'a device name as a folder'),
  createCase('com0', CR, '', undefined, 'com0 is no device'),
  createCase('console', CR, '', undefined, 'console is no device'),
  createCase('con .md', CR, '', undefined, 'a space before the dot'),
  createCase('Caf\u00e9/\u0131\u017F', CR, '', undefined, 'non-ASCII'),
  createCase(`${EMOJI}/${EMOJI}`, CR, '', undefined, 'astral'),
  createCase(
    'a/b',
    CR,
    '',
    { 'vault/a': { dir: true, mode: 0o555 } },
    'a folder nobody may write in',
  ),
  createCase('Note', CR, '', { vault: { dir: true, mode: 0o555 } }, 'a root nobody may write in'),
  createCase('1/2', CR, '', undefined, 'integer-like names'),
]

const NOTE_MD = [
  '---',
  'title: x',
  '# not a heading',
  '---',
  '# Top',
  'text ^p1',
  '',
  '```',
  '# in fence',
  '^lone',
  '```',
  '## Second ##  ',
  '### Third ^h3',
  '',
  '| a | b |',
  '^table',
  '',
  '> quote ^q',
  '####### seven',
  '#hashtag',
  '   ## Indented',
  '    # code indent',
  '~~~~ info',
  '# tilde',
  '~~~',
  '# still fenced',
  '~~~~',
  '# After',
  '^',
  '^x y',
].join('\n')

const headsCases: Case[] = [
  '',
  '\n',
  '# A',
  '#\tA\t#',
  '# A #  #',
  '#A',
  '# ',
  '#  #',
  '###### Six\n####### Seven',
  '   # Three\n    # Four',
  '# A ^id',
  '# ^id',
  '# A ^id1 ^id2',
  '# A^id',
  'text ^id',
  'text^id',
  '^id',
  '^id extra',
  '^a-B_c',
  '^a-B-c',
  'x ^a-B-c  ',
  'para\n\n\n^lone',
  '# H\n^lone',
  '```\n# x\n```\n^lone',
  '```\n^in\n```\n# After',
  '```js\ncode\n```\n# After',
  '`````\n```\n# still\n`````\n# out',
  '~~~\n```\n~~~\n# out',
  '```\n~~~\n```\n# out',
  '```\n```` trailing\n```\n# in',
  '````\n```\n````\n# out',
  '```\n``` x\n# in',
  '---\n# in front\n---\n# out',
  '---\n# never closed',
  '--- \n# in\n ---\n--- \n# out',
  '---x\n# not front',
  '\n---\n# not front',
  '# A\r\n# B\r\n',
  '# A\r\n^id\r\n',
  'x ^id\r\ny',
  '\u00a0# nbsp\n# \u00a0A\u00a0\n#\u00a0A',
  '#\u2028A\n# A\u2028B',
  `# ${EMOJI} \u0131\u017F\u212A ^${EMOJI}`,
  `# A\n${'^b'.repeat(2)}`,
  Array.from({ length: 205 }, (_, i) => `# H${i}`).join('\n'),
  Array.from({ length: 205 }, (_, i) => `text ^b${i}`).join('\n'),
  Array.from({ length: 205 }, (_, i) => `# H${i} ^b${i}`).join('\n'),
  Array.from({ length: 201 }, (_, i) => `# H${i}`).join('\n') +
    '\n# Last ^lastblock\ntext ^other\n^lone',
  Array.from({ length: 201 }, (_, i) => `text ^b${i}`).join('\n') + '\n# Late heading\n# Late ^blk',
  NOTE_MD,
].map((raw): Case => ({ args: [raw] }))

const wikiHeadsCase = (
  target: string,
  fromPath: string,
  root: string,
  files: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [target, fromPath, root],
  files,
  ...(note ? { note } : {}),
})
const wikiHeadsCases: Case[] = [
  wikiHeadsCase('', '', '$DIR/v', { 'v/Note.md': '# A' }, 'no target'),
  wikiHeadsCase('Note', '$DIR/v/a.md', '$DIR/v', { 'v/a.md': '', 'v/Note.md': '# A\ntext ^b' }),
  wikiHeadsCase('sub/Note', '', '$DIR/v', { 'v/sub/Note.md': '## Deep' }, 'by a path'),
  wikiHeadsCase('Missing', '$DIR/v/a.md', '$DIR/v', { 'v/a.md': '' }, 'unresolved'),
  wikiHeadsCase(
    '../x',
    '$DIR/v/a.md',
    '$DIR/v',
    { 'v/a.md': '', 'x.md': '# secret' },
    'a target that climbs',
  ),
  wikiHeadsCase(
    '#Top',
    '$DIR/v/a.md',
    '$DIR/v',
    { 'v/a.md': '# Mine\n^id' },
    'the open document itself',
  ),
  wikiHeadsCase(
    '#Top',
    '',
    '$DIR/v',
    { 'v/a.md': '# Mine' },
    'an untitled document has no headings to read',
  ),
  wikiHeadsCase('Note#Heading', '', '$DIR/v', { 'v/Note.md': '# A' }, 'a fragment is dropped'),
  wikiHeadsCase(
    'Pic.png',
    '',
    '$DIR/v',
    { 'v/Pic.png': { hex: '89504e47' } },
    'a file that is not text',
  ),
  wikiHeadsCase(
    'Bad',
    '',
    '$DIR/v',
    { 'v/Bad.md': { hex: '23ff2041' } },
    'bytes that are not UTF-8',
  ),
  wikiHeadsCase('Bom', '', '$DIR/v', { 'v/Bom.md': '\ufeff# A\n# B' }, 'a byte order mark'),
  wikiHeadsCase('Dir', '', '$DIR/v', { 'v/Dir.md': { dir: true } }, 'a folder is no note'),
  wikiHeadsCase(
    'Note',
    '',
    '$DIR/v',
    { 'v/Note.md': { text: '# A', mode: 0o000 } },
    'a note nobody may read',
  ),
  wikiHeadsCase('Note', '', '$DIR/v', { 'v/Note.md': NOTE_MD }, 'a full note'),
]

// ---- wiki-index ----

const targetsCases: Case[] = [
  '',
  'no links',
  '[[a]]',
  '![[img.png]]',
  '[[a|alias]] and [[b#h|x]]',
  '[[a]] [[a]] ![[a]] [[a#h]]',
  '[[ spaced ]]',
  '[[]] [[|x]]',
  '[[a\nb]]',
  '[[a[b]]',
  '[[a|b|c]]',
  '[[a|b[c]]',
  '[[[a]]]',
  '[[a]]]]',
  '`[[code]]` [[real]]',
  'a `x` [[one]] `[[two]]` [[three]]',
  '``[[double]]`` [[x]]',
  '`unclosed [[y]]',
  '```\n[[fenced]]\n```\n[[out]]',
  '~~~\n[[tilde]]\n~~~\n[[out2]]',
  '```\n[[a]]\n~~~\n[[still fenced]]\n```\n[[b]]',
  '   ```\n[[x]]\n   ```\n[[y]]',
  '    ```\n[[indented four is no fence]]',
  '```js\n[[a]]\n```',
  '\\[[escaped]]',
  '[[tab\t]] [[\u00e9]] [[\u0131\u017F\u212A]]',
  `[[${EMOJI}]] ![[${EMOJI}|${EMOJI}]]`,
  '[[a]]\r\n[[b]]\r\n```\r\n[[c]]\r\n```\r\n[[d]]',
  '[ [a]] [[a] ]',
  '[[a#]] [[#h]] [[#]]',
  '\u2028[[sep]]\u2029',
].map((raw): Case => ({ args: [raw] }))

const tagsCases: Case[] = [
  '',
  '#tag',
  ' #tag #Tag #tag',
  '#a/b #a-b_c #a1 #1a #_a #-a',
  '# heading\n## h2\n#hashtag',
  'a#b word#c (#d) [#e] "#f" ,#g .#h ;#i',
  'x/#y ~#z -#w _#v',
  '#\u00e9t\u00e9 #\u65e5\u672c\u8a9e #\u0141\u00f3d\u017a #\u03a9mega',
  `#${EMOJI} #a${EMOJI} #\u{10400}x`,
  '#\u0131 #\u017F #\u212A #i\u0307',
  '#a\u0301 #\u0660\u0661',
  '#x1\u0663 #y\u00b2 #z\u2160',
  'https://a.b/#top #real',
  'http://x/#a/#b #after',
  'see mailto:a@b.c #t and <https://x/#anchor> #u',
  '<ftp://f/#g> #h <a:b#c> #d',
  '[text](#anchor) #t [x](http://a/#b) #u',
  '[x](#a)#b',
  '[x](#a\nb) #c',
  '`#code` #real',
  '`#a` `#b` #c',
  '```\n#fenced\n```\n#out',
  '~~~\n#t\n~~~\n#o',
  '```\n#a\n~~~\n#still\n```\n#b',
  '#a\n#a\n#b',
  '\\#escaped #real',
  '##double #single',
  '#tag#other',
  '#a,#b #c;#d',
  'foo://bar#baz #qux',
  'A://b #c',
  '(#a)(#b)',
  '\u2028#sep',
  '#tag\r\n#next\r\n',
].map((raw): Case => ({ args: [raw] }))

const note = (text: string, mtimeMs?: number): FileSpec =>
  mtimeMs === undefined ? text : { text, mtimeMs }
const V = '$DIR/v'
const STEP_BL = (path: string): VaultStep => ({ op: 'backlinks', root: V, path })
const BL_TREE: Record<string, FileSpec> = {
  'v/a.md': note('[[b]] [[c#h]] [[a]] [[#self]] [[a#x]] ![[pic.png]]', T),
  'v/b.md': note('[[a]] [[b|alias]] `[[c]]`', T),
  'v/c.md': note('plain', T),
  'v/pic.png': 'png',
  'v/sub/d.markdown': note('[[a]] [[sub/d]] [[missing]]', T),
  'v/sub/e.txt': note('[[b]]', T),
  'v/UP.MD': note('[[a]]', T),
  'v/.git/g.md': note('[[a]]', T),
  'v/node_modules/n.md': note('[[a]]', T),
  'v/skip.docx': note('[[a]]', T),
  'v/1/2/3/4/5/6/deep.md': note('[[a]]', T),
  'v/1/2/3/4/5/6/7/toodeep.md': note('[[a]]', T),
}
const backlinksCases: Case[] = [
  vault(
    [
      STEP_BL('$DIR/v/b.md'),
      STEP_BL('$DIR/v/a.md'),
      STEP_BL('$DIR/v/c.md'),
      STEP_BL('$DIR/v/pic.png'),
      STEP_BL('$DIR/v/sub/d.markdown'),
      STEP_BL('$DIR/v/missing.md'),
      STEP_BL(''),
    ],
    BL_TREE,
    'backlinks of several notes',
  ),
  vault(
    [STEP_BL('$DIR/v/a.md')],
    { ...BL_TREE, 'v/dup.md': note('[[a]] [[a#h1]] [[a#h2]] [[a|x]] [[ a ]]', T) },
    'one source with several targets for one note',
  ),
  vault([STEP_BL('$DIR/v/a.md')], { 'v/a.md': note('x', T) }, 'a note nobody links to'),
  vault([STEP_BL('$DIR/v/a.md')], {}, 'a root that is not there'),
  vault([{ op: 'backlinks', root: '', path: '$DIR/v/a.md' }], BL_TREE, 'no root'),
  vault(
    [
      STEP_BL('$DIR/v/later.md'),
      { op: 'write', path: '$DIR/v/later.md', text: 'now it exists', mtimeMs: T },
      { op: 'newFs' },
      STEP_BL('$DIR/v/later.md'),
    ],
    { 'v/a.md': note('[[later]]', T) },
    'creating the target: the file set moved, the memo is dropped',
  ),
  vault(
    [
      STEP_BL('$DIR/v/b.md'),
      { op: 'write', path: '$DIR/v/a.md', text: '[[c]]', mtimeMs: T + 1000 },
      { op: 'newFs' },
      STEP_BL('$DIR/v/b.md'),
      STEP_BL('$DIR/v/c.md'),
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('x', T), 'v/c.md': note('x', T) },
    'a changed note is read again',
  ),
  vault(
    [
      STEP_BL('$DIR/v/b.md'),
      { op: 'write', path: '$DIR/v/a.md', text: '[[c]]', mtimeMs: T },
      { op: 'newFs' },
      STEP_BL('$DIR/v/b.md'),
      STEP_BL('$DIR/v/c.md'),
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('x', T), 'v/c.md': note('x', T) },
    'the same mtime: the old answer stands',
  ),
  vault(
    [
      STEP_BL('$DIR/v/b.md'),
      { op: 'rm', path: '$DIR/v/b.md' },
      { op: 'newFs' },
      STEP_BL('$DIR/v/b.md'),
      STEP_BL('$DIR/v/c.md'),
    ],
    { 'v/a.md': note('[[b]] [[c]]', T), 'v/b.md': note('x', T), 'v/c.md': note('x', T) },
    'a removed target: the memo is dropped',
  ),
  vault(
    [
      STEP_BL('$DIR/v/b.md'),
      { op: 'write', path: '$DIR/v/d.md', text: '[[b]]', mtimeMs: T },
      STEP_BL('$DIR/v/b.md'),
      { op: 'tick', ms: 2001 },
      STEP_BL('$DIR/v/b.md'),
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('x', T) },
    'a new note is seen once the folder listing is read again',
  ),
  vault(
    [STEP_BL('$DIR/v/b.md')],
    {
      'v/a.md': { text: '[[b]]', mode: 0o000 },
      'v/b.md': note('x', T),
      'v/c.md': note('[[b]]', T),
    },
    'a note nobody may read is skipped',
  ),
  vault(
    [STEP_BL('$DIR/v/b.md'), STEP_BL('$DIR/v/c.md')],
    { 'v/a.md': { hex: '5b5b625d5dff5b5b635d5d' }, 'v/b.md': note('x', T), 'v/c.md': note('x', T) },
    'bytes that are not UTF-8',
  ),
  vault(
    [STEP_BL('$DIR/v/n/z.md'), STEP_BL('$DIR/v/n/a.md')],
    {
      'v/n/z.md': note('x', T),
      'v/n/a.md': note('x', T),
      'v/m.md': note('[[z]] [[n/a]] [[a]]', T),
      'v/o/p.md': note('[[z]]', T),
    },
    'a path with a directory',
  ),
  vault(
    [STEP_BL('$DIR/v/\u00e9.md'), STEP_BL(`$DIR/v/${EMOJI}/x.md`)],
    {
      'v/\u00e9.md': note('x', T),
      [`v/${EMOJI}/x.md`]: note('x', T),
      'v/m.md': note(`[[\u00e9]] [[${EMOJI}/x]] [[x]]`, T),
    },
    'non-ASCII notes',
  ),
]

const TAG_TREE: Record<string, FileSpec> = {
  'v/a.md': note('#one #two #three', T),
  'v/b.md': note('#one #two', T),
  'v/c.md': note('#one', T),
  'v/d.txt': note('#two #zed', T),
  'v/sub/e.markdown': note('#\u00e9 #Zed #zed', T),
  'v/pic.png': '#image',
  'v/.git/x.md': note('#git', T),
}
const manyNotes = (count: number, body: (i: number) => string): Record<string, FileSpec> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `v/n${String(i).padStart(5, '0')}.md`,
      note(body(i), T),
    ]),
  )

const tagsCases2: Case[] = [
  vault([{ op: 'tags', root: V }], TAG_TREE, 'tags, most used first'),
  vault([{ op: 'tags', root: V }], {}, 'a root that is not there'),
  vault([{ op: 'tags', root: '' }], TAG_TREE, 'no root'),
  vault([{ op: 'tags', root: V }], { 'v/a.md': note('no tags here', T) }, 'no tags'),
  vault(
    [{ op: 'tags', root: V }],
    {
      'v/b.md': note('#b #a #Z #\u00e9 #\u{10400}x #\uFF21', T),
      'v/a.md': note('#b #a #Z #\u00e9 #\u{10400}x #\uFF21', T),
      'v/\uFF21.md': note('#b #\u{10400}x', T),
      'v/\u{10400}.md': note('#b #\u{10400}x', T),
    },
    'ties by UTF-16 order, files by UTF-16 order',
  ),
  vault(
    [
      { op: 'tags', root: V },
      { op: 'write', path: '$DIR/v/a.md', text: '#changed', mtimeMs: T + 1 },
      { op: 'newFs' },
      { op: 'tags', root: V },
      { op: 'rm', path: '$DIR/v/b.md' },
      { op: 'newFs' },
      { op: 'tags', root: V },
    ],
    TAG_TREE,
    'the index follows changes and removals',
  ),
  vault(
    [{ op: 'tags', root: V }],
    { 'v/a.md': { text: '#secret', mode: 0o000 }, 'v/b.md': note('#open', T) },
    'a note nobody may read',
  ),
  vault(
    [{ op: 'tags', root: V }],
    manyNotes(MAX_INDEX_FILES + 5, (i) => `#t${i % 3}`),
    'the file cap',
  ),
]

const graphCases: Case[] = [
  vault([{ op: 'graph', root: V }], BL_TREE, 'nodes, edges, orphans'),
  vault([{ op: 'graph', root: V }], {}, 'a root that is not there'),
  vault([{ op: 'graph', root: '' }], BL_TREE, 'no root'),
  vault(
    [{ op: 'graph', root: V }],
    {
      'v/a.md': note('[[b#x]] [[b#y]] [[b]] [[ b ]]', T),
      'v/b.md': note('[[a]]', T),
      'v/c.md': note('', T),
    },
    'an edge once',
  ),
  vault(
    [{ op: 'graph', root: V }],
    {
      'v/nest/a.md': note('[[b]]', T),
      'v/nest/in/b.md': note('[[nest/a]]', T),
      'v/X.MD': note('', T),
    },
    'names and relative paths',
  ),
  vault(
    [{ op: 'graph', root: V }],
    manyNotes(
      MAX_GRAPH_NODES + 5,
      (i) =>
        `[[n${String((i + 1) % (MAX_GRAPH_NODES + 5)).padStart(5, '0')}]] [[n${String(MAX_GRAPH_NODES + 4).padStart(5, '0')}]]`,
    ),
    'past the node cap: a slice, edges only between its nodes',
  ),
  vault(
    [
      { op: 'graph', root: V },
      { op: 'write', path: '$DIR/v/c.md', text: '[[a]]', mtimeMs: T + 1 },
      { op: 'newFs' },
      { op: 'graph', root: V },
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('', T), 'v/c.md': note('', T) },
    'the graph follows a change',
  ),
]

const warmCases: Case[] = [
  vault(
    [
      { op: 'warm', root: V },
      { op: 'write', path: '$DIR/v/c.md', text: '[[a]]', mtimeMs: T },
      { op: 'newFs' },
      STEP_BL('$DIR/v/a.md'),
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('', T) },
    'warmed, then a change',
  ),
  vault(
    [
      { op: 'warm', root: '' },
      { op: 'tags', root: V },
    ],
    { 'v/a.md': note('#t', T) },
    'no root: nothing started',
  ),
  vault(
    [
      { op: 'warm', root: '$DIR/none' },
      { op: 'graph', root: '$DIR/none' },
    ],
    undefined,
    'a root that is not there',
  ),
  vault(
    [
      { op: 'warm', root: V },
      { op: 'rm', path: '$DIR/v/b.md' },
      { op: 'newFs' },
      STEP_BL('$DIR/v/b.md'),
      { op: 'graph', root: V },
    ],
    { 'v/a.md': note('[[b]]', T), 'v/b.md': note('', T) },
    'warmed, then a removal',
  ),
]

// ---- wiki-fragment ----

interface FragStep {
  op: 'remember' | 'take'
  path: string
  fragment?: string
}

/** The module keeps one map; each script ends by taking every path it used, so the next one starts empty. */
function runFragments(a: unknown[]): unknown {
  const steps = a[0] as FragStep[]
  const taken: unknown[] = []
  for (const s of steps) {
    if (s.op === 'remember') rememberWikiFragment(s.path, s.fragment!)
    else taken.push(takeWikiFragment(s.path))
  }
  for (const s of steps) takeWikiFragment(s.path)
  return taken
}

const rem = (path: string, fragment: string): FragStep => ({ op: 'remember', path, fragment })
const take = (path: string): FragStep => ({ op: 'take', path })
const fragCase = (steps: FragStep[], note?: string): Case => ({
  args: [steps],
  ...(note ? { note } : {}),
})
const many = (count: number, from = 0): FragStep[] =>
  Array.from({ length: count }, (_, i) => rem(`p${i + from}`, `f${i + from}`))
const fragmentCases: Case[] = [
  fragCase([rem('a', 'H'), take('a'), take('a')], 'taken once'),
  fragCase([take('a')], 'nothing waiting'),
  fragCase([rem('', 'H'), take(''), take('x')], 'an empty path'),
  fragCase([rem('a', 'H'), rem('a', ''), take('a')], 'an empty fragment cancels'),
  fragCase([rem('a', ''), take('a')], 'an empty fragment with nothing waiting'),
  fragCase([rem('a', 'one'), rem('a', 'two'), take('a')], 'the last fragment stands'),
  fragCase([...many(32), take('p0'), take('p31')], 'thirty-two wait'),
  fragCase([...many(33), take('p0'), take('p1'), take('p32')], 'the oldest goes at the 33rd'),
  fragCase(
    [...many(32), rem('p0', 'again'), rem('new', 'n'), take('p0'), take('p1'), take('new')],
    'setting a key again keeps its place',
  ),
  fragCase(
    [
      ...many(32),
      rem('p5', ''),
      rem('x', 'x'),
      rem('y', 'y'),
      take('p0'),
      take('p1'),
      take('p6'),
      take('y'),
    ],
    'a cancelled one frees a place',
  ),
  fragCase(
    [...many(40), ...Array.from({ length: 40 }, (_, i) => take(`p${i}`))],
    'forty, the last thirty-two remain',
  ),
  fragCase(
    [
      rem('\u00e9', '\u00e9'),
      rem(EMOJI, EMOJI),
      rem('2', 'two'),
      rem('10', 'ten'),
      take(EMOJI),
      take('10'),
      take('\u00e9'),
      take('2'),
    ],
    'non-ASCII and integer-like paths',
  ),
]

// ---- asset-lifecycle ----

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const DOC = '$DIR/d/doc.md'
const MANIFEST = 'd/assets/.seuoffice-assets.json'
const OLD_MANIFEST = 'd/assets/.genoffice-assets.json'
const manifestOf = (
  files: [string, string][],
  documents: Record<string, string[]> = {},
  pending: Record<string, string[]> = {},
): string =>
  j({
    version: 1,
    files: files.map(([name, content]) => ({ name, sha256: sha(content) })),
    documents,
    pending,
  })
/** the files a case needs: the assets named with their content, and the manifest over them */
const owned = (
  files: [string, string][],
  documents: Record<string, string[]> = {},
  pending: Record<string, string[]> = {},
  extra: Record<string, FileSpec> = {},
): Record<string, FileSpec> => ({
  'd/doc.md': '',
  ...Object.fromEntries(files.map(([name, content]) => [`d/assets/${name}`, content])),
  [MANIFEST]: manifestOf(files, documents, pending),
  ...extra,
})

/** the files of a case without the named assets */
const gone = (files: Record<string, FileSpec>, ...names: string[]): Record<string, FileSpec> => {
  const out = { ...files }
  for (const name of names) delete out[`d/assets/${name}`]
  return out
}

const maskErrors = <T extends { errors: string[] }>(result: T): T => ({
  ...result,
  errors: result.errors.map(maskTmp),
})

const copyCase = (source: string, files: Record<string, FileSpec>, note?: string): Case => ({
  args: [DOC, source],
  files: { 'src/Pic One.PNG': 'picture', ...files },
  ...(note ? { note } : {}),
})
const copyCases: Case[] = [
  copyCase('$DIR/src/Pic One.PNG', { 'd/doc.md': '' }, 'a fresh assets folder'),
  copyCase(
    '$DIR/src/Pic One.PNG',
    owned([['Pic_One.png', 'old']], {}, {}),
    'the name is taken: -1',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    {
      ...owned([
        ['Pic_One.png', 'old'],
        ['Pic_One-1.png', 'old'],
        ['Pic_One-2.png', 'old'],
      ]),
    },
    'taken three times',
  ),
  copyCase('$DIR/src/none.png', { 'd/doc.md': '' }, 'no such source'),
  copyCase('$DIR/src/Pic One.PNG', { 'd/assets': 'a file', 'd/doc.md': '' }, 'assets is a file'),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { [MANIFEST]: '{broken', 'd/assets/x': 'x' },
    'a manifest that is not JSON: the copy is removed',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { [MANIFEST]: manifestOf([['Pic_One.png', 'other']]) },
    'the manifest owns that name for another file: the copy is removed',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { [MANIFEST]: j({ version: 2 }) },
    'a manifest of another version',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    {
      [MANIFEST]: manifestOf([['z.png', 'z']], { 'doc.md': ['z.png'] }, { 'other.md': ['z.png'] }),
      'd/assets/z.png': 'z',
    },
    'an earlier manifest is kept and extended',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { [OLD_MANIFEST]: manifestOf([['q.png', 'q']]), 'd/assets/q.png': 'q' },
    'a list under the old name keeps that name',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    {
      [OLD_MANIFEST]: manifestOf([]),
      [MANIFEST]: manifestOf([['n.png', 'n']]),
      'd/assets/n.png': 'n',
    },
    'both names: the current one',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { 'src/Pic One.PNG': { text: 'picture', mode: 0o600 } },
    'the copy takes the mode of the source',
  ),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { 'src/Pic One.PNG': { text: 'picture', mode: 0o755 } },
    'an executable source',
  ),
  copyCase('$DIR/src/a.p ng', { 'src/a.p ng': 'x' }, 'an extension with a space is dropped'),
  copyCase(
    '$DIR/src/b.verylongextension',
    { 'src/b.verylongextension': 'x' },
    'an extension of more than ten characters is dropped',
  ),
  copyCase('$DIR/src/c.JPEG', { 'src/c.JPEG': 'x' }, 'the extension goes to lower case'),
  copyCase(
    `$DIR/src/${'n'.repeat(200)}.png`,
    { [`src/${'n'.repeat(200)}.png`]: 'x' },
    'a long stem is cut',
  ),
  copyCase('$DIR/src/#%:*?"<>|.png', { 'src/#%:*?"<>|.png': 'x' }, 'characters no name can carry'),
  copyCase(
    '$DIR/src/\u00e9 \u0131 \u212A.png',
    { 'src/\u00e9 \u0131 \u212A.png': 'x' },
    'non-ASCII',
  ),
  copyCase('$DIR/src/.hidden', { 'src/.hidden': 'x' }, 'a dot file'),
  copyCase(
    '$DIR/src/Pic One.PNG',
    { 'd/assets': { dir: true, mode: 0o555 }, 'd/doc.md': '' },
    'an assets folder nobody may write in',
  ),
  copyCase('$DIR/src', { 'd/doc.md': '' }, 'a folder as the source'),
]

const writeAssetCase = (
  name: string,
  hex: string,
  files: Record<string, FileSpec> = { 'd/doc.md': '' },
  note?: string,
): Case => ({
  args: [DOC, name, hex],
  files,
  ...(note ? { note } : {}),
})
const PIC_HEX = hexOf('bytes')
const writeAssetCases: Case[] = [
  writeAssetCase('pic.png', PIC_HEX, undefined, 'a fresh folder'),
  writeAssetCase('pic.png', PIC_HEX, owned([['pic.png', 'old']]), 'taken'),
  writeAssetCase('pic.png', '', undefined, 'no bytes'),
  writeAssetCase('', PIC_HEX, undefined, 'no name'),
  writeAssetCase('   ', PIC_HEX, undefined, 'white space only'),
  writeAssetCase('...', PIC_HEX, undefined, 'dots only'),
  writeAssetCase('.png', PIC_HEX, undefined, 'a dot file'),
  writeAssetCase('a/b\\c.png', PIC_HEX, undefined, 'both separators'),
  writeAssetCase('C:\\x\\pic.png', PIC_HEX, undefined, 'a Windows path'),
  writeAssetCase('a:b.png', PIC_HEX, undefined, 'a colon'),
  writeAssetCase('../../evil.png', PIC_HEX, undefined, 'climbing'),
  writeAssetCase('a. .png', PIC_HEX, undefined, 'dots and spaces in the stem'),
  writeAssetCase('\u0001ctl\u001f.png', PIC_HEX, undefined, 'control characters'),
  writeAssetCase(`${'s'.repeat(150)}.JPG`, PIC_HEX, undefined, 'cut at 140 with the extension'),
  writeAssetCase(
    'image.png',
    PIC_HEX,
    owned([['image.png', 'old']], { 'doc.md': ['image.png'] }, {}),
    'the document already references the name',
  ),
  writeAssetCase(`${EMOJI}.png`, hexOf(`${EMOJI}\u00e9`), undefined, 'astral'),
  writeAssetCase(
    'x.png',
    PIC_HEX,
    { 'd/doc.md': '', 'd/assets': { dir: true }, [MANIFEST]: { dir: true } },
    'the manifest is a folder',
  ),
  writeAssetCase(
    'new.png',
    PIC_HEX,
    owned(
      [
        ['b.png', '1'],
        ['B.png', '2'],
        ['a.png', '3'],
        ['A.png', '4'],
        ['_x.png', '5'],
        ['-y.png', '6'],
        ['1.png', '7'],
        ['10.png', '8'],
        ['2.png', '9'],
        ['\u00e9.png', 'a'],
        ['e.png', 'b'],
        ['f.png', 'c'],
        ['Z.png', 'd'],
        ['z.png', 'e'],
        ['a b.png', 'f'],
        ['a-b.png', 'g'],
        ['ab.png', 'h'],
        ['\u00c4.png', 'i'],
      ],
      { '10': ['a.png'], '2': ['b.png'], 'b.md': ['B.png', 'a.png', 'a.png'], 'a.md': ['z.png'] },
      { '1': ['A.png'] },
    ),
    'the manifest is written sorted: files by collation, names by UTF-16, integer keys first',
  ),
  writeAssetCase(
    'x.png',
    PIC_HEX,
    {
      'd/doc.md': '',
      [MANIFEST]:
        '{"version":1,"files":[],"documents":{"__proto__":["a.png"],"x":[]},"pending":{}}',
    },
    'a document named __proto__',
  ),
]

const relCase = (source: string, files: Record<string, FileSpec> = REL_FILES, doc = DOC): Case => ({
  args: [doc, source],
  files,
})
const REL_FILES: Record<string, FileSpec> = {
  'd/doc.md': '',
  'd/img/a.png': 'a',
  'd/img/sp ace.png': 'b',
  'd/img/caf\u00e9.png': 'c',
  'd/top.png': 'top',
  'd/dir/x.png/inner': 'x',
  'out.png': 'outside',
}
const relativeCases: Case[] = [
  'img/a.png',
  './img/a.png',
  'img//a.png',
  'img/../img/a.png',
  ' img/a.png ',
  'img\\a.png',
  'img/sp%20ace.png',
  'img/sp ace.png',
  'img/caf%C3%A9.png',
  'img/caf\u00e9.png',
  'img/A.png',
  'top.png',
  '../out.png',
  'img/../../out.png',
  '%2e%2e/out.png',
  'dir/x.png',
  'img',
  'img/missing.png',
  '',
  '   ',
  'img/a.png?x=1',
  'img/a.png#frag',
  '/img/a.png',
  '\\img\\a.png',
  'C:/img/a.png',
  'c:\\img\\a.png',
  'http://example.com/a.png',
  'file:///a.png',
  'a:b',
  'data:image/png;base64,AAAA',
  'img/a%00.png',
  'img/%ZZ.png',
  'img/%E0%A4%A.png',
  'img/a.png\u0000',
  'img/\u00a0a.png',
].map((source): Case => relCase(source))

const vaultImageCase = (
  target: string,
  root = '$DIR/v',
  files: Record<string, FileSpec> = VAULT_FILES,
): Case => ({ args: [root, target], files })
const VAULT_FILES: Record<string, FileSpec> = {
  'v/a.png': 'a',
  'v/sub/b.png': 'b',
  'v2/c.png': 'c',
  'out.png': 'o',
  'v/dir/inner': 'x',
}
const vaultImageCases: Case[] = [
  vaultImageCase('$DIR/v/a.png'),
  vaultImageCase('$DIR/v/sub/b.png'),
  vaultImageCase('$DIR/v'),
  vaultImageCase('$DIR/v/'),
  vaultImageCase('$DIR/v/dir'),
  vaultImageCase('$DIR/v/none.png'),
  vaultImageCase('$DIR/v2/c.png'),
  vaultImageCase('$DIR/out.png'),
  vaultImageCase('$DIR/v/../out.png'),
  vaultImageCase('$DIR/v/sub/../a.png'),
  vaultImageCase('$DIR/v/./a.png'),
  vaultImageCase('$DIR/v/a.png', '$DIR/v/'),
  vaultImageCase('$DIR/v/a.png', '$DIR/v/sub/..'),
  vaultImageCase('$DIR/v/a.png', '$DIR/none'),
  vaultImageCase('$DIR/v/A.png'),
  vaultImageCase('a.png'),
  vaultImageCase('/'),
]

const md = (...lines: string[]): string => lines.join('\n')
const extractTexts: string[] = [
  '',
  'no images',
  '![alt](a.png)',
  '![](a.png) ![b](b.png)',
  '![a](b.png "Title") ![a](c.png \'T\') ![a](d.png (T))',
  '![a](b.png "unclosed)',
  '![a](b.png "a \\" b")',
  '![a](<my file.png>)',
  '![a](<my file.png> "t")',
  '![a](<unclosed.png)',
  '![a](<a>b>)',
  '![a](a\\(1\\).png)',
  '![a](a(1).png)',
  '![a](a(1.png)',
  '![a](a\\ b.png)',
  '![a](a\\\\b\\[c\\]\\<d\\>.png)',
  '![a] (spaced.png)',
  '![a]\t(tabbed.png)',
  '![a]\n(newline.png)',
  '![a [b] c](nested.png)',
  '![a \\] b](esc.png)',
  '![a(b.png)',
  '![a]()',
  '![a](   )',
  '![a](<>)',
  '\\![a](escaped.png)',
  '\\\\![a](two-slashes.png)',
  '!\\[a](bang.png)',
  '[![a](inner.png)](link.png)',
  '![a](b.png)![c](d.png)',
  '![a](b.png',
  '![a](',
  '!',
  '![',
  '![a',
  '![a]',
  'text ![a](x.png) text',
  `${EMOJI} ![a](x.png) ${EMOJI}`,
  `![a](x${EMOJI}.png "t")`,
  `![${EMOJI}](${EMOJI}.png)`,
  `![a](${EMOJI} "${EMOJI}")`,
  '![a](x.png "t"  )',
  '![a](  x.png  "t"  )',
  '![a](x.png "t" extra)',
  '![a](x.png\t"t")',
  '![a](x.png\u00a0"t")',
  '`![a](code.png)` ![b](real.png)',
  '``![a](code.png)`` ![b](real.png)',
  '`unclosed ![a](x.png)',
  '` ![a](x.png) `` ![b](y.png) `',
  '\\`![a](x.png)`',
  md('```', '![a](fenced.png)', '```', '![b](out.png)'),
  md('~~~', '![a](fenced.png)', '~~~', '![b](out.png)'),
  md('```', '![a](fenced.png)', '~~~', '![b](still.png)', '```', '![c](out.png)'),
  md('````', '```', '![a](in.png)', '```', '````', '![b](out.png)'),
  md('```', '![a](unclosed-fence.png)'),
  md('```js', '![a](info.png)', '```'),
  md('``` `x`', '![a](not a fence.png)'),
  md('~~~ `x`', '![a](tilde fence with backtick.png)', '~~~'),
  md('   ```', '![a](three spaces.png)', '   ```'),
  md('    ```', '![a](four spaces.png)'),
  md('```', '![a](x.png)', '  ```  '),
  md('```', '![a](x.png)', '``` x'),
  md('```', '![a](x.png)', '````'),
  md('  ```', '![a](x.png)', '```'),
  md('para', '', '    ![a](indented.png)', '', '![b](out.png)'),
  md('para', '\t![a](tabbed.png)', '![b](out.png)'),
  '    ![a](first-line-indent.png)',
  md('text', '    code ![a](x.png)', 'more ![b](y.png)'),
  '```\r\n![a](crlf-fence.png)\r\n```\r\n![b](out.png)',
  '    ![a](crlf-indent.png)\r\n![b](out.png)',
  '```\n![a](x.png)\n```\r\n![b](y.png)',
  'a\u2028```\n![a](x.png)\n```',
  'a\r```\n![a](x.png)\n```',
  md('```', '![a](x.png)', '```', '```', '![b](y.png)', '```'),
  '<img src="a.png">',
  "<IMG SRC='b.png'/>",
  '<img src=c.png>',
  '<img src=c.png/>',
  '<img alt="x" src="d.png" class=e>',
  '<img\nsrc\n=\n"e.png"\n>',
  '<img src = "f.png" >',
  '<img src="a.png" src="b.png">',
  '<img>',
  '<img/>',
  '<img src>',
  '<img src=>',
  '<img src="">',
  '<img src=a"b>',
  "<img src=a'b>",
  '<img src=a`b>',
  '<img src=a<b>',
  '<img src=a=b>',
  '<img / src="a.png">',
  '<img src="a.png" /',
  '<img src="a.png"',
  '<img src="a.png',
  '<img',
  '<img ',
  '<imgx src="a.png">',
  '<img/src="a.png">',
  '<img\tsrc="tab.png">',
  '<img\u00a0src="nbsp.png">',
  '<img src="a&amp;b.png">',
  '<img src="a&#65;&#x42;&#X43;.png">',
  '<img src="&lt;&gt;&quot;&apos;&nbsp;.png">',
  '<img src="&AMP;&Lt;.png">',
  '<img src="&unknown;.png">',
  '<img src="&constructor;.png">',
  '<img src="&__proto__;.png">',
  '<img src="&#0;.png">',
  '<img src="&#xD800;.png">',
  '<img src="&#1114112;.png">',
  '<img src="&#x10FFFF;.png">',
  '<img src="&#;.png">',
  '<img src="&#x;.png">',
  '<img src="&#xZ;.png">',
  '<img src="&#99999999999999999999;.png">',
  '<img src="&amp.png">',
  '<img src="&#65.png">',
  '<img src="a & b.png">',
  '<img src="&;.png">',
  '<img src="&&amp;.png">',
  '<img src="&\u00e9;.png">',
  `<img src="${EMOJI}.png">`,
  `${EMOJI}<img src="${EMOJI}.png" alt='${EMOJI}'>`,
  '<img src="a.png"><img src="b.png">',
  '<!-- <img src="c.png"> --> <img src="d.png">',
  '<!-- <img src="c.png">',
  '<!-- unclosed comment without any picture',
  '<!---->',
  '<!--> <img src="x.png">',
  '`<img src="code.png">` <img src="real.png">',
  md('```', '<img src="fenced.png">', '```', '<img src="out.png">'),
  md('    <img src="indented.png">', '', '<img src="out.png">'),
  '![a](x.png "<img src=y.png>")',
  '<img src="a.png" alt="![b](c.png)">',
  '<a title="![a](b.png)"><img src="c.png"></a>',
  '![a](x.png) <img src="x.png"> ![b](x.png)',
  '<p><img src="a.png"/>text<img src="b.png"/></p>',
  '<IMG\u212A src="a.png">',
  '< img src="a.png">',
  '<<img src="a.png">',
  '<img src="a.png">>',
  'a<b ![c](d.png) e>f',
  '\\<img src="a.png">',
  `${'x'.repeat(5000)} ![a](big.png) ${'y'.repeat(5000)}`,
  `![a](${'p'.repeat(3000)}.png "${'t'.repeat(3000)}")`,
  Array.from({ length: 50 }, (_, i) => `![a${i}](img${i}.png)`).join(' '),
  '![a](x.png)\n![a](x.png)',
]
const extractCases: Case[] = extractTexts.map((text): Case => ({ args: [text] }))

const docDirCases: Case[] = [
  ['/a/b', '/a', null],
  ['/a', '/a', null],
  ['/ab/c', '/a', null],
  ['/a/', '/a', null],
  ['/a/b', '/a/', null],
  ['/x', '/', null],
  ['', '', null],
  ['a', '', null],
  ['C:\\a\\b', 'C:\\a', '\\'],
  ['C:\\a\\b', 'C:\\a\\', '\\'],
  ['C:\\', 'C:\\', '\\'],
  ['C:\\x', 'C:\\', '\\'],
  ['C:/a/b', 'C:\\a', '\\'],
  ['/a/b', '/a', '/'],
  ['/a|b', '/a', '|'],
  ['/a/b', '/a', ''],
  ['/a', '/a', ''],
  ['\u00e9/b', '\u00e9', '/'],
  [`${EMOJI}/b`, EMOJI, '/'],
  ['\u0131/b', 'I', '/'],
].map((args): Case => ({ args }))

const rewriteCase = (markdown: string, pairs: [string, string][]): Case => ({
  args: [markdown, pairs],
})
const rewriteCases: Case[] = [
  rewriteCase('![a](x.png)', []),
  rewriteCase('![a](x.png)', [['y.png', 'z.png']]),
  rewriteCase('![a](x.png)', [['x.png', 'assets/x.png']]),
  rewriteCase('![a](x.png) text ![b](y.png) ![c](x.png)', [
    ['x.png', 'assets/x.png'],
    ['y.png', 'assets/y-1.png'],
  ]),
  rewriteCase('![a](x.png)', [
    ['x.png', 'a'],
    ['x.png', 'b'],
  ]),
  rewriteCase('![a](x.png "Title")', [['x.png', 'n.png']]),
  rewriteCase('![a](<my file.png>)', [['my file.png', 'new name.png']]),
  rewriteCase('![a](a\\ b.png)', [['a b.png', 'c d.png']]),
  rewriteCase('![a](x.png)', [['x.png', '']]),
  rewriteCase('<img src="x.png">', [['x.png', 'a&b<c>"d\'e.png']]),
  rewriteCase("<img src='x.png'>", [['x.png', 'a&b<c>"d\'e.png']]),
  rewriteCase('<img src=x.png>', [['x.png', 'a&b<c>"d\'e`f=g>h i\tj\nk\u00a0l.png']]),
  rewriteCase('<img src=x.png/>', [['x.png', `a${EMOJI}b.png`]]),
  rewriteCase('<img src="x&amp;y.png">', [['x&y.png', 'plain.png']]),
  rewriteCase('![a](x.png) <img src="x.png"> <img src=x.png>', [['x.png', 'a b&c.png']]),
  rewriteCase('`![a](x.png)` ![b](x.png)', [['x.png', 'y.png']]),
  rewriteCase(`${EMOJI} ![a](x.png) ${EMOJI}`, [['x.png', `${EMOJI}.png`]]),
  rewriteCase('![a](x.png "t")![b](y.png)', [['y.png', 'z.png']]),
  rewriteCase('![a](x.png) <img src="y.png" src="z.png">', [
    ['x.png', 'q.png'],
    ['y.png', 'q2.png'],
  ]),
  rewriteCase('![a](x.png "<img src=y.png>")', [
    ['x.png', 'q.png'],
    ['y.png', 'r.png'],
  ]),
  rewriteCase('no images', [['x.png', 'y.png']]),
  rewriteCase('', [['x.png', 'y.png']]),
]

// the save-as scenarios
const SRC = '$DIR/src/doc.md'
const TGT = '$DIR/dst/doc.md'
const prepCase = (
  text: string,
  imageSources: string[],
  files: Record<string, FileSpec>,
  note?: string,
  source = SRC,
  target = TGT,
): Case => ({
  args: [source, target, text, imageSources],
  files: { 'src/doc.md': '', ...files },
  ...(note ? { note } : {}),
})
const IMGS: Record<string, FileSpec> = {
  'src/img/a.png': 'AAA',
  'src/img/b.png': 'BBB',
  'src/one/p.png': 'P1',
  'src/two/p.png': 'P2',
  'src/sp ace.png': 'SP',
  'src/x.png': 'X',
}
const prepareCases: Case[] = [
  prepCase('![a](img/a.png)', [], { ...IMGS }, 'a copy and a rewrite'),
  prepCase(
    '![a](img/a.png) ![b](img/b.png)',
    ['img/a.png'],
    { ...IMGS },
    'a known source and one from the text',
  ),
  prepCase(
    '![a](img/a.png) ![b](./img/a.png) <img src="img/a.png">',
    [],
    { ...IMGS },
    'one file under three spellings',
  ),
  prepCase('![a](one/p.png) ![b](two/p.png)', [], { ...IMGS }, 'two files of one name'),
  prepCase('![a](sp%20ace.png)', ['sp%20ace.png'], { ...IMGS }, 'an escaped name'),
  prepCase(
    '![a](http://x/a.png) ![b](/abs.png) ![c](../out.png) ![d](missing.png) ![e](img/a.png?x)',
    [],
    { ...IMGS, 'out.png': 'o' },
    'sources that are not copied',
  ),
  prepCase(
    '![a](x.png)',
    [],
    { ...IMGS, 'dst/assets/x.png': 'taken' },
    'the name is taken in the target',
  ),
  prepCase(
    '![a](x.png)',
    [],
    {
      ...IMGS,
      'dst/assets/.seuoffice-assets.json': manifestOf([['x.png', 'old']]),
      'dst/assets/x.png': 'old',
    },
    'the target manifest owns the name',
  ),
  prepCase(
    '![a](x.png)',
    [],
    { ...IMGS, 'dst/assets': 'a file' },
    'assets is a file in the target',
  ),
  prepCase(
    '![a](x.png)',
    [],
    { ...IMGS, 'dst/assets/.seuoffice-assets.json': '{nope' },
    'a target manifest that is not JSON',
  ),
  prepCase('![a](x.png)', ['x.png', 'x.png', 'x.png'], { ...IMGS }, 'a source named three times'),
  prepCase(
    'plain text',
    ['x.png'],
    { ...IMGS },
    'a source that the text does not name: the rewrite cannot be shown, the copy is removed',
  ),
  prepCase('plain text', [], { ...IMGS }, 'nothing to copy'),
  prepCase(
    '![a](img/a.png)',
    [],
    { ...IMGS },
    'the same folder: no copy',
    SRC,
    '$DIR/src/renamed.md',
  ),
  prepCase(
    '![a](img/a.png)',
    ['q.png', 'img/a.png'],
    { ...IMGS },
    'the same folder keeps every source',
    SRC,
    '$DIR/src/../src/other.md',
  ),
  prepCase(
    '![a](x.png)',
    [],
    {
      ...IMGS,
      'dst/assets/.seuoffice-assets.json': manifestOf(
        [['k.png', 'k']],
        { 'doc.md': ['k.png'] },
        { 'doc.md': ['k.png'] },
      ),
      'dst/assets/k.png': 'k',
    },
    'an earlier manifest in the target',
  ),
  prepCase('<img src="x.png"> <img src=\'x.png\'>', [], { ...IMGS }, 'html sources'),
  prepCase(
    '![a](x.png)',
    [],
    { ...IMGS, 'dst/assets': { dir: true, mode: 0o555 } },
    'a target assets folder nobody may write in',
  ),
  prepCase(
    '![a](img/a.png) ![b](img/b.png)',
    [],
    { ...IMGS, 'dst/assets/b.png/inner': 'x' },
    'the second copy fails: the first is removed',
  ),
  prepCase(`![a](${EMOJI}.png)`, [], { ...IMGS, [`src/${EMOJI}.png`]: 'E' }, 'astral'),
]

const rollbackCase = (
  created: { name: string; sha256: string }[],
  files: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [{ targetDocumentPath: DOC, created }],
  files,
  ...(note ? { note } : {}),
})
const REC = (name: string, content: string) => ({ name, sha256: sha(content) })
const rollbackCases: Case[] = [
  rollbackCase(
    [REC('a.png', 'A')],
    owned(
      [
        ['a.png', 'A'],
        ['b.png', 'B'],
      ],
      {},
      { 'doc.md': ['a.png', 'b.png'] },
    ),
    'a created file goes',
  ),
  rollbackCase(
    [REC('a.png', 'A'), REC('b.png', 'B')],
    owned(
      [
        ['a.png', 'A'],
        ['b.png', 'B'],
        ['c.png', 'C'],
      ],
      { 'doc.md': ['b.png'] },
      { 'doc.md': ['a.png', 'b.png', 'c.png'] },
    ),
    'a referenced one stays',
  ),
  rollbackCase(
    [REC('a.png', 'A')],
    owned([['a.png', 'changed']], {}, { 'doc.md': ['a.png'] }, { 'd/assets/a.png': 'edited' }),
    'a changed file stays',
  ),
  rollbackCase(
    [REC('a.png', 'A')],
    gone(owned([['a.png', 'A']], {}, { 'doc.md': ['a.png'] }), 'a.png'),
    'the file is already gone',
  ),
  rollbackCase(
    [REC('a.png', 'other')],
    owned([['a.png', 'A']], {}, {}),
    'the manifest holds another hash',
  ),
  rollbackCase(
    [REC('ghost.png', 'G')],
    owned([['a.png', 'A']], {}, { 'doc.md': ['a.png'] }),
    'a record the manifest never held',
  ),
  rollbackCase(
    [],
    { 'd/doc.md': '', [MANIFEST]: '{broken' },
    'nothing created: the manifest is not read',
  ),
  rollbackCase(
    [REC('a.png', 'A')],
    { 'd/doc.md': '', [MANIFEST]: '{broken' },
    'a manifest that is not JSON',
  ),
  rollbackCase([REC('a.png', 'A')], { 'd/doc.md': '' }, 'no assets folder'),
  rollbackCase(
    [REC('a.png', 'A')],
    owned([['a.png', 'A']], { 'other.md': ['a.png'] }, { 'doc.md': ['a.png'] }),
    'another document references it',
  ),
  rollbackCase(
    [REC('a.png', 'A')],
    owned([['a.png', 'A']], { 'doc.md': ['a.png'] }, { 'doc.md': ['a.png'] }),
    'saved and pending',
  ),
  rollbackCase(
    [REC('a.png', 'A')],
    { ...owned([['a.png', 'A']], {}, { 'doc.md': ['a.png'] }), 'd/assets/a.png': { dir: true } },
    'a folder where the file was',
  ),
]

const pendingCase = (files: Record<string, FileSpec>, doc = DOC, note?: string): Case => ({
  args: [doc],
  files,
  ...(note ? { note } : {}),
})
const pendingCases: Case[] = [
  pendingCase(
    owned(
      [
        ['a.png', 'A'],
        ['b.png', 'B'],
      ],
      {},
      { 'doc.md': ['b.png', 'a.png'], 'other.md': ['x.png'] },
    ),
  ),
  pendingCase(owned([['a.png', 'A']], {}, { 'other.md': ['a.png'] })),
  pendingCase({ 'd/doc.md': '' }),
  pendingCase({ 'd/doc.md': '', [MANIFEST]: '{broken' }),
  pendingCase({ 'd/doc.md': '', 'd/assets': 'a file' }),
  pendingCase(owned([['a.png', 'A']], {}, { 'doc.md': ['a.png'] }), '$DIR/d/other.md'),
  pendingCase(
    {
      'd/doc.md': '',
      [OLD_MANIFEST]: manifestOf([['a.png', 'A']], {}, { 'doc.md': ['a.png'] }),
      'd/assets/a.png': 'A',
    },
    DOC,
    'the old name',
  ),
]

const PENDING_FILES = (extra: Record<string, FileSpec> = {}): Record<string, FileSpec> => ({
  ...owned(
    [
      ['a.png', 'A'],
      ['b.png', 'B'],
      ['c.png', 'C'],
    ],
    { 'other.md': ['b.png'] },
    { 'doc.md': ['a.png', 'b.png', 'c.png'], 'third.md': ['c.png'] },
  ),
  ...extra,
})
const discardCases: Case[] = [
  {
    args: [DOC],
    files: PENDING_FILES(),
    note: 'unreferenced goes, referenced stays and is let go',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/assets/a.png': 'edited' }),
    note: 'a changed file stays',
  },
  { args: [DOC], files: gone(PENDING_FILES(), 'a.png'), note: 'a file that is gone' },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/assets/a.png': { dir: true } }),
    note: 'a folder where the file was',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/sibling.md': '![x](assets/a.png)' }),
    note: 'a sibling document references it',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/doc.md': '![x](assets/a.png)' }),
    note: 'the document itself references it (it is still on disk)',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/s.markdown': '<img src="assets/a.png' }),
    note: 'a sibling with markup that cannot be read: everything stays',
  },
  {
    args: [DOC],
    files: PENDING_FILES({
      'd/s.md': '![x](assets/a.png)',
      'd/t.MD': '![x](assets/c.png)',
      'd/u.txt': '![x](assets/b.png)',
    }),
    note: 'only md and markdown siblings count',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/s.md': { hex: 'ff21215b785d28' } }),
    note: 'a sibling that is not UTF-8',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/s.md': { dir: true } }),
    note: 'a folder named like a document is no document',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/s.md': { text: '![x](assets/a.png)', mode: 0o000 } }),
    note: 'a sibling nobody may read: everything stays',
  },
  { args: [DOC], files: owned([['a.png', 'A']], {}, {}), note: 'nothing pending' },
  { args: [DOC], files: { 'd/doc.md': '' }, note: 'no assets folder' },
  {
    args: [DOC],
    files: { 'd/doc.md': '', [MANIFEST]: '{broken' },
    note: 'a manifest that is not JSON',
  },
  {
    args: [DOC],
    files: owned([['a.png', 'A']], {}, { 'doc.md': ['a.png', 'ghost.png'] }),
    note: 'a pending name the manifest does not hold',
  },
  {
    args: [DOC],
    files: PENDING_FILES({ 'd/assets': { dir: true, mode: 0o555 } }),
    note: 'an assets folder nobody may write in',
  },
  { args: ['$DIR/d/other.md'], files: PENDING_FILES(), note: 'another document: nothing pending' },
]

const resolveSourceCases: Case[] = [
  { args: [DOC, ['a.png']], files: PENDING_FILES(), note: 'only what was pending at the start' },
  {
    args: [DOC, ['a.png', 'c.png', 'ghost.png']],
    files: PENDING_FILES(),
    note: 'a name that was never pending',
  },
  { args: [DOC, []], files: PENDING_FILES(), note: 'nothing was pending' },
  {
    args: [DOC, ['b.png']],
    files: PENDING_FILES({ 'd/assets/b.png': 'edited' }),
    note: 'a changed file',
  },
  { args: [DOC, ['a.png']], files: { 'd/doc.md': '' }, note: 'no assets folder' },
  {
    args: [DOC, ['a.png']],
    files: { 'd/doc.md': '', [MANIFEST]: j({ version: 1, files: [], documents: [] }) },
    note: 'a manifest with bad references',
  },
]

const reconcileCase = (
  sources: string[],
  files: Record<string, FileSpec>,
  pendingNames: string[] | null = null,
  note?: string,
): Case => ({
  args: [DOC, sources, pendingNames],
  files,
  ...(note ? { note } : {}),
})
const RC_FILES = (extra: Record<string, FileSpec> = {}): Record<string, FileSpec> =>
  owned(
    [
      ['a.png', 'A'],
      ['b.png', 'B'],
      ['c.png', 'C'],
      ['d.png', 'D'],
    ],
    { 'other.md': ['d.png', 'ghost.png'], 'doc.md': ['a.png'] },
    { 'doc.md': ['b.png'], 'x.md': ['c.png'] },
    extra,
  )
const reconcileCases: Case[] = [
  reconcileCase(
    ['assets/a.png'],
    RC_FILES(),
    null,
    'a is kept, b was pending and is unreferenced, c is held by another document',
  ),
  reconcileCase(['assets/a.png', 'assets/b.png'], RC_FILES(), null, 'a and b are referenced'),
  reconcileCase([], RC_FILES(), null, 'nothing referenced'),
  reconcileCase(
    ['./assets/a.png', 'assets//b.png', 'ASSETS/c.png', 'assets\\d.png', ' assets/a.png '],
    RC_FILES(),
    null,
    'spellings of the same references',
  ),
  reconcileCase(
    [
      'http://x/assets/a.png',
      '/assets/a.png',
      'assets/a.png?x',
      'assets/../assets/a.png',
      'assets/sub/a.png',
      'img/a.png',
      'assets/ghost.png',
      'assets/.seuoffice-assets.json',
    ],
    RC_FILES(),
    null,
    'sources that name no owned file',
  ),
  reconcileCase(['assets/a.png'], RC_FILES(), [], 'no pending name is let go'),
  reconcileCase(['assets/a.png'], RC_FILES(), ['b.png'], 'one pending name is let go'),
  reconcileCase([], RC_FILES(), ['ghost.png', 'c.png'], 'names that are not pending'),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/assets/b.png': 'edited' }),
    null,
    'a changed file is let go',
  ),
  reconcileCase(
    ['assets/a.png'],
    gone(RC_FILES(), 'b.png'),
    null,
    'a file that is gone is dropped quietly',
  ),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/assets/b.png': { dir: true } }),
    null,
    'a folder where the file was',
  ),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/s.md': '![x](assets/b.png)' }),
    null,
    'a sibling references b',
  ),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/s.md': '<img src="assets/b.png" src="x">' }),
    null,
    'a sibling with markup that cannot be proven: all stay',
  ),
  reconcileCase(
    [],
    RC_FILES({ 'd/doc.md': '![x](assets/b.png)' }),
    null,
    'the document itself is not a sibling here',
  ),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/s.md': { text: '![x](assets/b.png)', mode: 0o000 } }),
    null,
    'a sibling nobody may read',
  ),
  reconcileCase(['assets/a.png'], { 'd/doc.md': '' }, null, 'no assets folder'),
  reconcileCase(
    ['assets/a.png'],
    { 'd/doc.md': '', 'd/assets': { dir: true } },
    null,
    'an empty assets folder',
  ),
  reconcileCase(
    ['assets/a.png'],
    { 'd/doc.md': '', 'd/assets': 'a file' },
    null,
    'assets is a file',
  ),
  reconcileCase(
    ['assets/a.png'],
    { 'd/doc.md': '', [MANIFEST]: { dir: true } },
    null,
    'the manifest is a folder',
  ),
  reconcileCase(
    ['assets/a.png'],
    RC_FILES({ 'd/assets': { dir: true, mode: 0o555 } }),
    null,
    'an assets folder nobody may write in',
  ),
  reconcileCase(
    [],
    owned(
      [
        ['2.png', '2'],
        ['10.png', '10'],
        ['x.png', 'x'],
      ],
      { '10': ['10.png'], '2': ['2.png'], 'b.md': ['x.png'], 'a.md': ['x.png'] },
      { '10': ['10.png'] },
    ),
    ['10.png'],
    'integer-like document names',
  ),
  reconcileCase(
    ['assets/10.png', 'assets/2.png'],
    owned(
      [
        ['2.png', '2'],
        ['10.png', '10'],
      ],
      {},
      {},
    ),
    null,
    'referencing integer-like files',
  ),
  reconcileCase(
    ['assets/a.png'],
    {
      'd/doc.md': '',
      [OLD_MANIFEST]: manifestOf(
        [
          ['a.png', 'A'],
          ['u.png', 'U'],
        ],
        {},
        { 'doc.md': ['u.png'] },
      ),
      'd/assets/a.png': 'A',
      'd/assets/u.png': 'U',
    },
    null,
    'the old manifest name',
  ),
  reconcileCase(
    ['assets/a.png'],
    {
      'd/doc.md': '',
      [OLD_MANIFEST]: manifestOf([['o.png', 'O']]),
      [MANIFEST]: manifestOf([['n.png', 'N']]),
      'd/assets/o.png': 'O',
      'd/assets/n.png': 'N',
    },
    null,
    'both names',
  ),
  ...[
    ['{broken', 'not JSON'],
    ['', 'empty'],
    ['null', 'null'],
    ['5', 'a number'],
    ['"x"', 'a string'],
    ['[]', 'a list'],
    ['{}', 'no version'],
    [j({ version: 2, files: [] }), 'another version'],
    [j({ version: '1', files: [] }), 'a version as text'],
    [j({ version: 1 }), 'no files'],
    [j({ version: 1, files: {} }), 'files is not a list'],
    [j({ version: 1, files: [null] }), 'a null entry'],
    [j({ version: 1, files: [5] }), 'a number entry'],
    [j({ version: 1, files: [[]] }), 'a list entry'],
    [j({ version: 1, files: [{}] }), 'an entry with nothing'],
    [j({ version: 1, files: [{ name: 'a.png' }] }), 'no hash'],
    [j({ version: 1, files: [{ name: 5, sha256: sha('x') }] }), 'a name that is no string'],
    [j({ version: 1, files: [{ name: '../a.png', sha256: sha('x') }] }), 'a name that climbs'],
    [j({ version: 1, files: [{ name: 'a/b.png', sha256: sha('x') }] }), 'a name with a slash'],
    [j({ version: 1, files: [{ name: 'a\\b.png', sha256: sha('x') }] }), 'a name with a backslash'],
    [j({ version: 1, files: [{ name: 'a\u0000b.png', sha256: sha('x') }] }), 'a name with NUL'],
    [j({ version: 1, files: [{ name: '', sha256: sha('x') }] }), 'an empty name'],
    [j({ version: 1, files: [{ name: '.', sha256: sha('x') }] }), 'a dot name'],
    [j({ version: 1, files: [{ name: '..', sha256: sha('x') }] }), 'a dot dot name'],
    [
      j({ version: 1, files: [{ name: '.seuoffice-assets.json', sha256: sha('x') }] }),
      'the manifest as a file',
    ],
    [
      j({ version: 1, files: [{ name: '.genoffice-assets.json', sha256: sha('x') }] }),
      'the old manifest as a file',
    ],
    [
      j({ version: 1, files: [{ name: 'n'.repeat(181), sha256: sha('x') }] }),
      'a name of 181 characters',
    ],
    [
      j({ version: 1, files: [{ name: 'n'.repeat(180), sha256: sha('x') }] }),
      'a name of 180 characters',
    ],
    [
      j({ version: 1, files: [{ name: `${EMOJI.repeat(90)}`, sha256: sha('x') }] }),
      'a name of 180 units',
    ],
    [
      j({ version: 1, files: [{ name: `${EMOJI.repeat(91)}`, sha256: sha('x') }] }),
      'a name of 182 units',
    ],
    [
      j({ version: 1, files: [{ name: 'a.png', sha256: sha('x').toUpperCase() }] }),
      'a hash in capitals',
    ],
    [j({ version: 1, files: [{ name: 'a.png', sha256: sha('x').slice(1) }] }), 'a short hash'],
    [
      j({ version: 1, files: [{ name: 'a.png', sha256: `${sha('x')}\n` }] }),
      'a hash with a newline',
    ],
    [
      j({
        version: 1,
        files: [
          { name: 'a.png', sha256: sha('x') },
          { name: 'a.png', sha256: sha('x') },
        ],
      }),
      'a name twice',
    ],
    [j({ version: 1, files: [], documents: [] }), 'documents is a list'],
    [j({ version: 1, files: [], documents: null }), 'documents is null'],
    [j({ version: 1, files: [], documents: 'x' }), 'documents is a string'],
    [j({ version: 1, files: [], documents: { '../x': [] } }), 'a document that climbs'],
    [j({ version: 1, files: [], documents: { 'a.md': 'x' } }), 'references that are no list'],
    [j({ version: 1, files: [], documents: { 'a.md': [5] } }), 'a reference that is no string'],
    [j({ version: 1, files: [], documents: { 'a.md': ['../x'] } }), 'a reference that climbs'],
    [j({ version: 1, files: [], pending: [] }), 'pending is a list'],
    [j({ version: 1, files: [], pending: null }), 'pending is null'],
    [j({ version: 1, files: [], pending: { 'a/b.md': [] } }), 'a pending document with a slash'],
    [j({ version: 1, files: [], pending: { 'a.md': 'x' } }), 'pending references that are no list'],
    [j({ version: 1, files: [], pending: { 'a.md': [null] } }), 'a pending reference that is null'],
    [j({ version: 1, files: [], pending: { 'a.md': ['.'] } }), 'a pending reference that is a dot'],
    ['\ufeff{"version":1,"files":[]}', 'a byte order mark'],
    ['{"version":1,"files":[],}', 'a trailing comma'],
    [`{"version":1,"files":[]} x`, 'text after the value'],
  ].map(([text, note]) =>
    reconcileCase([], { 'd/doc.md': '', [MANIFEST]: text! }, null, `manifest: ${note}`),
  ),
]

const renameCase = (
  oldPath: string,
  newPath: string,
  files: Record<string, FileSpec>,
  note?: string,
): Case => ({
  args: [oldPath, newPath],
  files,
  ...(note ? { note } : {}),
})
const RN_FILES = (
  documents: Record<string, string[]>,
  pending: Record<string, string[]> = {},
): Record<string, FileSpec> =>
  owned(
    [
      ['a.png', 'A'],
      ['b.png', 'B'],
    ],
    documents,
    pending,
    { 'd/old.md': '', 'd/new.md': '' },
  )
const renameCases: Case[] = [
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({ 'old.md': ['b.png', 'a.png'] }, { 'old.md': ['b.png'] }),
    'both move',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({ 'old.md': ['a.png'], 'new.md': ['b.png', 'a.png'] }, { 'new.md': ['b.png'] }),
    'merged with what the new name holds',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({ 'old.md': [] }),
    'an empty list still moves',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({}, { 'old.md': ['a.png'] }),
    'only pending moves',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({ 'other.md': ['a.png'] }),
    'the old name holds nothing: the manifest is left as it is',
  ),
  renameCase('$DIR/d/old.md', '$DIR/d/old.md', RN_FILES({ 'old.md': ['a.png'] }), 'the same name'),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/e/new.md',
    RN_FILES({ 'old.md': ['a.png'] }),
    'another folder: nothing to do',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/../d/new.md',
    RN_FILES({ 'old.md': ['a.png'] }),
    'the same folder spelled another way',
  ),
  renameCase('$DIR/d/old.md', '$DIR/d/new.md', { 'd/old.md': '' }, 'no assets folder'),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    { 'd/old.md': '', [MANIFEST]: '{broken' },
    'a manifest that is not JSON',
  ),
  renameCase(
    '$DIR/d/old.md',
    `$DIR/d/${'n'.repeat(181)}.md`,
    RN_FILES({ 'old.md': ['a.png'] }),
    'a new name that cannot be a key',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/.seuoffice-assets.json',
    RN_FILES({ 'old.md': ['a.png'] }),
    'a new name that is the manifest',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    {
      'd/old.md': '',
      [OLD_MANIFEST]: manifestOf([['a.png', 'A']], { 'old.md': ['a.png'] }),
      'd/assets/a.png': 'A',
    },
    'the old manifest name stays',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    RN_FILES({ '2': ['a.png'], 'old.md': ['b.png'], '10': ['a.png'] }),
    'integer-like keys keep their order',
  ),
  renameCase(
    '$DIR/d/old.md',
    '$DIR/d/new.md',
    { ...RN_FILES({ 'old.md': ['a.png'] }), 'd/assets': { dir: true, mode: 0o555 } },
    'an assets folder nobody may write in',
  ),
]

const readManifestCases: Case[] = [
  { args: [DOC], files: { 'd/doc.md': '' }, note: 'no assets folder' },
  {
    args: [DOC],
    files: { 'd/doc.md': '', 'd/assets': { dir: true } },
    note: 'an empty assets folder',
  },
  { args: [DOC], files: { 'd/doc.md': '', 'd/assets': 'a file' }, note: 'assets is a file' },
  { args: [DOC], files: { 'd/doc.md': '', [MANIFEST]: '{broken' }, note: 'not JSON' },
  { args: [DOC], files: { 'd/doc.md': '', [MANIFEST]: { dir: true } }, note: 'a folder' },
  {
    args: [DOC],
    files: owned(
      [
        ['b.png', 'B'],
        ['a.png', 'A'],
        ['B.png', 'b'],
      ],
      { 'x.md': ['b.png', 'a.png', 'a.png'], '10': ['a.png'], '2': ['b.png'], 'a.md': [] },
      { 'y.md': ['B.png'] },
    ),
    note: 'a manifest, normalised',
  },
  {
    args: [DOC],
    files: { 'd/doc.md': '', [OLD_MANIFEST]: manifestOf([['a.png', 'A']]) },
    note: 'the old name',
  },
  {
    args: [DOC],
    files: {
      'd/doc.md': '',
      [MANIFEST]: j({ version: 1, files: [], documents: { __proto__x: ['a'] }, extra: 1 }),
    },
    note: 'unknown keys are dropped',
  },
  {
    args: [DOC],
    files: {
      'd/doc.md': '',
      [MANIFEST]:
        '{"version":1,"files":[],"documents":{"__proto__":["a.png"],"a":["b.png"],"a":["c.png"]}}',
    },
    note: 'a key twice, __proto__',
  },
  {
    args: [DOC],
    files: { 'd/doc.md': '', [MANIFEST]: j({ version: 2, files: [] }) },
    note: 'another version',
  },
  {
    args: [DOC],
    files: { 'd/doc.md': '', [MANIFEST]: { text: j({ version: 1, files: [] }), mode: 0o000 } },
    note: 'a manifest nobody may read',
  },
]

const assetConstant = constant(ASSET_MANIFEST_FILENAME)

export const group: Group = {
  'markdown/old-names.OLD_ASSET_MANIFEST_FILENAMES': constant([...OLD_ASSET_MANIFEST_FILENAMES]),
  'markdown/old-names.OLD_CONVERSION_SESSION_MARKERS': constant([
    ...OLD_CONVERSION_SESSION_MARKERS,
  ]),
  'markdown/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: [
      { args: ['$DIR/a.md', 'new'] },
      { args: ['$DIR/a.md', 'new'], files: { 'a.md': 'old' } },
      {
        args: ['$DIR/a.md', 'new\u{1F600}'],
        files: { 'a.md': { text: 'old', mode: 0o444 } },
        note: 'a read-only target is replaced',
      },
      {
        args: ['$DIR/a.md', 'new'],
        files: { 'a.md.unsaved.tmp': 'stale' },
        note: 'a stale rescue copy goes',
      },
      { args: ['$DIR/none/a.md', 'new'], note: 'no folder' },
      { args: ['$DIR/a.md', 'new'], files: { 'a.md': { dir: true } }, note: 'a folder as target' },
    ],
  },
  'conversion-lifecycle.MARKDOWN_CONVERSION_TTL_MS': constant(MARKDOWN_CONVERSION_TTL_MS),
  'conversion-lifecycle.cleanupStaleMarkdownConversions': {
    ts: (a, cx) =>
      withNow({ now: cx.now }, () =>
        cleanupStaleMarkdownConversions(str(a, 0), opt<number>(a, 1), opt<number>(a, 2)),
      ),
    cases: cleanupCases,
  },
  'conversion-lifecycle.createMarkdownConversionSession': {
    ts: async (a, cx) => {
      const options = (a[1] ?? undefined) as
        { now?: number; id?: string; ttlMs?: number } | undefined
      const path = await withNow({ now: cx.now }, () =>
        createMarkdownConversionSession(str(a, 0), options),
      )
      return settleRandomPath(path)
    },
    cases: sessionCases,
  },
  'conversion-lifecycle.writeMarkdownConversion': {
    ts: async (a) =>
      settleRandomPath(
        await writeMarkdownConversion(
          str(a, 0),
          str(a, 1),
          Buffer.from(str(a, 2)),
          opt<string>(a, 3) as never,
        ),
      ),
    cases: writeCases,
  },
  'image-export.ImageExportSessions': { ts: (a) => runImageExport(a), cases: imageExportCases },
  'image-host.normalizeImageHostConfig': {
    ts: (a) => normalizeImageHostConfig(a[0]),
    cases: configCases,
  },
  'image-host.isImageHostUsable': {
    ts: (a) => isImageHostUsable(a[0] as never),
    cases: configCases,
  },
  'image-host.imageObjectKey': {
    ts: (a) =>
      withRandoms([(a[3] as number | null) ?? 0.3], () =>
        imageObjectKey(opt<string>(a, 0), str(a, 1), new Date(a[2] as number)),
      ),
    cases: objectKeyCases,
  },
  'image-host.sigV4': {
    ts: (a) =>
      sigV4(
        str(a, 0),
        new URL(str(a, 1)),
        a[2] as Record<string, string>,
        Buffer.from(str(a, 3)),
        a[4] as { accessKeyId: string; secretAccessKey: string; region: string; service: string },
        str(a, 5),
      ),
    cases: sigV4Cases,
  },
  'image-host.uploadImageToHost': { ts: runUpload, cases: uploadCases },
  'wiki-resolve.SKIP_DIRS': constant([...SKIP_DIRS]),
  'wiki-resolve.MAX_DEPTH': constant(MAX_DEPTH),
  'wiki-resolve.splitTarget': { ts: (a) => splitTarget(str(a, 0)), cases: splitCases },
  'wiki-resolve.nodeFs': { ts: (a, cx) => runVault(a, cx, true), cases: nodeFsCases },
  'wiki-resolve.resolveWikiLinks': {
    ts: async (a, cx) => {
      const options = a[1] as { fromPath: string; root: string }
      const resolved = await withNow({ now: cx.now }, () =>
        resolveWikiLinks(a[0] as string[], options, nodeFs()),
      )
      return [...resolved.entries()]
    },
    cases: resolveCases,
  },
  'wiki-notes.MAX_NOTES': constant(MAX_NOTES),
  'wiki-notes.listWikiNotes': {
    ts: (a, cx) =>
      withNow({ now: cx.now }, () =>
        listWikiNotes(
          str(a, 0),
          nodeFs(),
          a[1] == null ? undefined : typeof a[1] === 'string' ? Number(a[1]) : (a[1] as number),
        ),
      ),
    cases: notesCases,
  },
  'wiki-create.createWikiNote': {
    ts: (a) => createWikiNote(str(a, 0), a[1] as { root: string; fromDir: string }),
    cases: createCases,
  },
  'wiki-heads.MAX_HEAD_ENTRIES_PER_KIND': constant(MAX_HEAD_ENTRIES_PER_KIND),
  'wiki-heads.parseWikiHeads': { ts: (a) => parseWikiHeads(str(a, 0)), cases: headsCases },
  'wiki-heads.wikiHeads': {
    ts: (a, cx) => withNow({ now: cx.now }, () => wikiHeads(str(a, 0), str(a, 1), str(a, 2))),
    cases: wikiHeadsCases,
  },
  'wiki-index.MAX_INDEX_FILES': constant(MAX_INDEX_FILES),
  'wiki-index.MAX_GRAPH_NODES': constant(MAX_GRAPH_NODES),
  'wiki-index.extractWikiTargets': {
    ts: (a) => extractWikiTargets(str(a, 0)),
    cases: targetsCases,
  },
  'wiki-index.extractTags': { ts: (a) => extractTags(str(a, 0)), cases: tagsCases },
  'wiki-index.nodeVaultFs': { ts: (a, cx) => runVault(a, cx, false), cases: vaultFsCases },
  'wiki-index.wikiBacklinks': { ts: (a, cx) => runVault(a, cx, false), cases: backlinksCases },
  'wiki-index.wikiTags': { ts: (a, cx) => runVault(a, cx, false), cases: tagsCases2 },
  'wiki-index.wikiGraph': { ts: (a, cx) => runVault(a, cx, false), cases: graphCases },
  'wiki-index.warmWikiIndex': { ts: (a, cx) => runVault(a, cx, false), cases: warmCases },
  'wiki-fragment.rememberWikiFragment': { ts: (a) => runFragments(a), cases: fragmentCases },
  'wiki-fragment.takeWikiFragment': { ts: (a) => runFragments(a), cases: fragmentCases },
  'markdown/asset-lifecycle.ASSET_MANIFEST_FILENAME': assetConstant,
  'markdown/asset-lifecycle.copyImageIntoOwnedAssets': {
    ts: (a) => masked(() => copyImageIntoOwnedAssets(str(a, 0), str(a, 1))),
    cases: copyCases,
  },
  'markdown/asset-lifecycle.writeImageIntoOwnedAssets': {
    ts: (a) =>
      masked(() => writeImageIntoOwnedAssets(str(a, 0), str(a, 1), Buffer.from(str(a, 2), 'hex'))),
    cases: writeAssetCases,
  },
  'markdown/asset-lifecycle.resolveSafeRelativeImagePath': {
    ts: (a) => resolveSafeRelativeImagePath(str(a, 0), str(a, 1)),
    cases: relativeCases,
  },
  'markdown/asset-lifecycle.resolveSafeVaultImagePath': {
    ts: (a) => resolveSafeVaultImagePath(str(a, 0), str(a, 1)),
    cases: vaultImageCases,
  },
  'markdown/asset-lifecycle.extractMarkdownImageSources': {
    ts: (a) => extractMarkdownImageSources(str(a, 0)),
    cases: extractCases,
  },
  'markdown/asset-lifecycle.isInDocDir': {
    ts: (a) => isInDocDir(str(a, 0), str(a, 1), opt<string>(a, 2)),
    cases: docDirCases,
  },
  'markdown/asset-lifecycle.rewriteMarkdownImageSources': {
    ts: (a) => rewriteMarkdownImageSources(str(a, 0), new Map(a[1] as [string, string][])),
    cases: rewriteCases,
  },
  'markdown/asset-lifecycle.prepareAssetsForSaveAs': {
    ts: (a) =>
      masked(() => prepareAssetsForSaveAs(str(a, 0), str(a, 1), str(a, 2), a[3] as string[])),
    cases: prepareCases,
  },
  'markdown/asset-lifecycle.rollbackPreparedSaveAsAssets': {
    ts: (a) => masked(() => rollbackPreparedSaveAsAssets(a[0] as never)),
    cases: rollbackCases,
  },
  'markdown/asset-lifecycle.pendingOwnedAssetsForDocument': {
    ts: (a) => pendingOwnedAssetsForDocument(str(a, 0)),
    cases: pendingCases,
  },
  'markdown/asset-lifecycle.discardPendingOwnedAssets': {
    ts: async (a) => maskErrors(await discardPendingOwnedAssets(str(a, 0))),
    cases: discardCases,
  },
  'markdown/asset-lifecycle.resolveSourcePendingAfterSaveAs': {
    ts: async (a) => maskErrors(await resolveSourcePendingAfterSaveAs(str(a, 0), a[1] as string[])),
    cases: resolveSourceCases,
  },
  'markdown/asset-lifecycle.reconcileOwnedAssets': {
    ts: async (a) =>
      maskErrors(
        await reconcileOwnedAssets(
          str(a, 0),
          a[1] as string[],
          a[2] == null ? {} : { pendingNames: a[2] as string[] },
        ),
      ),
    cases: reconcileCases,
  },
  'markdown/asset-lifecycle.renameOwnedAssetDocument': {
    ts: (a) => masked(() => renameOwnedAssetDocument(str(a, 0), str(a, 1))),
    cases: renameCases,
  },
  'markdown/asset-lifecycle.readOwnedAssetManifest': {
    ts: (a) => readOwnedAssetManifest(str(a, 0)),
    cases: readManifestCases,
  },
}
