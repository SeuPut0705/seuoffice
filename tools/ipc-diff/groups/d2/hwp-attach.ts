/**
 * Group `d2/hwp-attach`: the Hangul editor's attachment and picture channels
 * (`apps/hwp/src/main/attachments-ipc.ts`, `ai-image.ts`), configured as
 * `hwp-main.ts` configures them: `registerHwpAttachmentIpc()` and
 * `registerHwpImageIpc({ filePathOf })`.
 *
 * The libraries the Rust side puts behind `HwpEngine` answer the TypeScript
 * handlers from the same `hosts.d2.hwp` case JSON (`hwp/attach-fakes-*.ts`);
 * `setOpenFilesSource` is registered from the case's `open_files`.
 */
import type * as ElectronUtils from '@seuoffice/electron-utils'
import type { Case, Group } from '../../types.ts'
import { appRequire, here, hwpHosts, setUpCase, swap, world } from './hwp/common.ts'

const ATTACH = 'apps/hwp/src/main/attachments-ipc'
const IMAGE = 'apps/hwp/src/main/ai-image'
type AttachmentsIpc = typeof import('../../../../apps/hwp/src/main/attachments-ipc.ts')
type ImageIpc = typeof import('../../../../apps/hwp/src/main/ai-image.ts')

swap([
  {
    specifier: '@seuoffice/file-parse',
    from: ATTACH,
    fake: here('attach-fakes-file-parse.ts'),
  },
  {
    // attachable.ts takes the same fake: a CommonJS `require` of one request from one
    // folder is answered from a cache that skips the hooks, so both files must agree
    specifier: '@seuoffice/drawio-model',
    from: 'file-parse/src/',
    fake: here('attach-fakes-drawio.ts'),
  },
  { specifier: '@seuoffice/ai-search', from: IMAGE, fake: here('attach-fakes-ai-search.ts') },
  {
    specifier: '@seuoffice/ai-provider/subscription',
    from: IMAGE,
    fake: here('attach-fakes-subscription.ts'),
  },
  {
    specifier: '@seuoffice/electron-utils/fetch-image-bytes',
    from: IMAGE,
    fake: here('attach-fakes-fetch-image.ts'),
  },
])

/**
 * `new Date()` reads the real clock and not `Date.now`, which setUpCase pins:
 * the pasted image's name carries the time of the paste.
 */
const RealDate = Date
if (!('pinned' in RealDate)) {
  class PinnedDate extends RealDate {
    static pinned = true
    constructor(...args: [] | [number | string | Date]) {
      if (args.length === 0) super(Date.now())
      else super(...(args as [number]))
    }
  }
  globalThis.Date = PinnedDate as unknown as DateConstructor
}

const kb = (n: number): string => 'x'.repeat(n)
const MB5 = 5 * 1024 * 1024
const MB50 = 50 * 1024 * 1024
const u = { $: 'u' }
const hwp = [{ view: 1, surface: 'Hwp' }]
const files = (...paths: string[]): unknown[] => [paths.map((p) => `$DIR/${p}`)]
const add = (...paths: string[]) => ({ channel: 'hwp:files-add', args: files(...paths) })
const read = (path: string, ...rest: unknown[]) => ({
  channel: 'hwp:files-read',
  args: [`$DIR/${path}`, ...rest],
})
const image = (path: string) => ({ channel: 'hwp:files-read-image', args: [`$DIR/${path}`] })
const document = (path: string) => ({ channel: 'hwp:files-read-document', args: [`$DIR/${path}`] })
const paste = (data: unknown, ext: unknown, buffers?: string[]) => ({
  channel: 'hwp:files-add-pasted-image',
  args: [data, ext],
  buffers,
})
const u8 = (i = 0) => ({ $: 'b', k: 'u8', i })
const ab = (i = 0) => ({ $: 'b', k: 'ab', i })
const PNG = '89504e470d0a1a0a'
const parse = (...answers: unknown[]) => ({ d2: { hwp: { parse_file_to_text: answers } } })
const text = (t: string) => ({ ok: true, kind: 'text', text: t })
const pick = (call: object, hosts: unknown) => ({ calls: [call], hosts })
const dialogs = (...answers: unknown[]) => ({ shared: { dialogs: { open: answers } } })
const fetchImage = (...args: unknown[]) => ({ channel: 'hwp:fetch-image', args })
const analyze = (op: unknown, buffers?: string[]) => ({
  channel: 'hwp:analyze-media',
  args: [op],
  buffers,
})
const png = (data: string): string => `data:image/png;base64,${data}`

const cases: Case[] = [
  // ---- hwp:files-add ----
  {
    note: 'files-add: accepted and rejected paths, each with its reason, in the order given',
    views: hwp,
    files: {
      'a.txt': 'hello',
      'UPPER.TXT': 'HELLO',
      'photo.JPG': 'jpg',
      'tool.exe': 'MZ',
      noext: 'x',
      'archive.tar.gz': 'x',
      'doc.v2.docx': 'docx',
      'folder.txt': { dir: true },
    },
    calls: [
      add(
        'a.txt',
        'tool.exe',
        'UPPER.TXT',
        'photo.JPG',
        'noext',
        'archive.tar.gz',
        'doc.v2.docx',
        'folder.txt',
        'missing.txt',
      ),
      { channel: 'hwp:files-add', args: [['$DIR/a.txt', 5, null, { path: 'x' }, ['$DIR/a.txt']]] },
    ],
  },
  {
    note: 'files-add: what is not a list of paths is an empty result',
    views: hwp,
    files: { 'a.txt': 'hello' },
    calls: [
      { channel: 'hwp:files-add', args: [] },
      { channel: 'hwp:files-add', args: ['$DIR/a.txt'] },
      { channel: 'hwp:files-add', args: [null] },
      { channel: 'hwp:files-add', args: [{ 0: '$DIR/a.txt' }] },
      { channel: 'hwp:files-add', args: [[]] },
      add('a.txt'),
    ],
  },
  {
    note: 'files-add: a picture may be 5MB, not a byte more; read-image reads the same limit',
    views: hwp,
    files: { 'ok.png': kb(MB5), 'big.jpg': kb(MB5 + 1), 'small.gif': 'GIF89a' },
    calls: [
      add('ok.png', 'big.jpg', 'small.gif'),
      image('ok.png'),
      image('big.jpg'),
      image('small.gif'),
    ],
  },
  {
    note: 'files-add: 50MB for the plain formats, no limit for the zip and pdf formats',
    views: hwp,
    files: {
      'big.txt': kb(MB50 + 1),
      'big.hwp': { link: 'big.txt' },
      'big.pdf': { link: 'big.txt' },
      'big.hwpx': { link: 'big.txt' },
    },
    calls: [
      add('big.txt', 'big.hwp', 'big.pdf', 'big.hwpx'),
      read('big.txt', 0, 5),
      read('big.pdf', 0, 5),
      // big.hwpx (no limit) is read in a case of small files: a difference in
      // this case's 50MB folder is too long for the report to hold, and a
      // fault it shows would crash the run instead of being caught
      document('big.hwp'),
    ],
  },
  {
    note: 'files-add: errors in Korean',
    views: hwp,
    hosts: { d2: { hwp: { ui_lang: 'ko' } } },
    files: { 'tool.exe': 'MZ', 'folder.txt': { dir: true }, 'big.png': kb(MB5 + 1) },
    calls: [add('tool.exe', 'folder.txt', 'big.png', 'gone.txt')],
  },
  {
    note: 'files-add: a draw.io picture is a diagram only when it holds its diagram',
    views: hwp,
    hosts: { d2: { hwp: { diagram_picture_has_no_original: [false, true, false, true] } } },
    files: {
      'a.drawio.png': PNG,
      'b.DRAWIO.PNG': PNG,
      'c.drawio.svg': '<svg/>',
      'd.drawio.svg': '<svg/>',
      'e.drawio.png': { dir: true },
    },
    calls: [
      add(
        'a.drawio.png',
        'b.DRAWIO.PNG',
        'c.drawio.svg',
        'd.drawio.svg',
        'e.drawio.png',
        'f.drawio.svg',
      ),
    ],
  },
  // ---- hwp:files-add-pasted-image ----
  {
    note: 'pasted image: saved under temp/seuoffice-pasted with a counter, as Uint8Array or ArrayBuffer',
    views: hwp,
    calls: [
      paste(u8(), 'PNG', [PNG]),
      paste(ab(), 'jpg', ['ffd8ffe0']),
      paste(u8(), 'Webp', ['52494646']),
    ],
  },
  {
    note: 'pasted image: what cannot be kept says why, leaves no file and does not count',
    views: hwp,
    calls: [
      paste(u8(), 'bmp', [PNG]),
      paste(u8(), u, [PNG]),
      paste(u8(), 5, [PNG]),
      paste(u8(), null, [PNG]),
      paste(u8(), '', [PNG]),
      paste(u8(), 'png', ['']),
      paste('bytes', 'png'),
      paste(null, 'png'),
      paste([1, 2, 3], 'png'),
      paste(u8(), 'gif', ['47494638']),
    ],
  },
  {
    note: 'pasted image: Korean refusal',
    views: hwp,
    hosts: { d2: { hwp: { ui_lang: 'ko' } } },
    calls: [paste(u8(), 'bmp', [PNG]), paste(u8(), 'png', [PNG])],
  },
  {
    note: 'pasted image: past 5MB nothing is written',
    views: hwp,
    calls: [paste(u8(), 'png', ['00'.repeat(MB5 + 1)]), paste(u8(), 'png', [PNG])],
  },
  {
    note: 'pasted image: the name carries the time of the paste',
    views: hwp,
    hosts: { d2: { hwp: { now_ms: 1_781_234_567_890 } } },
    calls: [paste(u8(), 'png', [PNG])],
  },
  // ---- hwp:files-pick ----
  {
    note: 'files-pick: the dialog and the files chosen, over the sender’s window',
    views: [{ view: 1, window: 5, surface: 'Hwp' }],
    hosts: dialogs(['$DIR/in/a.txt', '$DIR/in/tool.exe', '$DIR/in/b.pdf', '$DIR/in/missing.txt']),
    files: { 'in/a.txt': 'a', 'in/tool.exe': 'MZ', 'in/b.pdf': '%PDF' },
    calls: [{ channel: 'hwp:files-pick', args: [] }],
  },
  {
    note: 'files-pick: cancelled and an empty choice answer null; the next dialog opens where the pick was',
    views: hwp,
    hosts: dialogs(['$DIR/in/a.txt'], null, [], ['$DIR/other/b.txt']),
    files: { 'in/a.txt': 'a', 'other/b.txt': 'b' },
    calls: [
      { channel: 'hwp:files-pick', args: [] },
      { channel: 'hwp:files-pick', args: [] },
      { channel: 'hwp:files-pick', args: [] },
      { channel: 'hwp:files-pick', args: [] },
      { channel: 'hwp:files-pick', args: [] },
    ],
  },
  {
    note: 'files-pick: no dialog answer is a cancel; Korean titles',
    views: hwp,
    hosts: { d2: { hwp: { ui_lang: 'ko' } } },
    calls: [{ channel: 'hwp:files-pick', args: [] }],
  },
  // ---- hwp:files-read ----
  {
    note: 'files-read: the window of the text, in UTF-16 units, and the numbers it takes',
    views: hwp,
    files: {
      'k.txt': '\uAC00\uB098\uB2E4\uB77C\uB9C8',
      'e.txt': 'a\u{1F600}b',
      'long.txt': kb(50_000),
    },
    calls: [
      read('k.txt', 1, 2),
      read('k.txt', -3, 0),
      read('k.txt', u, 2.9),
      read('k.txt', 9, 5),
      read('k.txt', '2', '2'),
      read('k.txt', 'x', 'y'),
      read('k.txt', null, null),
      read('k.txt', true, [2]),
      read('k.txt', {}, [1, 2]),
      read('k.txt', 0.9, 4.5),
      read('k.txt', 1e9, 1e9),
      read('k.txt', -1e9, -1e9),
      read('e.txt', 0, 10),
      read('e.txt', 1, 2),
      read('long.txt', 0, 1_000_000),
      read('long.txt', 49_990, 1_000_000),
      { channel: 'hwp:files-read', args: ['$DIR/k.txt'] },
    ],
  },
  {
    note: 'files-read: an astral character cut in two',
    views: hwp,
    files: { 'e.txt': 'a\u{1F600}b' },
    calls: [read('e.txt', 0, 2), read('e.txt', 2, 1)],
  },
  {
    note: 'files-read: what has no text, or no file',
    views: hwp,
    files: { 'pic.PNG': 'png', 'folder.txt': { dir: true } },
    calls: [
      read('tool.exe', 0, 5),
      read('pic.PNG', 0, 5),
      read('none.txt', 0, 5),
      { channel: 'hwp:files-read', args: ['/', 0, 5] },
    ],
  },
  {
    note: 'files-read: a path that is not a string throws',
    views: hwp,
    calls: [
      { channel: 'hwp:files-read', args: [5, 0, 5] },
      { channel: 'hwp:files-read', args: [] },
      { channel: 'hwp:files-read', args: [null] },
      { channel: 'hwp:files-read', args: [true] },
      { channel: 'hwp:files-read', args: [['$DIR/a.txt']] },
      { channel: 'hwp:files-read', args: [{ path: 'x' }] },
      { channel: 'hwp:files-read', args: [u8(), 0, 5], buffers: ['00'] },
    ],
  },
  {
    note: 'files-read: a file is parsed once; another file is parsed on its own',
    views: hwp,
    hosts: parse(text('first'), text('second'), text('third')),
    files: { 'a.docx': 'v1', 'b.pdf': 'v2' },
    calls: [
      read('a.docx', 0, 99),
      read('a.docx', 1, 99),
      read('b.pdf', 0, 99),
      read('a.docx', 2, 2),
      read('b.pdf', 3, 99),
    ],
  },
  (() => {
    const names = Array.from({ length: 9 }, (_, i) => `f${i}.txt`)
    return {
      note: 'files-read: the cache keeps eight files; the oldest is parsed again',
      views: hwp,
      hosts: parse(...names.map((_, i) => text(`t${i}`)), text('again'), text('once more')),
      files: Object.fromEntries(names.map((n) => [n, 'x'])),
      calls: [
        ...names.map((n) => read(n, 0, 9)),
        read('f8.txt', 0, 9),
        read('f1.txt', 0, 9),
        read('f0.txt', 0, 9),
        read('f0.txt', 0, 9),
      ],
    }
  })(),
  {
    note: 'files-read: why a parse failed',
    views: hwp,
    hosts: parse(
      { ok: false, kind: 'text', error: 'Content mismatch: .pdf file has zip magic bytes' },
      { ok: false, kind: 'text', error: 'technical detail', damaged: true },
      { ok: true, kind: 'image' },
      { ok: false, kind: 'text', error: '' },
      { ok: true, kind: 'unsupported', text: 'x' },
      { ok: true, kind: 'text' },
      { ok: false, kind: 'text', text: 'partial', error: 'nope' },
      { ok: true, kind: 'text', text: '' },
    ),
    files: { 'a.pdf': 'x' },
    calls: Array.from({ length: 8 }, () => read('a.pdf', 0, 9)),
  },
  {
    note: 'files-read: Korean parse failure and size message',
    views: hwp,
    hosts: {
      d2: {
        hwp: { ui_lang: 'ko', parse_file_to_text: [{ ok: false, kind: 'text', damaged: true }] },
      },
    },
    files: { 'a.pdf': 'x' },
    calls: [read('a.pdf', 0, 9), read('b.exe', 0, 9)],
  },
  {
    note: 'files-read: a file open with unsaved changes is not read, before the cache',
    views: hwp,
    hosts: {
      d2: {
        hwp: {
          open_files: {
            files: [
              { filePath: '$DIR/dirty.txt', dirty: true },
              { filePath: '$DIR/clean.txt', dirty: false },
              { dirty: true },
              { filePath: 5, dirty: true },
            ],
          },
        },
      },
    },
    files: { 'dirty.txt': 'unsaved', 'clean.txt': 'saved', 'link.txt': { link: 'dirty.txt' } },
    calls: [
      read('dirty.txt', 0, 9),
      read('clean.txt', 0, 9),
      read('clean.txt', 1, 9),
      read('link.txt', 0, 9),
      document('dirty.txt'),
    ],
  },
  {
    note: 'files-read: an open-files source that fails blocks every read',
    views: hwp,
    hosts: { d2: { hwp: { open_files: { failed: true } } } },
    files: { 't.txt': 'hi', 'a.hwp': 'x' },
    calls: [read('t.txt', 0, 9), document('a.hwp'), read('x.exe', 0, 9)],
  },
  {
    note: 'files-read: an open-files source with no files, or none registered',
    views: hwp,
    hosts: { d2: { hwp: { open_files: {} } } },
    files: { 't.txt': 'hi' },
    calls: [read('t.txt', 0, 9)],
  },
  {
    note: 'files-read: a draw.io picture reads as diagram text, or is a picture',
    views: hwp,
    hosts: {
      d2: {
        hwp: {
          diagram_picture_has_no_original: [false, true],
          parse_file_to_text: [text('rows')],
        },
      },
    },
    files: { 'a.drawio.png': PNG, 'b.drawio.png': PNG },
    calls: [read('a.drawio.png', 0, 99), read('b.drawio.png', 0, 99), read('c.drawio.svg', 0, 9)],
  },
  {
    note: 'files-read: a file that does not read as UTF-8',
    views: hwp,
    files: { 'bin.txt': { hex: 'ff41fe42' }, 'bom.txt': { hex: 'efbbbf41' } },
    calls: [read('bin.txt', 0, 9), read('bom.txt', 0, 9)],
  },
  // ---- hwp:files-read-image ----
  {
    note: 'files-read-image: base64 and mime by extension',
    views: hwp,
    files: {
      'a.png': { hex: '010203' },
      'b.JPG': { hex: '010203' },
      'c.jpeg': { hex: 'ff' },
      'd.gif': 'GIF',
      'e.webp': { hex: '00' },
      'f.bmp': 'x',
      noext: 'x',
      'g.drawio.png': PNG,
      'dir.png': { dir: true },
    },
    calls: [
      'a.png',
      'b.JPG',
      'c.jpeg',
      'd.gif',
      'e.webp',
      'f.bmp',
      'noext',
      'g.drawio.png',
      'dir.png',
      'h.png',
      'dir/',
    ].map(image),
  },
  {
    note: 'files-read-image: Korean errors; a path that is not a string throws',
    views: hwp,
    hosts: { d2: { hwp: { ui_lang: 'ko' } } },
    calls: [
      image('f.bmp'),
      image('gone.png'),
      { channel: 'hwp:files-read-image', args: [5] },
      { channel: 'hwp:files-read-image', args: [] },
      { channel: 'hwp:files-read-image', args: [null] },
    ],
  },
  // ---- hwp:files-read-document ----
  {
    note: 'files-read-document: the checked bytes of Hangul files, or why they are refused',
    views: hwp,
    hosts: {
      d2: {
        hwp: {
          checked_hwp_bytes: [
            null,
            'Content mismatch: the .hwpx file is not a Hangul document',
            null,
          ],
        },
      },
    },
    files: {
      'a.hwp': { hex: '010203' },
      'b.hwpx': { hex: '010203' },
      'c.txt': 'x',
      'D.HWP': { hex: 'd0cf11e0' },
      'empty.hwp': '',
      'dir.hwp': { dir: true },
      'a.hwp.txt': 'x',
      noext: 'x',
      'ok.hwpx': { hex: '504b0304' },
      'UP.HWPX': { hex: '504b0304' },
    },
    calls: [
      'a.hwp',
      'b.hwpx',
      'c.txt',
      'D.HWP',
      'empty.hwp',
      'dir.hwp',
      'a.hwp.txt',
      'noext',
      'gone.hwp',
      'ok.hwpx',
      'UP.HWPX',
    ].map(document),
  },
  {
    note: 'files-read-document: the checker sees the extension; Korean size message is not reachable below 50MB',
    views: hwp,
    hosts: { d2: { hwp: { ui_lang: 'ko', checked_hwp_bytes: 'broken' } } },
    files: { 'a.hwp': { hex: '00ff00' }, 'b.hwpx': { hex: 'ff' } },
    calls: [
      document('a.hwp'),
      document('b.hwpx'),
      { channel: 'hwp:files-read-document', args: [5] },
      { channel: 'hwp:files-read-document', args: [] },
      { channel: 'hwp:files-read-document', args: [null] },
    ],
  },
  // ---- hwp:fetch-image ----
  {
    note: 'fetch-image: the picture, or null for what the fetch refuses; what is not an address never reaches it',
    views: hwp,
    hosts: {
      d2: {
        hwp: {
          fetch_image_bytes: [
            { base64: 'QUJD', mime: 'image/png' },
            null,
            { base64: 'REVG', mime: 'image/gif' },
            { base64: 'x' },
            { mime: 'image/png' },
            { base64: 5, mime: 'image/png' },
            'text',
          ],
        },
      },
    },
    calls: [
      fetchImage(5),
      fetchImage(''),
      fetchImage(),
      fetchImage(null),
      fetchImage(['https://example.test/a.png']),
      fetchImage('https://example.test/a.png'),
      fetchImage('http://127.0.0.1/a.png'),
      fetchImage('file:///store/generated.gif'),
      fetchImage('https://example.test/b.png'),
      fetchImage('https://example.test/c.png'),
      fetchImage('https://example.test/d.png'),
      fetchImage('https://example.test/e.png'),
    ],
  },
  // ---- hwp:analyze-media ----
  {
    note: 'analyze-media: only image data URLs are asked about; the tool sees what the handler gave it',
    views: [{ view: 4, surface: 'Hwp' }],
    calls: [
      analyze(
        {
          mediaUrls: [
            png('AAAA'),
            'https://example.test/a.png',
            'DATA:IMAGE/jpeg;base64,BBBB',
            'data:text/plain,hi',
            'data:image',
            'data:image/',
            7,
            null,
            true,
            {},
            ['data:image/gif;base64,CC'],
            [png('X'), png('Y')],
            [],
            u8(),
          ],
          requirements: 'what is shown?',
        },
        ['01'],
      ),
      analyze({ mediaUrls: [png('A')] }),
      analyze({ mediaUrls: [png('A')], requirements: null }),
      analyze({ mediaUrls: [png('A')], requirements: 12 }),
      analyze({ mediaUrls: [png('A')], requirements: false }),
      analyze({ mediaUrls: [png('A')], requirements: 0 }),
      analyze({ mediaUrls: [png('A')], requirements: ['a', 'b', null, 3] }),
      analyze({ mediaUrls: [png('A')], requirements: {} }),
      analyze({ mediaUrls: [png('A')], requirements: u8() }, ['0102']),
      analyze({ mediaUrls: [png('A')], requirements: '' }),
    ],
  },
  {
    note: 'analyze-media: nothing to look at never reaches the reader',
    views: hwp,
    hosts: { d2: { hwp: { analyze_media: { text: 'asked' } } } },
    calls: [
      { channel: 'hwp:analyze-media', args: [] },
      analyze(null),
      analyze('data:image/png;base64,AA'),
      analyze(5),
      analyze({}),
      analyze({ mediaUrls: png('AA') }),
      analyze({ mediaUrls: [] }),
      analyze({ mediaUrls: ['https://x.test/a.png', 'file:///a.png'] }),
      analyze({ mediaUrls: { 0: png('AA') } }),
      analyze({ mediaUrls: [png('AA')] }),
      analyze({ mediaUrls: ['data:image/webp;base64,AA'], requirements: 'x' }),
    ],
  },
  {
    note: 'analyze-media: the tool result is the answer, its rejection the error',
    views: hwp,
    hosts: {
      d2: {
        hwp: {
          analyze_media: [
            { error: 'no reader configured' },
            { throws: 'reader failed' },
            { text: 'a cat', model: 'x', usage: { tokens: 3 } },
            null,
            'plain',
            [1, 2],
            { throws: 5 },
          ],
        },
      },
    },
    calls: Array.from({ length: 7 }, () => analyze({ mediaUrls: [png('AA')] })),
  },
  // ---- surface ----
  {
    note: 'every channel is closed to another surface',
    views: [{ view: 1, surface: 'Docs' }],
    files: { 'a.txt': 'a' },
    calls: [
      add('a.txt'),
      { channel: 'hwp:files-pick', args: [] },
      read('a.txt', 0, 9),
      image('a.png'),
      document('a.hwp'),
      paste(u8(), 'png', [PNG]),
      fetchImage('https://example.test/a.png'),
      analyze({ mediaUrls: [png('A')] }),
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    setUpCase(cx)
    const utils = appRequire('@seuoffice/electron-utils') as typeof ElectronUtils
    const open = hwpHosts(cx).open_files as
      { failed?: unknown; files?: { filePath?: unknown; dirty?: unknown }[] } | null | undefined
    utils.setOpenFilesSource(
      open === undefined || open === null
        ? null
        : () => {
            world().log.push(['openFilesSource'])
            if (open.failed === true) throw new Error('the source failed')
            return (open.files ?? []).map((f) => ({
              filePath: typeof f.filePath === 'string' ? f.filePath : undefined,
              dirty: f.dirty === true,
            }))
          },
    )
    const attachments = await cx.fresh<AttachmentsIpc>(`${ATTACH}.ts`)
    attachments.registerHwpAttachmentIpc()
    const images = await cx.fresh<ImageIpc>(`${IMAGE}.ts`)
    images.registerHwpImageIpc({ filePathOf: () => null })
  },
  cases,
}
