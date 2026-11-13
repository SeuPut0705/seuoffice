/**
 * Group `w-shell`: the modules of apps/shell/src/main that batch W of stage 3
 * ported to crates/main-core/src/shell: the quick-look preview extractor and
 * the document picker's list.
 *
 * - extract: the four text parsers are called as they are. `extractQuickLook`
 *   runs with `parse` of the spec (`{ ok, text, error }`, `{ throws }`), which
 *   is what `@seuoffice/file-parse` answers, so the Rust takes the same
 *   answer from its fake engines; a given `parse` also turns the cache off.
 *   `extractEmbeddedThumbnail` takes hex bytes; the ZIP half reads through
 *   JSZip, which the Rust has behind a trait (its fake finds nothing), so the
 *   zips here hold no thumbnail.
 * - doc-list: `createDocList(deps)(asker, options)`; the spec lists the open
 *   documents, the recent files, the project files (absent: the dependency is
 *   not given, `{ throws }`) and the size of each path (absent: not there).
 * - doc-asker: the sources of `resolveDocAsker` are a spec of tabs, a split
 *   and detached windows.
 */
import { deflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import * as extract from '../../../apps/shell/src/main/quick-look/extract.ts'
import * as docList from '../../../apps/shell/src/main/doc-picker/doc-list.ts'
import * as docAsker from '../../../apps/shell/src/main/doc-picker/doc-asker.ts'
import * as attachable from '../../../packages/file-parse/src/attachable.ts'
import type { Case, Group } from '../types.ts'

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const MTIME = 1_700_000_000_000

// ---------------------------------------------------------------------------
// text parsers
// ---------------------------------------------------------------------------

const SHEET_TEXTS = [
  '',
  'plain line | b | c',
  '# One\na | b\n1 | 2\n\n# Two\nx | y',
  '\n\n# \na | b',
  '# A\r\nx | y\r\n# B\r\nz',
  `# Wide\n${Array.from({ length: 20 }, (_, i) => `c${i}`).join(' | ')}`,
  `# Tall\n${Array.from({ length: 60 }, (_, i) => `r${i} | v`).join('\n')}`,
  Array.from({ length: 10 }, (_, i) => `# S${i}\nk | v`).join('\n'),
  '#NoSpace\nrow | 1',
  'lead\n# Named\nrow',
]
const DELIMITED_TEXTS = [
  '',
  'a,b,c\n1,2,3\n',
  'a,"b,c",d\n"x ""y"" z",2',
  'a\tb\tc\n1\t2\t3',
  'a,b\r\nc,d\r\n\r\n',
  Array.from({ length: 20 }, (_, i) => `c${i}`).join(','),
  Array.from({ length: 60 }, (_, i) => `r${i},v`).join('\n'),
  '"open,quote\nnext,row',
]

const SLIDE_TEXTS = [
  '',
  '   \n ',
  'just a title\nand a bullet\nanother',
  '## Slide 1\nTitle\nBullet one\nBullet two\n### Notes\nSpeaker note\n## Slide 2\nSecond',
  '## slide 3 \nlower case title\n### NOTES\nn1\n### Comments\nc1\nc2\n### Other\nstill body',
  '## Slide 12\n\n  Spaced title  \n  - dash',
  '## Slide x\nnot a slide\n## Slide 7a\nnot either\n## Slide 9_\nno',
  'before\n## Slide 1\nA',
  '##Slide 1\nno space',
  Array.from({ length: 35 }, (_, i) => `## Slide ${i + 1}\nT${i}`).join('\n'),
  '## Slide 00012\nPadded number',
  '## Slide 1\n### Notes extra\nnot notes\n### Notes\nreal note',
]

const MINDMAP_TEXTS = [
  '',
  '- orphan\n  - child',
  '# Map one\n- root\n  - child\n    - grandchild\n- second root',
  '# \n- a',
  '# A\n- x\n# B\n- y',
  `# Deep\n${Array.from({ length: 10 }, (_, i) => `${' '.repeat(i * 2)}- level ${i}`).join('\n')}`,
  `# Big\n${Array.from({ length: 130 }, (_, i) => `- n${i}`).join('\n')}`,
  Array.from({ length: 8 }, (_, i) => `# M${i}\n- k`).join('\n'),
  '# T\n-nospace\n- ok\n\t- tabbed',
  '# T\r\n- crlf\r\n  - child\r\n',
]

const longCode = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
const DOC_TEXTS = [
  '',
  'Just a paragraph.',
  '# Title\n\nBody text\n- bullet\n* star\n• dot\n## Sub\n###### Six\n####### Seven',
  'a | b\n--- | ---\n1 | 2\n|x|y|\n|---|:--:|',
  '| a | b |\n|---|---|\n| 1 | 2 |\ntext after',
  'col1\tcol2\nv1\tv2\n\nnext',
  '```js\nconst a = 1\n\nlet b\n```\nafter',
  '```\nunclosed code\nmore',
  `\`\`\`\n${longCode}\n\`\`\``,
  Array.from({ length: 140 }, (_, i) => `p${i}`).join('\n'),
  Array.from({ length: 40 }, (_, i) => `r${i} | v`).join('\n'),
  `${Array.from({ length: 14 }, (_, i) => `c${i}`).join(' | ')}`,
  '#nospace\n-nospace\n#\n-',
  '  indented para  \n\t\n   \n- \n#  spaced heading  ',
  'tab\there\nnot a table | maybe\nplain',
  '| a | b |\n```\ncode\n```\n| c | d |',
]

// ---------------------------------------------------------------------------
// thumbnails
// ---------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('thumbnail-bytes')])
const GIF = Buffer.concat([Buffer.from('47494638', 'hex'), Buffer.from('gif-bytes')])
const JPG = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('jpeg-bytes')])
const BMP = Buffer.concat([Buffer.from('424d', 'hex'), Buffer.from('bmp-bytes!')])
const WEBP = Buffer.concat([
  Buffer.from('52494646', 'hex'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.from('webp-bytes'),
])

function hwp5(streams: Record<string, Buffer>): Buffer {
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, '/FileHeader', Buffer.alloc(256))
  for (const [name, content] of Object.entries(streams)) CFB.utils.cfb_add(cfb, name, content)
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array)
}

/** a ZIP of one stored file without a thumbnail: a local header, the data, an end record */
function emptyZip(): Buffer {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  return end
}

const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('hex')
const THUMB_CASES: unknown[][] = [
  ['hwp', hex(hwp5({ '/PrvImage': PNG }))],
  ['hwp', hex(hwp5({ '/PrvImage': GIF }))],
  ['hwp', hex(hwp5({ '/PrvImage': JPG }))],
  ['hwp', hex(hwp5({ '/PrvImage': BMP }))],
  ['hwp', hex(hwp5({ '/PrvImage': WEBP }))],
  ['hwp', hex(hwp5({ '/PrvImage': deflateRawSync(PNG) }))],
  ['hwp', hex(hwp5({ '/PrvImage': deflateRawSync(Buffer.from('not an image at all')) }))],
  ['hwp', hex(hwp5({ '/PrvImage': Buffer.from('short') }))],
  ['hwp', hex(hwp5({ '/PrvImage': Buffer.from('plain text but long enough, no image') }))],
  ['hwp', hex(hwp5({ PrvImage: PNG }))],
  ['hwp', hex(hwp5({ '/Other': PNG }))],
  ['hwp', hex(hwp5({ '/PrvImage': Buffer.alloc(6 * 1024 * 1024, 1) }))],
  ['hwp', hex(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600, 7)]))],
  ['hwp', 'd0cf11e0'],
  ['hwp', ''],
  ['docx', hex(hwp5({ '/PrvImage': PNG }))],
  ['hwpx', hex(emptyZip())],
  ['docx', hex(Buffer.from('PK not really a zip'))],
  ['txt', hex(emptyZip())],
  ['pdf', '255044462d'],
]

// ---------------------------------------------------------------------------
// extractQuickLook
// ---------------------------------------------------------------------------

interface ParseSpec {
  ok?: boolean
  text?: string
  error?: string
  throws?: string
}

const parseOf = (spec: ParseSpec | undefined) => async () => {
  if (!spec) throw new Error('parse was not expected to run')
  if (spec.throws !== undefined) throw new Error(spec.throws)
  const out: Record<string, unknown> = { ok: spec.ok ?? true, kind: 'text' }
  if (spec.text !== undefined) out.text = spec.text
  if (spec.error !== undefined) out.error = spec.error
  return out as never
}

const at = (text: string) => ({ text, mtimeMs: MTIME })
const bin = (b: Buffer) => ({ hex: b.toString('hex'), mtimeMs: MTIME })
const emoji = '\u{1F600}'.repeat(7000)

const QUICK_LOOK: Case[] = [
  { args: ['$DIR/a.txt', { ok: true, text: 'hello' }], files: { 'a.txt': at('x') }, note: 'text' },
  {
    args: ['$DIR/a.txt', { ok: true, text: 'y'.repeat(13000) }],
    files: { 'a.txt': at('x') },
    note: 'plain text past the cap',
  },
  {
    args: ['$DIR/a.txt', { ok: true, text: emoji }],
    files: { 'a.txt': at('x') },
    note: 'a cut on a pair boundary',
  },
  {
    args: ['$DIR/a.md', { ok: true, text: '# H\n- b\npara' }],
    files: { 'a.md': at('x') },
    note: 'markdown blocks',
  },
  {
    args: ['$DIR/a.docx', { ok: true, text: 'Title\n\na | b\n1 | 2' }],
    files: { 'a.docx': at('PK') },
    note: 'docx with a failed zip thumbnail',
  },
  {
    args: ['$DIR/a.xlsx', { ok: true, text: '# S1\na | b\n1 | 2' }],
    files: { 'a.xlsx': at('PK') },
    note: 'xlsx sheets',
  },
  {
    args: ['$DIR/a.csv', { ok: true, text: 'a,b\n1,2\n' }],
    files: { 'a.csv': at('a,b') },
    note: 'csv',
  },
  {
    args: ['$DIR/a.pptx', { ok: true, text: '## Slide 1\nT\nB' }],
    files: { 'a.pptx': at('PK') },
    note: 'pptx slides',
  },
  {
    args: ['$DIR/a.xmind', { ok: true, text: '# M\n- a\n  - b' }],
    files: { 'a.xmind': at('PK') },
    note: 'xmind',
  },
  {
    args: ['$DIR/a.pdf', { ok: true, text: 'page text' }],
    files: { 'a.pdf': at('%PDF') },
    note: 'pdf blocks',
  },
  {
    args: ['$DIR/a.html', { ok: true, text: '<p>x</p>' }],
    files: { 'a.html': at('x') },
    note: 'html is plain text',
  },
  {
    args: ['$DIR/a.hwp', { ok: true, text: 'hwp text' }],
    files: { 'a.hwp': bin(hwp5({ '/PrvImage': PNG })) },
    note: 'hwp text and its thumbnail',
  },
  {
    args: ['$DIR/a.hwp', { ok: false, error: 'damaged file' }],
    files: { 'a.hwp': bin(hwp5({ '/PrvImage': PNG })) },
    note: 'failed parse keeps the thumbnail',
  },
  {
    args: ['$DIR/a.hwp', { ok: false, error: 'the file is password protected' }],
    files: { 'a.hwp': bin(hwp5({ '/PrvImage': PNG })) },
    note: 'an encrypted file shows no thumbnail',
  },
  {
    args: ['$DIR/a.hwp', { ok: false, error: '암호가 걸린 문서' }],
    files: { 'a.hwp': bin(hwp5({ '/PrvImage': PNG })) },
    note: 'the Korean word for a password',
  },
  {
    args: ['$DIR/a.docx', { ok: false, error: 'broken' }],
    files: { 'a.docx': at('PK') },
    note: 'failed parse without a thumbnail',
  },
  {
    args: ['$DIR/a.docx', { ok: false, error: 'Unsupported File Type: docx' }],
    files: { 'a.docx': at('PK') },
    note: 'unsupported file type',
  },
  {
    args: ['$DIR/a.docx', { ok: false }],
    files: { 'a.docx': at('PK') },
    note: 'a failure without a reason',
  },
  {
    args: ['$DIR/a.txt', { throws: 'Encrypted document' }],
    files: { 'a.txt': at('x') },
    note: 'parse throws encrypted',
  },
  {
    args: ['$DIR/a.txt', { throws: 'boom' }],
    files: { 'a.txt': at('x') },
    note: 'parse throws',
  },
  {
    args: ['$DIR/a.txt', { ok: true }],
    files: { 'a.txt': at('x') },
    note: 'no text at all',
  },
  { args: ['$DIR/p.png'], files: { 'p.png': bin(PNG) }, note: 'png image' },
  { args: ['$DIR/p.jpg'], files: { 'p.jpg': bin(GIF) }, note: 'a gif named jpg: sniffed' },
  { args: ['$DIR/p.webp'], files: { 'p.webp': bin(Buffer.from('xx')) }, note: 'unsniffed webp' },
  { args: ['$DIR/p.gif'], files: { 'p.gif': bin(Buffer.alloc(0)) }, note: 'an empty image' },
  { args: ['$DIR/p.jpeg'], files: { 'p.jpeg': bin(JPG) }, note: 'jpeg' },
  { args: ['$DIR/missing.txt'], note: 'a file that is not there' },
  { args: ['$DIR/folder.txt'], files: { 'folder.txt': { dir: true } }, note: 'a folder' },
  { args: ['relative.txt'], note: 'a relative path' },
  { args: [''], note: 'an empty path' },
  { args: ['$DIR/a.xyz'], files: { 'a.xyz': at('x') }, note: 'an unsupported extension' },
  { args: ['$DIR/noext'], files: { noext: at('x') }, note: 'no extension' },
  { args: ['$DIR/A.TXT', { ok: true, text: 'upper' }], files: { 'A.TXT': at('x') }, note: 'case' },
  {
    args: ['$DIR/.txt', { ok: true, text: 'dot' }],
    files: { '.txt': at('x') },
    note: 'only an extension',
  },
]

// ---------------------------------------------------------------------------
// doc-list
// ---------------------------------------------------------------------------

interface ListSpec {
  open?: { id: string; path?: string; title: string; dirty: boolean }[]
  recent?: { path: string; title: string; missing: boolean }[]
  project?: { path: string; title: string }[] | { throws: true }
  sizes?: Record<string, number>
  asker?: Record<string, unknown>
  options?: { projectFiles?: boolean }
}

const listOf = async (spec: ListSpec) => {
  const sizes = spec.sizes ?? {}
  const project = spec.project
  const list = docList.createDocList({
    openDocuments: async () => spec.open ?? [],
    recent: async () => spec.recent ?? [],
    ...(project === undefined
      ? {}
      : {
          projectFiles: async () => {
            if ('throws' in project) throw new Error('project failed')
            return project
          },
        }),
    stat: async (path: string) => (path in sizes ? { sizeBytes: sizes[path] } : null),
    attachable: {
      ATTACHABLE_EXTS: attachable.ATTACHABLE_EXTS,
      ATTACHABLE_IMAGE_EXTS: attachable.ATTACHABLE_IMAGE_EXTS,
      ATTACHABLE_MAX_BYTES: attachable.ATTACHABLE_MAX_BYTES,
      ATTACHABLE_IMAGE_MAX_BYTES: attachable.ATTACHABLE_IMAGE_MAX_BYTES,
      attachableMaxBytes: attachable.attachableMaxBytes,
      diagramPictureExtOfName: attachable.diagramPictureExtOfName,
    },
  })
  return list(spec.asker, spec.options)
}

const open = (id: string, path: string | undefined, title: string, dirty = false) => ({
  id,
  ...(path === undefined ? {} : { path }),
  title,
  dirty,
})
const sized = (...paths: string[]): Record<string, number> =>
  Object.fromEntries(paths.map((p) => [p, 100]))

const BASIC_OPEN = [
  open('t1', '/w/a.docx', 'a.docx'),
  open('t2', '/w/b.xlsx', 'b.xlsx', true),
  open('t3', undefined, 'Untitled 1'),
  open('t4', '/w/c.pdf', 'c.pdf'),
]

const LISTS: ListSpec[] = [
  {},
  { open: BASIC_OPEN, sizes: sized('/w/a.docx', '/w/b.xlsx', '/w/c.pdf') },
  {
    open: BASIC_OPEN,
    sizes: sized('/w/a.docx', '/w/b.xlsx', '/w/c.pdf'),
    asker: { tabId: 't1', path: '/w/a.docx' },
  },
  {
    open: BASIC_OPEN,
    sizes: sized('/w/a.docx', '/w/b.xlsx', '/w/c.pdf'),
    asker: { tabId: 't1', path: '/w/a.docx', paneTabId: 't4' },
  },
  {
    open: BASIC_OPEN,
    sizes: sized('/w/a.docx', '/w/b.xlsx', '/w/c.pdf'),
    asker: { tabId: 't9', paneTabId: 'nope' },
  },
  {
    open: [open('t1', '/w/a.docx', 'a'), open('t2', '/w/a.docx', 'a copy', true)],
    sizes: sized('/w/a.docx'),
  },
  {
    open: [open('t1', '/W/A.DOCX', 'upper'), open('t2', '/w/a.docx', 'lower')],
    sizes: sized('/W/A.DOCX', '/w/a.docx'),
  },
  {
    open: [open('t1', '/w/x/../a.docx', 'dots'), open('t2', '/w/a.docx', 'plain')],
    sizes: sized('/w/x/../a.docx', '/w/a.docx'),
    asker: { path: '/w/./a.docx' },
  },
  {
    open: [open('t1', '/w/a.docx', 'gone')],
    recent: [{ path: '/w/old.docx', title: 'old', missing: true }],
  },
  {
    recent: [
      { path: '/r/one.txt', title: 'one', missing: false },
      { path: '/r/two.md', title: 'two', missing: false },
      { path: '/r/known-missing.md', title: 'km', missing: true },
      { path: '/r/dup.txt', title: 'dup', missing: false },
      { path: '/r/dup.txt', title: 'dup again', missing: false },
      { path: 'bare.txt', title: 'no folder', missing: false },
    ],
    sizes: sized('/r/one.txt', '/r/two.md', '/r/dup.txt', 'bare.txt'),
  },
  {
    recent: [
      { path: '/r/ok.docx', title: 'ok', missing: false },
      { path: '/r/huge.txt', title: 'huge', missing: false },
      { path: '/r/huge.docx', title: 'huge docx', missing: false },
      { path: '/r/big.png', title: 'big png', missing: false },
      { path: '/r/small.png', title: 'small png', missing: false },
      { path: '/r/ok.exe', title: 'not attachable', missing: false },
      { path: '/r/noext', title: 'no ext', missing: false },
    ],
    sizes: {
      '/r/ok.docx': 10,
      '/r/huge.txt': 51 * 1024 * 1024,
      '/r/huge.docx': 900 * 1024 * 1024,
      '/r/big.png': 6 * 1024 * 1024,
      '/r/small.png': 4 * 1024 * 1024,
      '/r/ok.exe': 1,
      '/r/noext': 1,
    },
  },
  {
    recent: [
      { path: '/d/flow.drawio.png', title: 'picture diagram', missing: false },
      { path: '/d/flow.DRAWIO.SVG', title: 'svg diagram', missing: false },
      { path: '/d/flow.drawio', title: 'xml diagram', missing: false },
      { path: '/d/plain.svg', title: 'svg', missing: false },
    ],
    sizes: {
      '/d/flow.drawio.png': 6 * 1024 * 1024,
      '/d/flow.DRAWIO.SVG': 100,
      '/d/flow.drawio': 1,
    },
  },
  {
    open: [open('t1', '/w/a.docx', 'a')],
    project: [
      { path: '/p/notes.md', title: 'notes' },
      { path: '/w/a.docx', title: 'a again' },
      { path: '/p/data.csv', title: 'data' },
    ],
    recent: [{ path: '/p/notes.md', title: 'recent notes', missing: false }],
    sizes: sized('/w/a.docx', '/p/notes.md', '/p/data.csv'),
    options: { projectFiles: true },
    asker: { webContentsId: 5 },
  },
  {
    project: [{ path: '/p/notes.md', title: 'notes' }],
    sizes: sized('/p/notes.md'),
    options: { projectFiles: false },
  },
  { project: [{ path: '/p/notes.md', title: 'notes' }], sizes: sized('/p/notes.md') },
  { project: { throws: true }, options: { projectFiles: true }, recent: [] },
  {
    project: { throws: true },
    options: { projectFiles: true },
    recent: [{ path: '/r/after.txt', title: 'after', missing: false }],
    sizes: sized('/r/after.txt'),
  },
  { options: { projectFiles: true }, recent: [{ path: '/r/x.txt', title: 'x', missing: false }] },
  {
    open: [open('', '', 'empty path string'), open('t2', undefined, 'second unsaved', true)],
  },
  {
    open: [open('t1', '/w/a.docx', 'a', true), open('t2', '/w/a.docx', 'a2')],
    sizes: sized('/w/a.docx'),
    asker: { tabId: 't2' },
  },
]

const MENTION_LISTS: unknown[][] = [
  [[]],
  [
    [
      { id: '/w/a.docx', title: 'A', dir: '/w', state: 'ok', group: 'open' },
      { id: 'unsaved:t3', title: 'Untitled 1', dir: '', state: 'unsaved', group: 'open' },
      { id: '/w/gone.docx', title: 'Gone', dir: '/w', state: 'missing', group: 'recent' },
      { id: '/w/b.xlsx', title: 'B', dir: '/w', state: 'modified', group: 'pane' },
    ],
  ],
  [[{ id: 'bare.txt', title: 'bare', dir: '', state: 'ok', group: 'project' }]],
]

// ---------------------------------------------------------------------------
// doc-asker
// ---------------------------------------------------------------------------

interface AskerSpec {
  tabs?: Record<string, { id: string; filePath?: string }>
  split?: { aTabId: string; bTabId: string } | null
  detached?: Record<string, { id: string; filePath?: string }>
}

const askerOf = (id: number, spec: AskerSpec) =>
  docAsker.resolveDocAsker(id, {
    tabFor: (wc: number) => spec.tabs?.[String(wc)],
    split: () => spec.split ?? null,
    detachedFor: (wc: number) => spec.detached?.[String(wc)],
  })

const ASKERS: unknown[][] = [
  [1, {}],
  [1, { tabs: { '1': { id: 'tab-a', filePath: '/w/a.docx' } } }],
  [1, { tabs: { '1': { id: 'tab-a' } } }],
  [1, { tabs: { '1': { id: 'tab-a', filePath: '' } } }],
  [
    1,
    {
      tabs: { '1': { id: 'tab-a', filePath: '/w/a.docx' } },
      split: { aTabId: 'tab-a', bTabId: 'tab-b' },
    },
  ],
  [
    1,
    {
      tabs: { '1': { id: 'tab-b', filePath: '/w/b.docx' } },
      split: { aTabId: 'tab-a', bTabId: 'tab-b' },
    },
  ],
  [
    1,
    {
      tabs: { '1': { id: 'tab-c' } },
      split: { aTabId: 'tab-a', bTabId: 'tab-b' },
    },
  ],
  [2, { detached: { '2': { id: 'detached:2', filePath: '/w/d.docx' } } }],
  [2, { detached: { '2': { id: 'detached:2' } } }],
  [
    3,
    {
      tabs: { '3': { id: 'tab-z' } },
      detached: { '3': { id: 'detached:3', filePath: '/w/d.docx' } },
    },
  ],
  [4, { tabs: { '1': { id: 'tab-a' } }, detached: { '2': { id: 'detached:2' } } }],
]

export const group: Group = {
  'extract.parseSheetsFromText': {
    ts: ([text, ext, name]) =>
      extract.parseSheetsFromText(text as string, ext as string, name as string),
    cases: [
      ...SHEET_TEXTS.map((t): Case => ({ args: [t, 'xlsx', 'Book.xlsx'] })),
      ...SHEET_TEXTS.slice(0, 3).map((t): Case => ({ args: [t, 'xls', 'Old.xls'] })),
      ...DELIMITED_TEXTS.flatMap((t): Case[] => [
        { args: [t, 'csv', 'data.csv'] },
        { args: [t, 'tsv', 'data.tsv'] },
      ]),
    ],
  },
  'extract.parseSlidesFromText': {
    ts: ([text]) => extract.parseSlidesFromText(text as string),
    cases: cases(...SLIDE_TEXTS.map((t) => [t])),
  },
  'extract.parseMindmapFromText': {
    ts: ([text]) => extract.parseMindmapFromText(text as string),
    cases: cases(...MINDMAP_TEXTS.map((t) => [t])),
  },
  'extract.parseDocBlocksFromText': {
    ts: ([text]) => extract.parseDocBlocksFromText(text as string),
    cases: cases(...DOC_TEXTS.map((t) => [t])),
  },
  'extract.extractEmbeddedThumbnail': {
    ts: async ([ext, bytes]) =>
      (await extract.extractEmbeddedThumbnail(
        ext as string,
        Buffer.from(bytes as string, 'hex'),
      )) ?? null,
    cases: cases(...THUMB_CASES),
  },
  'extract.extractQuickLook': {
    ts: ([path, spec]) =>
      extract.extractQuickLook(path as string, {
        parse: parseOf(spec as ParseSpec | undefined),
      }),
    cases: QUICK_LOOK,
  },
  'doc-list.createDocList': {
    ts: ([spec]) => listOf(spec as ListSpec),
    cases: cases(...LISTS.map((l) => [l])),
  },
  'doc-list.toMentionItems': {
    ts: ([items]) => docList.toMentionItems(items as never),
    cases: cases(...MENTION_LISTS),
  },
  'doc-asker.resolveDocAsker': {
    ts: ([id, spec]) => askerOf(id as number, spec as AskerSpec),
    cases: cases(...ASKERS),
  },
}
