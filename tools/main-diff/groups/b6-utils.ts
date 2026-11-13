/**
 * Group `b6-utils`: the modules of packages/electron-utils that call Electron
 * (batch B6 of decision 0030). Electron is the fake of electron-fake.ts; each
 * case installs the objects it describes, and each call of a fake is one log
 * line, as the Rust fakes of calls/b6_utils.rs write it.
 *
 * - save-conflict: the open-path probe of a spec is `null` (none),
 *   `{ open: [paths] }`, `{ answer: v }` or `{ throws: true }`. A recorded
 *   disk state is written by hand; the files of a case carry a fixed
 *   modification time, so both sides stat the same.
 * - save-image: bytes are hex strings. `net.fetch` answers
 *   `{ status, headers, body }` or rejects `{ reject: { name, message } }`,
 *   and logs `fetch` with the URL; the save dialog answers `pick` and logs
 *   `showSaveDialog` with `<window>` when it has a parent, and the options.
 */
import { createHash } from 'node:crypto'
import { useElectron } from '../electron-fake.ts'
import { fakeDialog, fakeParent } from '../fakes.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'
import type { SaveDiskState as DiskState } from '../../../packages/electron-utils/src/save-conflict.ts'

// loaded after electron-fake.ts has registered its hooks: a static import
// would resolve 'electron' before them
const conflict = await import('../../../packages/electron-utils/src/save-conflict.ts')
const image = await import('../../../packages/electron-utils/src/save-image.ts')

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// save-conflict
// ---------------------------------------------------------------------------

const MTIME = 1_700_000_000_123
const at = (text: string, mtimeMs = MTIME): FileSpec => ({ text, mtimeMs })
const state = (text: string, mtimeMs = MTIME): DiskState => ({
  mtimeMs,
  size: Buffer.byteLength(text),
  hash: sha(text),
})

function probeOf(spec: unknown): ((path: string) => boolean) | null {
  if (spec === null || typeof spec !== 'object') return null
  const o = spec as { open?: string[]; answer?: unknown; throws?: boolean }
  return (path: string) => {
    if (o.throws === true) throw new Error('probe failed')
    if (o.open) return o.open.includes(path)
    return o.answer as boolean
  }
}

const PROBES: unknown[] = [
  null,
  { open: ['$DIR/a.txt'] },
  { open: ['$DIR/other.txt'] },
  { answer: true },
  { answer: 'yes' },
  { answer: 1 },
  { throws: true },
]

/** the same document open in another pane, its disk moved on since the record */
const conflictFiles = { 'a.txt': at('changed', MTIME + 5000) }
const conflictRecord = state('before')

const confirmCases: Case[] = [
  ...PROBES.map((probe): Case => ({
    args: [
      {
        probe,
        parent: null,
        path: '$DIR/a.txt',
        recorded: conflictRecord,
        lang: 'en',
        response: 0,
      },
    ],
    files: conflictFiles,
    note: `probe ${JSON.stringify(probe)}`,
  })),
  ...[0, 1, 2, -1, 0.5].flatMap((response): Case[] =>
    [null, 'live', 'destroyed'].map((parent): Case => ({
      args: [
        {
          probe: { answer: true },
          parent,
          path: '$DIR/a.txt',
          recorded: conflictRecord,
          lang: 'ko',
          response,
        },
      ],
      files: conflictFiles,
      note: `response ${response}, parent ${parent}`,
    })),
  ),
  ...['en', 'ko-KR', 'fr', ''].map((lang): Case => ({
    args: [
      {
        probe: { answer: true },
        parent: 'live',
        path: '$DIR/a.txt',
        recorded: conflictRecord,
        lang,
        response: 1,
      },
    ],
    files: conflictFiles,
    note: `labels in ${lang}`,
  })),
  {
    args: [
      {
        probe: { answer: true },
        parent: null,
        path: '$DIR/a.txt',
        recorded: state('same text'),
        lang: 'en',
        response: 1,
      },
    ],
    files: { 'a.txt': at('same text') },
    note: 'the disk still matches the record: no question',
  },
  {
    args: [
      {
        probe: { answer: true },
        parent: null,
        path: '$DIR/a.txt',
        recorded: null,
        lang: 'en',
        response: 1,
      },
    ],
    files: conflictFiles,
    note: 'no record: no question',
  },
  {
    args: [
      {
        probe: { answer: true },
        parent: null,
        path: '$DIR/gone.txt',
        recorded: conflictRecord,
        lang: 'en',
        response: 1,
      },
    ],
    note: 'the file is gone: no question',
  },
]

const modifiedCases: Case[] = [
  { args: [null, '$DIR/a.txt'], files: { 'a.txt': at('x') }, note: 'no record' },
  { args: [state('x'), '$DIR/missing.txt'], note: 'a missing file' },
  { args: [state('x'), '$DIR/a.txt'], files: { 'a.txt': at('x') }, note: 'unchanged' },
  {
    args: [state('ab'), '$DIR/a.txt'],
    files: { 'a.txt': at('cd') },
    note: 'same mtime and size: the content is not read',
  },
  {
    args: [state('x'), '$DIR/a.txt'],
    files: { 'a.txt': at('x', MTIME + 1) },
    note: 'touched, same content',
  },
  {
    args: [state('x'), '$DIR/a.txt'],
    files: { 'a.txt': at('y', MTIME + 1) },
    note: 'touched, other content',
  },
  {
    args: [state('x'), '$DIR/a.txt'],
    files: { 'a.txt': at('xx') },
    note: 'grown at the same mtime',
  },
  {
    args: [state('x'), '$DIR/d'],
    files: { d: { dir: true, mtimeMs: MTIME } },
    note: 'a folder: stat answers, the read fails',
  },
  {
    args: [{ mtimeMs: MTIME, size: 1.5, hash: sha('x') }, '$DIR/a.txt'],
    files: { 'a.txt': at('x') },
    note: 'a fractional size never equals',
  },
]

const recordCases: Case[] = [
  { args: ['$DIR/a.txt'], files: { 'a.txt': at('hello') } },
  { args: ['$DIR/a.txt'], files: { 'a.txt': at('') }, note: 'empty' },
  { args: ['$DIR/a.txt'], files: { 'a.txt': at('\uc548\ub155', MTIME + 0.5) } },
  { args: ['$DIR/b.bin'], files: { 'b.bin': { hex: '00ff10', mtimeMs: MTIME } } },
  { args: ['$DIR/missing'], note: 'missing' },
  { args: ['$DIR/d'], files: { d: { dir: true } }, note: 'a folder' },
]

const deferCases: Case[] = [
  ...PROBES.map((probe): Case => ({
    args: [probe, '$DIR/a.txt', conflictRecord],
    files: conflictFiles,
    note: `probe ${JSON.stringify(probe)}`,
  })),
  {
    args: [{ answer: true }, '$DIR/a.txt', state('same')],
    files: { 'a.txt': at('same') },
    note: 'unchanged',
  },
]

const saveConflict: Group = {
  'save-conflict.recordDiskState': {
    ts: (a) => conflict.recordDiskState(a[0] as string),
    cases: recordCases,
  },
  'save-conflict.isModifiedSince': {
    ts: (a) =>
      conflict.isModifiedSince((a[0] ?? undefined) as DiskState | undefined, a[1] as string),
    cases: modifiedCases,
  },
  'save-conflict.isPathOpenElsewhere': {
    ts: (a) => {
      conflict.setOpenPathProbe(probeOf(a[0]))
      return conflict.isPathOpenElsewhere(a[1] as string)
    },
    cases: [
      ...PROBES.map((probe) => ({ args: [probe, '$DIR/a.txt'] })),
      { args: [{ open: ['$DIR/a.txt'] }, '$DIR/A.txt'], note: 'the case of the path counts' },
    ],
  },
  'save-conflict.confirmOverwriteIfConflicted': {
    ts: (a, cx) => {
      const o = a[0] as {
        probe: unknown
        parent: unknown
        path: string
        recorded: DiskState | null
        lang: string
        response: unknown
      }
      conflict.setOpenPathProbe(probeOf(o.probe))
      useElectron({ dialog: fakeDialog(o.response, cx.log) })
      return conflict.confirmOverwriteIfConflicted({
        parent: fakeParent(o.parent) as never,
        path: o.path,
        recorded: o.recorded ?? undefined,
        lang: o.lang,
      })
    },
    cases: confirmCases,
  },
  'save-conflict.shouldDeferAutoSave': {
    ts: (a) => {
      conflict.setOpenPathProbe(probeOf(a[0]))
      return conflict.shouldDeferAutoSave(
        a[1] as string,
        (a[2] ?? undefined) as DiskState | undefined,
      )
    },
    cases: deferCases,
  },
}

// ---------------------------------------------------------------------------
// save-image
// ---------------------------------------------------------------------------

const URLS = [
  'https://example.com/a.png',
  'http://example.com/a.png',
  'HTTPS://EXAMPLE.COM/A.PNG',
  'file:///etc/passwd',
  'FILE:///x.png',
  'blob:https://example.com/123',
  'javascript:alert(1)',
  'about:blank',
  'data:image/png;base64,AAAA',
  'seuoffice-asset://doc/img.png',
  'docx-media://1/x.jpeg',
  '/relative/a.png',
  'a.png',
  '',
  '1http://x',
  'h+t.t-p://x',
  ' https://x/a.png',
  'filex:/a.png',
  'files:/a.png',
  'aboutx:/a',
]

const decodeCases: Case[] = cases(
  ['data:image/png;base64,iVBORw0KGgo='],
  ['data:image/png;BASE64,iVBORw0KGgo='],
  ['DATA:image/svg+xml,%3Csvg%3E%3C/svg%3E'],
  ['data:image/svg+xml;charset=utf-8,<svg>\u00e9</svg>'],
  ['data:,hello'],
  ['data:;base64,aGk='],
  ['data:text/plain;base64;charset=x,aGk='],
  ['data:text/plain;charset=x;base64,aGk='],
  ['data:image/svg+xml,100%'],
  ['data:image/svg+xml,%E0%A4%A'],
  ['data:image/png;base64'],
  ['data:image/png;base64,a=b=c'],
  ['data:image/png;base64,!!!'],
  ['data:a;b;c;d;e;f;g;h'],
  ['data:image/png;base64x,aGk='],
  ['data:image/png;base64,\n aGk=\n'],
  ['data:x,a,b,c'],
  ['data:x;y=1,%F0%9F%98%80'],
  ['http://x/a.png'],
  [`data:image/png;base64,${'A'.repeat(1000)}`],
)

const suggestCases: Case[] = cases(
  ['https://example.com/photo.png', 'image/jpeg'],
  ['https://example.com/photo.JPEG', null],
  ['https://example.com/dir/photo.tif', null],
  ['https://example.com/dir/photo.tiff?x=1', null],
  ['https://example.com/dir/', 'image/webp'],
  ['https://example.com/dir/photo', 'image/gif; charset=x'],
  ['https://example.com/dir/photo', ' IMAGE/SVG+XML '],
  ['https://example.com/dir/photo', 'image/heic'],
  ['https://example.com/dir/photo', null],
  ['https://example.com/dir/photo', ''],
  ['https://example.com/dir/photo', 'constructor'],
  ['https://example.com/dir/photo', '__proto__'],
  ['https://example.com/dir/photo', 'toString'],
  ['https://example.com/dir/photo', 'hasownproperty'],
  ['https://example.com/a%20b.png', null],
  ['https://example.com/%E0%A4%A.png', 'image/png'],
  ['https://example.com/%EC%82%AC%EC%A7%84.gif', null],
  ['https://example.com/a%2Fb.png', null],
  ['data:image/png;base64,AAAA', 'image/png'],
  ['not a url', 'image/avif'],
  ['seuoffice-asset://doc/x/y.bmp', null],
  ['https://example.com/a.png.txt', 'image/bmp'],
  ['https://example.com/.png', null],
  ['https://example.com/a.webp#frag', null],
)

const PNG = '89504e470d0a1a0a'

interface ImageSpec {
  parent: unknown
  url: string
  title: string
  fallbackDir?: string
  fetch:
    | { status?: number; headers?: Record<string, string>; body?: string }
    | { reject: { name: string; message: string } }
    | null
  pick: unknown
}

function imageCase(o: Partial<ImageSpec>, note: string): Case {
  return {
    args: [
      {
        parent: null,
        url: 'https://example.com/photo.png',
        title: 'Save Image',
        fetch: { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
        pick: { canceled: false, filePath: '$DIR/out.png' },
        ...o,
      },
    ],
    note,
  }
}

const saveImageCases: Case[] = [
  imageCase({}, 'a fetched picture saved'),
  imageCase({ parent: 'live' }, 'over a window'),
  imageCase({ url: 'file:///etc/hosts' }, 'a file URL is refused'),
  imageCase({ url: 'javascript:1' }, 'a script URL is refused'),
  imageCase(
    { url: `data:image/png;base64,${Buffer.from(PNG, 'hex').toString('base64')}` },
    'a data URL is decoded',
  ),
  imageCase({ url: 'data:image/svg+xml,100%' }, 'a malformed data URL'),
  imageCase(
    {
      url: 'https://example.com/x',
      fetch: { status: 200, headers: { 'content-type': 'image/webp' }, body: PNG },
    },
    'the name from the type',
  ),
  imageCase({ fetch: { status: 404, body: '' } }, 'not found'),
  imageCase({ fetch: { status: 500, body: '00' } }, 'a server error'),
  imageCase(
    { fetch: { reject: { name: 'TypeError', message: 'fetch failed' } } },
    'the request fails',
  ),
  imageCase(
    { fetch: { status: 200, headers: { 'content-length': '99999999999' }, body: PNG } },
    'too large by its header',
  ),
  imageCase({ pick: { canceled: true, filePath: '' } }, 'canceled'),
  imageCase({ pick: { canceled: false, filePath: '' } }, 'no path picked'),
  imageCase({ pick: { canceled: false } }, 'no path at all'),
  imageCase(
    { pick: { canceled: false, filePath: '$DIR/missing/out.png' } },
    'the folder is missing',
  ),
  imageCase({ fallbackDir: '$DIR/fallback' }, 'a fallback folder anchors the name'),
  imageCase({ title: 'Bild speichern \u{1F600}' }, 'the title as given'),
  imageCase({ url: 'https://example.com/%EC%82%AC%EC%A7%84.jpeg' }, 'a decoded name'),
]

function imageFakes(o: ImageSpec, cx: TsContext): void {
  const pick = o.pick
  const record = (name: string, args: unknown[]): void => {
    const [first, second] = args
    if (args.length === 2) cx.log(name, '<window>', second)
    else cx.log(name, first)
  }
  useElectron({
    net: {
      fetch: async (url: string) => {
        cx.log('fetch', url)
        const f = o.fetch
        if (f && 'reject' in f) {
          const error =
            f.reject.name === 'TypeError'
              ? new TypeError(f.reject.message)
              : new Error(f.reject.message)
          throw error
        }
        return new Response(Buffer.from(f?.body ?? '', 'hex'), {
          status: f?.status ?? 200,
          headers: f?.headers ?? {},
        })
      },
    },
    dialog: {
      showSaveDialog: async (...args: unknown[]) => {
        record('showSaveDialog', args)
        return pick
      },
      showOpenDialog: async (...args: unknown[]) => {
        record('showOpenDialog', args)
        return pick
      },
    },
  })
}

const saveImage: Group = {
  'save-image.isSavableImageUrl': {
    ts: (a) => image.isSavableImageUrl(a[0] as string),
    cases: cases(...URLS.map((url) => [url])),
  },
  'save-image.suggestImageFileName': {
    ts: (a) => image.suggestImageFileName(a[0] as string, a[1] as string | null),
    cases: suggestCases,
  },
  'save-image.decodeDataUrl': {
    ts: (a) => {
      const decoded = image.decodeDataUrl(a[0] as string)
      return decoded && { bytes: decoded.bytes.toString('hex'), mime: decoded.mime }
    },
    cases: decodeCases,
  },
  'save-image.saveImageFromUrl': {
    ts: (a, cx) => {
      const o = a[0] as ImageSpec
      imageFakes(o, cx)
      return image.saveImageFromUrl(fakeParent(o.parent) as never, o.url, {
        title: o.title,
        ...(o.fallbackDir === undefined ? {} : { fallbackDir: o.fallbackDir }),
      })
    },
    cases: saveImageCases,
  },
}

export const group: Group = { ...saveConflict, ...saveImage }
