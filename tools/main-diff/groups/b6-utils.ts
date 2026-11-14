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
 * - context-menu: `installContextMenu` runs as a scenario over a fake app and
 *   windows: each event is a right-click on a window, the native menu's
 *   template is logged, and the listed entries are clicked. The Rust plays
 *   the adapter: it carries out the commands it decides on the same fakes.
 * - app-menu: the templates are compared as JSON (the clicks are functions,
 *   which JSON leaves out); an app's own entry is `{ label }`. `app-menu.click`
 *   clicks the menus' own entries in a scenario over fake windows, a fake
 *   `webContents` registry, the About box and the shell's two invokers.
 * - renderer-protocol: the handler the scheme installs answers each request
 *   URL, logged as `fetch` with the file URL or `404`.
 */
import { createHash } from 'node:crypto'
import { setUiLang } from '@seuoffice/i18n'
import type { MenuItemConstructorOptions as Item } from 'electron'
import { useElectron } from '../electron-fake.ts'
import { fakeDialog, fakeParent } from '../fakes.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'
import type { SaveDiskState as DiskState } from '../../../packages/electron-utils/src/save-conflict.ts'

// loaded after electron-fake.ts has registered its hooks: a static import
// would resolve 'electron' before them
const conflict = await import('../../../packages/electron-utils/src/save-conflict.ts')
const image = await import('../../../packages/electron-utils/src/save-image.ts')
const menu = await import('../../../packages/electron-utils/src/context-menu.ts')
const rendererProtocol = await import('../../../packages/electron-utils/src/renderer-protocol.ts')
const appMenu = await import('../../../packages/electron-utils/src/app-menu.ts')

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// save-conflict
// ---------------------------------------------------------------------------

/** whole seconds: a file's time set from it reads back exactly, so equal times are equal */
const MTIME = 1_700_000_000_000
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
  ['https://example.com/dir/photo', 'image/jpeg'],
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

/** the `net` and `dialog` of a save-image spec */
function imageElectron(o: ImageSpec, cx: TsContext): Record<string, unknown> {
  const pick = o.pick
  const record = (name: string, args: unknown[]): void => {
    const [first, second] = args
    if (args.length === 2) cx.log(name, '<window>', second)
    else cx.log(name, first)
  }
  return {
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
  }
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
      useElectron(imageElectron(o, cx))
      return image.saveImageFromUrl(fakeParent(o.parent) as never, o.url, {
        title: o.title,
        ...(o.fallbackDir === undefined ? {} : { fallbackDir: o.fallbackDir }),
      })
    },
    cases: saveImageCases,
  },
}

// ---------------------------------------------------------------------------
// context-menu
// ---------------------------------------------------------------------------

const FLAGS_ALL = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const FLAGS_SOME = { canCut: false, canCopy: true, canPaste: false, canSelectAll: true }

interface Params {
  isEditable: boolean
  selectionText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: typeof FLAGS_ALL
  mediaType?: string
  srcURL?: string
  x?: number
  y?: number
}

const params = (o: Partial<Params>): Params => ({
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: FLAGS_ALL,
  ...o,
})

const PARAMS: Params[] = [
  params({}),
  params({ selectionText: 'hello' }),
  params({ selectionText: ' \t\n' }),
  params({ selectionText: '\ufeff' }),
  params({ selectionText: '\u0085' }),
  params({ selectionText: 'x', editFlags: FLAGS_SOME }),
  params({ isEditable: true }),
  params({ isEditable: true, editFlags: FLAGS_SOME }),
  params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'] }),
  params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: [] }),
  params({ isEditable: true, misspelledWord: '', dictionarySuggestions: ['the'] }),
  params({ mediaType: 'image', srcURL: 'https://example.com/a.png' }),
  params({ mediaType: 'image', srcURL: '' }),
  params({ mediaType: 'image' }),
  params({ mediaType: 'video', srcURL: 'https://example.com/a.mp4' }),
  params({ mediaType: 'image', srcURL: 'https://example.com/a.png', selectionText: 'cap' }),
  params({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA', isEditable: true }),
]

const LANGS = ['en', 'ko', 'ko-KR', 'en-US', 'fr', 'fr-CA', '', '-', 'ko-', 'KO', 'constructor']

/** a window's interceptor: claims the right-click ("own"), passes ("native") or throws */
function interceptorOf(how: string, cx: TsContext) {
  return async (contents: { id: number }): Promise<boolean> => {
    cx.log('intercept', contents.id)
    if (how === 'throws') throw new Error('interceptor failed')
    return how === 'own'
  }
}

interface MenuEvent {
  contents: number
  params: Params
  clicks?: number[]
}

interface MenuScenario {
  lang: string
  interceptors?: Record<string, string>
  events: MenuEvent[]
  image?: Partial<ImageSpec>
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function runMenuScenario(o: MenuScenario, cx: TsContext): Promise<void> {
  type Listener = (...args: unknown[]) => unknown
  const appListeners: Record<string, Listener> = {}
  const app = {
    on(event: string, listener: Listener) {
      cx.log('on', event)
      appListeners[event] = listener
    },
  }
  let template: { click?: () => unknown }[]
  const imageFakes = imageElectron(
    {
      parent: 'live',
      url: '',
      title: '',
      fetch: { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
      pick: { canceled: false, filePath: '$DIR/out.png' },
      ...o.image,
    } as ImageSpec,
    cx,
  )
  useElectron({
    ...imageFakes,
    Menu: {
      buildFromTemplate(given: { click?: () => unknown }[]) {
        template = given
        cx.log('buildFromTemplate', JSON.parse(JSON.stringify(given)))
        return { popup: () => cx.log('popup') }
      },
    },
    BrowserWindow: {
      fromWebContents(contents: { id: number }) {
        cx.log('fromWebContents', contents.id)
        return { isDestroyed: () => false }
      },
    },
  })
  menu.installContextMenu(app as never, () => menu.contextMenuLabels(o.lang))
  for (const [id, how] of Object.entries(o.interceptors ?? {})) {
    menu.setContextMenuInterceptor(
      app as never,
      { id: Number(id) } as never,
      interceptorOf(how, cx) as never,
    )
  }
  for (const event of o.events) {
    const listeners: Record<string, Listener> = {}
    const contents = {
      id: event.contents,
      on: (name: string, listener: Listener) => {
        listeners[name] = listener
      },
      replaceMisspelling: (word: string) => cx.log('replaceMisspelling', word),
      send: (channel: string, ...rest: unknown[]) => cx.log('send', channel, ...rest),
      copyImageAt: (x: number, y: number) => cx.log('copyImageAt', x, y),
      cut: () => cx.log('cut'),
      copy: () => cx.log('copy'),
      paste: () => cx.log('paste'),
      selectAll: () => cx.log('selectAll'),
    }
    template = []
    appListeners['web-contents-created']?.({}, contents)
    await listeners['context-menu']?.({}, event.params)
    await settle()
    for (const i of event.clicks ?? []) await template[i]?.click?.()
  }
}

const IMAGE_PARAMS = params({
  mediaType: 'image',
  srcURL: 'https://example.com/photo.png',
  x: 12,
  y: 34.5,
  isEditable: true,
  misspelledWord: 'teh',
  dictionarySuggestions: ['the'],
})

const menuScenarios: Case[] = [
  {
    args: [
      {
        lang: 'en',
        events: [{ contents: 1, params: IMAGE_PARAMS, clicks: [0, 1, 2, 3, 5, 6, 7, 9] }],
      },
    ],
    note: 'every entry of an editable image clicked',
  },
  {
    args: [{ lang: 'ko', events: [{ contents: 1, params: IMAGE_PARAMS, clicks: [4, 8] }] }],
    note: 'separators do nothing',
  },
  {
    args: [{ lang: 'en', events: [{ contents: 2, params: params({}) }] }],
    note: 'nothing to offer: no menu',
  },
  {
    args: [
      {
        lang: 'en',
        interceptors: { '1': 'own', '2': 'native', '3': 'throws' },
        events: [1, 2, 3, 4].map((contents) => ({
          contents,
          params: params({ selectionText: 'x' }),
          clicks: [0],
        })),
      },
    ],
    note: 'an interceptor that claims, passes, throws, and none',
  },
  {
    args: [
      {
        lang: 'fr',
        events: [
          {
            contents: 1,
            params: params({ mediaType: 'image', srcURL: 'data:image/png;base64,iVBORw0KGgo=' }),
            clicks: [2],
          },
        ],
      },
    ],
    note: 'saving a data URL picture',
  },
  {
    args: [
      {
        lang: 'ko',
        events: [{ contents: 1, params: IMAGE_PARAMS, clicks: [2] }],
        image: { pick: { canceled: true, filePath: '' } },
      },
    ],
    note: 'saving, canceled',
  },
  {
    args: [
      {
        lang: 'en',
        events: [{ contents: 1, params: IMAGE_PARAMS, clicks: [2] }],
        image: { fetch: { reject: { name: 'TypeError', message: 'fetch failed' } } },
      },
    ],
    note: 'saving, the download fails',
  },
  {
    args: [
      {
        lang: 'en',
        events: [
          {
            contents: 7,
            params: params({ mediaType: 'image', srcURL: 'https://example.com/a.png' }),
            clicks: [0, 0],
          },
        ],
      },
    ],
    note: 'view image twice',
  },
]

const contextMenu: Group = {
  'context-menu.VIEW_IMAGE_CHANNEL': {
    ts: () => menu.VIEW_IMAGE_CHANNEL,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'context-menu.baseLang': {
    ts: (a) => menu.baseLang(a[0] as string),
    cases: cases(...LANGS.map((lang) => [lang]), ['a-b-c']),
  },
  'context-menu.contextMenuLabels': {
    ts: (a) => menu.contextMenuLabels(a[0] as string),
    cases: cases(...LANGS.map((lang) => [lang])),
  },
  'context-menu.buildContextMenuItems': {
    ts: (a) => menu.buildContextMenuItems(a[0] as never, menu.contextMenuLabels(a[1] as string)),
    cases: [
      ...PARAMS.map((p): Case => ({ args: [p, 'en'] })),
      ...PARAMS.map((p): Case => ({ args: [p, 'ko'] })),
    ],
  },
  'context-menu.installContextMenu': {
    ts: (a, cx) => runMenuScenario(a[0] as MenuScenario, cx),
    cases: menuScenarios,
  },
}

// ---------------------------------------------------------------------------
// renderer-protocol
// ---------------------------------------------------------------------------

const rendererProtocolGroup: Group = {
  'renderer-protocol.registerRendererScheme': {
    ts: () => {
      let given: unknown
      useElectron({ protocol: { registerSchemesAsPrivileged: (list: unknown) => (given = list) } })
      rendererProtocol.registerRendererScheme()
      return given
    },
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'renderer-protocol.installRendererProtocol': {
    ts: async (a, cx) => {
      let handler: ((request: { url: string }) => Promise<Response> | Response) | undefined
      useElectron({
        protocol: {
          handle: (_scheme: string, given: typeof handler) => {
            handler = given
          },
        },
        net: {
          fetch: async (url: string) => {
            cx.log('fetch', url)
            return new Response('ok')
          },
        },
      })
      rendererProtocol.installRendererProtocol(a[0] as Record<string, string>)
      for (const url of a[1] as string[]) {
        const res = await handler!({ url })
        if (res.status === 404) cx.log('404')
      }
    },
    cases: [
      {
        args: [
          { docs: '$DIR/docs', sheets: '$DIR/sheets/', '1': '$DIR/one' },
          [
            'genoffice-app://docs/index.html',
            'genoffice-app://sheets/assets/a%20b.js',
            'genoffice-app://docs/',
            'genoffice-app://docs/../secret',
            'genoffice-app://docs/%2e%2e/secret',
            'genoffice-app://docs/a%5c..%5c..%5cx',
            'genoffice-app://unknown/index.html',
            'genoffice-app://1/x.js',
            'genoffice-app://docs/%E0%A4%A',
            'genoffice-app://docs/a%00b',
            'genoffice-app://DOCS/index.html',
            'not a url',
            'genoffice-app://docs/\uc0ac\uc9c4.png',
          ],
        ],
      },
      { args: [{}, ['genoffice-app://docs/index.html']], note: 'no roots' },
      { args: [{ docs: '' }, ['genoffice-app://docs/index.html']], note: 'an empty root' },
    ],
  },
}

// ---------------------------------------------------------------------------
// app-menu
// ---------------------------------------------------------------------------

const json = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const appItems = (items: unknown): Item[] =>
  ((items as { label: string }[] | undefined) ?? []).map((item) => ({
    label: item.label,
    click: () => {},
  }))
const PLATFORMS = ['darwin', 'win32', 'linux']
const MENU_LANGS = ['en', 'ko', 'ko-KR', 'fr', '', 'constructor']
const labelsOf = (lang: unknown) => appMenu.appMenuLabels(lang as string)

interface DevContents {
  id: number
  devTools: number | null
  opened: boolean
  destroyed?: boolean
}

interface ClickStep {
  click?: 'minimize' | 'close' | 'devTools' | 'about' | 'checkUpdates' | 'settings'
  window?: boolean
  focused?: number | null
  destroy?: number
  response?: unknown
  fallback?: string
}

interface ClickScenario {
  lang: string
  uiLang?: string
  version?: string
  canCheck?: boolean
  settings?: boolean
  contents?: DevContents[]
  steps: ClickStep[]
}

async function runClicks(o: ClickScenario, cx: TsContext): Promise<void> {
  const labels = appMenu.appMenuLabels(o.lang)
  appMenu.setUpdateCheckInvoker(o.canCheck ? () => cx.log('checkUpdates') : null)
  appMenu.setSettingsInvoker(o.settings ? () => cx.log('settings') : null)
  setUiLang((o.uiLang ?? 'en') as never)
  const states = (o.contents ?? []).map((c) => ({ ...c }))
  const objects = new Map<number, unknown>()
  const objectOf = (id: number | null | undefined): unknown =>
    id === null || id === undefined ? null : objects.get(id)
  for (const state of states) {
    objects.set(state.id, {
      isDestroyed: () => state.destroyed === true,
      get devToolsWebContents() {
        return objectOf(state.devTools)
      },
      isDevToolsOpened: () => state.opened,
      closeDevTools: () => {
        cx.log('closeDevTools', state.id)
        state.opened = false
      },
      openDevTools: (options: unknown) => {
        cx.log('openDevTools', state.id, options)
        state.opened = true
      },
    })
  }
  let focused: number | null = null
  const windowMenu = appMenu.windowMenuTemplate('linux', labels).submenu as Item[]
  try {
    for (const step of o.steps) {
      if (step.destroy !== undefined) {
        const state = states.find((c) => c.id === step.destroy)
        if (state) state.destroyed = true
        continue
      }
      useElectron({
        webContents: { getFocusedWebContents: () => objectOf(focused) },
        app: { getVersion: () => o.version ?? '' },
        dialog: fakeDialog(step.response, cx.log),
        clipboard: { writeText: (text: string) => cx.log('writeText', text) },
      })
      const win = step.window
        ? { minimize: () => cx.log('minimize'), close: () => cx.log('close') }
        : undefined
      const item: Item | undefined =
        step.click === 'minimize'
          ? windowMenu[0]
          : step.click === 'close'
            ? windowMenu[2]
            : step.click === 'devTools'
              ? appMenu.toggleDevToolsItem(labels)
              : step.click === 'about'
                ? appMenu.aboutMenuItem(labels)
                : step.click === 'checkUpdates'
                  ? appMenu.checkUpdatesMenuItem(labels)
                  : step.click === 'settings'
                    ? appMenu.settingsMenuItem(
                        labels,
                        step.fallback === undefined
                          ? undefined
                          : () => cx.log('fallback', step.fallback),
                      )
                    : undefined
      if (step.click === 'devTools') focused = step.focused ?? null
      await (item?.click as ((...args: unknown[]) => unknown) | undefined)?.({}, win, {})
    }
  } finally {
    // the Developer Tools entry remembers its last window in the module: a
    // destroyed one is forgotten by the next case
    for (const state of states) state.destroyed = true
  }
}

const DEV_CONTENTS: DevContents[] = [
  { id: 1, devTools: 11, opened: false },
  { id: 2, devTools: 12, opened: false },
  { id: 11, devTools: null, opened: false },
  { id: 12, devTools: null, opened: false },
]

const clickCases: Case[] = [
  {
    args: [
      {
        lang: 'en',
        steps: [
          { click: 'minimize', window: true },
          { click: 'close', window: true },
          { click: 'minimize' },
          { click: 'close' },
        ],
      },
    ],
    note: 'the window entries, with and without a window',
  },
  {
    args: [
      {
        lang: 'en',
        contents: DEV_CONTENTS,
        steps: [
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 11 },
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: null },
          { click: 'devTools', focused: 2 },
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 12 },
        ],
      },
    ],
    note: 'open, close from its own DevTools window, open again, nothing focused',
  },
  {
    args: [
      {
        lang: 'ko',
        contents: DEV_CONTENTS,
        steps: [
          { click: 'devTools', focused: null },
          { click: 'devTools', focused: 1 },
          { destroy: 1 },
          { click: 'devTools', focused: null },
          { click: 'devTools', focused: 11 },
        ],
      },
    ],
    note: 'the remembered window is destroyed',
  },
  {
    args: [
      {
        lang: 'en',
        contents: [
          { id: 1, devTools: 11, opened: true },
          { id: 11, devTools: null, opened: false },
        ],
        steps: [
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 11 },
        ],
      },
    ],
    note: 'already open when first clicked',
  },
  ...[0, 1, 2, 3, 'x'].flatMap((response): Case[] =>
    [true, false].map((canCheck): Case => ({
      args: [
        {
          lang: 'en',
          uiLang: 'en',
          version: '0.12.40',
          canCheck,
          steps: [{ click: 'about', response }],
        },
      ],
      note: `about: response ${response}, update check ${canCheck}`,
    })),
  ),
  ...['ko', 'ko-KR', 'fr', 'zz'].map((uiLang): Case => ({
    args: [
      {
        lang: 'ko',
        uiLang,
        version: '1.0.0-beta.2',
        canCheck: true,
        steps: [{ click: 'about', response: 1 }],
      },
    ],
    note: `about in ${uiLang}`,
  })),
  {
    args: [
      {
        lang: 'en',
        canCheck: true,
        settings: true,
        steps: [
          { click: 'checkUpdates' },
          { click: 'settings' },
          { click: 'settings', fallback: 'prefs' },
        ],
      },
    ],
    note: 'the shell registered both',
  },
  {
    args: [
      {
        lang: 'en',
        steps: [
          { click: 'checkUpdates' },
          { click: 'settings' },
          { click: 'settings', fallback: 'prefs' },
        ],
      },
    ],
    note: 'an app on its own',
  },
  {
    args: [
      {
        lang: 'en',
        contents: DEV_CONTENTS,
        steps: [
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 1 },
          { click: 'devTools', focused: 11 },
        ],
      },
    ],
    note: 'closed from its own window, then the DevTools window has the focus',
  },
]

const appMenuGroup: Group = {
  'app-menu.appMenuLabels': {
    ts: (a) => labelsOf(a[0]),
    cases: cases(...MENU_LANGS.map((lang) => [lang]), ['en-GB']),
  },
  'app-menu.windowMenuTemplate': {
    ts: (a) => json(appMenu.windowMenuTemplate(a[0] as NodeJS.Platform, labelsOf(a[1]))),
    cases: cases(
      ...PLATFORMS.flatMap((p) => [
        [p, 'en'],
        [p, 'ko'],
      ]),
    ),
  },
  'app-menu.editMenuTemplate': {
    ts: (a) => json(appMenu.editMenuTemplate(a[0] as NodeJS.Platform, labelsOf(a[1]))),
    cases: cases(
      ...PLATFORMS.flatMap((p) => [
        [p, 'en'],
        [p, 'ko'],
      ]),
    ),
  },
  'app-menu.toggleDevToolsItem': {
    ts: (a) => json(appMenu.toggleDevToolsItem(labelsOf(a[0]))),
    cases: cases(['en'], ['ko']),
  },
  'app-menu.viewMenuTemplate': {
    ts: (a) =>
      json(
        a.length > 1
          ? appMenu.viewMenuTemplate(labelsOf(a[0]), a[1] as never)
          : appMenu.viewMenuTemplate(labelsOf(a[0])),
      ),
    cases: cases(
      ['en'],
      ['ko', {}],
      ['en', { devItems: false }],
      ['en', { pageZoom: false }],
      ['ko', { devItems: false, pageZoom: false }],
      ['en', { devItems: true, pageZoom: true }],
    ),
  },
  'app-menu.helpCheckUpdatesItems': {
    ts: (a) => json(appMenu.helpCheckUpdatesItems(labelsOf(a[0]), a[1] as NodeJS.Platform)),
    cases: cases(...PLATFORMS.map((p) => ['ko', p])),
  },
  'app-menu.appMenuPopupTemplate': {
    ts: (a) => json(appMenu.appMenuPopupTemplate(appItems(a[0]), labelsOf(a[1]))),
    cases: cases([[], 'en'], [[{ label: 'File' }, { label: 'Edit' }], 'ko']),
  },
  'app-menu.settingsMenuItem': {
    ts: (a) => json(appMenu.settingsMenuItem(labelsOf(a[0]), a[1] ? () => {} : undefined)),
    cases: cases(['en'], ['ko', 'prefs']),
  },
  'app-menu.appMenuTemplate': {
    ts: (a) => {
      const o = a[2] as { extra?: unknown; appLabel?: string } | undefined
      return json(
        appMenu.appMenuTemplate(
          a[0] as NodeJS.Platform,
          labelsOf(a[1]),
          o === undefined
            ? undefined
            : {
                ...(o.extra === undefined ? {} : { extra: appItems(o.extra) }),
                ...(o.appLabel === undefined ? {} : { appLabel: o.appLabel }),
              },
        ),
      )
    },
    cases: [
      ...PLATFORMS.map((p): Case => ({ args: [p, 'en'] })),
      { args: ['darwin', 'ko', { extra: [{ label: 'Preferences' }] }] },
      { args: ['darwin', 'en', { appLabel: 'Seu Docs' }] },
      { args: ['darwin', 'en', { appLabel: '' }] },
      { args: ['darwin', 'ko', { extra: [{ label: 'A' }, { label: 'B' }], appLabel: 'X' }] },
    ],
  },
  'app-menu.helpMenuTemplate': {
    ts: (a) =>
      json(appMenu.helpMenuTemplate(labelsOf(a[0]), appItems(a[1]), a[2] as NodeJS.Platform)),
    cases: [
      ...PLATFORMS.map((p): Case => ({ args: ['en', [], p] })),
      ...PLATFORMS.map((p): Case => ({ args: ['ko', [{ label: 'Guide' }], p] })),
    ],
  },
  'app-menu.click': {
    ts: (a, cx) => runClicks(a[0] as ClickScenario, cx),
    cases: clickCases,
  },
}

export const group: Group = {
  ...saveConflict,
  ...saveImage,
  ...contextMenu,
  ...appMenuGroup,
  ...rendererProtocolGroup,
}
