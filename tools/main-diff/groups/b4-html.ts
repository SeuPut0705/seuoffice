/**
 * Group `b4-html`: the Electron-free modules of apps/html/src/main and
 * apps/epub/src/main, and the three pieces of packages/pdf-structure the EPUB
 * store handlers call (`StoreWriteError`, `isTranslationMode`, `jobKeyOf`).
 *
 * Where two apps have a file of the same name the function is named
 * `html/<file>.<export>` or `epub/<file>.<export>` (`asset-lifecycle`,
 * `atomic-write`, `generate-handoff-ipc`, `old-names`); the pdf-structure
 * pieces are `pdf-structure/<file>.<export>`. Bytes are hex strings. What the
 * TypeScript takes as an object with methods or a callback is a fake the spec
 * describes, and each of its calls is one log line on both sides.
 *
 * The asset list of an HTML document (`assets/.seuoffice-assets.json`) is
 * driven through the case's folder: a case writes the document, its assets
 * and the list, calls the function, and the folder after the call is compared.
 * A temp file's random name in a message is written `<hex>` on both sides.
 * The sizes of the files stay small, so the 16 MiB bound of the sibling scan
 * is not reached. Names the spec writes with a lone surrogate are left out:
 * a Rust string cannot hold one.
 *
 * The reading state, the store handlers and the hand-off registration are
 * driven as scenarios: a list of steps answers one entry per step.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  ASSET_MANIFEST_FILENAME,
  copyImageIntoOwnedAssets,
  discardPendingOwnedAssets,
  extractDocumentImageSources,
  extractHtmlAssetReferences,
  extractHtmlImageSources,
  isInDocDir,
  pendingOwnedAssetsForDocument,
  prepareAssetsForSaveAs,
  readOwnedAssetManifest,
  reconcileOwnedAssets,
  renameOwnedAssetDocument,
  resolveSafeRelativeImagePath,
  resolveSourcePendingAfterSaveAs,
  rewriteDocumentImageSources,
  rewriteHtmlImageSources,
  rollbackPreparedSaveAsAssets,
  scanCssUrls,
  writeImageIntoOwnedAssets,
} from '../../../apps/html/src/main/asset-lifecycle.ts'
import {
  ASSET_SNIFF_BYTES,
  PREVIEW_ASSET_EXTS,
  editableImageMime,
  extensionlessAssetMime,
  slotFromAccept,
  sniffBinaryAssetMime,
} from '../../../apps/html/src/main/asset-mime.ts'
import { atomicWriteFile as htmlAtomicWriteFile } from '../../../apps/html/src/main/atomic-write.ts'
import { registerHtmlHandoffIpc } from '../../../apps/html/src/main/generate-handoff-ipc.ts'
import { OLD_ASSET_MANIFEST_FILENAMES } from '../../../apps/html/src/main/old-names.ts'
import {
  ASSET_SCHEME,
  PREVIEW_SCHEME,
  assetBaseHref,
  buildPreviewDocument,
  previewUrlFor,
} from '../../../apps/html/src/main/preview-document.ts'
import {
  inlineImagesForSingleFile,
  singleFileExportBaseName,
} from '../../../apps/html/src/main/single-file-html.ts'
import { atomicWriteFile as epubAtomicWriteFile } from '../../../apps/epub/src/main/atomic-write.ts'
import {
  MAX_POSITIONS,
  READING_STATE_FILE,
  createReadingState,
  readPositionOf,
  viewPrefsOf,
} from '../../../apps/epub/src/main/reading-state.ts'
import { checkResultPath, pathKey, samePath } from '../../../apps/epub/src/main/result-paths.ts'
import {
  createEpubStoreHandlers,
  type EpubStore,
} from '../../../apps/epub/src/main/store-handlers.ts'
import { EPUB_VIEW_PREFS_DEFAULT } from '../../../apps/epub/src/shared/ipc.ts'
import {
  generateRunStartedEvents,
  queueGenerateHandoff,
  resetGenerateHandoffsForTest,
  setGenerateTabIdResolver,
} from '../../../packages/electron-utils/src/generate-handoff.ts'
import type { GenerateHandoff } from '../../../packages/electron-utils/src/generate-handoff.ts'
import { StoreWriteError } from '../../../packages/pdf-structure/src/store/files.ts'
import { isTranslationMode, jobKeyOf } from '../../../packages/pdf-structure/src/store/job-keys.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'

const CONSTANT = 'a constant'

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex')
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// the temp file name of an atomic write, as it shows in a message
// ---------------------------------------------------------------------------

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskTmp(value)
  if (Array.isArray(value)) return value.map(maskDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]))
  }
  return value
}

/** the call, with a temp file's random name in the answer or the message written `<hex>` */
async function masked<T>(run: () => T | Promise<T>): Promise<unknown> {
  try {
    return maskDeep(await run())
  } catch (error) {
    if (error instanceof Error) error.message = maskTmp(error.message)
    throw error
  }
}

const str = (a: unknown[], i: number): string => a[i] as string
const strs = (a: unknown[], i: number): string[] => a[i] as string[]
const bytes = (a: unknown[], i: number): Buffer => Buffer.from(a[i] as string, 'hex')

// ---------------------------------------------------------------------------
// text samples: Markdown with images, HTML with images, CSS urls
// ---------------------------------------------------------------------------

const IMAGE_TEXTS: string[] = [
  '',
  'plain text',
  '![a](x.png)',
  '![a](x.png "Title")',
  "![a](x.png 'T')",
  '![a](x.png (T))',
  '![a](<my file.png>)',
  '![a](<my file.png> "t")',
  '![a](x\\(1\\).png)',
  '![a](x(1).png)',
  '![a [b]](y.png)',
  '![a](x.png)![b](y.png)',
  'text ![a] (z.png)',
  '![a]\t(z.png)',
  '![a](  w.png  )',
  '![a](\u00a0w.png\u00a0)',
  '![a]()',
  '![a](',
  '![](only.png)',
  '\\![a](esc.png)',
  '![a](x.png',
  '![a](x\\ y.png)',
  '![alt\u00e9\u{1F600}](u\u00e9\u{1F600}.png)',
  '\u{1F600}![a](x.png)\u{1F600}',
  '    ![code](c.png)',
  '\t![code](c.png)',
  '```\n![f](f.png)\n```',
  '~~~js\n<img src="g.png">\n~~~',
  '`![i](i.png)`',
  '``![i](i2.png)``',
  '```\nunclosed ![f](f2.png)',
  '````\n```\n![x](n.png)\n```\n````\n![after](after.png)',
  '   ```\n![in](in.png)\n   ```\n![out](out.png)',
  '    ```\n![ind](ind.png)\n```\n',
  '```a`b\n![nofence](nf.png)\n',
  '`unmatched ![u](u.png)',
  'a\r\n![crlf](crlf.png)\r\n',
  'a\r![cr](cr.png)',
  'x\u2028![ls](ls.png)',
  '<img src="h.png">',
  "<img src='h2.png'>",
  '<img src=h3.png>',
  '<img\nsrc="h4.png"\nalt="x">',
  '<IMG SRC="H5.png">',
  '<img src="a&amp;b.png">',
  '<img src="a&lt;b&gt;.png">',
  '<img src="a&#38;b.png">',
  '<img src="a&#x26;b.png">',
  '<img src="a&foo;b.png">',
  '<img src="&#0;x.png">',
  '<img src="&#xD800;.png">',
  '<img src="&#x;">',
  '<img src="&#;x">',
  '<img src="&#xZZ;">',
  '<img src="&#1114112;">',
  '<img src="&constructor;.png">',
  '<img src="&__proto__;">',
  '<img src="&nbsp;a.png">',
  '<img src="&AMP;b.png">',
  '<img src="a.png" src="b.png">',
  '<img alt=x>',
  '<img src>',
  '<img src=>',
  '<img src="">',
  '<img src=a"b>',
  '<img/src="j.png">',
  '<img src="k.png"/>',
  '<img src="k2.png" / >',
  '<imgx src="no.png">',
  '<img',
  '<img src="unterminated',
  '<!-- <img src="c.png"> -->![m](m.png)',
  '<!-- <img src="c.png">',
  '<!-- no img -->',
  '<img src="p.png"><img src="q.png">',
  '<p><img src="a.png" alt="x"></p>',
  '  <img src="indented.png">',
  '\u{1F600}<img src="e.png">\u{1F600}![b](b.png)',
  '<img src="a.png" \u00a0 alt="n">',
  '<img\u00a0src="nb.png">',
  '![md](m.png) <img src="m.png">',
  '<img src="a.png" ![x](a.png)>',
  '<img src=x.png onerror=a=b>',
  '<img src="a b.png"  data-x=\'1\'>',
]

const CSS_TEXTS: string[] = [
  '',
  'no urls here',
  'url(a.png)',
  'url("a.png")',
  "url('a.png')",
  'url(  a.png  )',
  'url(\n"a.png"\n)',
  'url(&quot;a.png&quot;)',
  'url(&#34;a.png&#34;)',
  'url(&#39;a.png&#39;)',
  'url(&apos;a.png&apos;)',
  'url(&QUOT;a.png&quot;)',
  'url(&quot;a.png&#39;)',
  'url("")',
  "url('')",
  'url()',
  'url( )',
  'URL(A.PNG)',
  'uRl("mixed.png")',
  'url(a b.png)',
  'url("a b.png")',
  'url(a.png)url(b.png)',
  'a{background:url(x.png)} b{background:url("y.png")}',
  '<div style="background:url(&quot;s.png&quot;)">',
  '\u{1F600}url(e.png)\u00e9url(f.png)',
  'url("a\nb.png")',
  'url("\u{1F600}.png")',
  'url(&quot;\u{1F600}.png&quot;)',
  'url(data:image/png;base64,AAAA)',
  'url(http://x/y.png)',
  'url("a.png"',
  'url(a.png',
  'x url(a.png) y url(a.png) z',
]

const REWRITES: [string, string][] = [
  ['x.png', 'assets/new one.png'],
  ['h.png', 'a"b.png'],
  ['h2.png', "it's.png"],
  ['h3.png', 'q r&s<t>.png'],
  ['a&b.png', 'a&b<c>.png'],
  ['m.png', 'a=b`c.png'],
  ['a.png', 'z.png'],
  ['y.png', '\u{1F600}.png'],
  ['only.png', '\u00a0nb.png'],
  ['x.png)', 'never'],
]

// ---------------------------------------------------------------------------
// the folders of the asset lifecycle
// ---------------------------------------------------------------------------

const MF = '.seuoffice-assets.json'
const OLD_MF = '.genoffice-assets.json'
const DOC = '$DIR/doc.html'

interface Mf {
  version?: number
  files?: [string, string][]
  documents?: Record<string, string[]>
  pending?: Record<string, string[]>
}

/** the text of a list: the files are `[name, content]`, held as their SHA-256 */
const mf = (m: Mf): string =>
  `${JSON.stringify(
    {
      version: m.version ?? 1,
      files: (m.files ?? []).map(([name, content]) => ({ name, sha256: sha(content) })),
      documents: m.documents ?? {},
      pending: m.pending ?? {},
    },
    null,
    2,
  )}\n`

/** an `assets/` folder: its files, and its list under `listName` */
function assetsDir(
  m: Mf | null,
  files: Record<string, string> = {},
  listName = MF,
  prefix = '',
): Record<string, FileSpec> {
  const out: Record<string, FileSpec> = {}
  for (const [name, content] of Object.entries(files)) out[`${prefix}assets/${name}`] = content
  if (m) out[`${prefix}assets/${listName}`] = mf(m)
  return out
}

/** two owned pictures: a.png referenced by the document, b.png pending */
const TWO: Record<string, FileSpec> = {
  'doc.html': '<img src="assets/a.png">',
  ...assetsDir(
    {
      files: [
        ['a.png', 'x'],
        ['b.png', 'y'],
      ],
      documents: { 'doc.html': ['a.png'] },
      pending: { 'doc.html': ['b.png'] },
    },
    { 'a.png': 'x', 'b.png': 'y' },
  ),
}

const withFiles = (extra: Record<string, FileSpec>): Record<string, FileSpec> => ({
  ...TWO,
  ...extra,
})

const fileCase = (args: unknown[], files?: Record<string, FileSpec>, note?: string): Case => ({
  args,
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})

/** lists a reader refuses, each with the message it is refused with */
const BAD_LISTS: [string, string][] = [
  ['not json', '{'],
  ['an empty file', ''],
  ['a byte order mark', '\ufeff{"version":1,"files":[]}'],
  ['null', 'null'],
  ['a number', '1'],
  ['a string', '"x"'],
  ['an array', '[]'],
  ['version 2', '{"version":2,"files":[]}'],
  ['version as a string', '{"version":"1","files":[]}'],
  ['no files', '{"version":1}'],
  ['files as an object', '{"version":1,"files":{}}'],
  ['a null file entry', '{"version":1,"files":[null]}'],
  ['a number file entry', '{"version":1,"files":[7]}'],
  ['an empty file entry', '{"version":1,"files":[{}]}'],
  ['an array file entry', '{"version":1,"files":[[]]}'],
  ['a name that is no string', `{"version":1,"files":[{"name":5,"sha256":"${sha('x')}"}]}`],
  ['a traversing name', `{"version":1,"files":[{"name":"../x.png","sha256":"${sha('x')}"}]}`],
  ['a path name', `{"version":1,"files":[{"name":"a/b.png","sha256":"${sha('x')}"}]}`],
  ['a dot name', `{"version":1,"files":[{"name":".","sha256":"${sha('x')}"}]}`],
  ['the list as a name', `{"version":1,"files":[{"name":"${MF}","sha256":"${sha('x')}"}]}`],
  ['the old list as a name', `{"version":1,"files":[{"name":"${OLD_MF}","sha256":"${sha('x')}"}]}`],
  ['a long name', `{"version":1,"files":[{"name":"${'n'.repeat(181)}","sha256":"${sha('x')}"}]}`],
  ['a bad hash', '{"version":1,"files":[{"name":"a.png","sha256":"ABC"}]}'],
  [
    'an upper-case hash',
    `{"version":1,"files":[{"name":"a.png","sha256":"${sha('x').toUpperCase()}"}]}`,
  ],
  [
    'a name twice',
    `{"version":1,"files":[{"name":"a.png","sha256":"${sha('x')}"},{"name":"a.png","sha256":"${sha('y')}"}]}`,
  ],
  ['documents as null', '{"version":1,"files":[],"documents":null}'],
  ['documents as an array', '{"version":1,"files":[],"documents":[]}'],
  ['documents as a string', '{"version":1,"files":[],"documents":"x"}'],
  ['an unsafe document key', '{"version":1,"files":[],"documents":{"../x":[]}}'],
  ['document names as a string', '{"version":1,"files":[],"documents":{"d.html":"a.png"}}'],
  ['a non-string document name', '{"version":1,"files":[],"documents":{"d.html":[1]}}'],
  ['an unsafe document name', '{"version":1,"files":[],"documents":{"d.html":["a/b"]}}'],
  ['pending as null', '{"version":1,"files":[],"pending":null}'],
  ['pending as an array', '{"version":1,"files":[],"pending":[]}'],
  ['an unsafe pending key', '{"version":1,"files":[],"pending":{"a/b":[]}}'],
  ['pending names as an object', '{"version":1,"files":[],"pending":{"d.html":{}}}'],
  ['an unsafe pending name', '{"version":1,"files":[],"pending":{"d.html":[""]}}'],
  ['a null pending name', '{"version":1,"files":[],"pending":{"d.html":[null]}}'],
]

const badListFiles = (text: string): Record<string, FileSpec> => ({
  'assets/a.png': 'x',
  [`assets/${MF}`]: text,
})

// ---------------------------------------------------------------------------
// head bytes
// ---------------------------------------------------------------------------

const PNG = '89504e470d0a1a0a0000000d49484452'
const JPEG = 'ffd8ffe000104a46494600'
const HEADS: [string, string][] = [
  ['jpeg', JPEG],
  ['jpeg, three bytes', 'ffd8ff'],
  ['jpeg, two bytes', 'ffd8'],
  ['png', PNG],
  ['png, short', '89504e470d0a1a'],
  ['gif 87a', hexOf('GIF87a') + '0100'],
  ['gif 89a', hexOf('GIF89a') + '0100'],
  ['gif 88a', hexOf('GIF88a')],
  ['gif, five bytes', hexOf('GIF89')],
  ['gif, no a', hexOf('GIF89b')],
  ['webp', hexOf('RIFF') + '24000000' + hexOf('WEBP') + '00'],
  ['wave', hexOf('RIFF') + '24000000' + hexOf('WAVE') + '00'],
  ['riff avi', hexOf('RIFF') + '24000000' + hexOf('AVI ') + '00'],
  ['riff, eleven bytes', hexOf('RIFF') + '24000000' + hexOf('WEB')],
  ['bmp', '424d3600000000000000'],
  ['bmp, no zeros', '424d3600000001000000'],
  ['bmp, short', '424d00'],
  ['ico', '00000100010010'],
  ['avif', '00000020' + hexOf('ftypavif') + '00'],
  ['avis', '00000020' + hexOf('ftypavis') + '00'],
  ['mp4', '00000020' + hexOf('ftypisom') + '00'],
  ['mp4, avix', '00000020' + hexOf('ftypavix') + '00'],
  ['ftyp, eleven bytes', '00000020' + hexOf('ftypavi')],
  ['webm', '1a45dfa3010000'],
  ['ogg', hexOf('OggS') + '00'],
  ['ogg, three bytes', hexOf('Ogg')],
  ['id3', hexOf('ID3') + '03'],
  ['mp3 sync', 'fffb9000'],
  ['mp3 sync, e2', 'ffe2'],
  ['mp3 sync, e0', 'ffe0'],
  ['mp3 sync, one byte', 'ff'],
  ['woff', hexOf('wOFF') + '00010000'],
  ['woff2', hexOf('wOF2') + '00010000'],
  ['otf', hexOf('OTTO') + '0004'],
  ['ttf, 5 tables', '00010000' + '0005'],
  ['ttf, 64 tables', '00010000' + '0040'],
  ['ttf, 65 tables', '00010000' + '0041'],
  ['ttf, no tables', '00010000' + '0000'],
  ['ttf, four bytes', '00010000'],
  ['ttf, five bytes', '0001000000'],
  ['true, 3 tables', hexOf('true') + '0003'],
  ['true, four bytes', hexOf('true')],
  ['svg text', hexOf('<svg xmlns="x">')],
  ['text', hexOf('hello world')],
  ['empty', ''],
  ['one byte', '00'],
]
const SVG_HEADS: [string, string][] = [
  ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('hex')],
  ['svg with a space after', Buffer.from('<svg ').toString('hex')],
  ['svg with a tag end', Buffer.from('<svg>').toString('hex')],
  ['svg with a tab', Buffer.from('<svg\t').toString('hex')],
  ['svg, longer name', Buffer.from('<svgx>').toString('hex')],
  ['svg, upper case', Buffer.from('<SVG viewBox="0 0 1 1">').toString('hex')],
  ['xml', Buffer.from('<?xml version="1.0"?><svg/>').toString('hex')],
  ['xml, upper case', Buffer.from('<?XML?>').toString('hex')],
  ['leading space', Buffer.from(' \n\t<svg>').toString('hex')],
  ['byte order mark', 'efbbbf' + Buffer.from('<svg>').toString('hex')],
  ['two byte order marks', 'efbbbfefbbbf' + Buffer.from('<svg>').toString('hex')],
  ['no-break space', Buffer.from('\u00a0<svg>').toString('hex')],
  ['feff as text', Buffer.from('\ufeff \u2003<svg>').toString('hex')],
  ['html', Buffer.from('<html><svg>').toString('hex')],
  ['comment first', Buffer.from('<!-- c --><svg>').toString('hex')],
  ['invalid utf-8', 'ff' + Buffer.from('<svg>').toString('hex')],
  ['empty', ''],
]

// ---------------------------------------------------------------------------
// the specs of the cases that need a folder
// ---------------------------------------------------------------------------

const resolveCases: Case[] = (() => {
  const files: Record<string, FileSpec> = {
    'doc.html': '<p>',
    'assets/a.png': 'x',
    'assets/sub/b.png': 'y',
    'assets/with space.png': 'z',
    'outside.txt': 'o',
    'dir/': { dir: true },
  }
  const sources = [
    'assets/a.png',
    './assets/a.png',
    'assets//a.png',
    'assets/sub/../a.png',
    'assets%2Fa.png',
    'assets/a%2Epng',
    'assets/with%20space.png',
    'assets/with space.png',
    '  assets/a.png  ',
    'assets\\a.png',
    'assets/sub/b.png',
    'assets/missing.png',
    'assets',
    'assets/',
    'dir',
    '../doc.html',
    '../x.png',
    'assets/../../x.png',
    '/etc/hosts',
    '\\windows\\x.png',
    'C:\\x.png',
    'c:/x.png',
    'http://x/a.png',
    'data:image/png;base64,AAAA',
    'file:///x.png',
    'assets/a.png?x=1',
    'assets/a.png#frag',
    '',
    '   ',
    '%zz',
    '%E0%A4%A',
    'assets/%00x',
    'assets/%2e%2e/outside.txt',
    'outside.txt',
    '\u00e9.png',
    'assets/\u{1F600}.png',
    'a:b',
    'x:',
    '1x:y',
    '\u212A:x',
  ]
  return [
    ...sources.map((s) => fileCase([DOC, s], files)),
    fileCase(['$DIR/nodoc/doc.html', 'assets/a.png'], files, 'the document folder is missing'),
  ]
})()

const COPY_SRC: Record<string, FileSpec> = {
  'src/photo.PNG': 'png bytes',
  'src/my photo?.jpg': 'jpg bytes',
  'src/\u00fcn\u00ef \u{1F600}.png': 'astral',
  'src/.hidden': 'hidden',
  'src/noext': 'noext',
  'src/a.b.c.tar.gz': 'tar',
  'src/a.': 'dot',
  'src/UPPER.JPEG': 'jpeg',
}

const copyCases: Case[] = [
  fileCase([DOC, '$DIR/src/photo.PNG'], COPY_SRC, 'a new assets folder'),
  fileCase([DOC, '$DIR/src/my photo?.jpg'], COPY_SRC, 'a name that is cleaned'),
  fileCase([DOC, '$DIR/src/\u00fcn\u00ef \u{1F600}.png'], COPY_SRC, 'a non-ASCII name'),
  fileCase([DOC, '$DIR/src/.hidden'], COPY_SRC, 'a dot file'),
  fileCase([DOC, '$DIR/src/noext'], COPY_SRC),
  fileCase([DOC, '$DIR/src/a.b.c.tar.gz'], COPY_SRC),
  fileCase([DOC, '$DIR/src/a.'], COPY_SRC),
  fileCase([DOC, '$DIR/src/UPPER.JPEG'], COPY_SRC),
  fileCase(
    [DOC, '$DIR/src/missing.png'],
    COPY_SRC,
    'no source: the folder is made, nothing copied',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, 'assets/photo.png': 'taken' },
    'the name is taken by a file the list does not own',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, 'assets/photo.png': 'a', 'assets/photo-1.png': 'b', 'assets/photo-2.png': 'c' },
    'three names taken',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, ...assetsDir({ files: [['other.png', 'o']] }, { 'other.png': 'o' }) },
    'a list that has files',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, ...assetsDir({ files: [['photo.png', 'not this']] }) },
    'the list owns another file under the name: the copy is removed',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    {
      ...COPY_SRC,
      ...assetsDir({
        pending: { 'doc.html': ['x.png'] },
        documents: { '2': ['x.png'], '10': ['y.png'] },
      }),
    },
    'a list with pending names and integer-like keys',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, ...assetsDir({}, {}, OLD_MF) },
    'a list under the old name keeps its name',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    {
      ...COPY_SRC,
      ...assetsDir({}, {}, MF),
      [`assets/${OLD_MF}`]: mf({ files: [['x.png', 'x']] }),
    },
    'both names: the current one wins',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, [`assets/${MF}`]: '{' },
    'an invalid list: the copy is removed',
  ),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, [`assets/${MF}`]: { dir: true } },
    'the list is a folder',
  ),
  fileCase([DOC, '$DIR/src/photo.PNG'], { ...COPY_SRC, assets: 'a file' }, 'assets is a file'),
  fileCase(
    [DOC, '$DIR/src/photo.PNG'],
    { ...COPY_SRC, assets: { dir: true, mode: 0o555 } },
    'a read-only assets folder',
  ),
]

const WRITE_NAMES = [
  'pasted image.png',
  'a.png',
  '',
  '.hidden',
  '...',
  '.png',
  'a/b\\c:d.png',
  'C:\\dir\\pic.PNG',
  'x'.repeat(200) + '.png',
  'x'.repeat(139) + '.jpeg',
  'a'.repeat(141),
  'p\u00e9\u00e9.JPG',
  'a.abcdefghijk',
  'a.abcdefghijkl',
  'a.K',
  'a.p\u017Fg',
  'a.\u0131mg',
  'tab\there.png',
  'ctrl\u0001x.png',
  'a  b\u00a0c.png',
  'a?b*c"d<e>f|g#h%i.png',
  'trail. .png',
  'name.. ',
  '\u{1F600}\u{1F600}.png',
  'a.\u{1F600}',
  '.seuoffice-assets.json',
  'x.seuoffice-assets.json',
  '.genoffice-assets.json',
  'image.png',
]

const writeCases: Case[] = [
  ...WRITE_NAMES.map((name) => fileCase([DOC, name, '89504e47'])),
  fileCase([DOC, 'a.png', ''], undefined, 'no bytes'),
  fileCase([DOC, 'a.png', 'ffd8ff'], { 'assets/a.png': 'taken' }, 'a name taken'),
  fileCase(
    [DOC, 'a.png', 'ffd8ff'],
    assetsDir({ files: [['a.png', 'other']] }),
    'the list owns another file under the name',
  ),
  fileCase([DOC, 'a.png', 'ffd8ff'], { assets: 'a file' }),
  fileCase([DOC, 'a.png', 'ffd8ff'], { assets: { dir: true, mode: 0o555 } }, 'a read-only folder'),
  fileCase([DOC, 'a.png', 'ffd8ff'], { [`assets/${MF}`]: '[]' }, 'a list that is an array'),
]

const PAIRS = REWRITES

const SIBLINGS = {
  img: { 'other.html': '<img src="assets/a.png">' },
  css: { 'other.html': '<div style="background:url(&quot;assets/b.png&quot;)">' },
  style: { 'other.htm': '<style>x{background:url(assets/a.png)}</style>' },
  upper: { 'OTHER.HTML': '<IMG SRC=assets/a.png>' },
  md: { 'other.html': '![a](assets/a.png)' },
  ambiguous: { 'other.html': '<img src="x&foo;.png">' },
  ambiguousSrc: { 'other.html': '<img src=assets/a.png alt="x" src=b>' },
  nothing: { 'other.html': '<p>no images</p>' },
  notHtml: { 'other.txt': '<img src="assets/a.png">' },
  folder: { 'other.html': { dir: true } },
  unreadable: { 'other.html': { text: '<img src="assets/a.png">', mode: 0 } },
  current: { 'doc.html': '<img src="assets/a.png"><img src="assets/b.png">' },
  encoded: { 'other.html': '<img src="assets/a%2Epng"><img src="./assets/b.png">' },
  nested: { 'other.html': '<img src="assets/sub/a.png"><img src="../assets/b.png">' },
} satisfies Record<string, Record<string, FileSpec>>

// ---------------------------------------------------------------------------
// a manifest to read
// ---------------------------------------------------------------------------

const MANIFEST_FILES: [string, Record<string, FileSpec>, string][] = [
  ['two owned pictures', TWO, ''],
  ['no assets folder', { 'doc.html': '' }, ''],
  [
    'documents and pending with duplicates and unsorted names',
    assetsDir({
      files: [
        ['z.png', 'z'],
        ['a.png', 'a'],
        ['B.png', 'b'],
      ],
      documents: { 'doc.html': ['z.png', 'a.png', 'z.png', 'B.png'], 'a.html': ['a.png'] },
      pending: { 'b.html': ['B.png', 'B.png'] },
    }),
    '',
  ],
  [
    'integer-like document keys',
    assetsDir({
      files: [['a.png', 'a']],
      documents: { zeta: ['a.png'], '10': ['a.png'], '2': ['a.png'], '1': ['a.png'], alpha: [] },
      pending: {
        '7': ['a.png'],
        '07': ['a.png'],
        '4294967295': ['a.png'],
        '4294967294': ['a.png'],
      },
    }),
    '',
  ],
  [
    'names that sort differently by code unit and by code point',
    assetsDir({
      files: [
        ['\uFF21.png', '1'],
        ['\u{1F600}.png', '2'],
        ['B.png', '3'],
      ],
      documents: { 'doc.html': ['\uFF21.png', '\u{1F600}.png', 'B.png', '\u00e9.png'] },
    }),
    '',
  ],
  [
    'file names the collation orders',
    assetsDir({
      files: [
        ['B.png', 'b'],
        ['a.png', 'a'],
        ['A.png', 'A'],
        ['_x.png', 'u'],
        ['1.png', '1'],
        ['10.png', '10'],
        ['2.png', '2'],
        ['\u00e9.png', 'e'],
        ['e.png', 'e2'],
        ['z.png', 'z'],
        ['-dash.png', 'd'],
        ['a b.png', 'sp'],
        ['ab.png', 'ab'],
        ['a-b.png', 'hy'],
        ['a_b.png', 'un'],
        ['\u00fc.png', 'ue'],
        ['u.png', 'u2'],
      ],
    }),
    '',
  ],
  ['a list under the old name', assetsDir({ files: [['a.png', 'x']] }, {}, OLD_MF), ''],
  [
    'both names',
    {
      ...assetsDir({ files: [['a.png', 'x']] }),
      [`assets/${OLD_MF}`]: mf({ files: [['old.png', 'o']] }),
    },
    '',
  ],
  ['assets without a list', { 'assets/a.png': 'x' }, ''],
  ['assets is a file', { assets: 'x' }, ''],
  ['the list is a folder', { [`assets/${MF}`]: { dir: true } }, ''],
  ['an empty list', { [`assets/${MF}`]: '{"version":1,"files":[]}' }, ''],
  [
    'a list with null-prototype keys',
    {
      [`assets/${MF}`]:
        '{"version":1,"files":[],"documents":{"__proto__":["a.png"],"constructor":["b.png"]}}',
    },
    '',
  ],
  [
    'a list with a key twice',
    {
      [`assets/${MF}`]:
        '{"version":1,"files":[],"documents":{"d":["a.png"],"e":[],"d":["b.png"]},"documents":{"x":["c.png"]}}',
    },
    '',
  ],
  ...BAD_LISTS.map(([label, text]): [string, Record<string, FileSpec>, string] => [
    `bad list: ${label}`,
    badListFiles(text),
    '',
  ]),
]

// ---------------------------------------------------------------------------
// the group: asset-lifecycle, asset-mime, small html modules
// ---------------------------------------------------------------------------

const htmlGroup: Group = {
  'html/asset-lifecycle.ASSET_MANIFEST_FILENAME': {
    ts: () => ASSET_MANIFEST_FILENAME,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'html/asset-lifecycle.isInDocDir': {
    ts: (a) => isInDocDir(str(a, 0), str(a, 1), (a[2] as string | null) ?? undefined),
    cases: cases(
      ['/a/b/c.png', '/a/b', null],
      ['/a/b', '/a/b', null],
      ['/a/bc/d.png', '/a/b', null],
      ['/a/b/', '/a/b', null],
      ['/a/b/', '/a/b/', null],
      ['/x.png', '/', null],
      ['/', '/', null],
      ['', '', null],
      ['C:\\a\\b.png', 'C:\\a', '\\'],
      ['C:\\a\\b.png', 'C:\\', '\\'],
      ['C:\\b.png', 'C:\\', '\\'],
      ['C:/a/b.png', 'C:\\a', '\\'],
      ['/a/b/c', '/a/b', ''],
      ['/a/bc', '/a/b', ''],
      ['/a/b::c', '/a/b', '::'],
      ['/a/b/c', '/a/b', '::'],
      ['/a/\u00e9/c', '/a/\u00e9', '/'],
      ['/a/\u{1F600}/c', '/a/\u{1F600}', '/'],
      ['/A/b/c', '/a/b', '/'],
    ),
  },
  'html/asset-lifecycle.extractHtmlImageSources': {
    ts: (a) => extractHtmlImageSources(str(a, 0)),
    cases: IMAGE_TEXTS.map((text) => ({ args: [text] })),
  },
  'html/asset-lifecycle.extractDocumentImageSources': {
    ts: (a) => extractDocumentImageSources(str(a, 0)),
    cases: IMAGE_TEXTS.map((text) => ({ args: [text] })),
  },
  'html/asset-lifecycle.scanCssUrls': {
    ts: (a) => scanCssUrls(str(a, 0)),
    cases: [...CSS_TEXTS, ...IMAGE_TEXTS.slice(0, 12)].map((text) => ({ args: [text] })),
  },
  'html/asset-lifecycle.extractHtmlAssetReferences': {
    ts: (a) => extractHtmlAssetReferences(str(a, 0)),
    cases: [
      ...CSS_TEXTS,
      ...IMAGE_TEXTS,
      '<img src="a.png"><div style="background:url(a.png)">![b](a.png)',
      '<style>a{background:url(x.png)} b{background:url("x.png")}</style><img src="y.png">',
    ].map((text) => ({ args: [text] })),
  },
  'html/asset-lifecycle.rewriteHtmlImageSources': {
    ts: (a) => rewriteHtmlImageSources(str(a, 0), new Map(a[1] as [string, string][])),
    cases: [
      ...IMAGE_TEXTS.map((text): Case => ({ args: [text, PAIRS] })),
      { args: ['![a](x.png)', []], note: 'no rewrites' },
      {
        args: [
          '![a](x.png) ![b](x.png)',
          [
            ['x.png', 'one'],
            ['x.png', 'two'],
          ],
        ],
      },
      { args: ['![a](x.png)', [['other.png', 'one']]], note: 'nothing matches' },
      { args: ['<img src=x.png>', [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ['<img src="x.png">', [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ["<img src='x.png'>", [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ['![a](x.png)', [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ['<img src=x.png>', [['x.png', '\u00a0\u2003\u{1F600}\u00e9']]] },
    ],
  },
  'html/asset-lifecycle.rewriteDocumentImageSources': {
    ts: (a) => rewriteDocumentImageSources(str(a, 0), new Map(a[1] as [string, string][])),
    cases: [
      ...IMAGE_TEXTS.map((text): Case => ({ args: [text, PAIRS] })),
      { args: ['<img src="x.png">', []], note: 'no rewrites' },
      { args: ['<img src="x.png"><img src="x.png">', [['x.png', 'one']]] },
      { args: ['    ![a](x.png)\n  <img src="x.png">', [['x.png', 'one']]], note: 'indented' },
      { args: ['<img src=x.png>', [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ['<img src="x.png">', [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
      { args: ["<img src='x.png'>", [['x.png', 'a b\tc\n"d\'e`f=g>h&i<j']]] },
    ],
  },
  'html/asset-lifecycle.resolveSafeRelativeImagePath': {
    ts: (a) => resolveSafeRelativeImagePath(str(a, 0), str(a, 1)),
    cases: resolveCases,
  },
  'html/asset-lifecycle.copyImageIntoOwnedAssets': {
    ts: (a) => masked(() => copyImageIntoOwnedAssets(str(a, 0), str(a, 1))),
    cases: copyCases,
  },
  'html/asset-lifecycle.writeImageIntoOwnedAssets': {
    ts: (a) => masked(() => writeImageIntoOwnedAssets(str(a, 0), str(a, 1), bytes(a, 2))),
    cases: writeCases,
  },
  'html/asset-lifecycle.prepareAssetsForSaveAs': {
    ts: (a) => masked(() => prepareAssetsForSaveAs(str(a, 0), str(a, 1), str(a, 2), strs(a, 3))),
    cases: (() => {
      const SRC = '$DIR/src/doc.html'
      const DST = '$DIR/dst/new.html'
      const files: Record<string, FileSpec> = {
        'src/doc.html': '',
        'src/assets/a.png': 'AAA',
        'src/assets/b.png': 'BBB',
        'src/assets/my photo.png': 'PHOTO',
        'src/other/c.png': 'CCC',
        'src/assets/sub/a.png': 'SUBA',
        'dst/': { dir: true },
      }
      const text = '![a](assets/a.png) <img src="assets/b.png"> ![c](other/c.png)'
      return [
        fileCase([SRC, '$DIR/src/copy.html', text, ['assets/a.png']], files, 'the same folder'),
        fileCase(
          [SRC, DST, text, ['assets/a.png', 'assets/b.png', 'other/c.png']],
          files,
          'a new folder',
        ),
        fileCase([SRC, DST, text, []], files, 'sources found in the text'),
        fileCase([SRC, DST, '', []], files, 'nothing to copy'),
        fileCase([SRC, DST, 'plain', ['assets/missing.png']], files, 'a source that is missing'),
        fileCase(
          [SRC, DST, text, ['../x.png', 'http://x/a.png', '/abs.png']],
          files,
          'sources outside',
        ),
        fileCase(
          [
            SRC,
            DST,
            '![a](assets/a.png) ![b](./assets/a.png) ![c](assets//a.png) ![d](assets/sub/../a.png)',
            [],
          ],
          files,
          'one file under several spellings',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          { ...files, 'dst/assets/a.png': 'taken' },
          'the name is taken in the target',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          { ...files, 'dst/assets/a.png': 'x', 'dst/assets/a-1.png': 'y' },
          'two names taken',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          { ...files, ...assetsDir({ files: [['a.png', 'elsewhere']] }, {}, MF, 'dst/') },
          'the target list reserves the name',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          {
            ...files,
            ...assetsDir(
              { pending: { 'new.html': ['z.png'], 'old.html': ['q.png'] } },
              {},
              MF,
              'dst/',
            ),
          },
          'a target list with pending names',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          { ...files, 'dst/assets/.seuoffice-assets.json': '{' },
          'an invalid target list: the copies are removed',
        ),
        fileCase(
          [SRC, DST, '![a](assets/a.png)', []],
          { ...files, 'dst/assets': 'a file' },
          'assets is a file in the target',
        ),
        fileCase([SRC, DST, '![a](assets/my%20photo.png)', []], files, 'a name that is cleaned'),
        fileCase(
          [SRC, DST, 'no images', ['assets/a.png']],
          files,
          'a source the text does not hold: the rewrite cannot be checked',
        ),
        fileCase(
          [SRC, DST, '<img src="assets/a.png">', ['assets/a.png']],
          { ...files, 'dst/assets': { dir: true, mode: 0o555 } },
          'a read-only target assets folder',
        ),
        fileCase(
          [SRC, '$DIR/dst/doc.html', '![a](assets/a.png)', ['assets/a.png']],
          {
            ...files,
            ...assetsDir({ files: [['a.png', 'AAA']] }, { 'a.png': 'AAA' }, OLD_MF, 'dst/'),
          },
          'a target list under the old name',
        ),
        fileCase(
          [SRC, '$DIR/dst/2', '![a](assets/a.png)', []],
          files,
          'a target named like an integer',
        ),
        fileCase(
          [SRC, DST, '`![a](assets/a.png)` ![b](assets/b.png)', []],
          files,
          'an image in code is not copied',
        ),
      ]
    })(),
  },
  'html/asset-lifecycle.rollbackPreparedSaveAsAssets': {
    ts: (a) =>
      masked(() =>
        rollbackPreparedSaveAsAssets(a[0] as Parameters<typeof rollbackPreparedSaveAsAssets>[0]),
      ),
    cases: (() => {
      const plan = (created: [string, string][], target = DOC) => ({
        targetDocumentPath: target,
        text: '',
        imageSources: [],
        rewrites: [],
        created: created.map(([name, content]) => ({ name, sha256: sha(content) })),
      })
      return [
        fileCase([plan([['b.png', 'y']])], TWO, 'a pending file is removed'),
        fileCase([plan([['a.png', 'x']])], TWO, 'a referenced file stays'),
        fileCase(
          [plan([['b.png', 'changed']])],
          TWO,
          'another content: the hash does not match the list',
        ),
        fileCase(
          [plan([['b.png', 'y']])],
          withFiles({ 'assets/b.png': 'edited since' }),
          'the file was edited since: it stays',
        ),
        fileCase(
          [plan([['b.png', 'y']])],
          {
            'doc.html': '',
            ...assetsDir({ files: [['b.png', 'y']], pending: { 'doc.html': ['b.png'] } }),
          },
          'the file is gone',
        ),
        fileCase([plan([['b.png', 'y']])], {
          'doc.html': '',
          ...assetsDir(
            { files: [['b.png', 'y']], pending: { 'doc.html': ['b.png'] } },
            { 'b.png': 'y' },
          ),
        }),
        fileCase([plan([])], TWO, 'nothing created'),
        fileCase([plan([['b.png', 'y']], '$DIR/none/doc.html')], TWO, 'no list there'),
        fileCase(
          [plan([['b.png', 'y']])],
          { 'doc.html': '', [`assets/${MF}`]: '{' },
          'an invalid list',
        ),
        fileCase(
          [plan([['b.png', 'y']])],
          withFiles({ 'assets/b.png': { dir: true } }),
          'a folder where the file was',
        ),
        fileCase(
          [
            plan([
              ['a.png', 'x'],
              ['b.png', 'y'],
            ]),
          ],
          {
            'doc.html': '',
            ...assetsDir(
              {
                files: [
                  ['a.png', 'x'],
                  ['b.png', 'y'],
                ],
                documents: { 'other.html': ['a.png'] },
                pending: { 'doc.html': ['a.png', 'b.png'], 'x.html': ['b.png'] },
              },
              { 'a.png': 'x', 'b.png': 'y' },
            ),
          },
          'another document holds one of them, and another holds a pending one',
        ),
        fileCase(
          [plan([['b.png', 'y']])],
          withFiles({ assets: { dir: true, mode: 0o555 } }),
          'a read-only folder',
        ),
      ]
    })(),
  },
  'html/asset-lifecycle.pendingOwnedAssetsForDocument': {
    ts: (a) => pendingOwnedAssetsForDocument(str(a, 0)),
    cases: [
      fileCase([DOC], TWO),
      fileCase([DOC], { 'doc.html': '' }, 'no assets'),
      fileCase(
        [DOC],
        { 'doc.html': '', ...assetsDir({ pending: { 'doc.html': ['z.png', 'a.png', 'z.png'] } }) },
        'sorted',
      ),
      fileCase(
        [DOC],
        { 'doc.html': '', ...assetsDir({ pending: { 'other.html': ['z.png'] } }) },
        'another document',
      ),
      fileCase([DOC], badListFiles('{'), 'an invalid list'),
      fileCase([DOC], badListFiles('{"version":2,"files":[]}'), 'a list that is refused'),
      fileCase([DOC], { 'doc.html': '', assets: 'x' }, 'assets is a file'),
      fileCase(['$DIR/dir/doc.html'], {
        'dir/doc.html': '',
        ...assetsDir({ pending: { 'doc.html': ['q.png'] } }, {}, MF, 'dir/'),
      }),
      fileCase(
        [DOC],
        { 'doc.html': '', ...assetsDir({ pending: { 'doc.html': ['m.png'] } }, {}, OLD_MF) },
        'the old name',
      ),
    ],
  },
  'html/asset-lifecycle.discardPendingOwnedAssets': {
    ts: (a) => masked(() => discardPendingOwnedAssets(str(a, 0))),
    cases: [
      fileCase([DOC], TWO, 'pending file removed'),
      fileCase([DOC], { 'doc.html': '' }, 'no assets'),
      fileCase([DOC], withFiles(SIBLINGS.img), 'a sibling references the pending file'),
      fileCase(
        [DOC],
        withFiles({ 'other.html': '<img src="assets/b.png">' }),
        'a sibling holds the pending one',
      ),
      fileCase([DOC], withFiles(SIBLINGS.css)),
      fileCase([DOC], withFiles(SIBLINGS.current), 'the document itself is counted'),
      fileCase([DOC], withFiles(SIBLINGS.ambiguous), 'an ambiguous sibling keeps everything'),
      fileCase([DOC], withFiles(SIBLINGS.unreadable), 'an unreadable sibling keeps everything'),
      fileCase([DOC], withFiles(SIBLINGS.folder), 'a folder named like a page'),
      fileCase([DOC], withFiles({ 'assets/b.png': 'edited' }), 'the file changed: preserved'),
      fileCase([DOC], withFiles({ 'assets/b.png': { dir: true } }), 'a folder where the file was'),
      fileCase(
        [DOC],
        {
          'doc.html': '',
          ...assetsDir({ files: [['b.png', 'y']], pending: { 'doc.html': ['b.png'] } }),
        },
        'the file is gone',
      ),
      fileCase(
        [DOC],
        {
          'doc.html': '',
          ...assetsDir(
            {
              files: [['b.png', 'y']],
              pending: { 'doc.html': ['b.png'], 'other.html': ['b.png'] },
            },
            { 'b.png': 'y' },
          ),
        },
        'another document has it pending',
      ),
      fileCase(
        [DOC],
        {
          'doc.html': '',
          ...assetsDir(
            {
              files: [['b.png', 'y']],
              documents: { 'other.html': ['b.png'] },
              pending: { 'doc.html': ['b.png'] },
            },
            { 'b.png': 'y' },
          ),
        },
        'another document saved it',
      ),
      fileCase(
        [DOC],
        {
          'doc.html': '',
          ...assetsDir(
            { files: [], pending: { 'doc.html': ['b.png', 'c.png'] } },
            { 'b.png': 'y' },
          ),
        },
        'pending names the list does not own',
      ),
      fileCase([DOC], withFiles({ assets: { dir: true, mode: 0o555 } }), 'a read-only folder'),
      ...BAD_LISTS.slice(0, 12).map(([label, text]) =>
        fileCase([DOC], badListFiles(text), `bad list: ${label}`),
      ),
      fileCase([DOC], { 'doc.html': '', assets: 'a file' }, 'assets is a file'),
    ],
  },
  'html/asset-lifecycle.resolveSourcePendingAfterSaveAs': {
    ts: (a) => masked(() => resolveSourcePendingAfterSaveAs(str(a, 0), strs(a, 1))),
    cases: [
      fileCase([DOC, ['b.png']], TWO, 'the pending file at the start'),
      fileCase([DOC, []], TWO, 'nothing was pending at the start: later insertions stay'),
      fileCase([DOC, ['c.png']], TWO, 'a name that is not pending'),
      fileCase([DOC, ['b.png', 'a.png']], TWO, 'one that is not pending, one that is'),
      fileCase([DOC, ['b.png']], withFiles(SIBLINGS.encoded), 'a sibling holds a.png only'),
      fileCase([DOC, ['b.png']], withFiles({ 'other.html': '<img src="assets/b.png">' })),
      fileCase([DOC, ['b.png']], { 'doc.html': '' }, 'no assets'),
      fileCase([DOC, ['b.png']], badListFiles('{'), 'an invalid list'),
    ],
  },
  'html/asset-lifecycle.reconcileOwnedAssets': {
    ts: (a) =>
      masked(() =>
        reconcileOwnedAssets(str(a, 0), strs(a, 1), {
          pendingNames: (a[2] as string[] | null) ?? undefined,
        }),
      ),
    cases: (() => {
      const both = ['assets/a.png', 'assets/b.png']
      const names = [
        'B.png',
        'a.png',
        'A.png',
        '_x.png',
        '1.png',
        '10.png',
        '2.png',
        '\u00e9.png',
        'z.png',
      ]
      return [
        fileCase([DOC, [], null], undefined, 'no assets'),
        fileCase([DOC, ['assets/a.png'], null], TWO, 'the pending file is dropped'),
        fileCase([DOC, both, null], TWO, 'both referenced'),
        fileCase([DOC, [], null], TWO, 'nothing referenced: both deleted'),
        fileCase([DOC, [], []], TWO, 'pending kept: b.png survives'),
        fileCase([DOC, [], ['b.png']], TWO),
        fileCase([DOC, [], ['a.png', 'q.png']], TWO),
        fileCase([DOC, ['assets/a.png'], ['b.png']], TWO),
        fileCase([DOC, [], null], withFiles(SIBLINGS.img), 'a sibling references a.png'),
        fileCase([DOC, [], null], withFiles(SIBLINGS.css), 'a sibling references b.png in CSS'),
        fileCase([DOC, [], null], withFiles(SIBLINGS.style)),
        fileCase([DOC, [], null], withFiles(SIBLINGS.upper)),
        fileCase([DOC, [], null], withFiles(SIBLINGS.md), 'Markdown text in a page'),
        fileCase([DOC, [], null], withFiles(SIBLINGS.ambiguous), 'an ambiguous sibling keeps both'),
        fileCase([DOC, [], null], withFiles(SIBLINGS.ambiguousSrc)),
        fileCase([DOC, [], null], withFiles(SIBLINGS.nothing)),
        fileCase([DOC, [], null], withFiles(SIBLINGS.notHtml), 'a text file is no page'),
        fileCase([DOC, [], null], withFiles(SIBLINGS.folder)),
        fileCase(
          [DOC, [], null],
          withFiles(SIBLINGS.unreadable),
          'an unreadable sibling keeps both',
        ),
        fileCase(
          [DOC, [], null],
          withFiles(SIBLINGS.current),
          'the document itself is not a sibling',
        ),
        fileCase([DOC, [], null], withFiles(SIBLINGS.encoded)),
        fileCase([DOC, [], null], withFiles(SIBLINGS.nested), 'sources that are not owned names'),
        fileCase(
          [DOC, ['assets/a.png'], null],
          withFiles({ 'assets/a.png': 'edited' }),
          'a.png changed: preserved',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          withFiles({ 'assets/a.png': { dir: true } }),
          'a.png is a folder',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          {
            'doc.html': '',
            ...assetsDir(
              {
                files: [
                  ['a.png', 'x'],
                  ['gone.png', 'g'],
                ],
                documents: { 'doc.html': ['gone.png'] },
              },
              { 'a.png': 'x' },
            ),
          },
          'a listed file is gone',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          { 'doc.html': '', ...assetsDir({ files: [['a.png', 'x']] }, { 'a.png': 'x' }, OLD_MF) },
          'the old list name',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          {
            'doc.html': '',
            ...assetsDir({ files: [['a.png', 'x']] }, { 'a.png': 'x' }),
            [`assets/${OLD_MF}`]: mf({ files: [['b.png', 'y']] }),
          },
          'both list names',
        ),
        fileCase(
          [
            DOC,
            [
              'assets/A.PNG',
              './assets/a.png',
              'assets//a.png',
              'assets\\a.png',
              'ASSETS/a.png',
              'assets/%61.png',
              'assets/a.png?x',
              'assets/a.png#h',
              'assets/sub/a.png',
              '../assets/a.png',
              'assets/./a.png',
              '',
            ],
            null,
          ],
          TWO,
          'spellings of the source',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          {
            'doc.html': '',
            'assets/other.png': 'o',
            ...assetsDir(
              {
                files: [['a.png', 'x']],
                documents: {
                  '2': ['a.png'],
                  '10': ['a.png'],
                  zeta: ['a.png'],
                  'doc.html': ['a.png'],
                },
              },
              { 'a.png': 'x' },
            ),
          },
          'integer-like document keys',
        ),
        fileCase(
          [DOC, names.map((n) => `assets/${n}`), null],
          {
            'doc.html': '',
            ...assetsDir(
              { files: names.map((n): [string, string] => [n, `content ${n}`]) },
              Object.fromEntries(names.map((n) => [n, `content ${n}`])),
            ),
          },
          'names in the collation order',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          withFiles({ assets: { dir: true, mode: 0o555 } }),
          'a read-only folder',
        ),
        fileCase(
          [DOC, [], null],
          withFiles({ assets: { dir: true, mode: 0o555 } }),
          'a read-only folder, nothing referenced',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          { 'doc.html': '', assets: 'a file' },
          'assets is a file',
        ),
        fileCase(
          [DOC, ['assets/a.png'], null],
          { 'doc.html': '', [`assets/${MF}`]: { dir: true } },
          'the list is a folder',
        ),
        ...BAD_LISTS.map(([label, text]) =>
          fileCase([DOC, ['assets/a.png'], null], badListFiles(text), `bad list: ${label}`),
        ),
        fileCase([DOC, [], null], { 'doc.html': '', 'assets/a.png': 'x' }, 'assets without a list'),
        fileCase(
          ['$DIR/sub/doc.html', ['assets/a.png'], null],
          {
            'sub/doc.html': '',
            ...assetsDir(
              {
                files: [['a.png', 'x']],
                documents: { 'doc.html': ['a.png'], 'sub.html': ['a.png'] },
              },
              { 'a.png': 'x' },
              MF,
              'sub/',
            ),
          },
          'a document in a folder',
        ),
      ]
    })(),
  },
  'html/asset-lifecycle.renameOwnedAssetDocument': {
    ts: (a) => masked(() => renameOwnedAssetDocument(str(a, 0), str(a, 1))),
    cases: [
      fileCase([DOC, '$DIR/new.html'], TWO, 'both lists move'),
      fileCase(['$DIR/other.html', '$DIR/new.html'], TWO, 'no entry under the old name'),
      fileCase([DOC, DOC], TWO, 'the same name'),
      fileCase([DOC, '$DIR/sub/doc.html'], TWO, 'another folder'),
      fileCase(
        [DOC, '$DIR/new.html'],
        {
          'doc.html': '',
          ...assetsDir({
            files: [
              ['a.png', 'x'],
              ['b.png', 'y'],
            ],
            documents: { 'doc.html': ['a.png'], 'new.html': ['b.png', 'a.png'] },
            pending: { 'new.html': ['b.png'] },
          }),
        },
        'the new name has entries: merged and sorted',
      ),
      fileCase(
        [DOC, '$DIR/new.html'],
        {
          'doc.html': '',
          ...assetsDir({ files: [['b.png', 'y']], pending: { 'doc.html': ['b.png'] } }),
        },
        'pending only',
      ),
      fileCase(
        [DOC, '$DIR/new.html'],
        {
          'doc.html': '',
          ...assetsDir({ files: [['a.png', 'x']], documents: { 'doc.html': [] } }),
        },
        'an empty list moves too',
      ),
      fileCase([DOC, '$DIR/new.html'], { 'doc.html': '' }, 'no assets'),
      fileCase([DOC, '$DIR/new.html'], badListFiles('{'), 'an invalid list'),
      fileCase([DOC, '$DIR/new.html'], { 'doc.html': '', assets: 'a file' }, 'assets is a file'),
      fileCase([DOC, '$DIR/2'], TWO, 'a new name that is an integer'),
      fileCase(
        [DOC, '$DIR/new.html'],
        withFiles({ assets: { dir: true, mode: 0o555 } }),
        'a read-only folder',
      ),
      fileCase(
        [DOC, '$DIR/new.html'],
        {
          'doc.html': '',
          ...assetsDir(
            { files: [['a.png', 'x']], documents: { 'doc.html': ['a.png'] } },
            { 'a.png': 'x' },
            OLD_MF,
          ),
        },
        'the old list name',
      ),
    ],
  },
  'html/asset-lifecycle.readOwnedAssetManifest': {
    ts: (a) => readOwnedAssetManifest(str(a, 0)),
    cases: MANIFEST_FILES.map(([note, files]) =>
      fileCase([DOC], { 'doc.html': '', ...files }, note),
    ),
  },
  'asset-mime.PREVIEW_ASSET_EXTS': {
    ts: () => [...PREVIEW_ASSET_EXTS],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'asset-mime.ASSET_SNIFF_BYTES': {
    ts: () => ASSET_SNIFF_BYTES,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'asset-mime.sniffBinaryAssetMime': {
    ts: (a) => sniffBinaryAssetMime(bytes(a, 0)),
    cases: HEADS.map(([note, hex]): Case => ({ args: [hex], note })),
  },
  'asset-mime.slotFromAccept': {
    ts: (a) => slotFromAccept(a[0] as string | null),
    cases: cases(
      [null],
      [''],
      ['image/avif,image/webp,*/*'],
      [' IMAGE/png'],
      ['\ufeffimage/png'],
      ['\u00a0image/png'],
      ['image/'],
      ['image'],
      ['text/css,*/*;q=0.1'],
      ['TEXT/CSS'],
      ['text/cssx'],
      ['text/html,application/xhtml+xml'],
      ['*/*'],
      ['\u0130mage/png'],
      ['\u212Aimage/png'],
      ['i\u0307mage/png'],
      ['\u{1F600}image/'],
      ['\tImage/svg+xml'],
    ),
  },
  'asset-mime.extensionlessAssetMime': {
    ts: (a) => extensionlessAssetMime(str(a, 0), bytes(a, 1), a[2] as string | null),
    cases: [
      ...HEADS.flatMap(([note, hex]) =>
        [
          ['/x/_files/tTsEQygh', hex, 'image/avif,image/*,*/*;q=0.8'],
          ['/x/_files/tTsEQygh', hex, '*/*'],
          ['/x/_files/tTsEQygh', hex, 'text/css,*/*;q=0.1'],
        ].map((args): Case => ({ args, note })),
      ),
      ...SVG_HEADS.flatMap(([note, hex]) =>
        [
          ['/x/_files/vec', hex, 'image/png'],
          ['/x/_files/vec', hex, null],
          ['/x/_files/vec', hex, 'text/css'],
        ].map((args): Case => ({ args, note })),
      ),
      ...cases(
        ['/x/_files/style', hexOf('body{}'), 'text/css'],
        ['/x/_files/script', hexOf('var a'), '*/*'],
        ['/x/_files/script', hexOf('var a'), null],
        ['/x/_files/style', '', 'text/css'],
        ['/x/_files/x.dat', hexOf('body{}'), 'text/css'],
        ['/x/_files/x.', hexOf('body{}'), 'text/css'],
        ['/x/_files/.env', hexOf('SECRET=1'), '*/*'],
        ['/x/_files/.json', hexOf('{}'), 'text/css'],
        ['/x/_files/data.json', hexOf('{}'), '*/*'],
        ['/x/_files/a.b.c', hexOf('body{}'), 'text/css'],
        ['/x/_files/dir/', hexOf('body{}'), 'text/css'],
        ['noext', hexOf('body{}'), 'text/css'],
        ['', hexOf('body{}'), 'text/css'],
        ['/x/_files/\u00e9\u{1F600}', hexOf('body{}'), 'text/css'],
        ['/x/_files/a\\b', hexOf('body{}'), 'text/css'],
        ['/x/_files/a\\b.png', hexOf('body{}'), 'text/css'],
        ['/x/_files/pic', JPEG, 'image/*'],
        ['/x/_files/pic.png', JPEG, 'image/*'],
        ['/x/_files/pic.png', JPEG, '*/*'],
        ['/x/_files/font', hexOf('wOFF') + '0001', '*/*'],
        ['/x/_files/font', hexOf('wOFF') + '0001', 'image/*'],
        ['/x/_files/.hidden', JPEG, 'image/*'],
      ),
    ],
  },
  'asset-mime.editableImageMime': {
    ts: (a) => editableImageMime(bytes(a, 0)),
    cases: HEADS.map(([note, hex]): Case => ({ args: [hex], note })),
  },

  // ---- the small modules ----
  'html/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => htmlAtomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: atomicCases(),
  },
  'html/old-names.OLD_ASSET_MANIFEST_FILENAMES': {
    ts: () => [...OLD_ASSET_MANIFEST_FILENAMES],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'html/generate-handoff-ipc.registerHtmlHandoffIpc': {
    ts: handoffIpcRun,
    // read after the module has loaded: the case builders are defined below
    get cases() {
      return handoffIpcCases()
    },
  },
  'preview-document.PREVIEW_SCHEME': {
    ts: () => PREVIEW_SCHEME,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'preview-document.ASSET_SCHEME': {
    ts: () => ASSET_SCHEME,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'preview-document.assetBaseHref': {
    ts: (a) => assetBaseHref(str(a, 0)),
    cases: cases(
      ['/a/b'],
      ['/a/b/'],
      ['/a/b///'],
      ['C:\\Users\\me'],
      ['C:\\Users\\me\\'],
      ['\\\\server\\share\\dir'],
      ['/a b/\u00fc/\u{1F600}'],
      [''],
      ['/'],
      ['//'],
      ['rel/dir'],
      ['/a:b/c:d'],
      ['/a%20b/100%'],
      ['/x/#?&=+;,@$'],
      ['/a//b'],
      ["/quote\"s/'single'"],
      ['/\u212A/\u0131/\u017F'],
      ['/dots/./../x'],
      ['/ends with space /'],
      ['/a\\b/c'],
    ),
  },
  'preview-document.buildPreviewDocument': {
    ts: (a) => buildPreviewDocument(str(a, 0), a[1] as string | null),
    cases: previewCases(),
  },
  'preview-document.previewUrlFor': {
    ts: (a) => previewUrlFor(a[0] as number),
    cases: cases(
      [1],
      [0],
      [-5],
      [1.5],
      [1e21],
      [123456789012],
      [0.000001],
      [1e-7],
      [2 ** 53],
      [1e300],
      [-1e-7],
      [4294967296],
    ),
  },
  'single-file-html.singleFileExportBaseName': {
    ts: (a) => singleFileExportBaseName(str(a, 0)),
    cases: cases(
      ['doc'],
      ['doc.single'],
      ['doc.SINGLE'],
      ['doc.Single.single'],
      ['doc.single.html'],
      [''],
      ['.single'],
      ['a.single '],
      ['\u00fcn\u00ef \u{1F600}.single'],
      ['x.s\u0131ngle'],
      ['x.\u017Fingle'],
      ['x.single\n'],
      ['.single.single'],
    ),
  },
  'single-file-html.inlineImagesForSingleFile': {
    ts: (a) => inlineImagesForSingleFile(str(a, 0), a[1] as string | null),
    cases: singleFileCases(),
  },
}

function atomicCases(): Case[] {
  const existing = { 'a.docx': 'old text' }
  return [
    fileCase(['$DIR/a.docx', 'new text'], undefined, 'a new file'),
    fileCase(['$DIR/a.docx', 'new text'], existing, 'replaces a file'),
    fileCase(['$DIR/a.docx', ''], existing, 'an empty file replaces text'),
    fileCase(['$DIR/\u00fcn\u00ef.docx', '\u00e9\u{1F600}\ud55c'], undefined, 'non-ASCII'),
    fileCase(['$DIR/missing/a.docx', 'x'], undefined, 'no folder: the temp file cannot be made'),
    fileCase(['$DIR/d', 'x'], { d: { dir: true } }, 'the target is a folder'),
    fileCase(['$DIR/ro/a.docx', 'x'], { ro: { dir: true, mode: 0o555 } }, 'a read-only folder'),
    fileCase(['$DIR/a.docx/b', 'x'], existing, 'a file where a folder is expected'),
  ]
}

const GH = (
  id: string,
  target: 'slides' | 'html' | 'mindmap',
  paths: string[] = ['/m/a.docx', '/m/b.pdf'],
  text = 'make it',
): GenerateHandoff => ({
  id,
  mode: 'ai',
  target,
  materials: paths.map((path, i) => ({ path, name: `file${i}` })),
  text,
  defaultText: false,
  createdAt: 1_700_000_000_000,
})

interface IpcCall {
  channel: string
  sender: number
  args: unknown[]
}

/** `[openedOnFile, queue, calls, resolver]`: see the Rust dispatcher */
async function handoffIpcRun(a: unknown[], cx: TsContext): Promise<unknown> {
  const [opened, queue, calls, resolver] = a as [
    number[],
    { id: number; handoff: GenerateHandoff }[],
    IpcCall[],
    { table: Record<string, string>; throwsFor?: number[] } | null,
  ]
  resetGenerateHandoffsForTest()
  const realNow = Date.now
  Date.now = () => cx.now
  try {
    for (const entry of queue) queueGenerateHandoff(entry.id, entry.handoff)
    if (resolver) {
      setGenerateTabIdResolver((id: number) => {
        if (resolver.throwsFor?.includes(id)) throw new Error('resolver boom')
        return resolver.table[String(id)]
      })
    }
    const handlers = new Map<
      string,
      (event: { sender: { id: number } }, ...args: unknown[]) => unknown
    >()
    registerHtmlHandoffIpc(
      {
        handle: (channel, handler) => {
          cx.log('handle', channel)
          handlers.set(channel, handler)
        },
      },
      (id) => {
        cx.log('openedOnFile', id)
        return opened.includes(id)
      },
    )
    const answers: unknown[] = []
    for (const call of calls) {
      try {
        const handler = handlers.get(call.channel)!
        answers.push({ ok: await handler({ sender: { id: call.sender } }, ...call.args) })
      } catch (error) {
        answers.push({ error: (error as Error).message })
      }
    }
    return { channels: [...handlers.keys()], answers, runs: generateRunStartedEvents() }
  } finally {
    Date.now = realNow
    setGenerateTabIdResolver(null)
    resetGenerateHandoffsForTest()
  }
}

function handoffIpcCases(): Case[] {
  const take = (sender: number): IpcCall => ({ channel: 'html:handoff-take', sender, args: [] })
  const run = (sender: number, ...args: unknown[]): IpcCall => ({
    channel: 'html:handoff-run-started',
    sender,
    args,
  })
  const q = (id: number, handoff: GenerateHandoff) => ({ id, handoff })
  const A = ['/m/a.docx']
  return [
    { args: [[], [q(7, GH('h1', 'html'))], [take(7), take(7)], null], note: 'taken once' },
    {
      args: [[7], [q(7, GH('h1', 'html'))], [take(7), take(7)], null],
      note: 'a view opened on a file never takes',
    },
    { args: [[], [q(7, GH('h1', 'slides'))], [take(7)], null], note: 'queued for another editor' },
    { args: [[], [q(7, GH('h1', 'mindmap'))], [take(7)], null] },
    { args: [[], [q(7, GH('h1', 'html'))], [take(8)], null], note: 'another view' },
    { args: [[], [], [take(7)], null], note: 'nothing queued' },
    {
      args: [
        [],
        [q(7, GH('h2', 'html', ['/m/\u00e9.docx', '/m/\u{1F600}.pdf'], 'text \u{1F600}'))],
        [take(7)],
        null,
      ],
      note: 'non-ASCII material',
    },
    {
      args: [[], [q(7, GH('h3', 'html', []))], [take(7), run(7, ['/m/a.docx'])], null],
      note: 'no materials',
    },
    {
      args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7, A), run(7, A)], null],
      note: 'a run is recorded once',
    },
    { args: [[], [q(7, GH('h1', 'html'))], [run(7, A)], null], note: 'a run before the take' },
    { args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7)], null], note: 'no argument' },
    {
      args: [
        [],
        [q(7, GH('h1', 'html'))],
        [take(7), run(7, 'x'), run(7, null), run(7, { 0: '/m/a.docx' })],
        null,
      ],
      note: 'not an array',
    },
    {
      args: [
        [],
        [q(7, GH('h1', 'html'))],
        [take(7), run(7, [1, null, {}, ['/m/a.docx']]), run(7, [1, null, '/m/a.docx'])],
        null,
      ],
      note: 'only the strings count',
    },
    {
      args: [
        [],
        [q(7, GH('h1', 'html'))],
        [take(7), run(7, ['/m/other.docx']), run(7, ['/m/b.pdf'])],
        null,
      ],
      note: 'a path that is no material, then one that is',
    },
    {
      args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7, ['/m/../m/a.docx'])], null],
      note: 'paths are resolved',
    },
    { args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7, [])], null], note: 'an empty list' },
    { args: [[], [q(7, GH('h1', 'html'))], [take(8), run(7, A)], null], note: 'another view took' },
    {
      args: [
        [],
        [q(7, GH('h1', 'html')), q(7, GH('h9', 'html', ['/m/z.docx']))],
        [take(7), run(7, ['/m/z.docx'])],
        null,
      ],
      note: 'a later request replaces the first',
    },
    {
      args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7, A)], { table: { '7': 'tab-7' } }],
      note: 'the tab id the shell names',
    },
    {
      args: [[], [q(7, GH('h1', 'html'))], [take(7), run(7, A)], { table: { '8': 'tab-8' } }],
      note: 'a resolver that does not know the view',
    },
    {
      args: [
        [],
        [q(7, GH('h1', 'html'))],
        [take(7), run(7, A), run(7, A)],
        { table: {}, throwsFor: [7] },
      ],
      note: 'a resolver that throws: the hand-off is used up',
    },
    {
      args: [
        [],
        [q(7, GH('h1', 'html')), q(9, GH('h2', 'html', ['/m/c.docx']))],
        [take(9), take(7), run(7, A), run(9, ['/m/c.docx'])],
        { table: { '7': '', '9': 'tab-9' } },
      ],
      note: 'two views',
    },
  ]
}

function previewCases(): Case[] {
  const base = 'html-asset://local/a/b/'
  const texts = [
    '',
    'plain',
    '<html><head></head><body></body></html>',
    '<!DOCTYPE html><html><body>x</body></html>',
    '<html lang="en">x',
    '<HTML><HEAD><TITLE>t</TITLE></HEAD>',
    '<head>',
    '<HEAD data-x="a>b">x',
    "<head a='>'>",
    '<head',
    '<head>x<head>',
    '<html><head></head><base href="/x/"></html>',
    '<BASE href="/x/">',
    '<base/>',
    '<!-- <base href=x> --><head>',
    '<!-- unterminated <head>',
    '<script>var a="<head>"</script><head>',
    '<script>var a="<base>"</script>',
    '<style>.a{}</style><head>',
    '<title><head></title><head>',
    '<textarea><base></textarea>',
    '<template><base href=x></template><head>',
    '<template><template><base></template></template><head>',
    '<template><script></template></script></template><head>',
    '<template>',
    '<template><head>',
    '<template><!-- </template> --></template><head>',
    '<template><!DOCTYPE x></template>',
    '<template><?x ?></template><head>',
    '<template a=">"><base></template>',
    '<template><',
    '<template></ template><base>',
    '<headx><head>',
    '<heading>',
    '<head:x><head>',
    '<base-x><head>',
    '<basex>',
    '<!DOCTYPE html><!-- c --><?php x ?><html>',
    '<!DOCTYPE',
    '<?xml',
    '<',
    '< head>',
    '<1head>',
    'text <b>bold</b> <head>',
    '<p a="1" b=\'2\'><head>',
    '<p a="unterminated',
    '<script>unterminated',
    '<script></SCRIPT ><head>',
    '<style></style ><head>',
    '<script>x</script\n><base>',
    '\u{1F600}<head>\u{1F600}',
    '\u00fc<html>\u00e9',
    '<HEAD>',
    '<Head>',
  ]
  return [
    ...texts.map((text): Case => ({ args: [text, base] })),
    { args: ['<head>', null], note: 'no base' },
    { args: ['<head>', ''], note: 'an empty base' },
    { args: ['<head>', 'html-asset://local/a"b"c/'] },
    { args: ['<html>', 'html-asset://local/\u00e9/'] },
    { args: ['x', '/x/y'] },
    { args: ['<base>', null] },
  ]
}

function singleFileCases(): Case[] {
  const files: Record<string, FileSpec> = {
    'assets/a.png': { hex: PNG },
    'assets/b.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/c.jpg': { hex: JPEG },
    'assets/d.txt': 'text',
    'assets/e.SVG': '<?xml version="1.0"?><svg/>',
    'assets/f.webp': { hex: hexOf('RIFF') + '24000000' + hexOf('WEBP') + '00' },
    'assets/g.mp4': { hex: '00000020' + hexOf('ftypisom') + '00' },
    'assets/h.gif': { hex: hexOf('GIF89a') + '0100' },
    'assets/my pic.png': { hex: PNG },
    'assets/\u00e9.png': { hex: PNG },
    'assets/unreadable.png': { hex: PNG, mode: 0 },
    'assets/dirpng.png/x': 'x',
    'assets/fake.png': 'not really a picture',
    'assets/page.html': '<svg/>',
    'nested/assets/n.png': { hex: PNG },
  }
  const doc = '$DIR/doc.html'
  const texts = [
    '<img src="assets/a.png">',
    '<img src="assets/a.png"><img src="assets/a.png">',
    '<div style="background:url(assets/a.png)">',
    '<div style="background:url(&quot;assets/a.png&quot;)">',
    '<div style="background:url(&#39;assets/a.png&#39;)">',
    '<style>a{background:url(\'assets/a.png\')} b{background:url("assets/c.jpg")}</style>',
    '<img src="assets/a.png"><div style="background:url(assets/a.png)">',
    '<img src="assets/b.svg"><img src="assets/e.SVG">',
    '<img src="assets/f.webp"><img src="assets/h.gif"><img src="assets/c.jpg">',
    '<img src="assets/missing.png">',
    '<img src="assets/d.txt"><img src="assets/g.mp4"><img src="assets/fake.png">',
    '<img src="assets/unreadable.png">',
    '<img src="assets/dirpng.png">',
    '<img src="../outside.png"><img src="/abs.png">',
    '<img src="http://x/a.png"><img src="data:image/png;base64,AAAA"><img src="//cdn/a.png"><img src="about:blank">',
    '<img src=""><img src="assets/a.png">',
    '<p>nothing</p>',
    '',
    '<img src="assets/a.png"><img src="assets/missing.png"><img src="assets/d.txt"><img src="assets/b.svg">',
    '    <img src="assets/a.png">\n  ![md](assets/a.png)',
    '<img src="assets/my%20pic.png"><img src="assets/%C3%A9.png">',
    '\u{1F600}<img src="assets/a.png">\u00e9<div style="background:url(assets/c.jpg)">\u{1F600}',
    '<img src="assets/page.html">',
    '<img src="assets/a.png" src="x">',
    '<img src=assets/a.png>',
    '<img src="assets/a.png"> <img src="assets/missing.png"> <img src="assets/missing.png">',
    '<div style="background:url(assets/missing.png)">',
  ]
  return [
    ...texts.map((text): Case => ({ args: [text, doc], files })),
    { args: ['<img src="assets/a.png">', null], files, note: 'a document that was never saved' },
    { args: ['<img src="assets/a.png">', ''], files, note: 'an empty path' },
    {
      args: ['<img src="assets/n.png">', '$DIR/nested/doc.html'],
      files,
      note: 'a document in a folder',
    },
    {
      args: ['<img src="assets/a.png">', '$DIR/none/doc.html'],
      files,
      note: 'a folder that is missing',
    },
  ]
}

// ---------------------------------------------------------------------------
// epub: reading state
// ---------------------------------------------------------------------------

type Step = Record<string, unknown>

/** `[dir, steps]`: one answer per step; the write goes to the file, the deps log their calls */
async function readingStateRun(a: unknown[], cx: TsContext): Promise<unknown> {
  const dir = str(a, 0)
  const steps = a[1] as Step[]
  let fail = false
  let tick = 0
  const state = createReadingState({
    dir: () => {
      cx.log('dir')
      return dir
    },
    write: async (path, text) => {
      cx.log('write', path)
      if (fail) throw Object.assign(new Error('boom'), { code: 'EBOOM' })
      await writeFile(path, text)
    },
    now: () => {
      cx.log('now')
      return cx.now + tick++
    },
  })
  const answers: unknown[] = []
  for (const step of steps) {
    const op = step.op as string
    try {
      let value: unknown
      switch (op) {
        case 'get':
          value = await state.get(step.path as string | null)
          break
        case 'setPosition':
          await state.setPosition(step.path as string, step.position as never)
          break
        case 'setViewPrefs':
          value = await state.setViewPrefs(step.patch)
          break
        case 'movePosition':
          await state.movePosition(step.from as string, step.to as string)
          break
        case 'failWrites':
          fail = step.on === true
          break
        default:
          throw new Error(`unknown op ${op}`)
      }
      answers.push(value === undefined ? { op } : { op, ok: value })
    } catch (error) {
      answers.push({ op, error: (error as Error).message })
    }
  }
  return answers
}

const P = (spineIndex: unknown, blockId: unknown = null): Record<string, unknown> => ({
  spineIndex,
  blockId,
})

const STATE_FILE = (positions: Record<string, unknown>, viewPrefs?: unknown): string =>
  JSON.stringify({ version: 1, viewPrefs: viewPrefs ?? EPUB_VIEW_PREFS_DEFAULT, positions })

const posEntry = (spineIndex: unknown, blockId: unknown, updatedAt: unknown): unknown => ({
  spineIndex,
  blockId,
  updatedAt,
})

function readingStateCases(): Case[] {
  const D = '$DIR/data'
  const f = `${D}/${READING_STATE_FILE}`
  const get = (path: string | null): Step => ({ op: 'get', path })
  const set = (path: string, position: unknown): Step => ({ op: 'setPosition', path, position })
  const prefs = (patch: unknown): Step => ({ op: 'setViewPrefs', patch })
  const move = (from: string, to: string): Step => ({ op: 'movePosition', from, to })
  const many: Record<string, unknown> = {}
  for (let i = 0; i < MAX_POSITIONS + 5; i++) {
    many[`/books/b${i}.epub`] = posEntry(i, null, 1_000 + ((i * 7) % 50))
  }
  const caseFor = (steps: Step[], files?: Record<string, FileSpec>, note?: string): Case =>
    fileCase([D, steps], files, note)
  return [
    caseFor([get('/b.epub')], undefined, 'no file yet'),
    caseFor([get(null), get('')], undefined, 'no book path'),
    caseFor([set('/b.epub', P(3, 'blk')), get('/b.epub')], undefined, 'a position is kept'),
    caseFor(
      [set('/b.epub', P(3, 'blk')), set('/b.epub', P(4)), get('/b.epub')],
      undefined,
      'a later position replaces',
    ),
    caseFor([set('/b.epub', P(0, null)), set('/c.epub', P(1, 'x'))], undefined, 'two books'),
    caseFor(
      [get('/a.epub')],
      { 'data/epub-reading.json': STATE_FILE({ '/a.epub': posEntry(2, 'q', 5) }) },
      'a file with a position',
    ),
    caseFor(
      [get('/A.EPUB')],
      { 'data/epub-reading.json': STATE_FILE({ '/a.epub': posEntry(2, 'q', 5) }) },
      'case of the path',
    ),
    caseFor(
      [get('/dir/../a.epub')],
      { 'data/epub-reading.json': STATE_FILE({ '/a.epub': posEntry(2, 'q', 5) }) },
      'path spelled with ..',
    ),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': '{' }, 'invalid JSON counts as empty'),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': '' }, 'an empty file'),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': '[]' }, 'an array'),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': 'null' }),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': '"x"' }),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': '\ufeff{}' }, 'a byte order mark'),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': { dir: true } }, 'the file is a folder'),
    caseFor([get('/a.epub')], { 'data/epub-reading.json': { hex: 'ff7b7dfe' } }, 'invalid UTF-8'),
    caseFor(
      [
        get('/a.epub'),
        get('/b.epub'),
        get('/c.epub'),
        get('/d.epub'),
        get('/e.epub'),
        get('/f.epub'),
        get('/g.epub'),
        get('/h.epub'),
        get('/i.epub'),
        get('/j.epub'),
        get('/k.epub'),
        get('/l.epub'),
      ],
      {
        'data/epub-reading.json': STATE_FILE({
          '/a.epub': posEntry(-1, null, 1),
          '/b.epub': posEntry(1.5, null, 1),
          '/c.epub': posEntry('1', null, 1),
          '/d.epub': posEntry(1, 5, 1),
          '/e.epub': posEntry(1, 'x'.repeat(65), 1),
          '/f.epub': posEntry(1, 'x'.repeat(64), 1),
          '/g.epub': { spineIndex: 1 },
          '/h.epub': 7,
          '/i.epub': posEntry(1, null, 'late'),
          '/j.epub': posEntry(9007199254740991, null, 1),
          '/k.epub': posEntry(9007199254740992, null, 1),
          '/l.epub': posEntry(0, '\u{1F600}'.repeat(32), 1),
        }),
      },
      'positions that are not',
    ),
    caseFor(
      [set('/z.epub', P(1))],
      {
        'data/epub-reading.json':
          '{"version":1,"viewPrefs":{},"positions":{"__proto__":{"spineIndex":1,"blockId":null,"updatedAt":3},"/q.epub":{"spineIndex":2,"blockId":null,"updatedAt":4}}}',
      },
      'a __proto__ position is dropped',
    ),
    caseFor(
      [set('/z.epub', P(1))],
      {
        'data/epub-reading.json':
          '{"version":1,"viewPrefs":{},"positions":{"10":{"spineIndex":1,"blockId":null,"updatedAt":3},"b":{"spineIndex":2,"blockId":null,"updatedAt":4},"2":{"spineIndex":3,"blockId":null,"updatedAt":5}}}',
      },
      'integer-like keys come first',
    ),
    caseFor(
      [set('2', P(1)), set('10', P(2)), set('a', P(3)), set('1', P(4))],
      undefined,
      'paths that resolve against the working folder',
    ),
    caseFor(
      [get('/a.epub')],
      {
        'data/epub-reading.json':
          '{"version":1,"viewPrefs":{"fontScale":9,"lineHeight":0,"dark":"yes"},"positions":{}}',
      },
      'view prefs clamped',
    ),
    caseFor([get('/a.epub')], {
      'data/epub-reading.json':
        '{"version":1,"viewPrefs":{"fontScale":0.1,"lineHeight":null,"dark":true},"positions":{}}',
    }),
    caseFor(
      [get('/a.epub')],
      {
        'data/epub-reading.json':
          '{"version":1,"viewPrefs":{"fontScale":"2","lineHeight":"2","dark":1},"positions":{}}',
      },
      'view prefs of the wrong type',
    ),
    caseFor([get('/a.epub')], {
      'data/epub-reading.json': '{"version":1,"viewPrefs":[],"positions":[]}',
    }),
    caseFor(
      [get('/a.epub')],
      { 'data/epub-reading.json': '{"version":1,"viewPrefs":{"fontScale":1e999},"positions":{}}' },
      'Infinity',
    ),
    caseFor(
      [
        prefs({ fontScale: 2 }),
        prefs({ lineHeight: 1.5 }),
        prefs({ dark: true }),
        prefs({ lineHeight: null }),
        get(null),
      ],
      undefined,
      'view settings change one field at a time',
    ),
    caseFor([prefs({ fontScale: 100, lineHeight: -4 })], undefined, 'clamped'),
    caseFor([prefs({ fontScale: NaN, lineHeight: Infinity, dark: 'x' })], undefined, 'not finite'),
    caseFor(
      [prefs(null), prefs(5), prefs([1]), prefs('x'), prefs(undefined)],
      undefined,
      'a patch that is no record',
    ),
    caseFor([
      prefs({ fontScale: 0.5 }),
      prefs({ fontScale: 3 }),
      prefs({ fontScale: -0 }),
      prefs({ lineHeight: 1 }),
      prefs({ lineHeight: 3 }),
    ]),
    caseFor([prefs({ fontScale: 1.23456789012345678 })]),
    caseFor(
      [set('/a.epub', P(1, 'x')), move('/a.epub', '/b.epub'), get('/a.epub'), get('/b.epub')],
      undefined,
      'a position follows a rename',
    ),
    caseFor(
      [move('/a.epub', '/b.epub'), get('/b.epub')],
      undefined,
      'nothing to move: the file is still written',
    ),
    caseFor(
      [set('/a.epub', P(1)), move('/a.epub', '/a.epub'), get('/a.epub')],
      undefined,
      'moved onto itself',
    ),
    caseFor(
      [set('/a.epub', P(1)), set('/b.epub', P(2)), move('/a.epub', '/b.epub'), get('/b.epub')],
      undefined,
      'moved onto another',
    ),
    caseFor([set('/a.epub', P(1)), move('/a.epub', '/dir/../c.epub'), get('/c.epub')]),
    caseFor(
      [get('/a.epub')],
      { 'data/epub-reading.json': STATE_FILE(many) },
      'more than the limit, read',
    ),
    caseFor(
      [set('/new.epub', P(1))],
      { 'data/epub-reading.json': STATE_FILE(many) },
      'one more: the oldest are dropped',
    ),
    caseFor(
      [set('/b7.epub', P(1))],
      { 'data/epub-reading.json': STATE_FILE(many) },
      'one that is known is moved up',
    ),
    caseFor(
      [
        failWrites(true),
        set('/a.epub', P(1)),
        get('/a.epub'),
        failWrites(false),
        get('/a.epub'),
        prefs({ dark: true }),
        get(null),
      ],
      undefined,
      'a refused write leaves the change in memory',
    ),
    caseFor(
      [failWrites(true), prefs({ dark: true })],
      undefined,
      'a refused write of the settings',
    ),
    caseFor([set('/a.epub', P(1))], { data: 'a file' }, 'the folder is a file'),
    caseFor([get('/a.epub'), set('/a.epub', P(1))], {
      'data/epub-reading.json': STATE_FILE({}),
      data2: '',
    }),
    caseFor([set('/\u00fcn\u00ef/\u{1F600}.epub', P(1, '\u00e9'))], undefined, 'non-ASCII'),
    caseFor([set('/a.epub', P(-0)), get('/a.epub')], undefined, 'minus zero'),
    caseFor([set('/a.epub', P(1.5))], undefined, 'a bad position is refused by the spec'),
    caseFor([{ op: 'nope' }], undefined, 'an unknown op'),
  ].filter(
    (c) =>
      !(c.note ?? '').includes('refused by the spec') && !(c.note ?? '').includes('unknown op'),
  )
}

function failWrites(on: boolean): Step {
  return { op: 'failWrites', on }
}

// ---------------------------------------------------------------------------
// epub: the store handlers
// ---------------------------------------------------------------------------

interface StoreConfig {
  known?: Record<string, string[]>
  store?: {
    langs?: string[]
    stored?: {
      lang: string
      provider: string | null
      model: string | null
      blocks: unknown[]
    } | null
    jobs?: unknown[]
    removed?: number
    heartbeat?: boolean
    throws?: 'write' | 'type' | 'error' | 'empty' | 'string' | 'number'
  }
  storeThrows?: boolean
}

interface HandlerCall {
  fn: 'translations' | 'translation' | 'unfinishedJobs' | 'write'
  owner: number
  args: unknown[]
}

/** what the fake store throws, by the name the spec gives */
function thrownBy(kind: string): unknown {
  switch (kind) {
    case 'write':
      return new StoreWriteError('/x/y', Object.assign(new Error('disk'), { code: 'ENOSPC' }))
    case 'type':
      return new TypeError('bad thing')
    case 'error':
      return new Error('boom')
    case 'empty':
      return new Error('')
    case 'string':
      return 'plain string'
    default:
      return 42
  }
}

/** `[config, calls]`: one answer per call, `{ ok }` or `{ error }` (a rejection) */
async function storeHandlersRun(a: unknown[], cx: TsContext): Promise<unknown> {
  const config = a[0] as StoreConfig
  const calls = a[1] as HandlerCall[]
  const s = config.store ?? {}
  const act = (method: string, ...args: unknown[]): void => {
    cx.log(method, ...args)
    if (s.throws) throw thrownBy(s.throws)
  }
  const store = {
    listTranslations: async (...args: unknown[]) => {
      act('listTranslations', ...args)
      return s.langs ?? []
    },
    readTranslation: async (...args: unknown[]) => {
      act('readTranslation', ...args)
      return s.stored
        ? {
            lang: s.stored.lang,
            provider: s.stored.provider,
            model: s.stored.model,
            blocks: new Map(s.stored.blocks.map((b, i) => [String(i), b])),
          }
        : null
    },
    unfinishedJobs: async (...args: unknown[]) => {
      act('unfinishedJobs', ...args)
      return s.jobs ?? []
    },
    writeTranslationMeta: async (...args: unknown[]) => act('writeTranslationMeta', ...args),
    writeTranslationBlocks: async (...args: unknown[]) => act('writeTranslationBlocks', ...args),
    deleteTranslation: async (...args: unknown[]) => act('deleteTranslation', ...args),
    deleteTranslationExceptEdited: async (...args: unknown[]) => {
      act('deleteTranslationExceptEdited', ...args)
      return s.removed ?? 0
    },
    writeJob: async (...args: unknown[]) => act('writeJob', ...args),
    heartbeatJob: async (...args: unknown[]) => {
      act('heartbeatJob', ...args)
      return s.heartbeat ?? false
    },
  }
  const handlers = createEpubStoreHandlers({
    store: () => {
      cx.log('store')
      if (config.storeThrows) throw new Error('no store')
      return store as unknown as EpubStore
    },
    knows: (owner, docHash) => {
      cx.log('knows', owner, docHash)
      return (config.known?.[String(owner)] ?? []).includes(docHash)
    },
  })
  const answers: unknown[] = []
  for (const call of calls) {
    try {
      const fn = handlers[call.fn] as (...args: unknown[]) => Promise<unknown>
      answers.push({ ok: await fn(call.owner, ...call.args) })
    } catch (error) {
      answers.push({ error: (error as Error).message })
    }
  }
  return answers
}

function storeHandlerCases(): Case[] {
  const H = 'abc123_-'
  const known = { '1': [H, 'other'], '2': ['zzz'] }
  const stored = {
    lang: 'ko',
    provider: 'p',
    model: 'm',
    blocks: [{ key: 1 }, { key: 2, text: 'x' }],
  }
  const call = (fn: HandlerCall['fn'], owner: number, ...args: unknown[]): HandlerCall => ({
    fn,
    owner,
    args,
  })
  const W = (req: unknown): HandlerCall => call('write', 1, req)
  const wr = (extra: Record<string, unknown>) => ({ docHash: H, lang: 'ko', ...extra })
  const job = (extra: Record<string, unknown> = {}) => ({
    kind: 'translate',
    lang: 'ko',
    state: 'running',
    ...extra,
  })
  const run = (
    calls: HandlerCall[],
    store: StoreConfig['store'] = {},
    extra: Partial<StoreConfig> = {},
  ): Case => ({
    args: [{ known, store, ...extra }, calls],
  })
  return [
    run(
      [
        call('translations', 1, H),
        call('translations', 1, H, 'translate'),
        call('translations', 1, H, 'easy'),
      ],
      { langs: ['ko', 'en'] },
    ),
    run([call('translations', 2, H)], { langs: ['ko'] }),
    run([call('translations', 3, H)], {}),
    run([call('translations', 1, 'not known')], {}),
    run([call('translations', 1, '')], {}),
    run([call('translations', 1, 'x'.repeat(128))], {}, { known: { '1': ['x'.repeat(128)] } }),
    run([call('translations', 1, 'x'.repeat(129))], {}, { known: { '1': ['x'.repeat(129)] } }),
    run([call('translations', 1, 'a b')], {}, { known: { '1': ['a b'] } }),
    run([call('translations', 1, 'h\u00e9')], {}, { known: { '1': ['h\u00e9'] } }),
    run([call('translations', 1, 'h\n')], {}, { known: { '1': ['h\n'] } }),
    run(
      [call('translations', 1, 5), call('translations', 1, null), call('translations', 1, ['abc'])],
      {},
    ),
    run(
      [
        call('translations', 1, H, 'bad'),
        call('translations', 1, H, null),
        call('translations', 1, H, 5),
      ],
      {},
    ),
    run(
      [
        call('translations', 1, H, 'EASY'),
        call('translations', 1, H, 'toString'),
        call('translations', 1, H, ['easy']),
      ],
      {},
    ),
    run([call('translations', 1, H)], { throws: 'write' }),
    run([call('translations', 1, H)], { throws: 'type' }),
    run([call('translations', 1, H)], { throws: 'error' }),
    run([call('translations', 1, H)], { throws: 'empty' }),
    run([call('translations', 1, H)], { throws: 'string' }),
    run([call('translations', 1, H)], { throws: 'number' }),
    run([call('translations', 1, H)], {}, { storeThrows: true }),
    run([call('translation', 1, H, 'ko'), call('translation', 1, H, 'ko', 'easy')], { stored }),
    run([call('translation', 1, H, 'ko')], { stored: null }),
    run([call('translation', 1, H, 'ko')], {
      stored: { lang: 'ko', provider: null, model: null, blocks: [] },
    }),
    run(
      [
        call('translation', 1, H, 'k o'),
        call('translation', 1, H, ''),
        call('translation', 1, H),
        call('translation', 1, H, 5),
      ],
      { stored },
    ),
    run(
      [
        call('translation', 1, H, 'ko', 'x'),
        call('translation', 1, 'unknown', 'ko'),
        call('translation', 1, 5, 'ko'),
      ],
      { stored },
    ),
    run([call('translation', 1, H, 'ko')], { stored, throws: 'write' }),
    run([call('translation', 1, H, 'ko')], { stored }, { storeThrows: true }),
    run([call('unfinishedJobs', 1, H)], {
      jobs: [{ kind: 'translate', lang: 'ko' }, { kind: 'summary' }],
    }),
    run(
      [call('unfinishedJobs', 1, H), call('unfinishedJobs', 2, H), call('unfinishedJobs', 1, 5)],
      {},
    ),
    run([call('unfinishedJobs', 1, H)], { throws: 'type' }),
    run([call('unfinishedJobs', 1, H)], {}, { storeThrows: true }),
    run([call('write', 1), W(null), W([]), W('x'), W(5)], {}),
    run(
      [
        W({ lang: 'ko', kind: 'deleteTranslation' }),
        W({ docHash: 'nope', lang: 'ko' }),
        W({ docHash: 5, lang: 'ko' }),
      ],
      {},
    ),
    run(
      [
        W({ docHash: H }),
        W({ docHash: H, lang: '' }),
        W({ docHash: H, lang: 'a b' }),
        W({ docHash: H, lang: 5 }),
      ],
      {},
    ),
    run(
      [
        W(wr({ mode: 'bad', kind: 'deleteTranslation' })),
        W(wr({ mode: null, kind: 'deleteTranslation' })),
        W(wr({ mode: 3, kind: 'deleteTranslation' })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'translationMeta', provider: 'p', model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: 'p', model: 'm', mode: 'easy' })),
        W(wr({ kind: 'translationMeta', provider: 'p', model: 'm', mode: 'translate' })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'translationMeta', provider: 'p' })),
        W(wr({ kind: 'translationMeta', model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: 1, model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: '', model: '' })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'translationMeta', provider: 'x'.repeat(200), model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: 'x'.repeat(201), model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: '\u{1F600}'.repeat(100), model: 'm' })),
        W(wr({ kind: 'translationMeta', provider: '\u{1F600}'.repeat(101), model: 'm' })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'translationBlocks', blocks: [{ a: 1 }, { b: 2 }] })),
        W(wr({ kind: 'translationBlocks', blocks: [], mode: 'easy' })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'translationBlocks' })),
        W(wr({ kind: 'translationBlocks', blocks: 'x' })),
        W(wr({ kind: 'translationBlocks', blocks: {} })),
        W(wr({ kind: 'translationBlocks', blocks: [{ a: 1 }, 5] })),
        W(wr({ kind: 'translationBlocks', blocks: [[]] })),
        W(wr({ kind: 'translationBlocks', blocks: [null] })),
      ],
      {},
    ),
    run(
      [W(wr({ kind: 'translationBlocks', blocks: Array.from({ length: 3 }, (_, i) => ({ i })) }))],
      {},
    ),
    {
      args: [
        { known, store: {} },
        [W(wr({ kind: 'translationBlocks', blocks: Array.from({ length: 10_001 }, () => ({})) }))],
      ],
      note: 'one block too many',
    },
    {
      args: [
        { known, store: {} },
        [W(wr({ kind: 'translationBlocks', blocks: Array.from({ length: 10_000 }, () => ({})) }))],
      ],
      note: 'exactly the most',
    },
    run(
      [W(wr({ kind: 'deleteTranslation' })), W(wr({ kind: 'deleteTranslation', mode: 'easy' }))],
      {},
    ),
    run(
      [
        W(wr({ kind: 'deleteTranslationExceptEdited' })),
        W(wr({ kind: 'deleteTranslationExceptEdited', mode: 'easy' })),
      ],
      { removed: 3 },
    ),
    run([W(wr({ kind: 'deleteTranslationExceptEdited' }))], { removed: 0 }),
    run(
      [
        W(wr({ kind: 'job', job: job() })),
        W(wr({ kind: 'job', job: job({ mode: 'easy' }), mode: 'easy' })),
        W(wr({ kind: 'job', job: job({ mode: 'translate' }) })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'job' })),
        W(wr({ kind: 'job', job: 'x' })),
        W(wr({ kind: 'job', job: [] })),
        W(wr({ kind: 'job', job: null })),
        W(wr({ kind: 'job', job: job({ kind: 'summary' }) })),
        W(wr({ kind: 'job', job: job({ lang: 'en' }) })),
        W(wr({ kind: 'job', job: job({ lang: 5 }) })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'job', job: job({ mode: 'easy' }) })),
        W(wr({ kind: 'job', job: job(), mode: 'easy' })),
        W(wr({ kind: 'job', job: job({ mode: 'bad' }) })),
        W(wr({ kind: 'job', job: job({ mode: null }) })),
      ],
      {},
    ),
    run(
      [
        W(wr({ kind: 'heartbeat', job: 'translate' })),
        W(wr({ kind: 'heartbeat', job: 'translate', mode: 'easy' })),
      ],
      { heartbeat: true },
    ),
    run([W(wr({ kind: 'heartbeat', job: 'translate' }))], { heartbeat: false }),
    run(
      [
        W(wr({ kind: 'heartbeat' })),
        W(wr({ kind: 'heartbeat', job: 'summary' })),
        W(wr({ kind: 'heartbeat', job: 5 })),
      ],
      { heartbeat: true },
    ),
    run(
      [
        W(wr({})),
        W(wr({ kind: 'nope' })),
        W(wr({ kind: 5 })),
        W(wr({ kind: 'TRANSLATIONMETA' })),
        W(wr({ kind: 'toString' })),
      ],
      {},
    ),
    run([W(wr({ kind: 'translationMeta', provider: 'p', model: 'm' }))], { throws: 'write' }),
    run([W(wr({ kind: 'translationBlocks', blocks: [{}] }))], { throws: 'type' }),
    run([W(wr({ kind: 'deleteTranslation' }))], { throws: 'error' }),
    run([W(wr({ kind: 'deleteTranslationExceptEdited' }))], { throws: 'empty' }),
    run([W(wr({ kind: 'job', job: job() }))], { throws: 'string' }),
    run([W(wr({ kind: 'heartbeat', job: 'translate' }))], { throws: 'number' }),
    run([W(wr({ kind: 'deleteTranslation' }))], {}, { storeThrows: true }),
    run([W(wr({ kind: 'nope' })), W({ docHash: 'nope', lang: 'ko' })], {}, { storeThrows: true }),
  ]
}

// ---------------------------------------------------------------------------
// epub: result paths
// ---------------------------------------------------------------------------

function resultPathCases(): Case[] {
  const ctx = (over: Record<string, unknown> = {}) => ({
    sourcePath: '/books/a.epub',
    open: ['/books/open.epub'],
    ...over,
  })
  const paths: unknown[] = [
    '/books/new.epub',
    '/books/new.EPUB',
    '/books/new.Epub',
    '/books/new.epub ',
    '/books/new.epub\n',
    '/books/.epub',
    '/books/epub',
    '/books/new.epubx',
    '/books/new.txt',
    '/books/a.epub',
    '/books/A.EPUB',
    '/books/../books/a.epub',
    '/books/./a.epub',
    '/books//a.epub',
    '/books/open.epub',
    '/books/OPEN.epub',
    'relative/new.epub',
    '',
    '/',
    '/' + 'x'.repeat(4090) + '.epub',
    '/' + 'x'.repeat(4091) + '.epub',
    '/' + '\u{1F600}'.repeat(2045) + '.epub',
    '/' + '\u{1F600}'.repeat(2046) + '.epub',
    '/b\u00fcch\u00e9r/\u00e9.epub',
    '/books/\u212A.epub',
    '/books/new.\u0435pub',
    5,
    null,
    undefined,
    {},
    ['/books/new.epub'],
    true,
  ]
  return [
    ...paths.map((p): Case => ({ args: [p, ctx()], note: JSON.stringify(p)?.slice(0, 40) })),
    ...paths
      .slice(0, 16)
      .map((p): Case => ({ args: [p, ctx({ caseInsensitive: true })], note: 'case-insensitive' })),
    ...paths
      .slice(0, 16)
      .map((p): Case => ({ args: [p, ctx({ caseInsensitive: false })], note: 'case-sensitive' })),
    { args: ['/b/x.epub', { sourcePath: '/b/x.epub', open: [] }], note: 'source and no tab' },
    {
      args: [
        '/b/x.epub',
        { sourcePath: '/b/other.epub', open: ['/b/x.epub'], caseInsensitive: false },
      ],
    },
    {
      args: ['/B/X.epub', { sourcePath: '/b/x.epub', open: ['/b/x.epub'], caseInsensitive: true }],
      note: 'the tab holds another case: it is asked with the path as given',
    },
  ]
}

function pathKeyCases(): Case[] {
  return [
    ...[
      '/a/b.epub',
      '/A/B.EPUB',
      '/a/../a/b.epub',
      '/a//b.epub',
      '/a/./b.epub',
      '/a/b.epub/',
      '/',
      '',
      '.',
      'rel/x.epub',
      '/\u0130/\u212A/\u017F',
      '/\u03A3\u03A3',
      '/\u00c9cole.epub',
      '/\u{1F600}.EPUB',
      'a\\b',
    ].flatMap((p) => [{ args: [p, null] }, { args: [p, true] }, { args: [p, false] }] as Case[]),
  ]
}

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

const epubGroup: Group = {
  'epub/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => epubAtomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: atomicCases(),
  },
  'reading-state.READING_STATE_FILE': {
    ts: () => READING_STATE_FILE,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'reading-state.MAX_POSITIONS': {
    ts: () => MAX_POSITIONS,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'reading-state.viewPrefsOf': {
    ts: (a) => viewPrefsOf(a[0], (a[1] as typeof EPUB_VIEW_PREFS_DEFAULT | null) ?? undefined),
    cases: [
      { args: [null, null] },
      { args: [5, null] },
      { args: [[], null] },
      { args: ['x', null] },
      { args: [{}, null] },
      { args: [{ fontScale: 2, lineHeight: 2, dark: true }, null] },
      { args: [{ fontScale: 0.25 }, null] },
      { args: [{ fontScale: 7 }, null] },
      { args: [{ fontScale: 0.5 }, null] },
      { args: [{ fontScale: 3 }, null] },
      { args: [{ fontScale: '2' }, null] },
      { args: [{ fontScale: null }, null] },
      { args: [{ lineHeight: null }, { fontScale: 2, lineHeight: 1.5, dark: true }] },
      { args: [{ lineHeight: 0 }, null] },
      { args: [{ lineHeight: 9 }, null] },
      { args: [{ lineHeight: 1.7 }, null] },
      { args: [{ lineHeight: '1.7' }, null] },
      { args: [{ dark: false }, { fontScale: 2, lineHeight: 1.5, dark: true }] },
      { args: [{ dark: 'false' }, { fontScale: 2, lineHeight: 1.5, dark: true }] },
      { args: [{ dark: 0 }, { fontScale: 2, lineHeight: 1.5, dark: true }] },
      {
        args: [
          { unknown: 1, fontScale: 1.25 },
          { fontScale: 2, lineHeight: 1.5, dark: false },
        ],
      },
      { args: [null, { fontScale: 2, lineHeight: 1.5, dark: false }] },
      { args: [{ fontScale: 1.23456789012345678, lineHeight: 2.5 }, null] },
      { args: [{ fontScale: -0 }, null] },
      { args: [{ fontScale: 1e300, lineHeight: -1e300 }, null] },
    ],
  },
  'reading-state.readPositionOf': {
    ts: (a) => readPositionOf(a[0]),
    cases: cases(
      [{ spineIndex: 0, blockId: null }],
      [{ spineIndex: 5, blockId: 'abc' }],
      [{ spineIndex: 5, blockId: 'x'.repeat(64) }],
      [{ spineIndex: 5, blockId: 'x'.repeat(65) }],
      [{ spineIndex: 5, blockId: '\u{1F600}'.repeat(32) }],
      [{ spineIndex: 5, blockId: '\u{1F600}'.repeat(33) }],
      [{ spineIndex: 5, blockId: 5 }],
      [{ spineIndex: 5 }],
      [{ spineIndex: -1, blockId: null }],
      [{ spineIndex: 1.5, blockId: null }],
      [{ spineIndex: '1', blockId: null }],
      [{ spineIndex: null, blockId: null }],
      [{ spineIndex: 9007199254740991, blockId: null }],
      [{ spineIndex: 9007199254740992, blockId: null }],
      [{ spineIndex: -0, blockId: null }],
      [{ blockId: null }],
      [{ spineIndex: 3, blockId: null, extra: 1 }],
      [null],
      [5],
      ['x'],
      [[]],
      [[{ spineIndex: 1, blockId: null }]],
    ),
  },
  'reading-state.createReadingState': {
    ts: readingStateRun,
    cases: readingStateCases(),
  },
  'result-paths.pathKey': {
    ts: (a) => pathKey(str(a, 0), (a[1] as boolean | null) ?? undefined),
    cases: pathKeyCases(),
  },
  'result-paths.samePath': {
    ts: (a) => samePath(str(a, 0), str(a, 1), (a[2] as boolean | null) ?? undefined),
    cases: cases(
      ['/a/b', '/a/b', null],
      ['/a/b', '/a/./b', null],
      ['/a/b', '/a/c', null],
      ['/a/B', '/a/b', true],
      ['/a/B', '/a/b', false],
      ['/a/B', '/a/b', null],
      ['/\u0130', '/i\u0307', true],
      ['/\u212A', '/k', true],
      ['/\u017F', '/s', true],
      ['/a/', '/a', false],
      ['', '.', false],
    ),
  },
  'result-paths.checkResultPath': {
    ts: (a, cx) =>
      checkResultPath(a[0], {
        sourcePath: (a[1] as { sourcePath: string }).sourcePath,
        isOpenInTab: (path: string) => {
          cx.log('isOpenInTab', path)
          return ((a[1] as { open?: string[] }).open ?? []).includes(path)
        },
        caseInsensitive: (a[1] as { caseInsensitive?: boolean }).caseInsensitive,
      }),
    cases: resultPathCases(),
  },
  'store-handlers.createEpubStoreHandlers': {
    ts: storeHandlersRun,
    cases: storeHandlerCases(),
  },

  // ---- the pieces of packages/pdf-structure ----
  'pdf-structure/job-keys.isTranslationMode': {
    ts: (a) => isTranslationMode(a[0]),
    cases: cases(
      ['translate'],
      ['easy'],
      ['EASY'],
      [''],
      ['toString'],
      ['constructor'],
      [5],
      [null],
      [['easy']],
      [{}],
      [true],
    ),
  },
  'pdf-structure/job-keys.jobKeyOf': {
    ts: (a) => jobKeyOf(a[0] as Parameters<typeof jobKeyOf>[0]),
    cases: cases(
      [{ kind: 'translate', lang: 'ko' }],
      [{ kind: 'translate-page', lang: 'en' }],
      [{ kind: 'summary', lang: 'ja' }],
      [{ kind: 'highlight', runId: 'r1' }],
      [{ kind: 'highlight', lang: 'ko' }],
      [{ kind: 'translate', runId: 'r1' }],
      [{ kind: 'translate' }],
      [{ kind: 'highlight' }],
      [{ kind: 'ai-read' }],
      [{ kind: 'ai-read', lang: 'ko', runId: 'r' }],
      [{ kind: 'nope', lang: 'ko', runId: 'r' }],
      [{ kind: 'translate', lang: '' }],
      [{ kind: 'Translate', lang: 'ko' }],
    ),
  },
  'pdf-structure/files.StoreWriteError': {
    ts: (a) => {
      const error = new StoreWriteError(str(a, 0), a[1])
      return {
        name: error.name,
        message: error.message,
        code: error.code,
        errno: error.errno,
        path: error.path,
      }
    },
    cases: cases(
      ['/x/y', { code: 'ENOSPC' }],
      ['/x/y', { code: 'EACCES' }],
      ['/x/y', { code: '' }],
      ['/x/y', {}],
      ['/x/y', null],
      ['/x/y', undefined],
      ['/x/y', 'text'],
      ['', { code: 'EIO' }],
      ['/\u00fc/\u{1F600}', { code: 'ENOTDIR' }],
      ['C:\\x\\y', { code: 'EPERM' }],
    ),
  },
}

export const group: Group = { ...htmlGroup, ...epubGroup }
