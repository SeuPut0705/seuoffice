/**
 * Group `b6-apps`: the modules of the editor apps that call Electron (batch B6
 * of decision 0030). Electron is the fake of electron-fake.ts; each case
 * installs the objects it describes, and each call of a fake is one log line,
 * as the Rust fakes of calls/b6_apps.rs write it.
 *
 * Modules that hold state in the module (the diagram session, the lazy media
 * sources, the Docs updater, the Slides session state) or import what a plain
 * Node cannot load are loaded as a patched copy (`loadPatched`): the source
 * text with its relative imports made absolute and the named imports pointed
 * at a stub module, written to tools/main-diff/out (ignored by git). A copy
 * per case also gives each case the state of a fresh process, which is what
 * the Rust side has: it keeps no global.
 *
 * - element-clipboard: the clipboard and `nativeImage` are described by one
 *   object (`buffer`, `html`, `png` as hex, and `...Throws` / `empty` flags).
 * - slides/font-store: `./fonts` (opentype.js, asset imports) is a stub whose
 *   `fontFileFamilies` answers from the case.
 * - sheets/template-fonts, html/preview-protocol: `protocol.handle` captures
 *   the handler, which then answers the case's request URLs.
 * - markdown/print-document, markdown/print-pdf: a window script as in b2-print.
 * - docs/updater: a scenario of steps over a fake `electron-updater`, timers and
 *   dialog.
 * - diagram-session: a scenario over a fake session; responses are described
 *   as `{ status, headers, body }`.
 * - docs/lazy-media: a scenario over a fake zip library
 *   (`@seuoffice/docx-engine/zip-splice` is not ported to Rust yet).
 * - pdf/image-edit: PDFium is a fake (batch E); `matchImage`, `imageMatrix`,
 *   `applyImageGeometry` and `decodeImage` are exported by the patched copy.
 * - slides/session-state: a scenario of steps over a session; the pptx engine,
 *   the font registry and the TIFF decoder are stubs.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../electron-fake.ts'
import { fakeDialog, fakeParent } from '../fakes.ts'
import type { Case, Group, TsContext } from '../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const repo = new URL('../../../', import.meta.url)
const scratch = new URL('../out/b6-apps/', import.meta.url)
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
function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

/**
 * The module at `file` (from the repository root) as a copy of its source:
 * `patch` first, then every relative import made absolute so the copy can sit
 * in the scratch folder.
 */
async function loadPatched(file: string, patch: (src: string) => string): Promise<J> {
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

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const hexOf = (text: string): string => Buffer.from(text).toString('hex')

const g = globalThis as J

/** `process[key]` set to `value` while `run` runs */
async function withProcess<T>(key: string, value: unknown, run: () => Promise<T> | T): Promise<T> {
  const had = Object.getOwnPropertyDescriptor(process, key)
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
  try {
    return await run()
  } finally {
    if (had) Object.defineProperty(process, key, had)
    else delete (process as J)[key]
  }
}

const settle = async (): Promise<void> => {
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
}

/** `{ status, headers, body }` of a `Response`, the body as hex or text */
async function describe(res: Response, kind: 'text' | 'hex'): Promise<J> {
  const headers = Object.fromEntries(res.headers)
  if (kind === 'hex') {
    return {
      status: res.status,
      headers,
      body: Buffer.from(await res.arrayBuffer()).toString('hex'),
    }
  }
  return { status: res.status, headers, body: res.body === null ? null : await res.text() }
}

// ---------------------------------------------------------------------------
// slides/element-clipboard
// ---------------------------------------------------------------------------

const clipboardModule = (): Promise<J> =>
  import('../../../apps/slides/src/main/element-clipboard.ts')

/** the clipboard and `nativeImage` of a case (see calls/b6_apps.rs `ClipFake`) */
function useClipboard(spec: J, log: (...args: unknown[]) => void): void {
  useElectron({
    clipboard: {
      readBuffer: (format: string) => {
        log('readBuffer', format)
        if (spec.bufferThrows) throw new Error('readBuffer')
        return Buffer.from(spec.buffer ?? '', 'hex')
      },
      readHTML: () => {
        log('readHTML')
        if (spec.htmlThrows) throw new Error('readHTML')
        return spec.html ?? ''
      },
      write: (data: J) => {
        log('write', { image: data.image.id, html: data.html })
        if (spec.writeThrows) throw new Error('write')
      },
    },
    nativeImage: {
      createFromBuffer: (bytes: Buffer) => {
        log('createFromBuffer', bytes.toString('hex'))
        if (spec.createThrows) throw new Error('createFromBuffer')
        return {
          id: 'img',
          isEmpty: () => {
            log('isEmpty')
            if (spec.emptyThrows) throw new Error('isEmpty')
            return !!spec.empty
          },
          toPNG: () => {
            log('toPNG')
            if (spec.pngThrows) throw new Error('toPNG')
            return Buffer.from(spec.png ?? '', 'hex')
          },
        }
      },
    },
  })
}

const TOKEN_HTML = (token: string, extra = ''): string =>
  `<p>x</p><img src="data:image/png;base64,AAAA" ${extra}data-seuoffice-slides-elements="${encodeURIComponent(token)}">`

const markerCases: Case[] = [
  { args: ['tok', { buffer: hexOf('tok') }], note: 'the buffer matches: the HTML is not read' },
  { args: ['tok', { buffer: hexOf('other'), html: TOKEN_HTML('tok') }], note: 'the HTML matches' },
  { args: ['tok', { buffer: hexOf('other'), html: TOKEN_HTML('nope') }], note: 'neither' },
  {
    args: ['tok', { bufferThrows: true, html: TOKEN_HTML('tok') }],
    note: 'the buffer read throws',
  },
  { args: ['tok', { bufferThrows: true, htmlThrows: true }], note: 'both throw' },
  { args: ['', { buffer: '' }], note: 'an empty token asks nothing' },
  { args: ['a'.repeat(257), { buffer: hexOf('a'.repeat(257)) }], note: 'a token past 256' },
  { args: ['a'.repeat(256), { buffer: hexOf('a'.repeat(256)) }], note: 'a token of 256' },
  {
    args: ['\u{1F600}'.repeat(129), { buffer: hexOf('\u{1F600}'.repeat(129)) }],
    note: '129 astral characters are 258 code units',
  },
  {
    args: ['a b&c/\u00e9', { html: TOKEN_HTML('a b&c/\u00e9') }],
    note: 'the token is URI-encoded in the HTML',
  },
  {
    args: ['tok', { html: `<IMG SRC=x   data-seuoffice-slides-elements  =  "tok"  >` }],
    note: 'case and spaces around the equals sign',
  },
  {
    args: ['tok', { html: `<img data-seuoffice-slides-elementsX="tok">` }],
    note: 'another attribute name',
  },
  {
    args: ['tok', { html: `<img data-seuoffice-slides-elements='tok'>` }],
    note: 'single quotes do not count',
  },
  {
    args: ['tok', { html: `<img alt="x>y" data-seuoffice-slides-elements="tok">` }],
    note: 'the tag stops at the first bracket',
  },
  {
    args: ['tok', { html: `${TOKEN_HTML('first')}${TOKEN_HTML('tok')}` }],
    note: 'the second image carries it',
  },
]

const WRITER = { buffer: hexOf('tok'), png: '89504e47' }

const writeCases: Case[] = [
  { args: ['tok', 'iVBORw0K', WRITER], note: 'written' },
  { args: ['tok', 'QQ==', WRITER], note: 'padding' },
  { args: ['tok', 'QUI=', WRITER], note: 'one padding character' },
  { args: ['tok', 'Zm9v/+8=', WRITER], note: 'the whole alphabet' },
  { args: ['tok', null, WRITER], note: 'not a string' },
  { args: ['tok', 5, WRITER], note: 'a number' },
  { args: ['tok', '', WRITER], note: 'empty' },
  { args: ['tok', 'abc', WRITER], note: 'length not a multiple of 4' },
  { args: ['tok', 'ab!d', WRITER], note: 'a character outside the alphabet' },
  { args: ['tok', '====', WRITER], note: 'only padding' },
  { args: ['tok', 'AA=A', WRITER], note: 'padding in the middle' },
  { args: ['tok', 'AAAA\n', WRITER], note: 'a trailing newline' },
  { args: ['', 'iVBORw0K', WRITER], note: 'an empty token' },
  { args: ['tok', 'iVBORw0K', { ...WRITER, createThrows: true }], note: 'createFromBuffer throws' },
  { args: ['tok', 'iVBORw0K', { ...WRITER, empty: true }], note: 'the decoded image is empty' },
  { args: ['tok', 'iVBORw0K', { ...WRITER, emptyThrows: true }], note: 'isEmpty throws' },
  { args: ['tok', 'iVBORw0K', { ...WRITER, png: '' }], note: 'toPNG is empty' },
  { args: ['tok', 'iVBORw0K', { ...WRITER, pngThrows: true }], note: 'toPNG throws' },
  {
    args: ['tok', 'iVBORw0K', { ...WRITER, buffer: hexOf('someone else') }],
    note: 'the clipboard changed meanwhile',
  },
  { args: ['tok', 'iVBORw0K', { ...WRITER, writeThrows: true }], note: 'write throws' },
  {
    args: ['a b&c/\u00e9', 'iVBORw0K', { png: '89504e47', buffer: hexOf('a b&c/\u00e9') }],
    note: 'a token that needs encoding',
  },
]

const canWriteCases: Case[] = [
  { args: [{ token: 'tok', senderId: 3 }, 3, 'tok', { buffer: hexOf('tok') }], note: 'allowed' },
  {
    args: [{ token: 'tok', senderId: 3 }, 4, 'tok', { buffer: hexOf('tok') }],
    note: 'another sender',
  },
  {
    args: [{ token: 'tok', senderId: 3 }, 3, 'other', { buffer: hexOf('other') }],
    note: 'another token',
  },
  { args: [null, 3, 'tok', { buffer: hexOf('tok') }], note: 'no copy yet' },
  {
    args: [{ token: 'tok', senderId: 3 }, 3, 5, { buffer: hexOf('tok') }],
    note: 'a number as token',
  },
  {
    args: [{ token: 'tok', senderId: 3 }, 3, 'tok', { buffer: hexOf('x') }],
    note: 'the clipboard moved on',
  },
  {
    args: [{ token: 'tok', senderId: 3 }, 3, 'tok', { buffer: '', html: TOKEN_HTML('tok') }],
    note: 'the HTML marker',
  },
  { args: [{ token: '', senderId: 3 }, 3, '', { buffer: '' }], note: 'an empty token' },
]

const elementClipboard: Group = {
  'element-clipboard.ELEMENT_CLIPBOARD_FORMAT': {
    ts: async () => (await clipboardModule()).ELEMENT_CLIPBOARD_FORMAT,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'element-clipboard.isElementClipboardToken': {
    ts: async (a) => (await clipboardModule()).isElementClipboardToken(a[0]),
    cases: [
      { args: [] },
      ...cases(
        [null],
        [''],
        ['a'],
        ['a'.repeat(256)],
        ['a'.repeat(257)],
        [5],
        [{}],
        [['a']],
        [true],
        ['\u{1F600}'.repeat(128)],
        ['\u{1F600}'.repeat(129)],
      ),
    ],
  },
  'element-clipboard.elementClipboardMarkerMatches': {
    ts: async (a, cx) => {
      const mod = await clipboardModule()
      useClipboard(a[1] ?? {}, cx.log)
      return mod.elementClipboardMarkerMatches(a[0])
    },
    cases: markerCases,
  },
  'element-clipboard.canWriteElementClipboardImage': {
    ts: async (a, cx) => {
      const mod = await clipboardModule()
      useClipboard(a[3] ?? {}, cx.log)
      return mod.canWriteElementClipboardImage(a[0] ?? null, a[1], a[2])
    },
    cases: canWriteCases,
  },
  'element-clipboard.writeElementClipboardImage': {
    ts: async (a, cx) => {
      const mod = await clipboardModule()
      useClipboard(a[2] ?? {}, cx.log)
      return mod.writeElementClipboardImage(a[0], a[1])
    },
    cases: writeCases,
  },
}

// ---------------------------------------------------------------------------
// slides/font-store
// ---------------------------------------------------------------------------

async function fontStoreModule(): Promise<J> {
  return loadPatched('apps/slides/src/main/font-store.ts', (src) =>
    must(
      src,
      "import { fontFileFamilies, setUserFontDir } from './fonts'",
      [
        'const fontFileFamilies = (path: string): string[] => (globalThis as any).__b6Fonts.fontFileFamilies(path)',
        'const setUserFontDir = (dir: string): void => (globalThis as any).__b6Fonts.setUserFontDir(dir)',
      ].join('\n'),
      'font-store.ts',
    ),
  )
}

function useUserData(userData: string, log: (...args: unknown[]) => void): void {
  useElectron({
    app: {
      getPath: (name: string) => {
        log('getPath', name)
        return userData
      },
    },
  })
}

const sfnt = (magic: string): { hex: string } => ({ hex: magic + '00010203' })
const TTF = sfnt('00010000')
const OTF = sfnt('4f54544f')
const TTC = sfnt('74746366')

const fontStore: Group = {
  'slides/font-store.fontStoreDir': {
    ts: async (a, cx) => {
      const mod = await fontStoreModule()
      useUserData(a[0] as string, cx.log)
      return mod.fontStoreDir()
    },
    cases: cases(['/home/u/.config/SeuOffice'], [''], ['/ud/'], ['/a/../b'], ['relative/ud']),
  },
  'slides/font-store.initFontStore': {
    ts: async (a, cx) => {
      const mod = await fontStoreModule()
      useUserData(a[0] as string, cx.log)
      g.__b6Fonts = { setUserFontDir: (dir: string) => cx.log('setUserFontDir', dir) }
      mod.initFontStore()
      return undefined
    },
    cases: cases(['/home/u/.config/SeuOffice'], [''], ['/a/../b']),
  },
  'slides/font-store.installLocalFontFiles': {
    ts: async (a, cx) => {
      const mod = await fontStoreModule()
      useUserData(a[0] as string, cx.log)
      const table = new Map<string, string[]>(a[1] as [string, string[]][])
      g.__b6Fonts = {
        fontFileFamilies: (path: string) => {
          cx.log('fontFileFamilies', path)
          return table.get(path) ?? []
        },
      }
      return mod.installLocalFontFiles(a[2] as string[])
    },
    cases: [
      {
        args: ['$DIR/ud', [['$DIR/in/Foo.ttf', ['Foo Sans', 'Foo']]], ['$DIR/in/Foo.ttf']],
        files: { 'in/Foo.ttf': TTF },
        note: 'one font installed under its family name',
      },
      {
        args: [
          '$DIR/ud',
          [
            ['$DIR/in/a-BoldItalic.otf', ['Fam']],
            ['$DIR/in/b-bold.ttc', ['Fam']],
            ['$DIR/in/c-Oblique.OTC', ['Fam']],
            ['$DIR/in/d-italic.ttf', ['Fam', 'Other']],
            ['$DIR/in/e plain.TTF', ['Fam']],
            ['$DIR/in/notfont.ttf', ['Never']],
            ['$DIR/in/empty-name.ttf', []],
          ],
          [
            '$DIR/in/a-BoldItalic.otf',
            '$DIR/in/b-bold.ttc',
            '$DIR/in/c-Oblique.OTC',
            '$DIR/in/d-italic.ttf',
            '$DIR/in/e plain.TTF',
            '$DIR/in/notfont.ttf',
            '$DIR/in/empty-name.ttf',
            '$DIR/in/missing.ttf',
          ],
        ],
        files: {
          'in/a-BoldItalic.otf': OTF,
          'in/b-bold.ttc': TTC,
          'in/c-Oblique.OTC': TTC,
          'in/d-italic.ttf': TTF,
          'in/e plain.TTF': TTF,
          'in/notfont.ttf': { text: 'not a font at all' },
          'in/empty-name.ttf': TTF,
        },
        note: 'style suffixes, extensions, a file that is no font, no family, a missing file',
      },
      { args: ['$DIR/ud', [], []], note: 'nothing to install still makes the folder' },
      {
        args: [
          '$DIR/ud',
          [
            ['$DIR/in/A.ttf', ['One']],
            ['$DIR/in/B.ttf', ['One', 'Two']],
          ],
          ['$DIR/in/A.ttf', '$DIR/in/B.ttf'],
        ],
        files: { 'in/A.ttf': TTF, 'in/B.ttf': TTF },
        note: 'a family reported once',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// sheets/template-fonts
// ---------------------------------------------------------------------------

const templateFontsModule = (): Promise<J> =>
  import('../../../apps/sheets/src/main/template-fonts.ts')

const FONT_URL = (file: string): string => `seuoffice-docx-media://template-fonts/${file}`

interface FontsSpec {
  packaged: boolean
  appPath: string
  resourcesPath: string
  requests?: string[]
}

const fontsApp = (spec: FontsSpec, log: (...args: unknown[]) => void): void =>
  useElectron({
    app: {
      isPackaged: spec.packaged,
      getAppPath: () => {
        log('getAppPath')
        return spec.appPath
      },
    },
  })

const FONT_FILES: Record<string, { hex: string }> = {
  'res/template-fonts/Pretendard-Regular.otf': { hex: '4f54544f00010203' },
  'res/template-fonts/BlackHanSans-Regular.ttf': { hex: '0001000000aa' },
  'res/template-fonts/PlayfairDisplay[wght].ttf': { hex: '00010000ff' },
}

const sheetsFonts: Group = {
  'sheets/template-fonts.sheetsTemplateFontsDir': {
    ts: async (a, cx) => {
      const spec = a[0] as FontsSpec
      const mod = await templateFontsModule()
      fontsApp(spec, cx.log)
      return withProcess('resourcesPath', spec.resourcesPath, () => mod.sheetsTemplateFontsDir())
    },
    cases: [
      { args: [{ packaged: true, appPath: '/app/x', resourcesPath: '/res' }], note: 'installed' },
      {
        args: [{ packaged: false, appPath: '/repo/apps/sheets', resourcesPath: '/res' }],
        note: 'a checkout',
      },
      {
        args: [{ packaged: false, appPath: '/repo/apps/shell/out/main', resourcesPath: '' }],
        note: 'the app path is asked only when not packaged',
      },
    ],
  },
  'sheets/template-fonts.installStandaloneTemplateFontProtocol': {
    ts: async (a, cx) => {
      const spec = a[0] as FontsSpec
      const mod = await templateFontsModule()
      let handler: ((request: { url: string }) => Promise<Response>) | undefined
      useElectron({
        app: {
          isPackaged: spec.packaged,
          getAppPath: () => {
            cx.log('getAppPath')
            return spec.appPath
          },
        },
        protocol: {
          handle: (scheme: string, fn: typeof handler) => {
            cx.log('handle', scheme)
            handler = fn
          },
        },
      })
      await withProcess('resourcesPath', spec.resourcesPath, () =>
        mod.installStandaloneTemplateFontProtocol(),
      )
      const answers: J[] = []
      for (const url of spec.requests ?? [])
        answers.push(await describe(await handler!({ url }), 'hex'))
      return answers
    },
    cases: [
      {
        args: [
          {
            packaged: true,
            appPath: '/app',
            resourcesPath: '$DIR/res',
            requests: [
              FONT_URL('Pretendard-Regular.otf'),
              FONT_URL('BlackHanSans-Regular.ttf'),
              FONT_URL('PlayfairDisplay%5Bwght%5D.ttf'),
              FONT_URL('GowunDodum-Regular.ttf'),
              FONT_URL('evil.otf'),
              FONT_URL('..%2Fsecret.otf'),
              'https://example.com/Pretendard-Regular.otf',
              'seuoffice-docx-media://handoff/abc',
            ],
          },
        ],
        files: FONT_FILES,
        note: 'listed files, a listed file that is missing, others',
      },
      {
        args: [
          {
            packaged: false,
            appPath: '$DIR/repo/apps/sheets',
            resourcesPath: '',
            requests: [FONT_URL('Pretendard-Regular.otf')],
          },
        ],
        files: { 'repo/packages/ui/template-fonts/Pretendard-Regular.otf': { hex: '4f54544f' } },
        note: 'the checkout folder',
      },
    ],
  },
  'sheets/template-fonts.templateFontFaceCss': {
    ts: async (a) => (await templateFontsModule()).templateFontFaceCss(a[0] as string),
    cases: cases(
      ['/opt/seu/template-fonts'],
      ['/a b/c#d'],
      ['/with"quote'],
      ['/[bracket]'],
      ['/ünï/폰트'],
      ['/tmp/100%/x'],
      ['/a/../b/./c/'],
    ),
  },
  'sheets/template-fonts.withTemplateFontFaces': {
    ts: async (a) =>
      (await templateFontsModule()).withTemplateFontFaces(a[0] as string, a[1] as string),
    cases: cases(
      ['<html><head><title>t</title></head><body>x</body></html>', '/f'],
      ['<HTML><HEAD lang="ko"><meta charset=utf-8></HEAD>', '/f'],
      ['<!doctype html><p>no head</p>', '/f'],
      ['  \n<!DOCTYPE html PUBLIC "x"><p>y</p>', '/f'],
      ['plain text', '/f'],
      ['<header>not a head</header>', '/f'],
      ['<p>text</p><head>late</head>', '/f'],
      ['', '/f'],
      ['<head>\u00e9\u{1F600}</head>', '/with space'],
    ),
  },
}

// ---------------------------------------------------------------------------
// html/preview-protocol
// ---------------------------------------------------------------------------

async function previewModule(): Promise<J> {
  return loadPatched('apps/html/src/main/preview-protocol.ts', (src) =>
    must(
      src,
      "from '@seuoffice/electron-utils'",
      "from '@seuoffice/electron-utils/renderer-scheme'",
      'preview-protocol.ts',
    ),
  )
}

const PREVIEW_ENTRIES = {
  '12': {
    text: '<html><head><title>a</title></head><body>12</body></html>',
    baseHref: 'file:///x/y/',
  },
  '5': { text: 'plain text', baseHref: null },
  '1e+22': { text: '<p>huge</p>', baseHref: '' },
  '0': { text: '<base href="z"><p>own base</p>', baseHref: 'file:///q/' },
}

const previewProtocol: Group = {
  'preview-protocol.registerPrivilegedSchemes': {
    ts: async (a, cx) => {
      const mod = await previewModule()
      useElectron({
        protocol: {
          registerSchemesAsPrivileged: (list: unknown) =>
            cx.log('registerSchemesAsPrivileged', list),
        },
      })
      if (a[0] === null || a[0] === undefined) mod.registerPrivilegedSchemes()
      else mod.registerPrivilegedSchemes(a[0])
      return undefined
    },
    cases: [
      { args: [null], note: 'no extra schemes' },
      { args: [[]], note: 'an empty list' },
      {
        args: [
          [
            { scheme: 'mindmap-app', privileges: { standard: true, secure: true } },
            { scheme: 'x', privileges: { bypassCSP: true } },
          ],
        ],
        note: 'the other editors',
      },
    ],
  },
  'preview-protocol.registerPreviewProtocol': {
    ts: async (a, cx) => {
      const mod = await previewModule()
      const spec = a[0] as { entries: Record<string, unknown>; urls: string[] }
      let handler: ((request: { url: string }) => Response) | undefined
      useElectron({
        protocol: {
          handle: (scheme: string, fn: typeof handler) => {
            cx.log('handle', scheme)
            handler = fn
          },
        },
      })
      mod.registerPreviewProtocol((id: number) => {
        cx.log('resolve', id)
        return spec.entries[String(id)] ?? null
      })
      const answers: J[] = []
      for (const url of spec.urls)
        answers.push(await describe(handler!({ url }) as Response, 'text'))
      return answers
    },
    cases: [
      {
        args: [
          {
            entries: PREVIEW_ENTRIES,
            urls: [
              'html-preview://view-12/',
              'html-preview://view-5/index.html',
              'html-preview://view-99/',
              'html-preview://other/',
              'not a url',
              'html-preview://view-12:80/',
              'html-preview://view-0012/',
              'html-preview://view-/',
              'html-preview://view-1e3/',
              'html-preview://view-9999999999999999999999/',
              'html-preview://view-0/',
              'html-preview://VIEW-12/',
              'html-preview:///view-12',
            ],
          },
        ],
        note: 'hosts of every shape',
      },
      { args: [{ entries: {}, urls: ['html-preview://view-1/'] }], note: 'nothing registered' },
    ],
  },
}

// ---------------------------------------------------------------------------
// markdown/print-document, markdown/print-pdf
// ---------------------------------------------------------------------------

const printDocumentModule = (): Promise<J> =>
  import('../../../apps/markdown/src/main/print-document.ts')
const printPdfModule = (): Promise<J> => import('../../../apps/markdown/src/main/print-pdf.ts')

interface WindowScript {
  createWindow?: 'throws'
  loadFile?: 'throws'
  showThrows?: boolean
  focusThrows?: boolean
  print?: 'throws' | { success: boolean; reason?: string }
  printToPDF?: 'throws'
  pdfHex?: string
  destroyThrows?: boolean
}

/** `BrowserWindow` of a script; `state.workDir` is the folder the load named */
function useWindow(script: WindowScript, cx: TsContext, state: { workDir?: string }): void {
  const win = {
    async loadFile(path: string) {
      state.workDir = dirname(path)
      cx.log(
        'loadFile',
        basename(dirname(path)).slice(0, -6),
        basename(path),
        readFileSync(path, 'utf8'),
      )
      if (script.loadFile === 'throws') throw new Error('load failed')
    },
    show() {
      cx.log('show')
      if (script.showThrows) throw new Error('show threw')
    },
    focus() {
      cx.log('focus')
      if (script.focusThrows) throw new Error('focus threw')
    },
    webContents: {
      print(options: unknown, done: (success: boolean, reason?: string) => void) {
        cx.log('print', options)
        if (script.print === 'throws') throw new Error('print threw')
        done(script.print?.success === true, script.print?.reason)
      },
      async printToPDF(options: unknown) {
        cx.log('printToPDF', options)
        if (script.printToPDF === 'throws') throw new Error('printToPDF threw')
        return Buffer.from(script.pdfHex ?? '', 'hex')
      },
    },
    destroy() {
      cx.log('destroy')
      if (script.destroyThrows) throw new Error('destroy threw')
    },
  }
  useElectron({
    BrowserWindow: function BrowserWindow() {
      cx.log('createWindow')
      if (script.createWindow === 'throws') throw new Error('createWindow threw')
      return win
    },
  })
}

/** the random part of the print folders is cut off the messages */
const unrand = (message: unknown): string =>
  String(message).replace(/\/(seuoffice-md-print-)[A-Za-z0-9]{6}/g, '/$1<rand>')

async function masked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    const wrapped = new Error(unrand(e.message)) as Error & { code?: unknown }
    if (typeof e.code === 'string') wrapped.code = e.code
    throw wrapped
  }
}

const LETTER = { pageSize: 'Letter', marginIn: 0.6, landscape: true, printBackground: true }
const NARROW = { pageSize: 'A4', marginIn: 0.25, landscape: false, printBackground: false }
const OK_PRINT: WindowScript = { print: { success: true } }

const markdownPrint: Group = {
  'markdown/print-document.printMarkdownDocument': {
    ts: async (a, cx) => {
      const mod = await printDocumentModule()
      const state: { workDir?: string } = {}
      useWindow(a[4] as WindowScript, cx, state)
      try {
        return await masked(() =>
          withProcess('platform', a[3] as string, () =>
            mod.printMarkdownDocument(
              a[0] as string,
              (a[1] ?? null) as unknown,
              (a[2] ?? undefined) as unknown,
            ),
          ),
        )
      } finally {
        if (state.workDir) rmSync(state.workDir, { recursive: true, force: true })
      }
    },
    cases: cases(
      ['<p>hi</p>', null, null, 'linux', OK_PRINT],
      ['<p>hi</p>', null, null, 'darwin', OK_PRINT],
      ['<p>hi</p>', null, null, 'win32', OK_PRINT],
      ['<p>caf\u00e9 \u{1F600}</p>', { from: 2, to: 5 }, LETTER, 'linux', OK_PRINT],
      ['', { from: 1, to: 1 }, NARROW, 'linux', OK_PRINT],
      [
        '<p>x</p>',
        null,
        null,
        'linux',
        { print: { success: false, reason: 'Print job canceled' } },
      ],
      ['<p>x</p>', null, null, 'linux', { print: { success: false, reason: 'CANCELLED' } }],
      ['<p>x</p>', null, null, 'linux', { print: { success: false, reason: 'Driver failure' } }],
      ['<p>x</p>', null, null, 'linux', { print: { success: false, reason: '' } }],
      ['<p>x</p>', null, null, 'linux', { print: { success: false } }],
      ['<p>x</p>', null, null, 'linux', {}],
      ['<p>x</p>', null, null, 'linux', { print: 'throws' }],
      ['<p>x</p>', null, null, 'linux', { createWindow: 'throws' }],
      ['<p>x</p>', null, null, 'linux', { loadFile: 'throws', print: { success: true } }],
      ['<p>x</p>', null, null, 'win32', { showThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'win32', { focusThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { showThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { destroyThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { destroyThrows: true, loadFile: 'throws' }],
    ),
  },
  'markdown/print-pdf.printMarkdownPdf': {
    ts: async (a, cx) => {
      const mod = await printPdfModule()
      const state: { workDir?: string } = {}
      useWindow(a[2] as WindowScript, cx, state)
      try {
        return await masked(async () =>
          (await mod.printMarkdownPdf(a[0] as string, (a[1] ?? undefined) as unknown)).toString(
            'hex',
          ),
        )
      } finally {
        if (state.workDir) rmSync(state.workDir, { recursive: true, force: true })
      }
    },
    cases: cases(
      ['<html><body>x</body></html>', null, { pdfHex: '255044462d' }],
      ['', null, { pdfHex: '' }],
      ['<p>caf\u00e9 \u{1F600}</p>', LETTER, { pdfHex: '00ff10' }],
      ['<p>x</p>', NARROW, { pdfHex: '01' }],
      ['<p>x</p>', null, { createWindow: 'throws' }],
      ['<p>x</p>', null, { loadFile: 'throws' }],
      ['<p>x</p>', null, { printToPDF: 'throws' }],
      ['<p>x</p>', null, { destroyThrows: true }],
      ['<p>x</p>', null, { loadFile: 'throws', destroyThrows: true }],
    ),
  },
}

// ---------------------------------------------------------------------------
// docs/updater
// ---------------------------------------------------------------------------

async function updaterModule(): Promise<J> {
  return loadPatched('apps/docs/src/main/updater.ts', (src) => {
    let out = must(
      src,
      "import { autoUpdater } from 'electron-updater'",
      [
        'const autoUpdater: any = new Proxy({}, {',
        '  get: (_t, k) => (globalThis as any).__b6Updater[k],',
        '  set: (_t, k, v) => { (globalThis as any).__b6Updater[k] = v; return true },',
        '})',
      ].join('\n'),
      'updater.ts',
    )
    out = must(
      out,
      "console.log('[docs-updater]', ...args)",
      "(globalThis as any).__b6Log('[docs-updater]', ...args)",
      'updater.ts',
    )
    out = must(
      out,
      'setTimeout(check, FIRST_CHECK_DELAY_MS)',
      ';(globalThis as any).__b6Timers.setTimeout(check, FIRST_CHECK_DELAY_MS)',
      'updater.ts',
    )
    return must(
      out,
      'setInterval(check, RECHECK_INTERVAL_MS)',
      ';(globalThis as any).__b6Timers.setInterval(check, RECHECK_INTERVAL_MS)',
      'updater.ts',
    )
  })
}

interface UpdaterSpec {
  lang: string
  packaged: boolean
  platform: string
  window?: string
  response?: number | number[]
  check?: 'rejects' | 'rejectsValue'
  steps: J[]
}

async function runUpdater(spec: UpdaterSpec, cx: TsContext): Promise<undefined> {
  const mod = await updaterModule()
  setUiLang(spec.lang as 'en' | 'ko')
  const listeners: Record<string, (arg: unknown) => void> = {}
  const timers: Record<string, () => void> = {}
  const fake: J = new Proxy(
    {},
    {
      set: (t: J, key: string, value: unknown) => {
        cx.log('set', key, value)
        t[key] = value
        return true
      },
      get: (t: J, key: string) => {
        if (key === 'on') {
          return (name: string, fn: (arg: unknown) => void) => {
            cx.log('on', name)
            listeners[name] = fn
          }
        }
        if (key === 'checkForUpdates') {
          return () => {
            cx.log('checkForUpdates')
            if (spec.check === 'rejects') return Promise.reject(new Error('offline'))
            if (spec.check === 'rejectsValue') return Promise.reject('boom')
            return Promise.resolve()
          }
        }
        if (key === 'quitAndInstall') {
          return (...a: unknown[]) => cx.log('quitAndInstall', ...a)
        }
        return t[key]
      },
    },
  )
  g.__b6Updater = fake
  g.__b6Log = (...a: unknown[]) => cx.log('log', ...a)
  g.__b6Timers = {
    setTimeout: (fn: () => void, ms: number) => {
      cx.log('setTimeout', ms)
      timers.first = fn
    },
    setInterval: (fn: () => void, ms: number) => {
      cx.log('setInterval', ms)
      timers.interval = fn
    },
  }
  useElectron({
    app: { isPackaged: spec.packaged },
    dialog: fakeDialog(spec.response, cx.log),
  })
  try {
    await withProcess('platform', spec.platform, async () => {
      for (const step of spec.steps) {
        if (step.init) {
          mod.initDocsAutoUpdater(() => {
            cx.log('getWindow')
            return fakeParent(spec.window)
          })
        } else if (step.error !== undefined) {
          listeners.error?.(
            step.error.message !== undefined ? new Error(step.error.message) : step.error.value,
          )
        } else if (step.downloaded !== undefined) {
          listeners['update-downloaded']?.({ version: step.downloaded })
        } else if (step.fire === 'first') {
          timers.first?.()
        } else if (step.fire === 'interval') {
          timers.interval?.()
        }
        await settle()
      }
    })
  } finally {
    delete g.__b6Updater
    delete g.__b6Log
    delete g.__b6Timers
  }
  return undefined
}

const INIT: J = { init: true }
const downloaded = (version: string): J => ({ downloaded: version })

const updater: Group = {
  'docs/updater.initDocsAutoUpdater': {
    ts: (a, cx) => runUpdater(a[0] as UpdaterSpec, cx),
    cases: [
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            window: 'live',
            response: 0,
            steps: [INIT, downloaded('1.2.0')],
          },
        ],
        note: 'install',
      },
      {
        args: [
          {
            lang: 'ko',
            packaged: true,
            platform: 'win32',
            window: 'live',
            response: 1,
            steps: [INIT, downloaded('1.2.0')],
          },
        ],
        note: 'later, in Korean',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'win32',
            window: 'live',
            response: [1, 0, 0],
            steps: [
              INIT,
              downloaded('1.2.0'),
              downloaded('1.2.0'),
              downloaded('1.3.0'),
              downloaded('1.3.0'),
            ],
          },
        ],
        note: 'a declined version is not asked again, the next one is',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            window: 'destroyed',
            response: 0,
            steps: [INIT, downloaded('2.0.0')],
          },
        ],
        note: 'the window is gone: a box without a parent',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            response: 2,
            steps: [INIT, downloaded('2.0.0')],
          },
        ],
        note: 'no window; a button that is neither',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            window: 'live',
            steps: [INIT, downloaded('2.0.1')],
          },
        ],
        note: 'the box answers nothing',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: false,
            platform: 'darwin',
            steps: [INIT, downloaded('1.0.0'), { fire: 'first' }],
          },
        ],
        note: 'an unpackaged run registers nothing',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'linux',
            steps: [INIT, downloaded('1.0.0'), { fire: 'first' }],
          },
        ],
        note: 'linux is not served',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            window: 'live',
            response: 0,
            steps: [INIT, INIT, downloaded('1.0.0')],
          },
        ],
        note: 'a second init does nothing',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: false,
            platform: 'darwin',
            steps: [INIT],
          },
        ],
        note: 'the first init of an unpackaged run still counts',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            steps: [
              INIT,
              { error: { message: 'net::ERR_INTERNET_DISCONNECTED' } },
              { error: { value: 'plain text' } },
              { error: { value: { code: 'E' } } },
              { fire: 'first' },
              { fire: 'interval' },
            ],
          },
        ],
        note: 'errors and checks that go well',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            check: 'rejects',
            steps: [INIT, { fire: 'first' }, { fire: 'interval' }],
          },
        ],
        note: 'a check that fails',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            check: 'rejectsValue',
            steps: [INIT, { fire: 'first' }],
          },
        ],
        note: 'a check that fails with a string',
      },
      {
        args: [
          {
            lang: 'en',
            packaged: true,
            platform: 'darwin',
            steps: [{ fire: 'first' }, { error: { message: 'x' } }],
          },
        ],
        note: 'events before init',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// diagram-session
// ---------------------------------------------------------------------------

async function diagramModule(): Promise<J> {
  return loadPatched('apps/diagram/src/main/diagram-session.ts', (src) => src)
}

const PRINT_TOKEN = '0123456789abcdef0123456789abcdef'

interface DiagramSpec {
  paths: { rendererDir: string; drawioDir: string; bridgeFile: string; devOrigins: string[] }
  steps: J[]
}

async function runDiagramSession(spec: DiagramSpec, cx: TsContext): Promise<J[]> {
  const mod = await diagramModule()
  const printDocument = await import('../../../apps/diagram/src/main/print-document.ts')
  const handlers: Record<string, (request: { method: string; url: string }) => Promise<Response>> =
    {}
  let before:
    ((details: { url: string }, done: (r: { cancel: boolean }) => void) => void) | undefined
  let permissionRequest: ((c: unknown, p: string, done: (g: boolean) => void) => void) | undefined
  let permissionCheck: ((c: unknown, p: string) => boolean) | undefined
  const ses = {
    protocol: {
      handle: (scheme: string, fn: (typeof handlers)[string]) => {
        cx.log('handle', scheme)
        handlers[scheme] = fn
      },
    },
    webRequest: {
      onBeforeRequest: (fn: typeof before) => {
        cx.log('onBeforeRequest')
        before = fn
      },
    },
    setSpellCheckerEnabled: (enabled: boolean) => cx.log('setSpellCheckerEnabled', enabled),
    setPermissionRequestHandler: (fn: typeof permissionRequest) => {
      cx.log('setPermissionRequestHandler')
      permissionRequest = fn
    },
    setPermissionCheckHandler: (fn: typeof permissionCheck) => {
      cx.log('setPermissionCheckHandler')
      permissionCheck = fn
    },
  }
  useElectron({
    session: {
      fromPartition: (partition: string) => {
        cx.log('fromPartition', partition)
        return ses
      },
    },
  })
  let token = ''
  const address = (request: { url: string }): string => request.url.split('$PRINT').join(token)
  const results: J[] = []
  for (const step of spec.steps) {
    let result: J = null
    if (step.install) {
      mod.diagramSession(spec.paths)
    } else if (step.hold !== undefined) {
      token = printDocument.holdPrintDocument(step.hold)
    } else if (step.drawio && handlers['drawio-app']) {
      result = await describe(
        await handlers['drawio-app']({ method: step.drawio.method, url: address(step.drawio) }),
        'text',
      )
    } else if (step.renderer && handlers['genoffice-app']) {
      result = await describe(
        await handlers['genoffice-app']({
          method: step.renderer.method,
          url: address(step.renderer),
        }),
        'text',
      )
    } else if (step.before !== undefined && before) {
      before({ url: step.before }, (r) => {
        result = r.cancel
      })
    } else if (step.permission !== undefined && permissionRequest && permissionCheck) {
      let request: boolean | null = null
      permissionRequest(null, step.permission, (granted) => {
        request = granted
      })
      result = { request, check: permissionCheck(null, step.permission) }
    } else if (step.log) {
      result = mod.diagramRequestLog()
    }
    results.push(result)
  }
  // the held print documents are the module's, shared by every copy of the session
  if (token) printDocument.takePrintDocument(token)
  return results
}

const DRAWIO_INDEX = '<!doctype html><html><head><title>draw.io</title></head><body></body></html>'
const DIAGRAM_FILES: Record<string, string | { hex: string } | { dir: true }> = {
  'drawio/index.html': DRAWIO_INDEX,
  'drawio/js/app.min.js': 'console.log("draw.io")',
  'drawio/styles/grapheditor.css': 'body { color: red }',
  'drawio/img/logo.png': { hex: '89504e470d0a1a0a' },
  'drawio/data.bin': { hex: 'aabbcc' },
  'drawio/dir': { dir: true },
  'bridge/bridge.js': 'window.bridge = 1',
  'renderer/index.html': '<!doctype html><html><head></head><body>app</body></html>',
  'renderer/assets/app.js': 'export const a = 1',
}
const DIAGRAM_PATHS = {
  rendererDir: '$DIR/renderer',
  drawioDir: '$DIR/drawio',
  bridgeFile: '$DIR/bridge/bridge.js',
  devOrigins: [] as string[],
}
const drawio = (method: string, url: string): J => ({ drawio: { method, url } })
const renderer = (method: string, url: string): J => ({ renderer: { method, url } })

const diagramSession: Group = {
  'diagram-session.scenario': {
    ts: (a, cx) => runDiagramSession(a[0] as DiagramSpec, cx),
    cases: [
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              { install: true },
              drawio('GET', 'drawio-app://editor/index.html'),
              drawio('HEAD', 'drawio-app://editor/index.html'),
              drawio('GET', 'drawio-app://editor/js/app.min.js'),
              drawio('HEAD', 'drawio-app://editor/js/app.min.js'),
              drawio('GET', 'drawio-app://editor/styles/grapheditor.css'),
              drawio('GET', 'drawio-app://editor/img/logo.png'),
              drawio('GET', 'drawio-app://editor/data.bin'),
              drawio('GET', 'drawio-app://editor/__ieum/bridge.js'),
              drawio('HEAD', 'drawio-app://editor/__ieum/bridge.js'),
            ],
          },
        ],
        files: DIAGRAM_FILES,
        note: 'draw.io files, with the bridge injected into the start page',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              drawio('GET', 'drawio-app://editor/missing.js'),
              drawio('GET', 'drawio-app://editor/dir'),
              drawio('GET', 'drawio-app://editor/'),
              drawio('GET', 'drawio-app://editor/%2e%2e/secret'),
              drawio('GET', 'drawio-app://editor/a%2fb'),
              drawio('GET', 'drawio-app://editor/a%5cb'),
              drawio('GET', 'drawio-app://editor/a%00b'),
              drawio('GET', 'drawio-app://other/index.html'),
              drawio('GET', 'not a url'),
              drawio('POST', 'drawio-app://editor/index.html'),
              drawio('PUT', 'drawio-app://editor/js/app.min.js'),
              drawio('DELETE', 'drawio-app://editor/index.html'),
              drawio('GET', 'drawio-app://editor/__ieum/other.js'),
              drawio('GET', 'drawio-app://editor/__ieum/print/zz'),
            ],
          },
        ],
        files: DIAGRAM_FILES,
        note: 'what is refused, and with which status',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              drawio('GET', 'drawio-app://editor/__ieum/print/$PRINT'),
              { hold: '<html><body>print me</body></html>' },
              drawio('GET', 'drawio-app://editor/__ieum/print/$PRINT'),
              drawio('GET', 'drawio-app://editor/__ieum/print/$PRINT'),
              { hold: '<p>again</p>' },
              drawio('HEAD', 'drawio-app://editor/__ieum/print/$PRINT'),
            ],
          },
        ],
        files: DIAGRAM_FILES,
        note: 'a print page is served once; even to HEAD it carries its text',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              drawio('GET', 'drawio-app://editor/index.html'),
              drawio('HEAD', 'drawio-app://editor/index.html'),
              drawio('GET', 'drawio-app://editor/js/app.min.js'),
            ],
          },
        ],
        files: { ...DIAGRAM_FILES, 'drawio/index.html': '<!doctype html><body>no head</body>' },
        note: 'a start page without <head> is not served',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              drawio('GET', 'drawio-app://editor/index.html'),
              drawio('GET', 'drawio-app://editor/missing/index.html'),
            ],
          },
        ],
        files: {
          ...DIAGRAM_FILES,
          'drawio/index.html': '\u{feff}<html><head></head>\u00e9</html>',
        },
        note: 'a byte order mark and a non-ASCII text',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              renderer('GET', 'genoffice-app://diagram/index.html'),
              renderer('HEAD', 'genoffice-app://diagram/index.html'),
              renderer('POST', 'genoffice-app://diagram/index.html'),
              renderer('GET', 'genoffice-app://diagram/assets/app.js'),
              renderer('GET', 'genoffice-app://diagram/assets/missing.js'),
              renderer('GET', 'genoffice-app://diagram/assets'),
              renderer('GET', 'genoffice-app://docs/index.html'),
              renderer('GET', 'genoffice-app://diagram/../drawio/index.html'),
              renderer('GET', 'garbage'),
            ],
          },
        ],
        files: DIAGRAM_FILES,
        note: 'the renderer scheme of this session',
      },
      {
        args: [
          {
            paths: {
              ...DIAGRAM_PATHS,
              devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5174'],
            },
            steps: [
              { install: true },
              drawio('GET', 'drawio-app://editor/index.html'),
              drawio('GET', 'drawio-app://editor/js/app.min.js'),
            ],
          },
        ],
        files: DIAGRAM_FILES,
        note: 'a development run lets its own origins frame the pages',
      },
      {
        args: [
          {
            paths: { ...DIAGRAM_PATHS, devOrigins: ['http://localhost:5173'] },
            steps: [
              drawio('GET', 'drawio-app://editor/index.html'),
              { before: 'drawio-app://editor/index.html' },
              { install: true },
              { before: 'drawio-app://editor/index.html' },
              { before: 'genoffice-app://diagram/index.html' },
              { before: 'data:text/plain,hi' },
              { before: 'blob:drawio-app://editor/1' },
              { before: 'https://example.com/a?token=secret' },
              { before: 'http://localhost:5173/src/main.ts' },
              { before: 'file:///etc/passwd' },
              { before: 'not a url' },
              { before: 'ws://localhost:5173/' },
              { log: true },
            ],
          },
        ],
        note: 'the request screen and what the log kept; nothing before the install',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { install: true },
              ...Array.from({ length: 105 }, (_, i): J => ({
                before: `https://example.com/${i}?q=${i}`,
              })),
              { log: true },
            ],
          },
        ],
        note: 'only the last hundred refused addresses are kept',
      },
      {
        args: [
          {
            paths: DIAGRAM_PATHS,
            steps: [
              { permission: 'clipboard-sanitized-write' },
              { install: true },
              { permission: 'clipboard-sanitized-write' },
              { permission: 'clipboard-read' },
              { permission: 'media' },
              { permission: '' },
            ],
          },
        ],
        note: 'only the clipboard write is granted',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// docs/lazy-media
// ---------------------------------------------------------------------------

const STUB_ZIP = `
const lib = () => globalThis.__b6Zip
export const bufferSource = (buf) => ({ size: buf.length, read: async (offset, length) => buf.subarray(offset, offset + length) })
export const lazyMediaHashesIn = (...a) => lib().lazyMediaHashesIn(...a)
export const materializeDocx = (...a) => lib().materializeDocx(...a)
export const openZipFile = (...a) => lib().openZipFile(...a)
export const readZipEntries = (...a) => lib().readZipEntries(...a)
export const slimDocx = (...a) => lib().slimDocx(...a)
`

let zipStubUrl: string | undefined

async function lazyMediaModule(): Promise<J> {
  zipStubUrl ??= scratchFile('zip-stub.mjs', STUB_ZIP)
  return loadPatched('apps/docs/src/main/lazy-media.ts', (src) => {
    const out = must(
      src,
      "from '@seuoffice/docx-engine/zip-splice'",
      `from '${zipStubUrl}'`,
      'lazy-media.ts',
    )
    return must(
      out,
      "from '@seuoffice/electron-utils'",
      "from '@seuoffice/electron-utils/renderer-scheme'",
      'lazy-media.ts',
    )
  })
}

const entryOf = (e: J): J => ({
  name: e.name,
  nameBytes: Buffer.from(e.name),
  flags: 0,
  method: e.method,
  time: 0,
  date: 0,
  crc: 0,
  csize: e.csize,
  usize: e.usize,
  verMade: 20,
  verNeed: 20,
  intAttr: 0,
  extAttr: 0,
  dataOffset: e.dataOffset,
})

interface LazySpec {
  lib: J
  fontsDir?: string
  steps: J[]
}

async function runLazyMedia(spec: LazySpec, cx: TsContext): Promise<J[]> {
  const mod = await lazyMediaModule()
  const byteHandoff = await import('../../../apps/docs/src/main/byte-handoff.ts')
  const lib = spec.lib
  g.__b6Zip = {
    openZipFile: async (path: string) => {
      cx.log('openZipFile', path)
      const zip = (lib.zips ?? []).find((z: J) => z.path === path)
      if (!zip || (lib.openThrows ?? []).includes(path)) throw new Error('zip: cannot open')
      return {
        size: zip.size ?? 0,
        entries: new Map(zip.entries.map((e: J) => [e.name, entryOf(e)])),
        read: async () => {
          throw new Error('unused')
        },
        close: async () => cx.log('close'),
      }
    },
    slimDocx: async (_zip: unknown, hash: string, min: number) => {
      cx.log('slimDocx', hash, min)
      const v = lib.slim?.[hash]
      if (v === 'throws') throw new Error('slim failed')
      return v == null ? null : { bytes: Buffer.from(v, 'hex') }
    },
    lazyMediaHashesIn: async (bytes: Buffer) => {
      const key = bytes.toString('hex')
      cx.log('lazyMediaHashesIn', key)
      const v = lib.hashes?.[key]
      if (!Array.isArray(v)) throw new Error('not a zip')
      return new Set(v)
    },
    readZipEntries: async (src: J) => {
      const bytes: Buffer = await src.read(0, src.size)
      const key = bytes.toString('hex')
      cx.log('readZipEntries', key)
      const v = lib.mem?.[key]
      if (!Array.isArray(v)) throw new Error('zip: not a zip')
      return v.map(entryOf)
    },
    materializeDocx: async (bytes: Buffer, getZip: (hash: string) => Promise<J>) => {
      const key = bytes.toString('hex')
      cx.log('materializeDocx', key)
      const parts: Buffer[] = [bytes]
      for (const hash of lib.hashes?.[key] ?? []) {
        const zip = await getZip(hash)
        cx.log('getZip', hash, zip === null ? null : zip.size)
        if (zip) {
          const first = zip.entries.values().next().value
          if (first) parts.push(await zip.read(first.dataOffset, Math.min(first.csize, 4)))
        }
      }
      return Buffer.concat(parts)
    },
  }
  let handler: ((request: { url: string }) => Promise<Response>) | undefined
  useElectron({
    protocol: {
      isProtocolHandled: (scheme: string) => {
        cx.log('isProtocolHandled', scheme)
        return handled
      },
      handle: (scheme: string, fn: typeof handler) => {
        cx.log('handle', scheme)
        handler = fn
      },
    },
  })
  let handled = false
  let handoffUrl = ''
  const address = (url: string): string => url.split('$HANDOFF').join(handoffUrl)
  const results: J[] = []
  try {
    for (const step of spec.steps) {
      let result: J = null
      try {
        if (step.open) {
          const opened = await mod.openLazyDocx(step.open.path, step.open.wc)
          result = opened ? { bytes: opened.bytes.toString('hex'), hash: opened.hash } : null
        } else if (step.adopt) {
          await mod.adoptLazyMediaHashes(
            Buffer.from(step.adopt.bytes, 'hex'),
            step.adopt.path,
            step.adopt.wc,
          )
        } else if (step.move) {
          mod.moveLazyMediaSource(step.move[0], step.move[1])
        } else if (step.forget !== undefined) {
          mod.forgetLazyMediaOwner(step.forget)
        } else if (step.materialize !== undefined) {
          const done = await mod.materializeLazyDocx(Buffer.from(step.materialize, 'hex'))
          result = { bytes: done.bytes.toString('hex'), hashes: [...done.hashes] }
        } else if (step.point) {
          mod.pointLazyMediaAt(
            new Set(step.point.hashes as string[]),
            step.point.path,
            step.point.wc,
            step.point.plain === undefined ? undefined : Buffer.from(step.point.plain, 'hex'),
          )
        } else if (step.read !== undefined) {
          const found = await mod.readLazyMedia(address(step.read))
          result = found ? { body: found.body.toString('hex'), mime: found.mime } : null
        } else if (step.handoff !== undefined) {
          handoffUrl = byteHandoff.handOffBytes(Buffer.from(step.handoff, 'hex'))
        } else if (step.register) {
          handled = step.register.handled === true
          const before = handler
          try {
            mod.registerLazyMediaProtocol(spec.fontsDir ?? '')
            result = handler !== before
          } catch (err) {
            result = { threw: (err as Error).message }
          }
        } else if (step.request !== undefined) {
          result = handler
            ? await describe(await handler({ url: address(step.request) }), 'hex')
            : null
        }
      } catch (err) {
        result = { threw: (err as Error).message }
      }
      results.push(result)
    }
  } finally {
    delete g.__b6Zip
    if (handoffUrl) byteHandoff.takeHandoff(handoffUrl)
  }
  return results
}

const STORED = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_RAW = Buffer.from('JFIF a picture that deflates '.repeat(4))
const JPEG_Z = deflateRawSync(JPEG_RAW)
const DOC = Buffer.concat([Buffer.from('504b0304', 'hex'), STORED, JPEG_Z])
const DOC_HASH = sha(DOC)
const OTHER_HASH = sha('another document')
const lazyUrl = (part: string, hash = DOC_HASH): string => `seuoffice-docx-media://${hash}/${part}`
const DOC_ENTRIES = [
  { name: 'word/media/image1.png', method: 0, csize: STORED.length, usize: 900_000, dataOffset: 4 },
  {
    name: 'word/media/image2.jpeg',
    method: 8,
    csize: JPEG_Z.length,
    usize: 200_000,
    dataOffset: 4 + STORED.length,
  },
  { name: 'word/media/image3.emf', method: 0, csize: 8, usize: 5_000_000, dataOffset: 4 },
  { name: 'word/media/image4.gif', method: 9, csize: 8, usize: 10, dataOffset: 4 },
  { name: 'word/media/image5.bmp', method: 0, csize: 64, usize: 64, dataOffset: DOC.length - 8 },
  { name: 'word/document.xml', method: 8, csize: 3, usize: 3, dataOffset: 4 },
]
const SMALL_ENTRIES = [
  { name: 'word/media/image1.png', method: 0, csize: 8, usize: 1000, dataOffset: 4 },
]
const docFile = (name: string): J => ({ [name]: { hex: DOC.toString('hex') } })
const PLACEHOLDER_DOC = Buffer.from('slim document bytes').toString('hex')
const PLAIN_DOC = Buffer.concat([Buffer.from('1111', 'hex'), STORED]).toString('hex')

const baseLib = (extra: J = {}): J => ({
  zips: [{ path: '$DIR/doc.docx', size: DOC.length, entries: DOC_ENTRIES }],
  slim: { [DOC_HASH]: PLACEHOLDER_DOC },
  hashes: { [PLACEHOLDER_DOC]: [DOC_HASH] },
  ...extra,
})
const open = (path = '$DIR/doc.docx', wc = 1): J => ({ open: { path, wc } })
const read = (part: string, hash = DOC_HASH): J => ({ read: lazyUrl(part, hash) })

const lazyMedia: Group = {
  'docs/lazy-media.scenario': {
    ts: (a, cx) => runLazyMedia(a[0] as LazySpec, cx),
    cases: [
      {
        args: [
          {
            lib: baseLib(),
            steps: [
              open(),
              read('word/media/image1.png'),
              read('word/media/image2.jpeg'),
              read('word/media/image1.png'),
              read('word/media/image3.emf'),
              read('word/media/image4.gif'),
              read('word/media/missing.png'),
              read('word/media/image1.PNG'),
              read('word/media/image5.bmp'),
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'a large document opens lazily; stored, deflated, odd parts, a truncated source',
      },
      {
        args: [
          {
            lib: baseLib(),
            steps: [
              open(),
              read('word/media/%2e%2e/image1.png'),
              read('word/media/..%2fimage1.png'),
              read('word/media/%zz.png'),
              read(`word/media/${'a'.repeat(520)}.png`),
              read('word/media/a%00b.png'),
              { read: 'seuoffice-docx-media://nothex/word/media/image1.png' },
              { read: `seuoffice-docx-media://${DOC_HASH}/` },
              { read: 'https://example.com/word/media/image1.png' },
              read('word/media/image1.png', OTHER_HASH),
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'addresses that are not served',
      },
      {
        args: [
          {
            lib: baseLib({ zips: [{ path: '$DIR/doc.docx', size: 1, entries: SMALL_ENTRIES }] }),
            steps: [open(), read('word/media/image1.png')],
          },
        ],
        files: docFile('doc.docx'),
        note: 'media below the threshold: read whole',
      },
      {
        args: [{ lib: baseLib({ openThrows: ['$DIR/doc.docx'] }), steps: [open()] }],
        files: docFile('doc.docx'),
        note: 'an odd zip',
      },
      {
        args: [{ lib: baseLib({ slim: {} }), steps: [open(), read('word/media/image1.png')] }],
        files: docFile('doc.docx'),
        note: 'nothing to slim',
      },
      {
        args: [
          {
            lib: baseLib({ slim: { [DOC_HASH]: 'throws' } }),
            steps: [open(), read('word/media/image1.png')],
          },
        ],
        files: docFile('doc.docx'),
        note: 'slimming throws',
      },
      {
        args: [{ lib: baseLib(), steps: [open('$DIR/missing.docx')] }],
        note: 'a file that is not there',
      },
      {
        args: [
          {
            lib: baseLib(),
            steps: [
              open('$DIR/doc.docx', 1),
              open('$DIR/doc.docx', 2),
              { forget: 1 },
              read('word/media/image1.png'),
              { forget: 2 },
              read('word/media/image1.png'),
              { forget: 3 },
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'served while one window still owns it',
      },
      {
        args: [
          {
            lib: baseLib({
              zips: [
                { path: '$DIR/doc.docx', size: DOC.length, entries: DOC_ENTRIES },
                { path: '$DIR/moved.docx', size: DOC.length, entries: DOC_ENTRIES },
              ],
            }),
            steps: [
              open(),
              read('word/media/image1.png'),
              { move: ['$DIR/doc.docx', '$DIR/moved.docx'] },
              read('word/media/image1.png'),
              { move: ['$DIR/nothing.docx', '$DIR/x.docx'] },
              read('word/media/image2.jpeg'),
            ],
          },
        ],
        files: { ...docFile('doc.docx'), ...docFile('moved.docx') },
        note: 'the file moved: the table is read again',
      },
      {
        args: [
          {
            lib: baseLib({
              zips: [
                { path: '$DIR/doc.docx', size: DOC.length, entries: DOC_ENTRIES },
                { path: '$DIR/copy.docx', size: DOC.length, entries: DOC_ENTRIES },
              ],
              hashes: { [PLACEHOLDER_DOC]: [DOC_HASH] },
            }),
            steps: [
              open(),
              read('word/media/image1.png'),
              { adopt: { bytes: PLACEHOLDER_DOC, path: '$DIR/copy.docx', wc: 2 } },
              read('word/media/image2.jpeg'),
              { adopt: { bytes: PLACEHOLDER_DOC, path: '$DIR/copy.docx', wc: 3 } },
              read('word/media/image1.png'),
            ],
          },
        ],
        files: { ...docFile('doc.docx'), ...docFile('copy.docx') },
        note: 'the same hash from another path: the entry table is read again, once',
      },
      {
        args: [
          {
            lib: baseLib({
              hashes: { [PLACEHOLDER_DOC]: [DOC_HASH], aabb: [OTHER_HASH, DOC_HASH] },
            }),
            steps: [
              { adopt: { bytes: PLACEHOLDER_DOC, path: '$DIR/doc.docx', wc: 5 } },
              read('word/media/image1.png'),
              { adopt: { bytes: 'aabb', path: '$DIR/doc.docx', wc: 6 } },
              read('word/media/image1.png', OTHER_HASH),
              { adopt: { bytes: 'ccdd', path: '$DIR/doc.docx', wc: 7 } },
            ],
            fontsDir: '$DIR',
          },
        ],
        files: docFile('doc.docx'),
        note: 'a recovery copy names the hashes; one that is no zip names nothing',
      },
      {
        args: [
          {
            lib: baseLib(),
            steps: [
              open(),
              { materialize: PLACEHOLDER_DOC },
              { materialize: 'ff00' },
              { materialize: PLACEHOLDER_DOC },
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'a save swaps the placeholders back; bytes without placeholders stay',
      },
      {
        args: [
          {
            lib: baseLib({ hashes: { [PLACEHOLDER_DOC]: [DOC_HASH, DOC_HASH, OTHER_HASH] } }),
            steps: [open(), { materialize: PLACEHOLDER_DOC }],
          },
        ],
        files: docFile('doc.docx'),
        note: 'the same source twice opens once; an unknown hash has no source',
      },
      {
        args: [
          {
            lib: baseLib({
              mem: {
                [PLAIN_DOC]: [
                  { name: 'word/media/image1.png', method: 0, csize: 8, usize: 8, dataOffset: 2 },
                ],
              },
            }),
            steps: [
              open(),
              { point: { hashes: [DOC_HASH], path: '$DIR/plain.docx', wc: 1, plain: PLAIN_DOC } },
              read('word/media/image1.png'),
              read('word/media/image1.png'),
              { materialize: PLACEHOLDER_DOC },
              { point: { hashes: [DOC_HASH], path: '$DIR/doc.docx', wc: 1 } },
              read('word/media/image1.png'),
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'an encrypted save serves from memory, then from the file again',
      },
      {
        args: [
          {
            lib: baseLib(),
            steps: [
              { point: { hashes: [DOC_HASH], path: '$DIR/doc.docx', wc: 1, plain: PLAIN_DOC } },
              read('word/media/image1.png'),
            ],
          },
        ],
        files: docFile('doc.docx'),
        note: 'a memory source whose entries cannot be read',
      },
      {
        args: [
          {
            lib: baseLib(),
            fontsDir: '$DIR/fonts',
            steps: [
              { request: lazyUrl('word/media/image1.png') },
              { register: { handled: true } },
              { register: { handled: false } },
              { request: 'seuoffice-docx-media://template-fonts/Pretendard-Regular.otf' },
              { request: 'seuoffice-docx-media://template-fonts/BlackHanSans-Regular.ttf' },
              { request: 'seuoffice-docx-media://template-fonts/evil.otf' },
              open(),
              { request: lazyUrl('word/media/image1.png') },
              { request: lazyUrl('word/media/image2.jpeg') },
              { request: lazyUrl('word/media/image3.emf') },
              { handoff: 'cafe01' },
              { request: '$HANDOFF' },
              { request: '$HANDOFF' },
              { request: 'seuoffice-docx-media://handoff/unknown' },
            ],
          },
        ],
        files: {
          ...docFile('doc.docx'),
          'fonts/Pretendard-Regular.otf': { hex: '4f54544f' },
          'fonts/BlackHanSans-Regular.ttf': { hex: '00010000aa' },
        },
        note: 'the protocol: handed-off bytes once, fonts, pictures, 404',
      },
      {
        args: [
          {
            lib: baseLib(),
            fontsDir: '$DIR/fonts',
            steps: [
              { register: { handled: false } },
              { request: lazyUrl('word/media/image1.png') },
            ],
          },
        ],
        note: 'nothing opened: a lazy URL is 404',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// pdf/image-edit
// ---------------------------------------------------------------------------

const TEXT_EDIT_STUB = `
export const FPDF_PAGEOBJ_TEXT = 1
export const chainPdfium = (fn) => fn()
export const eraseTextRuns = () => []
export const loadPdfium = async () => globalThis.__b6Pdf.m
export const saveDoc = () => Uint8Array.of(9)
export const withDocument = async (_m, _bytes, fn) => fn(1)
`
const FORM_TEXT_STUB = `
export const SHARED_TEMPLATE_IMAGE_REASON = 'the image lives in a template that is drawn more than once'
export const chainIsExclusive = (_tree, pageIndex, ordinals) => globalThis.__b6Pdf.chainIsExclusive(pageIndex, ordinals)
export const formDrawTree = async () => { globalThis.__b6Pdf.log('formDrawTree'); return {} }
export const liftOutOfForms = (_m, page, obj) => globalThis.__b6Pdf.log('lift', page - 100, obj)
export const transformRect = (rect) => rect
export const walkPageText = () => {}
`

let pdfStubs: { textEdit: string; formText: string } | undefined

async function imageEditModule(): Promise<J> {
  pdfStubs ??= {
    textEdit: scratchFile('text-edit-stub.mjs', TEXT_EDIT_STUB),
    formText: scratchFile('form-text-stub.mjs', FORM_TEXT_STUB),
  }
  return loadPatched('apps/pdf/src/main/image-edit.ts', (src) => {
    let out = must(src, "from './text-edit'", `from '${pdfStubs!.textEdit}'`, 'image-edit.ts')
    out = must(out, "from './form-text'", `from '${pdfStubs!.formText}'`, 'image-edit.ts')
    out = must(out, 'function collectObjects(', 'function collectObjectsReal(', 'image-edit.ts')
    out = must(out, 'function collectImages(', 'function collectImagesReal(', 'image-edit.ts')
    return `${out}
function collectObjects(_m: Pdfium, page: number): PageObj[] {
  return (globalThis as any).__b6Pdf.collectObjects(page)
}
function collectImages(_m: Pdfium, page: number): ImageObj[] {
  return (globalThis as any).__b6Pdf.collectImages(page)
}
export { matchImage, imageMatrix, applyImageGeometry, decodeImage }
`
  })
}

/** the PDFium of a case (see calls/b6_apps.rs `PdfFake`) */
function usePdf(spec: J, log: (...args: unknown[]) => void): J {
  const pages: J[] = spec.pages ?? []
  const list = (key: string): number[] => spec[key] ?? []
  const heap = new ArrayBuffer(1 << 16)
  let next = 8
  const m: J = {
    HEAPU8: new Uint8Array(heap),
    HEAPF32: new Float32Array(heap),
    HEAP32: new Int32Array(heap),
    _malloc: (size: number) => {
      const at = next
      next += (size + 7) & ~7
      return at
    },
    _free: () => {},
    _FPDF_GetPageCount: () => pages.length,
    _FPDF_LoadPage: (_doc: number, i: number) => {
      const index = i | 0
      log('loadPage', index)
      return index >= 0 && index < pages.length && !list('loadFails').includes(index)
        ? 100 + index
        : 0
    },
    _FPDF_ClosePage: (page: number) => log('closePage', page - 100),
    _FPDFPage_GenerateContent: (page: number) => {
      log('generateContent', page - 100)
      return list('generateFails').includes(page - 100) ? 0 : 1
    },
    _FPDFPage_RemoveObject: (page: number, obj: number) => {
      log('removeObject', page - 100, obj)
      return list('removeFails').includes(obj) ? 0 : 1
    },
    _FPDFPageObj_Destroy: (obj: number) => log('destroyObject', obj),
    _FPDFPage_InsertObject: (page: number, obj: number) => log('insertObject', page - 100, obj),
    _FPDFPageObj_Transform: (obj: number, ...matrix: number[]) => log('transform', obj, ...matrix),
    _FPDFBitmap_CreateEx: (width: number, height: number) => {
      log('bitmapCreateEx', width, height)
      return spec.image?.bitmapFails ? 0 : 5
    },
    _FPDFPageObj_NewImageObj: () => {
      log('newImageObj')
      return spec.image?.noObj ? 0 : 900
    },
    _FPDFImageObj_SetBitmap: (pagesPtr: number, _count: number, obj: number) => {
      log('setBitmap', pagesPtr === 0 ? 0 : m.HEAP32[pagesPtr >> 2] - 100, obj)
      return spec.image?.setBitmapFails ? 0 : 1
    },
    _FPDFBitmap_Destroy: () => log('bitmapDestroy'),
    _FPDFPageObj_SetMatrix: (obj: number, ptr: number) =>
      log('setMatrix', obj, ...Array.from(m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + 6))),
  }
  if (!spec.noInsertAt) {
    m._FPDFPage_InsertObjectAtIndex = (page: number, obj: number, index: number) => {
      log('insertObjectAt', page - 100, obj, index)
      return spec.insertAtFails ? 0 : 1
    }
  }
  g.__b6Pdf = {
    m,
    log,
    collectObjects: (page: number) =>
      (pages[page - 100]?.objects ?? []).map((o: J, i: number) => ({
        obj: i,
        index: o.index,
        type: o.type,
        bounds: [0, 0, 1, 1],
      })),
    collectImages: (page: number) =>
      (pages[page - 100]?.images ?? []).map((o: J) => ({
        obj: o.obj,
        index: o.index,
        bounds: [...o.bounds],
        chain: o.inForm ? [{}] : [],
        ordinals: [o.obj],
      })),
    chainIsExclusive: (pageIndex: number, ordinals: number[]) => {
      log('chainIsExclusive', pageIndex, ordinals[0])
      return list('exclusive').includes(ordinals[0]!)
    },
  }
  useElectron({
    nativeImage: {
      createFromBuffer: () => {
        log('createFromBuffer')
        return {
          isEmpty: () => {
            log('isEmpty')
            return !!spec.image?.empty
          },
          getSize: () => {
            log('getSize')
            return { width: spec.image?.width ?? 1, height: spec.image?.height ?? 1 }
          },
          toBitmap: () => {
            log('toBitmap')
            return Buffer.from([1, 2, 3, 255])
          },
        }
      },
    },
  })
  return m
}

const edit = (kind: string, pageIndex: number, extra: J = {}): J => ({
  kind,
  pageIndex,
  oldRect: [100, 100, 200, 200],
  rect: [110, 120, 210, 220],
  image: 'AAAA',
  ...extra,
})
const IMG = (obj: number, bounds: number[], extra: J = {}): J => ({
  obj,
  index: obj,
  bounds,
  ...extra,
})
const WORLD: J = {
  pages: [
    {
      objects: [
        { type: 2, index: 0 },
        { type: 1, index: 3 },
        { type: 1, index: 5 },
      ],
      images: [IMG(11, [100, 100, 200, 200]), IMG(12, [300, 300, 340, 340], { index: 8 })],
    },
    {
      objects: [{ type: 3, index: 1 }],
      images: [
        IMG(21, [100.5, 99.5, 201, 200.25]),
        IMG(22, [100, 100, 200, 200], { inForm: true }),
        IMG(23, [50, 50, 52, 52], { index: 0 }),
      ],
    },
    { objects: [], images: [] },
  ],
}
const world = (extra: J): J => ({ ...WORLD, ...extra })

const runImageEdit = async (a: unknown[], cx: TsContext, fn: string): Promise<unknown> => {
  const mod = await imageEditModule()
  const spec = a[0] as J
  usePdf(spec, cx.log)
  try {
    if (fn === 'applyImageEdits') {
      const bytes = Uint8Array.of(1, 2, 3)
      const done = await mod.applyImageEdits(bytes, spec.edits)
      return { saved: done.bytes !== bytes, skipped: done.skipped }
    }
    if (fn === 'listPageImages') return await mod.listPageImages(Uint8Array.of(1))
    return await mod.verifyImageEdits(Uint8Array.of(1), spec.checks)
  } finally {
    delete g.__b6Pdf
  }
}

const imageEdit: Group = {
  'image-edit.matchImage': {
    ts: async (a) => {
      const mod = await imageEditModule()
      const objects = (a[0] as J[]).map((o) => ({
        ...o,
        obj: 0,
        index: 0,
        chain: [],
        ordinals: [],
      }))
      const found = mod.matchImage(objects, a[1])
      return found ? objects.indexOf(found) : null
    },
    cases: cases(
      [[{ bounds: [0, 0, 10, 10] }], [0, 0, 10, 10]],
      [[{ bounds: [0, 0, 10, 10] }], [1, 1, 11, 11]],
      [[{ bounds: [0, 0, 10, 10] }], [3, 0, 10, 10]],
      [
        [{ bounds: [0, 0, 10, 10] }, { bounds: [0, 0, 11, 10] }],
        [0, 0, 10.5, 10],
      ],
      [
        [{ bounds: [0, 0, 11, 10] }, { bounds: [0, 0, 10, 10] }],
        [0, 0, 10.5, 10],
      ],
      [
        [{ bounds: [0, 0, 10, 10] }, { bounds: [0, 0, 10, 10] }],
        [0, 0, 10, 10],
      ],
      [[{ bounds: [0, 0, 10, 12] }], [0, 0, 10, 10]],
      [[{ bounds: [0, 0, 10, 11.5] }], [0, 0, 10, 10]],
      [[{ bounds: [0, 0, 10, 12.5] }], [0, 0, 10, 10]],
      [[], [0, 0, 1, 1]],
    ),
  },
  'image-edit.imageMatrix': {
    ts: async (a) => (await imageEditModule()).imageMatrix(a[0], a[1]),
    cases: cases(
      [[10, 20, 110, 70], 0],
      [[10, 20, 110, 70], 90],
      [[10, 20, 110, 70], 180],
      [[10, 20, 110, 70], 270],
      [[10, 20, 110, 70], 360],
      [[10, 20, 110, 70], -90],
      [[10, 20, 110, 70], 450],
      [[10, 20, 110, 70], 45],
      [[10, 20, 110, 70], -270],
      [[0, 0, 0, 0], 90],
    ),
  },
  'image-edit.applyImageGeometry': {
    ts: async (a, cx) => {
      const mod = await imageEditModule()
      const m = {
        _FPDFPageObj_Transform: (obj: number, ...matrix: number[]) =>
          cx.log('transform', obj, ...matrix),
      }
      mod.applyImageGeometry(m, 7, a[0], a[1], (a[2] ?? undefined) as number | undefined)
      return undefined
    },
    cases: cases(
      [[100, 100, 200, 200], [100, 100, 200, 200], null],
      [[100, 100, 200, 200], [110, 120, 310, 220], null],
      [[100, 100, 200, 200], [100, 100, 200, 200], 1],
      [[100, 100, 200, 160], [100, 100, 200, 160], 1],
      [[100, 100, 200, 160], [90, 90, 250, 190], 3],
      [[100, 100, 200, 160], [100, 100, 200, 160], 2],
      [[100, 100, 200, 160], [100, 100, 200, 160], 5],
      [[100, 100, 200, 160], [100, 100, 200, 160], -1],
      [[100, 100, 200, 160], [100, 100, 200, 160], 4],
      [[100, 100, 200, 160], [100, 100, 200, 160], 0],
      [[100, 100, 200, 160], [100, 100, 200, 160], 1.5],
      [[100, 100, 100, 160], [0, 0, 50, 50], null],
      [[100, 100, 200, 100.0000001], [0, 0, 50, 50], null],
    ),
  },
  'image-edit.decodeImage': {
    ts: async (a, cx) => {
      const mod = await imageEditModule()
      const spec = a[0] as J
      useElectron({
        nativeImage: {
          createFromBuffer: (buf: Buffer) => {
            cx.log('createFromBuffer', buf.toString('base64'))
            return {
              isEmpty: () => {
                cx.log('isEmpty')
                return !!spec.empty
              },
              getSize: () => {
                cx.log('getSize')
                return { width: spec.width, height: spec.height }
              },
              toBitmap: () => {
                cx.log('toBitmap')
                return Buffer.from(spec.bitmap, 'hex')
              },
            }
          },
        },
      })
      const out = mod.decodeImage(spec.b64)
      return { width: out.width, height: out.height, bgra: out.bgra.toString('hex') }
    },
    cases: [
      { args: [{ b64: 'AAAA', width: 1, height: 1, bitmap: '10203040' }], note: 'opaque pixels' },
      {
        args: [{ b64: 'AAAA', width: 2, height: 1, bitmap: '10203080' + '0a141e01' }],
        note: 'premultiplied pixels are scaled back',
      },
      {
        args: [{ b64: 'AAAA', width: 2, height: 1, bitmap: 'ffffff80' + '80808000' }],
        note: 'a clamp and a transparent pixel',
      },
      {
        args: [{ b64: 'AAAA', width: 1, height: 1, bitmap: '7f7f7f7f' }],
        note: 'a rounding tie',
      },
      { args: [{ b64: 'AAAA', empty: true }], note: 'nothing decoded' },
      {
        args: [{ b64: 'AAAA', width: 1, height: 1, bitmap: '10203040ff' }],
        note: 'a partial pixel',
      },
      { args: [{ b64: 'AAAA', width: 0, height: 0, bitmap: '' }], note: 'no pixels' },
    ],
  },
  'image-edit.applyImageEdits': {
    ts: (a, cx) => runImageEdit(a, cx, 'applyImageEdits'),
    cases: [
      {
        args: [
          world({
            edits: [edit('deleteImage', 0), edit('deleteImage', 7), edit('deleteImage', -1)],
          }),
        ],
        note: 'delete; pages that do not exist',
      },
      {
        args: [
          world({
            edits: [
              edit('transformImage', 0),
              edit('transformImage', 0, {
                oldRect: [300, 300, 340, 340],
                rect: [300, 300, 340, 340],
                quarterTurns: 1,
              }),
              edit('transformImage', 0, { oldRect: [10, 10, 20, 20] }),
              edit('deleteImage', 1, { oldRect: [100.5, 99.5, 201, 200.25] }),
            ],
          }),
        ],
        note: 'transforms, an image that is not there, edits grouped by page',
      },
      {
        args: [
          world({
            edits: [edit('transformImage', 0, { layer: 'belowText' })],
          }),
        ],
        note: 'moved below the first text object',
      },
      {
        args: [world({ edits: [edit('transformImage', 0, { layer: 'aboveText' })] })],
        note: 'moved to the top',
      },
      {
        args: [
          world({ edits: [edit('transformImage', 0, { layer: 'belowText' })], noInsertAt: true }),
        ],
        note: 'no insert at an index',
      },
      {
        args: [
          world({
            edits: [edit('transformImage', 0, { layer: 'belowText' })],
            insertAtFails: true,
          }),
        ],
        note: 'the reinsert fails: the object stays on top',
      },
      {
        args: [
          world({ edits: [edit('transformImage', 0, { layer: 'belowText' })], removeFails: [11] }),
        ],
        note: 'the remove fails',
      },
      {
        args: [world({ edits: [edit('deleteImage', 0)], removeFails: [11] })],
        note: 'a delete that fails',
      },
      {
        args: [
          world({
            edits: [edit('transformImage', 1), edit('deleteImage', 1)],
            exclusive: [],
          }),
        ],
        note: 'a template image drawn more than once',
      },
      {
        args: [
          world({
            edits: [
              edit('transformImage', 1),
              edit('transformImage', 1, {
                oldRect: [100.5, 99.5, 201, 200.25],
                rect: [100.5, 99.5, 201, 200.25],
              }),
            ],
            exclusive: [22],
          }),
        ],
        note: 'a template image drawn once is lifted; the census is loaded once',
      },
      {
        args: [world({ edits: [edit('transformImage', 0, { quarterTurns: 1.5 })] })],
        note: 'a fractional quarter turn throws inside the edit',
      },
      {
        args: [
          world({
            edits: [
              edit('insertImage', 0, { rotate: 90 }),
              edit('insertImage', 0, { layer: 'belowText', rotate: 0 }),
            ],
          }),
        ],
        note: 'inserted images',
      },
      {
        args: [world({ edits: [edit('insertImage', 0)], image: { empty: true } })],
        note: 'an image that does not decode',
      },
      {
        args: [world({ edits: [edit('insertImage', 0)], image: { bitmapFails: true } })],
        note: 'no bitmap',
      },
      {
        args: [world({ edits: [edit('insertImage', 0)], image: { noObj: true } })],
        note: 'no image object',
      },
      {
        args: [world({ edits: [edit('insertImage', 0)], image: { setBitmapFails: true } })],
        note: 'the bitmap does not take',
      },
      {
        args: [
          world({ edits: [edit('insertImage', 0, { layer: 'belowText' })], insertAtFails: true }),
        ],
        note: 'the inserted image cannot go below the text',
      },
      {
        args: [
          world({
            edits: [
              edit('replaceImage', 0, { quarterTurns: 3 }),
              edit('replaceImage', 0, { layer: 'aboveText' }),
            ],
          }),
        ],
        note: 'replaced pictures',
      },
      {
        args: [
          world({
            edits: [edit('replaceImage', 0)],
            image: { setBitmapFails: true, width: 2, height: 3 },
          }),
        ],
        note: 'a replacement that does not take',
      },
      {
        args: [world({ edits: [edit('replaceImage', 0)], image: { empty: true } })],
        note: 'a replacement that does not decode',
      },
      {
        args: [world({ edits: [edit('deleteImage', 0)], loadFails: [0] })],
        note: 'a page that cannot be loaded ends the run',
      },
      {
        args: [
          world({ edits: [edit('deleteImage', 0), edit('deleteImage', 1)], generateFails: [0] }),
        ],
        note: 'a page that cannot be regenerated ends the run',
      },
      {
        args: [
          world({ edits: [edit('deleteImage', 0, { oldRect: [1, 1, 2, 2] })], generateFails: [0] }),
        ],
        note: 'nothing applied: the content is not regenerated',
      },
      {
        args: [world({ edits: [edit('deleteImage', 1.5), edit('deleteImage', 2)] })],
        note: 'a fractional page index loads the page below',
      },
      { args: [world({ edits: [] })], note: 'no edits' },
      {
        args: [world({ edits: [edit('deleteImage', 3)] })],
        note: 'the page index of the page count does not exist',
      },
      {
        args: [
          {
            pages: [
              { objects: [], images: [IMG(22, [100, 100, 200, 200], { inForm: true })] },
              { objects: [], images: [IMG(32, [100, 100, 200, 200], { inForm: true })] },
            ],
            exclusive: [22, 32],
            edits: [edit('deleteImage', 0), edit('transformImage', 1)],
          },
        ],
        note: 'the census of shared templates is loaded once for the document',
      },
    ],
  },
  'image-edit.listPageImages': {
    ts: (a, cx) => runImageEdit(a, cx, 'listPageImages'),
    cases: [
      { args: [WORLD], note: 'sizes, and z-band relative to the first text object' },
      { args: [world({ loadFails: [0, 2] })], note: 'pages that do not load are skipped' },
      { args: [{ pages: [] }], note: 'no pages' },
      {
        args: [
          {
            pages: [
              {
                objects: [{ type: 1, index: 4 }],
                images: [
                  IMG(1, [0, 0, 3, 3], { index: 4 }),
                  IMG(2, [0, 0, 2.99, 10], { index: 5 }),
                  IMG(3, [0, 0, 10, 3], { index: 2 }),
                ],
              },
            ],
          },
        ],
        note: 'the 3pt cut and the index equal to the text',
      },
    ],
  },
  'image-edit.verifyImageEdits': {
    ts: (a, cx) => runImageEdit(a, cx, 'verifyImageEdits'),
    cases: [
      {
        args: [
          world({
            checks: [
              { pageIndex: 0, rect: [100, 100, 200, 200] },
              { pageIndex: 0, rect: [10, 10, 20, 20] },
              { pageIndex: 1, rect: [100.5, 99.5, 201, 200.25] },
              { pageIndex: 5, rect: [0, 0, 1, 1] },
              { pageIndex: 3, rect: [0, 0, 1, 1] },
              { pageIndex: -1, rect: [0, 0, 1, 1] },
            ],
          }),
        ],
        note: 'found, missing, a page that is not there',
      },
      {
        args: [
          world({
            checks: [
              { pageIndex: 0, rect: [1, 1, 2, 2] },
              { pageIndex: 0, rect: [3, 3, 4, 4] },
            ],
            loadFails: [0],
          }),
        ],
        note: 'a page that cannot be read fails each of its checks',
      },
      { args: [world({ checks: [] })], note: 'nothing to check' },
    ],
  },
}

// ---------------------------------------------------------------------------
// slides/session-state
// ---------------------------------------------------------------------------

const SLIDES_STUB = `
const lib = () => globalThis.__b6Slides
export const materializeSlide = () => null
export const parseClrMap = (...a) => lib().parseClrMap(...a)
export const parseTheme = (...a) => lib().parseTheme(...a)
export const resolveSchemeColor = (...a) => lib().resolveSchemeColor(...a)
export const buildRenderSlide = (...a) => lib().buildRenderSlide(...a)
export const createSystemFontMetrics = (...a) => lib().createSystemFontMetrics(...a)
export const resetFontRegistry = (...a) => lib().resetFontRegistry(...a)
export const tiffToPng = (...a) => lib().tiffToPng(...a)
`

let slidesStub: string | undefined

async function sessionStateModule(): Promise<J> {
  slidesStub ??= scratchFile('slides-stub.mjs', SLIDES_STUB)
  return loadPatched('apps/slides/src/main/session-state.ts', (src) => {
    let out = src
    for (const spec of [
      '@seuoffice/pptx-engine',
      '@seuoffice/pptx-render',
      './fonts',
      './tiff-decode',
    ]) {
      out = must(out, `from '${spec}'`, `from '${slidesStub}'`, 'session-state.ts')
    }
    out = must(
      out,
      "import { randomUUID } from 'node:crypto'",
      'const randomUUID = (): string => (globalThis as any).__b6Slides.uuid()',
      'session-state.ts',
    )
    return must(out, '__dirname', "'/dist/main'", 'session-state.ts')
  })
}

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'))
const snapJson = (s: J): J => ({
  slides: s.slides,
  entries: [...s.entries].map(([k, v]: [string, Uint8Array]) => [
    k,
    Buffer.from(v).toString('hex'),
  ]),
  size: s.size,
  metaDirty: s.metaDirty,
})
const stateJson = (s: J): J => ({
  path: s.path,
  undo: s.undoStack.map(snapJson),
  redo: s.redoStack.map(snapJson),
  batch: s.historyBatch
    ? {
        depth: s.historyBatch.depth,
        undoStart: s.historyBatch.undoStart,
        before: snapJson(s.historyBatch.before),
      }
    : null,
  aiSnapshots: s.aiSnapshots
    ? [...s.aiSnapshots].map(([id, snap]: [number, J]) => [id, snapJson(snap)])
    : null,
  aiRun: s.aiRun !== undefined,
  metaDirty: !!s.metaDirty,
  metaRev: s.metaRev ?? null,
  opSeq: s.opSeq ?? null,
  opLog: s.opLog ?? null,
  notify: !!s.historyNotifyScheduled,
  broadcast: !!s.deckBroadcastScheduled,
  updates: s.deckBroadcastUpdates ?? null,
})

interface SlidesSpec {
  path?: string
  deck: { slides: J[]; size: J }
  entries?: Record<string, string>
  fit?: number
  live?: number[]
  windows?: Record<string, { destroyed?: boolean }>
  fromWc?: Record<string, string>
  hookMap?: Record<string, string>
  chains?: Record<string, J>
  steps: J[]
}

async function runSessionState(spec: SlidesSpec, cx: TsContext): Promise<J> {
  const ss = await sessionStateModule()
  const fit = spec.fit ?? 1000
  let uuid = 0
  let created = 0
  let focused: string | null = null
  const makeSession = (path: string, slides: J[], size: J, entries: Map<string, Uint8Array>): J => {
    const opened = {
      deck: { slides: structuredClone(slides), size: { ...size } },
      archive: {
        entries,
        readBytes: (p: string) => entries.get(p),
        readText: (p: string) => {
          const bytes = entries.get(p)
          return bytes ? Buffer.from(bytes).toString('utf8') : null
        },
        resolveSlideChain: (p: string) => {
          cx.log('resolveSlideChain', p)
          return spec.chains?.[p] ?? {}
        },
      },
    }
    return { path, opened, fitWidthPx: fit, undoStack: [], redoStack: [] }
  }
  let session = makeSession(
    spec.path ?? '',
    spec.deck.slides,
    spec.deck.size,
    new Map(Object.entries(spec.entries ?? {}).map(([k, v]) => [k, bytesOf(v)])),
  )
  g.__b6Slides = {
    uuid: () => `uuid-${++uuid}`,
    buildRenderSlide: (slide: J, _size: J, options: J) => ({
      partPath: slide.path,
      slideNo: options.slideNo,
      fitWidthPx: options.fitWidthPx,
    }),
    createSystemFontMetrics: () => {
      cx.log('createSystemFontMetrics')
      return { id: ++created }
    },
    resetFontRegistry: () => cx.log('resetFontRegistry'),
    tiffToPng: (bytes: Uint8Array) =>
      bytes.length > 4 && bytes[4] !== 0 ? { png: Buffer.from('89504e47', 'hex') } : null,
    parseTheme: (xml: string) => {
      if (xml.includes('THROWTHEME')) throw new Error('bad theme')
      return {
        colors: Object.fromEntries(
          xml
            .split(',')
            .filter((p) => p.includes('='))
            .map((p) => p.split('=') as [string, string]),
        ),
      }
    },
    parseClrMap: (
      master: string | undefined,
      layout: string | undefined,
      slide: string | undefined,
    ) => {
      cx.log('parseClrMap', master ?? null, layout ?? null, slide ?? null)
      if ((layout ?? '').includes('THROWMAP')) throw new Error('bad map')
      return {}
    },
    resolveSchemeColor: (name: unknown, theme: J) =>
      typeof name === 'string' && Object.hasOwn(theme.colors, name)
        ? theme.colors[name]
        : undefined,
  }
  const windows = new Map<string, J>(
    Object.entries(spec.windows ?? {}).map(([name, w]) => [
      name,
      {
        name,
        isDestroyed: () => {
          cx.log('isDestroyed', name)
          return !!w.destroyed
        },
      },
    ]),
  )
  const win = (name: string | null | undefined): J =>
    name == null ? null : (windows.get(name) ?? null)
  const live = spec.live ?? []
  useElectron({
    webContents: {
      fromId: (id: number) =>
        live.includes(id)
          ? { send: (channel: string, payload: unknown) => cx.log('send', id, channel, payload) }
          : undefined,
    },
    BrowserWindow: {
      fromWebContents: (wc: J) => win(spec.fromWc?.[String(wc.id)]),
      getFocusedWindow: () => win(focused),
    },
  })
  const results: J[] = []
  try {
    for (const step of spec.steps) {
      let result: J = null
      switch (step.op) {
        case 'push':
          ss.pushHistory(session)
          break
        case 'begin':
          ss.beginHistoryBatch(session)
          break
        case 'end': {
          const collapsed = ss.endHistoryBatch(session)
          result = collapsed ? snapJson(collapsed) : null
          break
        }
        case 'edit':
          if (step.slides) session.opened.deck.slides = structuredClone(step.slides)
          if (step.size) session.opened.deck.size = { ...step.size }
          for (const [k, v] of Object.entries(step.set ?? {}))
            session.opened.archive.entries.set(k, bytesOf(v as string))
          for (const k of step.delete ?? []) session.opened.archive.entries.delete(k)
          break
        case 'restore': {
          const snap = (step.from === 'redo' ? session.redoStack : session.undoStack).pop()
          if (snap) ss.restoreSnapshot(session, snap)
          result = !!snap
          break
        }
        case 'registerAi':
          result = ss.registerAiSnapshot(session, ss.takeSnapshot(session))
          break
        case 'registerBefore':
          result = session.historyBatch
            ? ss.registerAiSnapshot(session, session.historyBatch.before)
            : null
          break
        case 'restoreAi':
          result = ss.restoreAiSnapshot(session, step.id)
          break
        case 'settle':
          ss.settleStaleHistoryBatch(session)
          break
        case 'setAiRun':
          session.aiRun = step.on ? {} : undefined
          break
        case 'meta':
          ss.markMetaDirty(session)
          break
        case 'journal':
          ss.journalOps(session, step.source, structuredClone(step.records))
          break
        case 'replace': {
          const next = makeSession(
            step.path ?? '',
            session.opened.deck.slides,
            session.opened.deck.size,
            new Map(session.opened.archive.entries),
          )
          ss.carryHistoryForReplacement(session, next)
          for (const [id, s] of ss.sessions) if (s === session) ss.sessions.set(id, next)
          session = next
          break
        }
        case 'broadcast':
          ss.scheduleDeckBroadcast(session)
          break
        case 'slideUpdate':
          result = ss.buildSlideUpdate(session, step.before ?? [], step.changed)
          break
        case 'flush':
          await new Promise((done) => setImmediate(done))
          break
        case 'attach':
          ss.sessions.set(step.wc, session)
          if (step.viewer) ss.viewerWcIds.add(step.wc)
          break
        case 'attached':
          result = { attached: ss.attachedIds(session), editors: ss.editorAttachedIds(session) }
          break
        case 'shell':
          ss.setSlidesShellWindow(win(step.window))
          break
        case 'hook':
          ss.setSlidesHostWindowHook(
            step.on ? (wc: J) => win(spec.hookMap?.[String(wc.id)]) ?? undefined : null,
          )
          break
        case 'host': {
          const found = ss.hostWindowFor({ id: step.wc })
          result = found ? found.name : null
          break
        }
        case 'dialogParent': {
          focused = step.focused ?? null
          const found = ss.dialogParent()
          result = found ? found.name : null
          break
        }
        case 'fontMetrics':
          if (step.do === 'reset') ss.resetFontMetrics()
          else result = ss.getFontMetrics().id
          break
        case 'resolve':
          result = ss.makeMediaResolver(session.opened, step.slidePath)(step.ref) ?? null
          break
        case 'read': {
          const found = ss.readSlideMedia(step.url)
          result = found
            ? { body: Buffer.from(found.body).toString('hex'), mime: found.mime }
            : null
          break
        }
        case 'prune':
          ss.pruneMediaSources(session)
          break
      }
      results.push(result)
    }
  } finally {
    delete g.__b6Slides
    // the sessions and viewers of this copy of the module are dropped with it
    ss.sessions.clear()
    ss.viewerWcIds.clear()
  }
  return { steps: results, state: stateJson(session) }
}

const S1 = 'ppt/slides/slide1.xml'
const S2 = 'ppt/slides/slide2.xml'
const S3 = 'ppt/slides/slide3.xml'
const slide = (path: string, elements: J[] = [], extra: J = {}): J => ({ path, elements, ...extra })
const slideNo = (): J => ({
  type: 'text',
  text: { paragraphs: [{ runs: [{ field: 'slidenum' }] }] },
})
const plainText = (): J => ({ type: 'text', text: { paragraphs: [{ runs: [{ text: 'hi' }] }] } })
const SIZE = { cx: 9144000, cy: 6858000 }
const DECK: SlidesSpec['deck'] = {
  slides: [
    slide(S1, [plainText()]),
    slide(S2, [{ type: 'group', children: [plainText(), slideNo()] }]),
    slide(S3, [], { decorations: [slideNo()] }),
  ],
  size: SIZE,
}
const slides = (...paths: string[]): J[] => paths.map((p) => slide(p, [plainText()]))
const push = (): J => ({ op: 'push' })
const flush = (): J => ({ op: 'flush' })
const edit1 = (name: string, hex: string): J => ({ op: 'edit', set: { [name]: hex } })
const state0 = (extra: Partial<SlidesSpec> = {}): SlidesSpec => ({
  deck: DECK,
  entries: { a: '0a', b: '0b' },
  live: [1, 2, 3],
  steps: [],
  ...extra,
})

const SVG = (rules: string): string =>
  Buffer.from(`<svg><style>${rules}</style><path/></svg>`).toString('hex')
const SVG_RULES =
  '.MsftOfcThm_Accent1_Fill { fill:#4472C4; } .MsftOfcThm_Accent1_Stroke { stroke:#4472C4; stroke-width:2 } ' +
  '.MsftOfcThm_Text1_Fill_v2 {fill:#000000} .MsftOfcThm_Background1_Fill{fill:#fff;stroke:#eee} ' +
  '.MsftOfcThm_Foo_Fill { fill:red } .MsftOfcThm_Hyperlink_Fill { fill : blue ; } .MsftOfcThm_constructor_Fill { fill:green } ' +
  '.MsftOfcThm_FollowedHyperlink_Stroke { stroke : #123 } .MsftOfcThm_Text2_Fill { fill:1 } .MsftOfcThm_Background2_Fill { fill:2 } ' +
  '.MsftOfcThm_Accent2_Fill { fill:3 } .MsftOfcThm_Accent3_Fill { fill:3 } .MsftOfcThm_Accent4_Fill { fill:3 } .MsftOfcThm_Accent5_Fill { fill:3 } .MsftOfcThm_Accent6_Fill { fill:3 }'
const MEDIA_ENTRIES: Record<string, string> = {
  'ppt/media/image1.png': '89504e470d0a1a0a',
  'ppt/media/image2.jpg':
    'ffd8ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
  'ppt/media/image3.tif': '49492a00ff',
  'ppt/media/image4.tif': '49492a0000',
  'ppt/media/image5.svg': SVG(SVG_RULES),
  'ppt/media/odd.constructor': '0102',
  'ppt/theme/theme1.xml': hexOf(
    'accent1=#FF0000,accent2=#00FF00,accent3=#0000FE,accent4=#111111,accent5=#222222,accent6=#333333,tx1=#0000FF,tx2=#444444,bg1=#FFFFFF,bg2=#555555,hlink=#00AAFF,folHlink=#AA00FF',
  ),
  'ppt/slideLayouts/l1.xml': hexOf('<layout/>'),
  'ppt/slideMasters/m1.xml': hexOf('<master/>'),
  [S1]: hexOf('<slide/>'),
  [S2]: hexOf('<slide2/>'),
}
const CHAIN = {
  [S1]: {
    themePath: 'ppt/theme/theme1.xml',
    layoutPath: 'ppt/slideLayouts/l1.xml',
    masterPath: 'ppt/slideMasters/m1.xml',
  },
  [S2]: { themePath: 'ppt/theme/theme1.xml' },
  [S3]: { layoutPath: 'ppt/slideLayouts/l1.xml' },
}
const mediaWorld = (steps: J[], extra: Partial<SlidesSpec> = {}): SlidesSpec => ({
  deck: DECK,
  entries: MEDIA_ENTRIES,
  chains: CHAIN,
  live: [1],
  steps,
  ...extra,
})
const resolve = (ref: string, slidePath?: string): J => ({ op: 'resolve', ref, slidePath })

const sessionState: Group = {
  'slides/session-state.scenario': {
    ts: (a, cx) => runSessionState(a[0] as SlidesSpec, cx),
    cases: [
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              push(),
              { op: 'edit', slides: slides(S1, S2) },
              push(),
              { op: 'edit', slides: slides(S1) },
              flush(),
              { op: 'restore' },
              { op: 'restore' },
              { op: 'restore' },
              { op: 'restore', from: 'redo' },
              flush(),
              push(),
              flush(),
            ],
          }),
        ],
        note: 'undo history: a push clears redo; the notification is coalesced per task',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              ...Array.from({ length: 53 }, (_, i): J[] => [
                edit1('a', i.toString(16).padStart(2, '0')),
                push(),
              ]).flat(),
              flush(),
            ],
          }),
        ],
        note: 'the history keeps the last fifty snapshots',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'attach', wc: 2 },
              { op: 'begin' },
              { op: 'begin' },
              push(),
              { op: 'edit', slides: slides(S1, S2) },
              push(),
              { op: 'end' },
              { op: 'end' },
              { op: 'end' },
              { op: 'end' },
              flush(),
              { op: 'begin' },
              { op: 'end' },
              { op: 'setAiRun', on: true },
              push(),
              flush(),
            ],
          }),
        ],
        note: 'nested batches collapse into the pre-transaction snapshot; no edit, nothing collapses; the AI flag',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'begin' },
              { op: 'begin' },
              push(),
              { op: 'edit', slides: slides(S3) },
              { op: 'settle' },
              { op: 'settle' },
              { op: 'begin' },
              { op: 'settle' },
            ],
          }),
        ],
        note: 'a batch that outlived its run is closed and kept as a rollback point',
      },
      {
        args: [
          state0({
            steps: [
              ...Array.from({ length: 22 }, (_, i): J[] => [
                edit1('b', i.toString(16).padStart(2, '0')),
                { op: 'registerAi' },
              ]).flat(),
              { op: 'restoreAi', id: 1 },
              { op: 'restoreAi', id: 22 },
              { op: 'restoreAi', id: 22 },
              { op: 'restoreAi', id: 2.5 },
              { op: 'restoreAi', id: 5 },
              flush(),
            ],
          }),
        ],
        note: 'twenty rollback points; ids that are gone; a restore is one undo step',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'meta' },
              { op: 'meta' },
              push(),
              { op: 'edit', slides: slides(S1) },
              { op: 'restore' },
              { op: 'meta' },
              {
                op: 'journal',
                source: 'edit',
                records: [
                  { op: { op: 'setText', text: 'a' }, slideId: 's1', created: ['x', 'y'] },
                  { op: { op: 'noop' }, slideId: '', created: [] },
                  { op: { op: 'move' } },
                ],
              },
              { op: 'journal', source: 'batch', records: [] },
              { op: 'journal', source: 'script', records: [{ op: { op: 'a' } }] },
              { op: 'restore' },
              push(),
              { op: 'restore' },
              { op: 'journal', source: 'generate', records: [{ op: { op: 'b' }, created: ['q'] }] },
            ],
          }),
        ],
        note: 'the meta counter; the op journal; a snapshot jump leaves a reset marker only once there is a journal',
      },
      {
        args: [
          state0({
            steps: [
              ...Array.from({ length: 205 }, (_, i): J => ({
                op: 'journal',
                source: 'edit',
                records: [{ op: { op: 'n', i } }],
              })),
              { op: 'edit', slides: slides(S1) },
              push(),
              { op: 'restore' },
            ],
          }),
        ],
        note: 'the journal keeps the last two hundred entries',
      },
      {
        args: [
          state0({
            path: 'deck.pptx',
            steps: [
              { op: 'attach', wc: 1 },
              push(),
              { op: 'setAiRun', on: true },
              { op: 'registerAi' },
              { op: 'replace', path: '' },
              flush(),
              { op: 'replace', path: 'other.pptx' },
              flush(),
            ],
          }),
        ],
        note: 'AI replaces the deck: history carries over; the run is kept only for an untitled deck',
      },
      {
        args: [
          state0({
            path: '',
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'setAiRun', on: true },
              { op: 'replace', path: '' },
              flush(),
            ],
          }),
        ],
        note: 'an untitled deck keeps its run',
      },
      {
        args: [
          state0({
            live: [1, 2],
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'attach', wc: 2 },
              { op: 'attach', wc: 3 },
              { op: 'attach', wc: 2, viewer: true },
              { op: 'attached' },
              { op: 'broadcast' },
              { op: 'broadcast' },
              push(),
              flush(),
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [0] },
              { op: 'broadcast' },
              flush(),
              { op: 'slideUpdate', before: [S1, S2], changed: [] },
              flush(),
            ],
          }),
        ],
        note: 'several windows on one deck; viewers; a broadcast resyncs fully; sends only to live windows',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'broadcast' },
              flush(),
              { op: 'attach', wc: 2 },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [1] },
              { op: 'slideUpdate', before: [S3, S1, S2] },
              { op: 'slideUpdate', before: [S1, 'gone', S2, S3] },
              flush(),
              { op: 'broadcast' },
              flush(),
            ],
          }),
        ],
        note: 'a lone window gets nothing; a second one gets the partial update',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'attach', wc: 2 },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [0] },
              { op: 'broadcast' },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [2] },
              flush(),
            ],
          }),
        ],
        note: 'an update noted after a queued edit replaces its place',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'attach', wc: 1 },
              { op: 'attach', wc: 2 },
              { op: 'broadcast' },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [2, 0] },
              { op: 'broadcast' },
              { op: 'edit', slides: slides(S1, S2) },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [1] },
              flush(),
            ],
          }),
        ],
        note: 'partial updates merge by part; a slide that left the order is dropped',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [0] },
              { op: 'attach', wc: 1 },
              { op: 'attach', wc: 2 },
              { op: 'broadcast' },
              { op: 'slideUpdate', before: [S2, S1, S3], changed: [] },
              { op: 'slideUpdate', before: [S1, S2, S3], changed: [0.5, 2] },
              flush(),
            ],
          }),
        ],
        note: 'slides that moved and hold a slide number are rebuilt; a fractional index is none',
      },
      {
        args: [
          state0({
            windows: { shellWin: {}, tab: {}, hook: {}, gone: { destroyed: true } },
            fromWc: { '5': 'tab', '6': 'gone', '7': 'gone' },
            hookMap: { '7': 'hook', '8': 'hook', '6': 'gone' },
            steps: [
              { op: 'host', wc: 5 },
              { op: 'shell', window: 'shellWin' },
              { op: 'host', wc: 5 },
              { op: 'host', wc: 6 },
              { op: 'host', wc: 9 },
              { op: 'hook', on: true },
              { op: 'host', wc: 7 },
              { op: 'host', wc: 8 },
              { op: 'host', wc: 6 },
              { op: 'shell', window: 'gone' },
              { op: 'host', wc: 9 },
              { op: 'hook', on: false },
              { op: 'host', wc: 8 },
              { op: 'shell', window: null },
              { op: 'host', wc: 8 },
              { op: 'dialogParent', focused: null },
              { op: 'dialogParent', focused: 'tab' },
              { op: 'shell', window: 'shellWin' },
              { op: 'dialogParent', focused: null },
              { op: 'dialogParent', focused: 'gone' },
            ],
          }),
        ],
        note: 'the window a tab lives in: its own, the hook, the shell window; the dialog parent',
      },
      {
        args: [
          state0({
            steps: [
              { op: 'fontMetrics' },
              { op: 'fontMetrics' },
              { op: 'fontMetrics', do: 'reset' },
              { op: 'fontMetrics' },
              { op: 'slideUpdate', before: [] },
              { op: 'fontMetrics', do: 'reset' },
              { op: 'broadcast' },
            ],
          }),
        ],
        note: 'the font metrics are built once and rebuilt after a reset',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image1.png'),
            resolve('ppt/media/image1.png'),
            resolve('ppt/media/image2.jpg'),
            resolve('ppt/media/missing.png'),
            resolve('ppt/media/odd.constructor'),
            resolve('ppt/media/image3.tif'),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fpng' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Fjpeg' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-3?mime=image%2Fx' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-9' },
          ]),
        ],
        note: 'opaque URLs per bytes and mime; a mislabeled part; display conversions',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image3.tif'),
            resolve('ppt/media/image4.tif'),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Ftiff' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Ftiff' },
          ]),
        ],
        note: 'TIFF becomes PNG when it decodes, else nothing',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image5.svg', S1),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fsvg%2Bxml' },
            resolve('ppt/media/image5.svg', S2),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Fsvg%2Bxml' },
            resolve('ppt/media/image5.svg', S3),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-3?mime=image%2Fsvg%2Bxml' },
            resolve('ppt/media/image5.svg'),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-4?mime=image%2Fsvg%2Bxml' },
            resolve('ppt/media/image5.svg', S1),
          ]),
        ],
        note: 'a themed SVG is retinted per slide; its URL depends on the slide, layout, master and theme bytes',
      },
      {
        args: [
          mediaWorld(
            [
              resolve('ppt/media/image5.svg', S1),
              { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fsvg%2Bxml' },
            ],
            {
              entries: {
                ...MEDIA_ENTRIES,
                'ppt/theme/theme1.xml': hexOf('THROWTHEME,accent1=#FF0000'),
              },
            },
          ),
        ],
        note: 'a theme that does not parse leaves the SVG as it is',
      },
      {
        args: [
          mediaWorld(
            [
              resolve('ppt/media/image5.svg', S1),
              { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fsvg%2Bxml' },
            ],
            { entries: { ...MEDIA_ENTRIES, 'ppt/slideLayouts/l1.xml': hexOf('THROWMAP') } },
          ),
        ],
        note: 'a color map that does not parse leaves the SVG as it is',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image5.svg', 'ppt/slides/none.xml'),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fsvg%2Bxml' },
            resolve('ppt/media/image5.svg', ''),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Fsvg%2Bxml' },
          ]),
        ],
        note: 'a slide without a theme chain; an empty slide path',
      },
      {
        args: [
          mediaWorld(
            [
              resolve('ppt/media/image5.svg'),
              { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fsvg%2Bxml' },
            ],
            { deck: { slides: [], size: SIZE } },
          ),
        ],
        note: 'no slide at all: no chain to read',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image1.png'),
            push(),
            edit1('ppt/media/image1.png', 'aabbccdd'),
            resolve('ppt/media/image1.png'),
            { op: 'prune' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fpng' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Fpng' },
            { op: 'restore' },
            resolve('ppt/media/image1.png'),
            { op: 'edit', delete: ['ppt/media/image1.png'] },
            { op: 'prune' },
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-2?mime=image%2Fpng' },
            { op: 'prune' },
            { op: 'flush' },
          ]),
        ],
        note: 'a replacement gets a new URL, undo the old one; pruning keeps what the archive and the history hold',
      },
      {
        args: [
          mediaWorld([
            resolve('ppt/media/image1.png'),
            { op: 'attach', wc: 1 },
            { op: 'edit', set: { 'ppt/media/image1.png': 'ff' } },
            push(),
            { op: 'begin' },
            { op: 'registerBefore' },
            { op: 'edit', delete: ['ppt/media/image1.png'] },
            flush(),
            { op: 'read', url: 'seuoffice-slide-media://archive/uuid-1?mime=image%2Fpng' },
          ]),
        ],
        note: 'history, the open batch and rollback points hold bytes against the flush prune',
      },
    ],
  },
}

export const group: Group = {
  ...elementClipboard,
  ...fontStore,
  ...sheetsFonts,
  ...previewProtocol,
  ...markdownPrint,
  ...updater,
  ...diagramSession,
  ...lazyMedia,
  ...imageEdit,
  ...sessionState,
}
