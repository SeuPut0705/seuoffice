/**
 * Group `d1/diagram-export`: picture and PDF export (`apps/diagram/src/main/export-main.ts`).
 * The PDF is made by the shell's hidden window: the host log has the print
 * document it was asked to render (`diagram.renderPdf`).
 */
import { loadDiagram } from '../../d1/diagram-host.ts'
import { bin, call, diagramCase, opened } from '../../d1/diagram-cases.ts'
import type { Case, Group } from '../../types.ts'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]
const png = (number: unknown) => ({ number, bytes: bin(PNG) })
const images = (request: unknown) => call('diagram:export-images', [request])
const exportPng = (pages: unknown[], extra: Record<string, unknown> = {}) =>
  images({ format: 'png', pages, scope: 'all', suggestedName: 'plan', ...extra })
const page = (extra: Record<string, unknown> = {}) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  width: 10,
  height: 20,
  pageWidth: 827,
  pageHeight: 1169,
  ...extra,
})
const pdf = (request: unknown) => call('diagram:export-pdf', [request])

const cases: Case[] = [
  diagramCase('what is not an export request is refused before any dialog', {}, [
    call('diagram:export-images'),
    images({ format: 'gif', pages: [] }),
    exportPng([]),
    exportPng([png(0)]),
    exportPng([png(1.5)]),
    exportPng([{ number: 1, bytes: 'png' }]),
    exportPng([{ number: 1, bytes: bin('<svg/>') }]),
    exportPng([png(1), png(1)]),
    images({ format: 'svg', pages: [{ number: 1, bytes: bin(PNG) }] }),
  ]),
  diagramCase('the person cancels the dialog', {}, [exportPng([png(1)])]),
  diagramCase(
    'every page is a file of its own, a one-page diagram too',
    { saves: ['$DIR/out', '$DIR/solo.png'] },
    [exportPng([png(1), png(3)]), exportPng([png(2)])],
  ),
  diagramCase(
    'the page on screen is the chosen file; the ending is added',
    { saves: ['$DIR/shot', '$DIR/Shot2.PNG'] },
    [exportPng([png(2)], { scope: 'current' }), exportPng([png(4)], { scope: 'current' })],
  ),
  diagramCase(
    'SVG pictures begin with a tag or a declaration',
    { saves: ['$DIR/a.svg', '$DIR/b.svg'] },
    [
      images({
        format: 'svg',
        pages: [{ number: 1, bytes: bin('  \n<svg></svg>') }],
        scope: 'current',
      }),
      images({
        format: 'svg',
        pages: [{ number: 1, bytes: bin('<?xml version="1.0"?><svg/>') }],
        scope: 'current',
      }),
    ],
  ),
  diagramCase(
    'the dialog opens beside the diagram file, under the suggested name',
    { d1: opened('a.drawio'), saves: [null] },
    [
      exportPng([png(1)], { suggestedName: 'a/b' }),
      exportPng([png(1)], { suggestedName: '' }),
      exportPng([png(1)], { suggestedName: 5 }),
    ],
  ),
  diagramCase(
    'files that exist are replaced only when the person says so',
    { saves: ['$DIR/dup', '$DIR/dup', '$DIR/dup'], messages: [1, 0] },
    [exportPng([png(1), png(2)]), exportPng([png(1), png(2)]), exportPng([png(1), png(2)])],
    {
      files: {
        'dup-p1.png': 'old1',
        'dup-p2.png': 'old2',
      },
    },
  ),
  diagramCase(
    'the name the dialog already confirmed is not asked about again',
    { saves: ['$DIR/one.png'], messages: [1] },
    [exportPng([png(1)], { scope: 'current' })],
    { files: { 'one.png': 'old' } },
  ),
  diagramCase('a request for pages with no number of its own', { saves: ['$DIR/x'] }, [
    exportPng([{ bytes: bin(PNG) }]),
  ]),

  diagramCase('a PDF needs pages that can be printed', {}, [
    pdf(null),
    pdf({ pages: [] }),
    pdf({ pages: 'x' }),
    pdf({ pages: [page({ svg: '<div/>' })] }),
    pdf({ pages: [page({ width: 'wide' })] }),
    pdf({ pages: [page(), null] }),
  ]),
  diagramCase('the person cancels the PDF dialog', {}, [
    pdf({ pages: [page()], suggestedName: 'plan' }),
  ]),
  diagramCase(
    'the shell renders the pages and the file lands where the person chose',
    { saves: ['$DIR/plan', '$DIR/Other.PDF'] },
    [
      pdf({ pages: [page(), page({ svg: '<SVG></SVG>' })], suggestedName: 'plan' }),
      pdf({ pages: [page()], suggestedName: 7 }),
    ],
  ),
  diagramCase(
    'a PDF the shell made',
    { d1: { pdf: '255044462d312e34', ...opened('a.drawio') }, saves: ['$DIR/made'] },
    [pdf({ pages: [page()], suggestedName: 'made' })],
  ),
]

export const group: Group = {
  batch: 'D1',
  load: loadDiagram,
  cases,
}
