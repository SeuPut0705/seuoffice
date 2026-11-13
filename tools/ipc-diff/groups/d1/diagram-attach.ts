/**
 * Group `d1/diagram-attach`: the AI panel's attachments (`apps/diagram/src/main/ai-attachments.ts`).
 * What `@seuoffice/file-parse` answers is the case's (`diagramPictureExtOf`,
 * `parseFileToText`); what is open with unsaved changes is `unsaved`.
 * A picture pasted without a file is written under a name that has the clock
 * in it, so only the answers that write nothing are compared.
 */
import { loadDiagram } from '../../d1/diagram-host.ts'
import { UNDEFINED, bin, call, diagramCase } from '../../d1/diagram-cases.ts'
import type { Case, FileSpec, Group } from '../../types.ts'

const FILES: Record<string, FileSpec> = {
  'note.txt': 'héllo wörld, a longer text to read in pages',
  'data.csv': 'a,b\n1,2\n',
  'blob.bin': 'x',
  'pic.png': { hex: '89504e470d0a1a0a' },
  'pic.JPG': { hex: 'ffd8ffe0' },
  'big.png': { hex: '89504e47'.repeat(1) },
  'sub.txt': { dir: true },
  'plan.docx': 'PK',
  'dia.drawio.png': { hex: '89504e47' },
  'empty.txt': '',
}
const add = (...paths: unknown[]) => call('diagram:files-add', [paths])
const read = (...args: unknown[]) => call('diagram:files-read', args)
const image = (path: unknown) => call('diagram:files-read-image', [path])
const D = '$DIR/'

const cases: Case[] = [
  diagramCase('files are accepted by extension, with a reason for each that is not', {}, [
    add(`${D}note.txt`, `${D}blob.bin`, `${D}nope.txt`, `${D}sub.txt`, `${D}plan.docx`, `${D}pic.png`),
    add(`${D}pic.JPG`, 3, '', null),
    call('diagram:files-add', ['not a list']),
    call('diagram:files-add'),
  ], { files: FILES }),
  diagramCase('a draw.io picture is a diagram, not a picture', { d1: { pictureExt: { 'dia.drawio.png': 'drawio.png' } } }, [
    add(`${D}dia.drawio.png`, `${D}pic.png`),
  ], { files: FILES }),
  diagramCase('the open dialog offers the supported files; cancelled, or with files', { opens: [null, [`${D}note.txt`, `${D}blob.bin`], []] }, [
    call('diagram:files-pick'),
    call('diagram:files-pick'),
    call('diagram:files-pick'),
  ], { files: FILES }),
  diagramCase('a pasted picture is checked before anything is written', {}, [
    call('diagram:files-add-pasted-image', [bin([1, 2, 3]), 'txt']),
    call('diagram:files-add-pasted-image', [bin([]), 'png']),
    call('diagram:files-add-pasted-image', ['data', 'png']),
    call('diagram:files-add-pasted-image', [bin([1]), UNDEFINED]),
  ]),
  diagramCase('a pasted picture over the limit is refused before it is written', {}, [
    call('diagram:files-add-pasted-image', [bin(new Uint8Array(5 * 1024 * 1024 + 1)), 'png']),
  ]),

  diagramCase('a text is read from an offset, a page at a time', {}, [
    read(`${D}note.txt`, 0, 5),
    read(`${D}note.txt`, 1, 4),
    read(`${D}note.txt`, 38, 100),
    read(`${D}note.txt`, 100, 10),
    read(`${D}note.txt`, '3', '4'),
    read(`${D}note.txt`, -5, 0),
    read(`${D}note.txt`, UNDEFINED, 99999),
    read(`${D}note.txt`),
  ], { files: FILES }),
  diagramCase('a file read twice is parsed once', {}, [
    read(`${D}data.csv`, 0, 100),
    read(`${D}data.csv`, 2, 100),
  ], { files: FILES }),
  diagramCase('what cannot be read says why', { d1: { unsaved: { 'plan.docx': 'open with unsaved changes' } } }, [
    read(3, 0, 5),
    read('', 0, 5),
    read(`${D}blob.bin`, 0, 5),
    read(`${D}pic.png`, 0, 5),
    read(`${D}plan.docx`, 0, 5),
    read(`${D}nope.txt`, 0, 5),
  ], { files: FILES }),
  diagramCase(
    'the reader decides what a file says, and what it withholds',
    {
      d1: {
        parseFileToText: {
          'plan.docx': { ok: true, kind: 'text', text: 'Slide one' },
          'data.csv': { ok: false, damaged: true, error: 'broken zip' },
          'note.txt': { ok: false, damaged: false, error: 'password protected' },
          'empty.txt': { ok: true, kind: 'other' },
        },
      },
    },
    [
      read(`${D}plan.docx`, 0, 100),
      read(`${D}data.csv`, 0, 100),
      read(`${D}note.txt`, 0, 100),
      read(`${D}empty.txt`, 0, 100),
    ],
    { files: FILES },
  ),

  diagramCase('a picture is read as base64', {}, [
    image(`${D}pic.png`),
    image(`${D}pic.JPG`),
    image(`${D}note.txt`),
    image(`${D}nope.png`),
    image(3),
    image(''),
  ], { files: FILES }),
]

export const group: Group = {
  batch: 'D1',
  load: loadDiagram,
  cases,
}
