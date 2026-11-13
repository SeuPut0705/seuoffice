/**
 * The Word editor's exports: PDF (printed by the view, internal links
 * added), merged PDF parts, HTML (lazy pictures inlined), Markdown (pictures
 * beside it), Hangul (converted, losses confirmed), page images (a temp PDF,
 * PNGs into a picked folder), and saving a picture. A target the renderer
 * names must have been authorized by a dialog first.
 */
import type { Call, Case, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]
const A4 = [11906, 16838]
const hex = (text: string): string => Buffer.from(text).toString('hex')
const b64 = (text: string): string => Buffer.from(text).toString('base64')

const bytesCall = (channel: string, args: unknown[], text: string): Call => ({
  channel,
  args: args.map((a) => (a === BYTES ? { $: 'b', k: 'ab', i: 0 } : a)),
  buffers: [hex(text)],
})
const BYTES = Symbol('bytes')

const cases: Case[] = [
  {
    note: 'export-pdf refuses a bad page size or scale, and a path no dialog authorized',
    calls: [
      { channel: 'docs:export-pdf', args: ['d.docx', 0, 16838] },
      { channel: 'docs:export-pdf', args: ['d.docx', ...A4, { $: 'u' }, 99] },
      { channel: 'docs:export-pdf', args: ['d.docx', ...A4, '$DIR/out/d.pdf'] },
    ],
  },
  {
    note: 'export-pdf: dialog cancelled, then printed into the pick and revealed',
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [null, '$DIR/out/d.pdf'] }, contents: { pdf: hex('%PDF-1.7') } },
    },
    calls: [
      { channel: 'docs:export-pdf', args: ['d.docx', ...A4] },
      { channel: 'docs:export-pdf', args: ['d.odt', ...A4, { $: 'u' }, 0.5] },
    ],
  },
  {
    note: 'export-pdf with internal links, and the shell opening the export in a tab',
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/l.pdf'] }, contents: { pdf: hex('%PDF') } },
      d2: { docs: { add_pdf_internal_links: '%PDF+links', open_generated_path: true } },
    },
    calls: [
      {
        channel: 'docs:export-pdf',
        args: [
          'l.docx',
          ...A4,
          { $: 'u' },
          1,
          [{ page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.1, to: 1 }],
        ],
      },
    ],
  },
  {
    note: 'export-pdf whose printing fails names the authorized path for a retry',
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: ['$DIR/out/f.pdf'] } } },
    calls: [
      { channel: 'docs:export-pdf', args: ['f.docx', ...A4] },
      { channel: 'docs:export-pdf', args: ['f.docx', ...A4, '$DIR/out/f.pdf'] },
    ],
  },
  {
    note: 'export-pdf without a default name to suggest throws as the TypeScript does',
    calls: [{ channel: 'docs:export-pdf', args: [5, ...A4] }],
  },
  {
    note: 'merged PDF parts: one file, pages in order, links added',
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: [null, '$DIR/out/m.pdf'] } } },
    calls: [
      { channel: 'docs:save-merged-pdf', args: ['m.docx', [b64('a')]] },
      {
        channel: 'docs:save-merged-pdf',
        args: ['m.docx', [b64('part one,'), b64('part two')], { $: 'u' }, [{ page: 1 }]],
      },
      { channel: 'docs:save-merged-pdf', args: ['m.docx', [b64('x')], '$DIR/out/other.pdf'] },
    ],
  },
  {
    note: 'export-html: empty refused, written with the lazy pictures inlined',
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/p.html'] } },
      d2: { docs: { read_lazy_media: { body: 'png!', mime: 'image/png' } } },
    },
    calls: [
      { channel: 'docs:export-html', args: ['p.docx', ''] },
      {
        channel: 'docs:export-html',
        args: [
          'p.docx',
          '<img src="seuoffice-docx-media://abc/word/media/image1.png"><img src="seuoffice-docx-media://abc/word/media/image1.png">',
        ],
      },
    ],
  },
  {
    note: 'export-markdown: refused lists, pictures beside it, the folder name escaped',
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: [null, '$DIR/out/note (1).md'] } } },
    calls: [
      { channel: 'docs:export-markdown', args: ['n.docx', ''] },
      { channel: 'docs:export-markdown', args: ['n.docx', '# x', 'no'] },
      { channel: 'docs:export-markdown', args: ['n.docx', '# x', []] },
      {
        channel: 'docs:export-markdown',
        args: [
          'n.docx',
          '![](__seuoffice_media__/image1.png) ![](__seuoffice_media__/image2.png)',
          [
            { name: 'image1.png', src: `data:image/png;base64,${b64('one')}` },
            { name: '../evil.png', src: `data:image/png;base64,${b64('x')}` },
            { name: 'image2.png', src: 'seuoffice-docx-media://h/word/media/image2.png' },
          ],
        ],
      },
    ],
  },
  {
    note: 'export-hwp: a bad request, an unauthorized path, the dialog cancelled',
    calls: [
      { channel: 'docs:export-hwp', args: ['d', 'x'] },
      bytesCall('docs:export-hwp', ['d', BYTES, 7], 'x'),
      bytesCall('docs:export-hwp', ['d.docx', BYTES, '$DIR/x.hwp'], 'x'),
      bytesCall('docs:export-hwp', ['d.docx', BYTES], 'x'),
    ],
  },
  {
    note: 'export-hwp: converted into the pick (HWPX first by the settings) and opened',
    files: { out: { dir: true }, 'userData/app-settings.json': '{"hwpDefaultFormat":"hwpx"}' },
    hosts: { shared: { dialogs: { save: ['$DIR/out/d'] } } },
    calls: [bytesCall('docs:export-hwp', ['d.docx', BYTES], 'docx bytes')],
  },
  {
    note: 'export-hwp: a loss asks; cancel writes nothing, a second try saves; a refusal names its code',
    files: { out: { dir: true } },
    hosts: {
      shared: {
        dialogs: {
          save: ['$DIR/out/a.hwp', '$DIR/out/b.hwp', '$DIR/out/c.hwp'],
          message: [{ response: 1 }, { response: 0 }],
        },
      },
      d2: {
        docs: {
          convert_to_hwp: [
            { losses: [{ feature: 'chart', kind: 'dropped', count: 2 }] },
            { losses: [{ feature: 'comment', kind: 'changed', count: 1 }] },
            { code: 'unsupported', error: 'cannot convert' },
          ],
        },
      },
    },
    calls: [
      bytesCall('docs:export-hwp', ['a.docx', BYTES], 'a'),
      bytesCall('docs:export-hwp', ['b.docx', BYTES, { $: 'u' }, true], 'b'),
      bytesCall('docs:export-hwp', ['c.docx', BYTES], 'c'),
    ],
  },
  {
    note: 'page images: a folder picked (cancel first), the temp PDF printed, read back once, PNGs written',
    files: { imgs: { dir: true }, temp: { dir: true } },
    hosts: {
      shared: { dialogs: { open: [null, ['$DIR/imgs']] }, contents: { pdf: hex('%PDF pages') } },
    },
    calls: [
      { channel: 'docs:pick-export-images-target', args: [] },
      { channel: 'docs:pick-export-images-target', args: [] },
      {
        channel: 'docs:export-pdf',
        args: [
          'd.docx',
          ...A4,
          '$DIR/temp/seuoffice-docs-images-00000000-0000-4000-8000-000000000001.pdf',
        ],
      },
      {
        channel: 'docs:take-export-pdf',
        args: ['$DIR/temp/seuoffice-docs-images-00000000-0000-4000-8000-000000000001.pdf'],
      },
      {
        channel: 'docs:take-export-pdf',
        args: ['$DIR/temp/seuoffice-docs-images-00000000-0000-4000-8000-000000000001.pdf'],
      },
      { channel: 'docs:write-export-image', args: ['$DIR/imgs', 'page-1.png', b64('png one')] },
      { channel: 'docs:write-export-image', args: ['$DIR/imgs', '../x.png', b64('x')] },
      { channel: 'docs:write-export-image', args: ['$DIR/imgs', 'a.jpg', b64('x')] },
      { channel: 'docs:write-export-image', args: ['$DIR/other', 'a.png', b64('x')] },
    ],
  },
  {
    note: 'take-export-pdf of a temp file that is gone answers the read error',
    files: { imgs: { dir: true } },
    hosts: { shared: { dialogs: { open: [['$DIR/imgs']] } } },
    calls: [
      { channel: 'docs:pick-export-images-target', args: [] },
      {
        channel: 'docs:take-export-pdf',
        args: ['$DIR/temp/seuoffice-docs-images-00000000-0000-4000-8000-000000000001.pdf'],
      },
      { channel: 'docs:take-export-pdf', args: [3] },
    ],
  },
  {
    note: 'save a picture: refused, a data URL saved where picked, cancelled, an unsupported URL',
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: ['$DIR/out/pic.png', null] } } },
    calls: [
      { channel: 'docs:save-image-as', args: [3] },
      { channel: 'docs:save-image-as', args: [`data:image/png;base64,${b64('hi')}`] },
      { channel: 'docs:save-image-as', args: [`data:image/png;base64,${b64('hi')}`] },
      { channel: 'docs:save-image-as', args: ['javascript:alert(1)'] },
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    await loadDocs(cx)
  },
  cases: cases.map((c) => (c.views ? c : { ...c, views })),
}
