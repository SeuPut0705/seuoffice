/**
 * The Word editor's other invokes: altChunk HTML to docx, AI media analysis,
 * the page capture, picking a picture, the mail merge's source and output,
 * copying a picture, and the AI's new documents.
 */
import type { Case, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]
const hex = (text: string): string => Buffer.from(text).toString('hex')
const b64 = (text: string): string => Buffer.from(text).toString('base64')
const ab = (i: number) => ({ $: 'b', k: 'ab', i })

const cases: Case[] = [
  {
    note: 'altChunk HTML: blank and non-string refused, converted bytes answered, a failed conversion is null',
    files: { temp: { dir: true } },
    hosts: { d2: { docs: { html_to_docx: ['DOCX BYTES', { error: 'layout failed' }] } } },
    calls: [
      { channel: 'docs:altchunk-html-to-docx', args: ['   '] },
      { channel: 'docs:altchunk-html-to-docx', args: [12] },
      { channel: 'docs:altchunk-html-to-docx', args: ['<p>chunk</p>'] },
      { channel: 'docs:altchunk-html-to-docx', args: ['<p>again</p>'] },
    ],
  },
  {
    note: 'analyze-media: a missing request throws; lazy pictures are handed over as data URLs',
    files: { 'docs/a.docx': 'PK' },
    hosts: {
      d2: {
        docs: {
          read_lazy_media: [null, { body: 'img', mime: 'image/png' }],
          analyze_media: [{ text: 'a cat' }, { error: 'provider down' }],
        },
      },
    },
    calls: [
      { channel: 'docs:analyze-media', args: [] },
      {
        channel: 'docs:analyze-media',
        args: [{ mediaUrls: ['https://x/a.png', ''], requirements: 'what' }],
      },
      { channel: 'docs:open-path', args: ['$DIR/docs/a.docx'] },
      {
        channel: 'docs:analyze-media',
        args: [{ mediaUrls: ['seuoffice-docx-media://h/word/media/image1.png'] }],
      },
    ],
  },
  {
    note: 'analyze-media with media URLs that are no list',
    calls: [{ channel: 'docs:analyze-media', args: [{ mediaUrls: 'x' }] }],
  },
  {
    note: 'capture-rect: a bad rectangle is null; a good one is captured in whole device pixels',
    hosts: { d2: { docs: { capture_rect: ['PNG BYTES', ''] } } },
    calls: [
      { channel: 'docs:capture-rect', args: [{ x: 0, y: 0, width: 0, height: 5 }] },
      { channel: 'docs:capture-rect', args: [{ x: 'a', y: 0, width: 5, height: 5 }] },
      { channel: 'docs:capture-rect', args: [null] },
      { channel: 'docs:capture-rect', args: [{ x: -3.5, y: 1.2, width: 10.2, height: 5 }] },
      { channel: 'docs:capture-rect', args: [{ x: 0, y: 0, width: 20000, height: 1 }] },
    ],
  },
  {
    note: 'pick-image: cancelled, a picture read, another type refused',
    files: { 'img/a.PNG': 'png data', 'img/b.bmp': 'bmp' },
    hosts: { shared: { dialogs: { open: [null, ['$DIR/img/a.PNG'], ['$DIR/img/b.bmp']] } } },
    calls: [
      { channel: 'docs:pick-image', args: [] },
      { channel: 'docs:pick-image', args: [] },
      { channel: 'docs:pick-image', args: [] },
    ],
  },
  {
    note: 'merge-data-source: cancelled, read, refused by the reader',
    hosts: {
      shared: { dialogs: { open: [null, ['$DIR/list.csv'], ['$DIR/bad.xlsx']] } },
      d2: {
        docs: {
          read_merge_data_source: [{ name: 'list.csv', fields: ['Name'] }, { error: 'bad sheet' }],
        },
      },
    },
    calls: [
      { channel: 'docs:merge-data-source', args: [] },
      { channel: 'docs:merge-data-source', args: [] },
      { channel: 'docs:merge-data-source', args: [] },
    ],
  },
  {
    note: 'merge-output: nothing to write; one file cancelled, then written',
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: [null, '$DIR/out/Letters.docx'] } } },
    calls: [
      { channel: 'docs:merge-output', args: [{ mode: 'single', files: [] }] },
      { channel: 'docs:merge-output', args: [null] },
      {
        channel: 'docs:merge-output',
        args: [{ mode: 'single', files: [{ name: 'a/b:Letters', data: ab(0) }] }],
        buffers: [hex('merged')],
      },
      {
        channel: 'docs:merge-output',
        args: [{ mode: 'labels', files: [{ name: 'Labels', data: ab(0) }] }],
        buffers: [hex('labels')],
      },
    ],
  },
  {
    note: 'merge-output: one file per record into a folder, names kept unique',
    files: { merged: { dir: true }, 'merged/Kim.docx': 'old' },
    hosts: { shared: { dialogs: { open: [['$DIR/merged']] } } },
    calls: [
      {
        channel: 'docs:merge-output',
        args: [
          {
            mode: 'folder',
            files: [
              { name: 'Kim', data: ab(0) },
              { name: 'Kim', data: ab(1) },
              { name: '', data: ab(2) },
            ],
          },
        ],
        buffers: [hex('one'), hex('two'), hex('three')],
      },
    ],
  },
  {
    note: 'copy a picture: refused URLs, a data URL with its layout, a lazy picture inlined, an empty image',
    hosts: {
      d2: {
        docs: {
          image_size: [40, 30],
          read_lazy_media: [{ body: 'lazy', mime: 'image/jpeg' }, null],
        },
      },
    },
    calls: [
      { channel: 'docs:copy-image-to-clipboard', args: ['data:text/html;base64,AA=='] },
      { channel: 'docs:copy-image-to-clipboard', args: [5] },
      {
        channel: 'docs:copy-image-to-clipboard',
        args: [`data:image/png;base64,${b64('png')}`, '{"imageWidthPx":12.6,"align":"<c>"}'],
      },
      {
        channel: 'docs:copy-image-to-clipboard',
        args: ['seuoffice-docx-media://h/word/media/i.jpg', 7],
      },
      {
        channel: 'docs:copy-image-to-clipboard',
        args: ['seuoffice-docx-media://h/word/media/gone.jpg'],
      },
    ],
  },
  {
    note: 'copy a picture the image decoder finds empty',
    hosts: { d2: { docs: { image_size: null } } },
    calls: [
      { channel: 'docs:copy-image-to-clipboard', args: [`data:image/png;base64,${b64('x')}`] },
    ],
  },
  {
    note: 'create-document: empty refused, docx to a new tab, markdown into the default folder, a type refused',
    calls: [
      { channel: 'docs:create-document', args: [{ type: 'md', content: '  ' }] },
      {
        channel: 'docs:create-document',
        args: [{ type: 'docx', title: 'T', content: '<p>x</p>' }],
      },
      { channel: 'docs:create-document', args: [{ type: 'md', title: 'a/b', content: '# hi' }] },
      { channel: 'docs:create-document', args: [{ type: 'md', title: 'a/b', content: '# again' }] },
      { channel: 'docs:create-document', args: [{ type: 'xls', content: 'x' }] },
      { channel: 'docs:create-document', args: [null] },
    ],
  },
  {
    note: 'create-document: HTML filed into the asking view\u2019s project',
    files: { project: { dir: true } },
    hosts: {
      d2: { docs: { write_new_document: '$DIR/project/Page.html', open_generated_path: true } },
    },
    calls: [
      {
        channel: 'docs:create-document',
        args: [{ type: 'html', title: 'Page', content: '<b>x</b>' }],
      },
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
