/**
 * Group `d1/sheets-files`: the AI panel's attachments and screen capture
 * (`apps/sheets/src/main/sheets-main.ts`: `sheets:files-pick`, `files-add`,
 * `files-add-pasted-image`, `files-read`, `files-read-image`,
 * `capture-screen-sources`, `capture-screen-source`), loaded as the shell
 * loads it (`d1/sheets-host.ts`).
 *
 * What `@seuoffice/file-parse` answers is the case's (`d1.parse`, by file
 * name; a file without an entry is read as text); what is open with unsaved
 * changes is `d1.unsaved`. A pasted picture is written under a name with the
 * clock in it, which is fixed. The permission checks of the screen capturer
 * answer from `d1.screenStatus`, in turn, then `granted`; window 1 is the
 * asking tab's own and is left out of the list.
 */
import { loadSheets } from '../../d1/sheets-host.ts'
import { UNDEFINED, bin, call } from '../../d1/diagram-cases.ts'
import { FILES, sheetsCase } from '../../d1/sheets-cases.ts'
import type { Case, FileSpec, Group } from '../../types.ts'

const D = '$DIR/'
const files: Record<string, FileSpec> = {
  ...FILES,
  'pic.JPG': { hex: 'ffd8ffe0' },
  'dia.drawio.png': { hex: '89504e47' },
  'sub.txt': { dir: true },
  'empty.txt': '',
  'huge.png': { text: 'x'.repeat(5 * 1024 * 1024 + 1), mtimeMs: 1_600_000_000_000 },
}
const add = (...paths: unknown[]) => call('sheets:files-add', [paths])
const read = (...args: unknown[]) => call('sheets:files-read', args)
const image = (path: unknown) => call('sheets:files-read-image', [path])

const cases: Case[] = [
  // ---- pick and add ----
  sheetsCase(
    'the open dialog offers the supported files: cancelled, with files, with none',
    { opens: [null, [`${D}notes.txt`, `${D}odd.bin`, `${D}missing.txt`], [], [`${D}pic.png`]] },
    [
      call('sheets:files-pick'),
      call('sheets:files-pick'),
      call('sheets:files-pick'),
      call('sheets:files-pick'),
    ],
    { files },
  ),
  sheetsCase(
    'files are accepted by extension, with a reason for each that is not',
    {},
    [
      add(
        `${D}notes.txt`,
        `${D}odd.bin`,
        `${D}missing.txt`,
        `${D}sub.txt`,
        `${D}doc.docx`,
        `${D}pic.png`,
      ),
      add(`${D}pic.JPG`, `${D}a.xlsx`),
      add(),
      call('sheets:files-add', ['not a list']),
      call('sheets:files-add', [[3]]),
      call('sheets:files-add', [['']]),
      call('sheets:files-add', [['x'.repeat(1025)]]),
      call('sheets:files-add'),
    ],
    { files },
  ),
  sheetsCase(
    'a draw.io picture is a diagram by its name, not a picture',
    { d1: { pictureExt: { 'dia.drawio.png': 'drawio.png' } } },
    [add(`${D}dia.drawio.png`, `${D}pic.png`)],
    { files },
  ),
  sheetsCase('a picture past its limit is turned back', {}, [add(`${D}huge.png`, `${D}pic.png`)], {
    files,
  }),

  // ---- pasted pictures ----
  sheetsCase(
    'a pasted picture is written under the temp folder',
    {},
    [
      call('sheets:files-add-pasted-image', [bin([0x89, 0x50, 0x4e, 0x47]), 'png']),
      call('sheets:files-add-pasted-image', [bin([0xff, 0xd8, 0xff, 0xe0]), 'JPG']),
      call('sheets:files-add-pasted-image', [bin([0xff, 0xd8, 0xff, 0xe0]), 'png']),
    ],
    { files },
  ),
  sheetsCase(
    'a pasted picture that is not one, or has no data',
    {},
    [
      call('sheets:files-add-pasted-image', [bin([0x89, 0x50, 0x4e, 0x47]), 'exe']),
      call('sheets:files-add-pasted-image', [bin([]), 'png']),
      call('sheets:files-add-pasted-image', ['text', 'png']),
      call('sheets:files-add-pasted-image', [UNDEFINED, UNDEFINED]),
      call('sheets:files-add-pasted-image', [bin([0x89, 0x50, 0x4e, 0x47]), 3]),
      call('sheets:files-add-pasted-image'),
    ],
    { files },
  ),

  // ---- read ----
  sheetsCase(
    'text is read in pages',
    {},
    [
      read(`${D}notes.txt`),
      read(`${D}long.txt`, 5, 10),
      read(`${D}long.txt`, 195, 100),
      read(`${D}long.txt`, 500, 10),
      read(`${D}long.txt`, -3, 4),
      read(`${D}long.txt`, '7', '3'),
      read(`${D}long.txt`, 1.9, 2.9),
      read(`${D}long.txt`, UNDEFINED, 0),
      read(`${D}long.txt`, 0, 99_999),
      read(`${D}notes.txt`, 'x', null),
    ],
    { files },
  ),
  sheetsCase(
    'what cannot be read as text',
    { d1: { pictureExt: { 'dia.drawio.png': 'drawio.png' } } },
    [
      read(`${D}odd.bin`),
      read(`${D}pic.png`),
      read(`${D}missing.txt`),
      read(`${D}sub.txt`),
      read(`${D}dia.drawio.png`),
      read(''),
      read(3),
      read(`${'x'.repeat(1025)}.txt`),
      read(),
    ],
    { files },
  ),
  sheetsCase(
    'the parser refuses a file, or finds it damaged',
    {
      d1: {
        parse: {
          'doc.docx': { ok: false, error: 'bad zip' },
          'long.txt': { ok: false, damaged: true, error: 'raw failure' },
          'notes.txt': { ok: true, kind: 'binary' },
          't.csv': { ok: true, kind: 'text', text: 'parsed\nrows' },
        },
      },
    },
    [
      read(`${D}doc.docx`),
      read(`${D}long.txt`),
      read(`${D}notes.txt`),
      read(`${D}t.csv`, 0, 6),
      read(`${D}t.csv`, 7, 100),
    ],
    { files },
  ),
  sheetsCase(
    'the text of a file is read once while it stays the same',
    {},
    [read(`${D}notes.txt`), read(`${D}notes.txt`, 1, 3), read(`${D}long.txt`)],
    { files },
  ),
  sheetsCase(
    'a file open with unsaved changes is not read',
    { d1: { unsaved: [`${D}notes.txt`] } },
    [read(`${D}notes.txt`), read(`${D}long.txt`)],
    { files },
  ),
  // ---- read an image ----
  sheetsCase(
    'a picture is read as base64 with its type',
    {},
    [
      image(`${D}pic.png`),
      image(`${D}pic.JPG`),
      image(`${D}missing.png`),
      image(`${D}huge.png`),
      image(`${D}notes.txt`),
      image(`${D}sub.txt`),
      image(''),
      image(3),
      image(UNDEFINED),
    ],
    { files },
  ),

  // ---- screen capture ----
  sheetsCase(
    'the screens and the other windows are listed, not the asking window',
    {},
    [call('sheets:capture-screen-sources')],
    { files },
  ),
  sheetsCase(
    'the screen permission is denied, or granted only after the listing',
    {
      d1: {
        screenStatus: [
          'denied',
          'not-determined',
          'denied',
          'not-determined',
          'granted',
          'restricted',
        ],
      },
    },
    [
      call('sheets:capture-screen-sources'),
      call('sheets:capture-screen-sources'),
      call('sheets:capture-screen-sources'),
      call('sheets:capture-screen-sources'),
    ],
    { files },
  ),
  sheetsCase(
    'one source is captured whole',
    {},
    [
      call('sheets:capture-screen-source', [{ id: 'screen:0' }]),
      call('sheets:capture-screen-source', [{ id: 'window:7' }]),
      call('sheets:capture-screen-source', [{ id: 'window:99' }]),
      call('sheets:capture-screen-source', [{ id: '' }]),
      call('sheets:capture-screen-source', [{ id: 'x'.repeat(257) }]),
      call('sheets:capture-screen-source', [{ id: 'screen:0', extra: 1 }]),
      call('sheets:capture-screen-source', [null]),
      call('sheets:capture-screen-source'),
    ],
    { files },
  ),
]

export const group: Group = {
  batch: 'D1',
  load: loadSheets,
  cases,
  single: {},
}
