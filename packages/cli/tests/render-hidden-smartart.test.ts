import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { redactExtXml } from '../../pptx-engine/src/redaction-xml'
import { run, tempDir } from './helpers'

/**
 * A SmartArt keeps its words, and the marks on them, in its data part: a slide
 * whose diagram data holds a hidden run is not rendered, as a slide holding a
 * hidden run of its own is not, and `slides read` gives the diagram's text as
 * a placeholder.
 */

const SECRET = '13800138000'
const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="50" name="Diagram 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="4572000" cy="2743200"/></p:xfrm>' +
  `<a:graphic><a:graphicData uri="${DGM}">` +
  `<dgm:relIds xmlns:dgm="${DGM}" r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>` +
  '</a:graphicData></a:graphic></p:graphicFrame>'

const point = (id: string, runs: string) =>
  `<dgm:pt modelId="${id}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p>${runs}</a:p></dgm:t></dgm:pt>`

const DATA =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>` +
  '<dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>' +
  point(
    '1',
    `<a:r><a:rPr lang="en-US"><a:extLst>${redactExtXml('client phone')}</a:extLst></a:rPr><a:t>${SECRET}</a:t></a:r>`,
  ) +
  point('2', '<a:r><a:rPr lang="en-US"/><a:t>Plain</a:t></a:r>') +
  '</dgm:ptLst><dgm:cxnLst>' +
  '<dgm:cxn modelId="c1" srcId="0" destId="1" srcOrd="0" destOrd="0"/>' +
  '<dgm:cxn modelId="c2" srcId="0" destId="2" srcOrd="1" destOrd="0"/>' +
  '</dgm:cxnLst></dgm:dataModel>'

/** a plain deck with a SmartArt on its first slide whose data, and nothing else, holds the mark */
async function smartArtDeck(target = '../diagrams/data1.xml'): Promise<string> {
  const dir = tempDir()
  const spec = join(dir, 'deck.json')
  writeFileSync(
    spec,
    JSON.stringify({
      pages: [
        {
          elements: [
            {
              type: 'text',
              x: 80,
              y: 40,
              w: 600,
              h: 60,
              paragraphs: [{ runs: [{ text: 'Title' }] }],
            },
          ],
        },
      ],
    }),
  )
  const file = join(dir, 'smartart.pptx')
  expect(
    (await run(['create', '--type', 'pptx', '--spec', spec, '--out', file, '--json'])).code,
  ).toBe(0)
  const zip = await JSZip.loadAsync(readFileSync(file))
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${FRAME}</p:spTree>`))
  const relsPath = 'ppt/slides/_rels/slide1.xml.rels'
  const rels = await zip.file(relsPath)!.async('string')
  zip.file(
    relsPath,
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdDm" Type="${REL}/diagramData" Target="${target}"/></Relationships>`,
    ),
  )
  zip.file('ppt/diagrams/data1.xml', DATA)
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '</Types>',
      '<Override PartName="/ppt/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/></Types>',
    ),
  )
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}

describe('a slide whose SmartArt data holds a hidden run', () => {
  it.each([
    ['a relative target', '../diagrams/data1.xml'],
    ['a target from the package root', '/ppt/diagrams/data1.xml'],
    ['a percent-encoded target', '../diagrams/data%31.xml'],
  ])('is not rendered (%s)', async (_name, target) => {
    const file = await smartArtDeck(target)
    for (const extra of [[], ['--page', '1']]) {
      const r = await run(
        ['render', file, '--out', join(tempDir(), 'png'), '--json', ...extra],
        NO_APP,
      )
      expect(r.code, r.stdout).not.toBe(0)
      expect(JSON.parse(r.stdout).message).toContain('hidden from AI')
    }
  })

  it('reads its diagram text as a placeholder', async () => {
    const file = await smartArtDeck()
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.code, read.stdout).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
  })
})
