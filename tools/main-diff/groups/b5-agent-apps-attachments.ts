/**
 * `{diagram,epub,mindmap}/ai-attachments`: the AI panel's attachments. Each
 * module is loaded as a patched copy per case (its module state, the text
 * cache, the pasted-picture counter and the one-time prune, starts afresh):
 * `parseFileToText`, `diagramPictureExtOf` and `assertFileSaved` are stubs
 * the case's `ctx` drives, the files are the case's own folder, and the
 * clock is the comparison's.
 *
 * ctx: `{ lang?, temp?, diagram?: { path: ext }, saved?: { path: message } (the message is
 * the shell's own: the Rust side reads the file as open and dirty),
 * parse?: { path: { ok, kind?, text?, damaged?, error? } | { throw } },
 * hasFile?: { id: bool } }`. Each call of a stub is one log line.
 *
 * Scenario steps of `registerXAiIpc` (the handlers of `ipcMain`): `register`,
 * `hook`, `pick`, `add`, `paste`, `read`, `readImage`, `title`.
 */
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'
import { g, loadPatched, must, repoUrl, tick, type J } from './b5-agent-apps-lib.ts'

const diagramIpc = await import('../../../apps/diagram/src/shared/ipc.ts')
const epubIpc = await import('../../../apps/epub/src/shared/ipc.ts')
const mindmapIpc = await import('../../../apps/mindmap/src/shared/ipc.ts')

const NOW = 1_794_452_400_000
const OLD = 1_700_000_000_000

type AppId = 'diagram' | 'epub' | 'mindmap'

interface Ctx {
  lang?: string
  temp?: string
  diagram?: Record<string, string>
  saved?: Record<string, string>
  parse?: Record<string, J>
  hasFile?: Record<string, boolean>
  channels?: string[]
}

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

/** `Date` and `Date.now` of the comparison's clock while `run` runs */
async function withClock<T>(run: () => Promise<T> | T): Promise<T> {
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(NOW)
      else super(...(args as [number]))
    }
    static now(): number {
      return NOW
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor
  try {
    return await run()
  } finally {
    globalThis.Date = RealDate
  }
}

/** the tables of a case are keyed by file name */
const baseOf = (path: string): string => path.replace(/^.*[\\/]/, '')

async function attachmentsModule(
  app: AppId,
  ctx: Ctx,
  log: (...args: unknown[]) => void,
): Promise<J> {
  setUiLang((ctx.lang ?? 'en') as 'en')
  g.__b5Attach = {
    assertSaved: async (path: string) => {
      log('assertFileSaved', path)
      const message = ctx.saved?.[baseOf(path)]
      if (message !== undefined) throw new Error(message)
    },
    parse: async (path: string) => {
      log('parseFileToText', path)
      const result = ctx.parse?.[baseOf(path)]
      if (result?.throw !== undefined) throw new Error(result.throw)
      return result ?? { ok: false }
    },
    diagramExt: (path: string) => {
      log('diagramPictureExtOf', path)
      return ctx.diagram?.[baseOf(path)] ?? null
    },
  }
  return loadPatched(`apps/${app}/src/main/ai-attachments.ts`, (src) => {
    let out = must(
      src,
      "import { assertFileSaved, showOpenDialogWithMemory } from '@seuoffice/electron-utils'",
      [
        "import { showOpenDialogWithMemory } from '@seuoffice/electron-utils'",
        'const assertFileSaved = (path: string): any => (globalThis as any).__b5Attach.assertSaved(path)',
      ].join('\n'),
      `${app}/ai-attachments.ts`,
    )
    out = out.replace(
      /import \{[^}]*\} from '@seuoffice\/file-parse'/,
      [
        `import { ATTACHABLE_EXTS, ATTACHABLE_IMAGE_EXTS, ATTACHABLE_MAX_BYTES, attachableMaxBytes, ATTACHABLE_IMAGE_MAX_BYTES, diagramPictureExtOfName } from '${repoUrl('packages/file-parse/src/attachable.ts')}'`,
        'const parseFileToText = (path: string): any => (globalThis as any).__b5Attach.parse(path)',
        'const diagramPictureExtOf = (path: string): any => (globalThis as any).__b5Attach.diagramExt(path)',
      ].join('\n'),
    )
    return out
  })
}

const tempOf = (ctx: Ctx): J => ({
  getPath: (name: string) => {
    ;(g.__b5AttachLog as (...a: unknown[]) => void)('getPath', name)
    return ctx.temp ?? '/tmp/none'
  },
})

/** the electron the module reaches without a dialog */
function useTemp(ctx: Ctx, log: (...args: unknown[]) => void): void {
  g.__b5AttachLog = log
  useElectron({ app: tempOf(ctx) })
}

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const TEXT = (text: string, over: J = {}): J => ({ ok: true, kind: 'text', text, ...over })

/** a folder of attachments: names, sizes and ages */
const FILES = (): Record<string, J> => ({
  'a.txt': 'hello world',
  'notes.MD': { text: '# notes', mtimeMs: OLD },
  'sheet.xlsx': { hex: '504b0304', mtimeMs: OLD },
  'huge.bin.txt': { text: 'x'.repeat(100) },
  'pic.png': { hex: '89504e470d0a1a0a', mtimeMs: OLD },
  'pic.JPG': { hex: 'ffd8ffe0', mtimeMs: OLD },
  'pic.webp': { hex: '52494646', mtimeMs: OLD },
  noext: 'no extension',
  'trailing.': 'trailing dot',
  'archive.zip': 'zip',
  'folder.txt': { dir: true },
  'map.drawio.svg': '<svg/>',
  'chart.DRAWIO.PNG': { hex: '89504e47' },
  'plain.drawio.png': { hex: '89504e47' },
  'flow.drawio': '<mxfile/>',
  'old.dio': '<mxfile/>',
  'book.epub': { hex: '504b0304' },
  'outline.xmind': { hex: '504b0304' },
  'script.ts': 'export {}',
  'weird.constructor': 'x',
  'weird.__proto__': 'x',
})

const D = '$DIR/'

const collectCases = (): Case[] => [
  {
    args: [[`${D}a.txt`, `${D}notes.MD`, `${D}sheet.xlsx`], {}],
    files: FILES(),
    note: 'text, markdown and an office file',
  },
  { args: [[`${D}pic.png`, `${D}pic.JPG`, `${D}pic.webp`], {}], files: FILES(), note: 'pictures' },
  {
    args: [
      [`${D}noext`, `${D}trailing.`, `${D}archive.zip`, `${D}missing.txt`, `${D}folder.txt`],
      {},
    ],
    files: FILES(),
    note: 'rejected: extension, missing, a folder',
  },
  {
    args: [
      [
        `${D}map.drawio.svg`,
        `${D}chart.DRAWIO.PNG`,
        `${D}plain.drawio.png`,
        `${D}flow.drawio`,
        `${D}old.dio`,
      ],
      { diagram: { 'map.drawio.svg': 'drawio.svg', 'chart.DRAWIO.PNG': 'drawio.png' } },
    ],
    files: FILES(),
    note: 'a draw.io picture that holds its diagram is read as a diagram',
  },
  {
    args: [
      [
        `${D}book.epub`,
        `${D}outline.xmind`,
        `${D}script.ts`,
        `${D}weird.constructor`,
        `${D}weird.__proto__`,
      ],
      {},
    ],
    files: FILES(),
    note: 'other kinds',
  },
  {
    args: [[5, null, '', `${D}a.txt`, ['x'], {}, true], { lang: 'ko' }],
    files: FILES(),
    note: 'only strings that are not empty are looked at; Korean',
  },
  { args: [[], {}], note: 'nothing' },
  {
    args: [
      [`${D}over.txt`, `${D}limit.txt`, `${D}over.docx`, `${D}over.png`, `${D}limit.png`],
      { lang: 'ko' },
    ],
    files: {
      'over.txt': { text: 'x'.repeat(50 * 1024 * 1024 + 1) },
      'limit.txt': { text: 'x'.repeat(50 * 1024 * 1024) },
      'over.docx': { text: 'x'.repeat(50 * 1024 * 1024 + 1) },
      'over.png': { hex: '61'.repeat(5 * 1024 * 1024 + 1) },
      'limit.png': { hex: '61'.repeat(5 * 1024 * 1024) },
    },
    note: 'the size limits: text 50 MB, pictures 5 MB, office files none',
  },
  {
    args: [[`${D}pic.png`, `${D}missing.png`], { lang: 'ko' }],
    files: FILES(),
    note: 'Korean reasons',
  },
  {
    args: [[`${D}over.txt`], {}],
    files: { 'over.txt': { text: 'x'.repeat(50 * 1024 * 1024 + 1) } },
    note: 'the too large text, in English',
  },
  {
    args: [[`${D}pic.png`, `${D}a.txt`, `${D}notes.MD`], {}],
    files: { ...FILES(), 'pic.png': { hex: '89504e47'.repeat(5) } },
    note: 'what is accepted, with the size of each file in bytes',
  },
]

const pageCases = (): Case[] => {
  const text = 'abcdefghij'.repeat(10)
  const files = {
    ...FILES(),
    'long.txt': text,
    'emoji.txt': '\u{1F600}a\u{1F600}b',
    'doc.docx': { hex: '504b0304', mtimeMs: OLD },
    'cached.txt': { text: 'cached', mtimeMs: OLD },
    'huge.md': { text: 'y'.repeat(20) },
  }
  const parse = (path: string, result: J): Record<string, J> => ({ [path]: result })
  return [
    {
      args: [
        [
          { read: [`${D}long.txt`, 5, 10] },
          { read: [`${D}long.txt`, 95, 100] },
          { read: [`${D}long.txt`, 500, 10] },
        ],
        { parse: parse('long.txt', TEXT(text)) },
      ],
      files,
      note: 'a page, the end, past the end',
    },
    {
      args: [
        [
          { read: [`${D}long.txt`, '7', '3'] },
          { read: [`${D}long.txt`, -5, 3] },
          { read: [`${D}long.txt`, 2.9, 2.9] },
          { read: [`${D}long.txt`, null, null] },
          { read: [`${D}long.txt`] },
          { read: [`${D}long.txt`, 'x', 0] },
          { read: [`${D}long.txt`, 0, -4] },
        ],
        { parse: parse('long.txt', TEXT(text)) },
      ],
      files,
      note: 'offsets and sizes read as numbers',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 1e9] }],
        { parse: parse('long.txt', TEXT('z'.repeat(60000))) },
      ],
      files,
      note: 'one read hands back at most 48,000 characters',
    },
    {
      args: [
        [{ read: [`${D}emoji.txt`, 1, 3] }],
        { parse: parse('emoji.txt', TEXT('\u{1F600}a\u{1F600}b')) },
      ],
      files,
      note: 'UTF-16 offsets',
    },
    {
      args: [
        [
          { read: [`${D}doc.docx`, 0, 5] },
          { read: [`${D}doc.docx`, 0, 5] },
          { write: { path: `${D}doc.docx`, text: 'changed content', mtimeMs: OLD } },
          { read: [`${D}doc.docx`, 0, 5] },
          { read: [`${D}cached.txt`, 0, 5] },
        ],
        {
          parse: {
            ...parse('doc.docx', TEXT('first read')),
            ...parse('cached.txt', TEXT('cached')),
          },
        },
      ],
      files,
      note: 'a file read twice is parsed once; a changed file is read again',
    },
    {
      args: [
        [
          { read: [`${D}pic.png`, 0, 5] },
          { read: [`${D}archive.zip`, 0, 5] },
          { read: ['', 0, 5] },
          { read: [5, 0, 5] },
          { read: [null] },
        ],
        { lang: 'ko' },
      ],
      files,
      note: 'a picture has no text; other kinds; no path',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        {
          saved: { 'long.txt': 'This file is open with unsaved changes. Save it, then try again.' },
          parse: parse('long.txt', TEXT(text)),
        },
      ],
      files,
      note: 'a file with unsaved changes is not read',
    },
    { args: [[{ read: [`${D}missing.txt`, 0, 5] }], {}], files, note: 'a file that is gone' },
    {
      args: [[{ read: [`${D}huge.md`, 0, 5] }], { parse: parse('huge.md', TEXT('ok')) }],
      files,
      note: 'a text file within the cap',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: false, error: 'locked file' }) },
      ],
      files,
      note: 'a reader that fails with its own words',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        {
          parse: parse('long.txt', { ok: false, damaged: true, error: 'damaged zip' }),
          lang: 'ko',
        },
      ],
      files,
      note: 'a damaged file hides its error',
    },
    {
      args: [
        [
          ...Array.from({ length: 9 }, (_, i) => ({ read: [`${D}f${i}.txt`, 0, 3] })),
          { read: [`${D}f1.txt`, 0, 3] },
          { read: [`${D}f0.txt`, 0, 3] },
        ],
        {
          parse: Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [`f${i}.txt`, TEXT(`text ${i}`)]),
          ),
        },
      ],
      files: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}.txt`, `file ${i}`])),
      note: 'the cache holds eight texts: the oldest is read again',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: false, error: '' }) },
      ],
      files,
      note: 'a reader that fails with an empty message',
    },
    {
      args: [[{ read: [`${D}long.txt`, 0, 5] }], { parse: parse('long.txt', { ok: false }) }],
      files,
      note: 'a reader that says nothing',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: true, kind: 'pdf', text: 'x' }) },
      ],
      files,
      note: 'not a text answer',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: true, kind: 'text' }) },
      ],
      files,
      note: 'a text answer without text',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: false, kind: 'text', text: 'x' }) },
      ],
      files,
      note: 'not ok',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { throw: 'reader crashed' }) },
      ],
      files,
      note: 'a reader that throws',
    },
    {
      args: [
        [{ read: [`${D}long.txt`, 0, 5] }],
        { parse: parse('long.txt', { ok: true, kind: 'text', text: '', error: 'x' }) },
      ],
      files,
      note: 'empty text is text',
    },
    {
      args: [
        [
          { read: [`${D}map.drawio.svg`, 0, 50] },
          { read: [`${D}chart.DRAWIO.PNG`, 0, 50] },
          { read: [`${D}plain.drawio.png`, 0, 50] },
        ],
        {
          diagram: { 'map.drawio.svg': 'drawio.svg' },
          parse: {
            ...parse('map.drawio.svg', TEXT('diagram table')),
            ...parse('chart.DRAWIO.PNG', TEXT('capped diagram')),
            ...parse('plain.drawio.png', TEXT('picture-named')),
          },
        },
      ],
      files,
      note: 'a diagram picture is text; one that only carries the name is a picture',
    },
    {
      args: [
        [
          { read: [`${D}over.txt`, 0, 5] },
          { read: [`${D}limit.txt`, 0, 5] },
          { read: [`${D}over.docx`, 0, 5] },
        ],
        { parse: { ...parse('limit.txt', TEXT('limit')), ...parse('over.docx', TEXT('docx')) } },
      ],
      files: {
        'over.txt': { text: 'x'.repeat(50 * 1024 * 1024 + 1) },
        'limit.txt': { text: 'x'.repeat(50 * 1024 * 1024) },
        'over.docx': { text: 'x'.repeat(50 * 1024 * 1024 + 1) },
      },
      note: 'the size cap applies to plain text, not to office files',
    },
  ]
}

const imageCases = (): Case[] => [
  { args: [`${D}pic.png`, {}], files: FILES(), note: 'png' },
  { args: [`${D}pic.JPG`, {}], files: FILES() },
  { args: [`${D}pic.webp`, {}], files: FILES() },
  { args: [`${D}a.txt`, { lang: 'ko' }], files: FILES(), note: 'not a picture' },
  { args: [`${D}missing.png`, {}], files: FILES(), note: 'a picture that is gone' },
  {
    args: [`${D}folder.png`, { lang: 'ko' }],
    files: { 'folder.png': { dir: true } },
    note: 'a folder named like a picture',
  },
  {
    args: [`${D}big.png`, {}],
    files: { 'big.png': { hex: '00'.repeat(5 * 1024 * 1024 + 1) } },
    note: 'over the 5 MB limit',
  },
  {
    args: [`${D}ok.png`, {}],
    files: { 'ok.png': { hex: '00'.repeat(5 * 1024 * 1024) } },
    note: 'at the limit',
  },
  {
    args: [`${D}weird.constructor`, {}],
    files: FILES(),
    note: 'an extension every object inherits',
  },
  { args: [`${D}weird.__proto__`, {}], files: FILES(), note: 'another one' },
  { args: ['', {}], note: 'no path' },
  { args: [5, {}], note: 'not a path' },
  { args: [null, {}] },
  { args: ['pic.gif', {}], note: 'a relative path' },
  { args: [`${D}dot.`, {}], files: { 'dot.': 'x' } },
]

// ---------------------------------------------------------------------------
// the scenarios of the handlers
// ---------------------------------------------------------------------------

interface RegStep {
  register?: boolean
  hook?: boolean
  pick?: { win?: 'sender' | 'focused' | 'none'; response: J }
  add?: unknown
  paste?: { kind: 'buffer' | 'view' | 'other'; hex?: string; ext?: unknown }
  read?: unknown[]
  readImage?: unknown
  title?: { value?: unknown; sender?: number }
}

const hookSetter: Record<AppId, string | null> = {
  diagram: 'setDiagramProvisionalTitleHook',
  epub: null,
  mindmap: 'setMindmapProvisionalTitleHook',
}
const registerFn: Record<AppId, string> = {
  diagram: 'registerDiagramAiIpc',
  epub: 'registerEpubAiIpc',
  mindmap: 'registerMindmapAiIpc',
}
const channelsOf: Record<AppId, J> = {
  diagram: diagramIpc.DIAGRAM_CHANNELS,
  epub: epubIpc.EPUB_CHANNELS,
  mindmap: mindmapIpc.MINDMAP_CHANNELS,
}

async function runRegister(app: AppId, a: unknown[], cx: TsContext): Promise<unknown> {
  const steps = a[0] as RegStep[]
  const ctx = (a[1] ?? {}) as Ctx
  const log = cx.log
  const channels = channelsOf[app]
  const handlers = new Map<string, (...args: J[]) => unknown>()
  const registered: string[] = []
  let current: RegStep = {}
  const WIN = { id: 'win' }
  const record = (name: string, args: unknown[]): void => {
    if (args.length === 2) log(name, '<window>', args[1])
    else log(name, args[0])
  }
  g.__b5AttachLog = log
  useElectron({
    app: tempOf(ctx),
    ipcMain: {
      handle: (channel: string, fn: (...args: J[]) => unknown) => {
        registered.push(channel)
        handlers.set(channel, fn)
      },
      on: (channel: string, fn: (...args: J[]) => unknown) => {
        registered.push(`on:${channel}`)
        handlers.set(channel, fn)
      },
    },
    BrowserWindow: {
      fromWebContents: () => (current.pick?.win === 'sender' ? WIN : null),
      getFocusedWindow: () => (current.pick?.win === 'focused' ? WIN : null),
    },
    dialog: {
      showOpenDialog: async (...args: unknown[]) => {
        record('showOpenDialog', args)
        return current.pick?.response
      },
    },
  })
  const mod = await attachmentsModule(app, ctx, log)
  // a module that checks the window by id needs `useElectron` again after the load
  const hasFile = (id: number): boolean => {
    log('hasFile', id)
    return ctx.hasFile?.[String(id)] ?? false
  }
  const answers: unknown[] = []
  return withClock(async () => {
    for (const step of steps) {
      current = step
      if (step.register) {
        const before = registered.length
        if (app === 'epub') mod[registerFn[app]]()
        else mod[registerFn[app]]({ hasFile })
        answers.push(registered.slice(before))
      } else if (step.hook !== undefined) {
        mod[hookSetter[app]!](
          step.hook ? (wc: J, title: string) => log('hook', wc.id, title) : null,
        )
        answers.push(null)
      } else if (step.pick) {
        answers.push((await handlers.get(channels.filesPick)!({ sender: { id: 5 } })) ?? null)
      } else if (step.add !== undefined) {
        answers.push(await handlers.get(channels.filesAdd)!({}, step.add))
      } else if (step.paste) {
        const bytes = Buffer.from(step.paste.hex ?? '', 'hex')
        let data: unknown
        if (step.paste.kind === 'buffer')
          data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        else if (step.paste.kind === 'view') {
          const big = new Uint8Array(bytes.length + 6)
          big.set(bytes, 3)
          data = big.subarray(3, 3 + bytes.length)
        } else data = 'text'
        answers.push(await handlers.get(channels.filesAddPastedImage)!({}, data, step.paste.ext))
      } else if (step.read) {
        answers.push(await handlers.get(channels.filesRead)!({}, ...step.read))
      } else if (step.readImage !== undefined) {
        answers.push(await handlers.get(channels.filesReadImage)!({}, step.readImage))
      } else if (step.title) {
        handlers.get(channels.provisionalTitle)!(
          { sender: { id: step.title.sender ?? 5 } },
          step.title.value,
        )
        answers.push(null)
      }
      await tick(2)
    }
    return { answers, registered }
  })
}

const regChannels = (app: AppId): string[] => {
  const c = channelsOf[app]
  const list = [c.filesPick, c.filesAdd, c.filesAddPastedImage, c.filesRead, c.filesReadImage]
  return app === 'epub' ? list : [...list, `on:${c.provisionalTitle}`]
}

const PNG = '89504e470d0a1a0a'
const picked = (...files: string[]): J => ({ canceled: false, filePaths: files })

const regCases = (app: AppId): Case[] => {
  const base: Case[] = [
    {
      args: [
        [
          { register: true },
          { register: true },
          { add: [`${D}a.txt`, `${D}pic.png`, `${D}zip.zip`] },
          { add: 'not a list' },
          { add: null },
        ],
        { lang: 'ko', temp: `${D}tmp` },
      ],
      files: { ...FILES(), 'zip.zip': 'z' },
      note: 'registration (a diagram registers once) and the files of the panel',
    },
    {
      args: [
        [
          { register: true },
          { pick: { win: 'sender', response: picked(`${D}a.txt`, `${D}pic.png`) } },
          { pick: { win: 'focused', response: picked(`${D}notes.MD`) } },
          { pick: { win: 'none', response: { canceled: true, filePaths: [] } } },
          { pick: { response: { canceled: false, filePaths: [] } } },
        ],
        { temp: `${D}tmp` },
      ],
      files: FILES(),
      note: 'the dialog: the window, the memory of the last folder, cancel, an empty pick',
    },
    {
      args: [
        [
          { register: true },
          { paste: { kind: 'buffer', hex: PNG, ext: 'PNG' } },
          { paste: { kind: 'view', hex: PNG, ext: 'jpg' } },
          { paste: { kind: 'buffer', hex: PNG, ext: 'png' } },
          { paste: { kind: 'other', ext: 'png' } },
          { paste: { kind: 'buffer', hex: '', ext: 'png' } },
          { paste: { kind: 'buffer', hex: PNG, ext: 'txt' } },
          { paste: { kind: 'buffer', hex: PNG, ext: 5 } },
        ],
        { temp: `${D}tmp`, lang: 'ko' },
      ],
      files: {
        'tmp/seuoffice-pasted/pasted-mid.png': { hex: PNG, mtimeMs: NOW - 3 * 86_400_000 },
        'tmp/seuoffice-pasted/pasted-8d.png': { hex: PNG, mtimeMs: NOW - 8 * 86_400_000 },
        'tmp/seuoffice-pasted/pasted-old.png': { hex: PNG, mtimeMs: OLD },
        'tmp/seuoffice-pasted/pasted-new.png': { hex: PNG },
        'tmp/seuoffice-pasted/sub': { dir: true },
      },
      note: 'pasted pictures: kinds of data, extensions, the numbering; the first one prunes the old ones',
    },
    {
      args: [
        [
          { register: true },
          { paste: { kind: 'buffer', hex: '61'.repeat(5 * 1024 * 1024 + 1), ext: 'png' } },
          { paste: { kind: 'view', hex: '61'.repeat(5 * 1024 * 1024), ext: 'png' } },
        ],
        { temp: `${D}tmp3` },
      ],
      note: 'a pasted picture over the limit is not written; one at the limit is',
    },
    {
      args: [
        [
          { register: true },
          { paste: { kind: 'buffer', hex: PNG, ext: 'gif' } },
          { paste: { kind: 'buffer', hex: PNG, ext: 'webp' } },
        ],
        { temp: `${D}tmp2` },
      ],
      note: 'the folder is made; the prune runs once',
    },
    {
      args: [
        [
          { register: true },
          { read: [`${D}long.txt`, 0, 4] },
          { readImage: `${D}pic.png` },
          { readImage: `${D}a.txt` },
        ],
        { parse: { 'long.txt': TEXT('abcdefgh') } },
      ],
      files: { ...FILES(), 'long.txt': 'abcdefgh' },
      note: 'reading through the channels',
    },
  ]
  if (app === 'epub') return base
  return [
    ...base,
    {
      args: [
        [
          { register: true },
          { title: { value: '  A  title\n with   spaces ', sender: 5 } },
          { hook: true },
          { title: { value: '  A  title\n with   spaces ', sender: 5 } },
          { title: { value: 'has a file', sender: 6 } },
          { title: { value: '   ', sender: 5 } },
          { title: { value: 7, sender: 5 } },
          { title: { value: 'x'.repeat(100), sender: 5 } },
          { hook: false },
          { title: { value: 'late', sender: 5 } },
        ],
        { hasFile: { '6': true } },
      ],
      note: 'the provisional name: only a string, only for a view without a file, cleaned, cut at 80, and only while a hook is set',
    },
    {
      args: [
        [
          { register: true },
          { title: { value: '\u{1F600}'.repeat(50) } },
          { hook: true },
          { title: { value: '\u{1F600}'.repeat(50) } },
        ],
        {},
      ],
      note: 'the cut counts UTF-16 units',
    },
  ]
}

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

function attachmentFns(app: AppId): Group {
  const prefix = `${app}/ai-attachments.`
  const fns: Group = {
    [`${prefix}ATTACHMENT_MAX_BYTES`]: constant(50 * 1024 * 1024),
    [`${prefix}ATTACHMENT_IMAGE_MAX_BYTES`]: constant(5 * 1024 * 1024),
    [`${prefix}ATTACHMENT_READ_MAX_CHARS`]: constant(48000),
    [`${prefix}ATTACHMENT_EXTS`]: {
      ts: async (_a, cx) => [...(await attachmentsModule(app, {}, cx.log)).ATTACHMENT_EXTS],
      cases: [{ args: [] }],
      single: 'a constant',
    },
    [`${prefix}collectAttachments`]: {
      ts: (a, cx) => withClockCall(app, a, cx, (mod) => mod.collectAttachments(a[0] as unknown[])),
      cases: collectCases(),
    },
    [`${prefix}readAttachmentPage`]: {
      ts: (a, cx) => runPages(app, a, cx),
      cases: pageCases(),
    },
    [`${prefix}readAttachmentImage`]: {
      ts: (a, cx) => withClockCall(app, a, cx, (mod) => mod.readAttachmentImage(a[0])),
      cases: imageCases(),
    },
    [`${prefix}${registerFn[app]}`]: {
      ts: (a, cx) => runRegister(app, a, cx),
      cases: regCases(app).map((c): Case => ({
        ...c,
        args: [c.args[0], { ...(c.args[1] as Ctx), channels: regChannels(app) }],
      })),
    },
  }
  const setter = hookSetter[app]
  if (setter) {
    fns[`${prefix}${setter}`] = {
      ts: (a, cx) => runRegister(app, a, cx),
      cases: [
        {
          args: [
            [
              { register: true },
              { hook: true },
              { title: { value: 'first' } },
              { hook: false },
              { title: { value: 'second' } },
            ],
            { channels: regChannels(app) },
          ],
        },
        {
          args: [
            [{ register: true }, { title: { value: 'no hook' } }],
            { channels: regChannels(app) },
          ],
        },
        {
          args: [
            [{ register: true }, { hook: true }, { hook: true }, { title: { value: 'again' } }],
            { channels: regChannels(app) },
          ],
        },
      ],
    }
  }
  return fns
}

/** one call of an exported function over a fresh copy of the module */
async function withClockCall(
  app: AppId,
  a: unknown[],
  cx: TsContext,
  run: (mod: J) => unknown,
): Promise<unknown> {
  const ctx = (a[1] ?? {}) as Ctx
  useTemp(ctx, cx.log)
  const mod = await attachmentsModule(app, ctx, cx.log)
  return withClock(() => run(mod))
}

interface PageStep {
  read?: unknown[]
  write?: { path: string; text: string; mtimeMs?: number }
}

async function runPages(app: AppId, a: unknown[], cx: TsContext): Promise<unknown> {
  const steps = a[0] as PageStep[]
  const ctx = (a[1] ?? {}) as Ctx
  useTemp(ctx, cx.log)
  const mod = await attachmentsModule(app, ctx, cx.log)
  const { writeFileSync, utimesSync } = await import('node:fs')
  const answers: unknown[] = []
  for (const step of steps) {
    if (step.write) {
      writeFileSync(step.write.path, step.write.text)
      if (step.write.mtimeMs !== undefined) {
        utimesSync(step.write.path, step.write.mtimeMs / 1000, step.write.mtimeMs / 1000)
      }
    } else if (step.read) {
      answers.push(await mod.readAttachmentPage(...step.read))
    }
  }
  return answers
}

export const attachmentsGroup: Group = {
  ...attachmentFns('diagram'),
  ...attachmentFns('epub'),
  ...attachmentFns('mindmap'),
}
