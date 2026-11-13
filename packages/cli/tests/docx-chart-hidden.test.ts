import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { docxToText } from '../../file-parse/src/docx'
import { RedactionMarkError } from '../../file-parse/src/redaction-error'
import {
  buildDocx,
  CHART_PARAGRAPH_XML,
  CHART_PART_XML,
} from '../../docx-engine/tests/helpers/build-docx'
import { LABEL, PLACEHOLDER, SECRET } from '../../docx-engine/tests/helpers/hidden-stories'
import { redactExtXml } from '../../pptx-engine/src/redaction-xml'
import { run, tempDir } from './helpers'

/**
 * A chart in a Word document (word/charts/chartN.xml) whose title run carries our mark: the
 * title is drawn by the renderer and read by the document model, so the chart is withheld as a
 * whole, like a hidden picture. A chart beside it that holds no mark reads as it did.
 */

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart'
const CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const PLAIN_TITLE = 'Plain chart title'

const markedRun = (words: string) =>
  `<a:r><a:rPr>${redactExtXml(LABEL)}</a:rPr><a:t>${words}</a:t></a:r>`
const MARKED_PART = CHART_PART_XML.replace('<a:r><a:t>销售</a:t></a:r>', markedRun(SECRET))
const PLAIN_PART = CHART_PART_XML.replace(
  '<a:r><a:t>销售</a:t></a:r>',
  `<a:r><a:t>${PLAIN_TITLE}</a:t></a:r>`,
)

const SPELLINGS: Array<[string, (xml: string) => string]> = [
  ['as the engine writes it', (xml) => xml],
  ['single quotes', (xml) => xml.replace(/="([^"]*)"/g, "='$1'")],
  [
    'the mark under another prefix',
    (xml) => xml.replace(/go:/g, 'gx:').replace('xmlns:go', 'xmlns:gx'),
  ],
  [
    'no prefix',
    (xml) =>
      xml
        .replace(/<go:redact /g, '<redact ')
        .replace(/ xmlns:go="[^"]*"/g, '')
        .replace(
          /<redact /g,
          `<redact xmlns="${'https://github.com/SeuPut0705/seuoffice/redaction/2026'}" `,
        ),
  ],
  ['a mark in a comment', (xml) => xml.replace(/<a:t>/g, '<!-- <go:redact label="x"/> --><a:t>')],
]

async function chartDocx(part: string, name = 'chart.docx'): Promise<string> {
  const second = CHART_PARAGRAPH_XML.replace('rId30', 'rId31').replace('图表 1', '图表 2')
  const file = join(tempDir(), name)
  writeFileSync(
    file,
    await buildDocx({
      bodyXml: `${CHART_PARAGRAPH_XML}<w:p><w:r><w:t>Edit me please</w:t></w:r></w:p>${second}`,
      extraRels:
        `<Relationship Id="rId30" Type="${REL}" Target="charts/chart1.xml"/>` +
        `<Relationship Id="rId31" Type="${REL}" Target="charts/chart2.xml"/>`,
      extraParts: [
        { path: 'word/charts/chart1.xml', xml: part, contentType: CT },
        { path: 'word/charts/chart2.xml', xml: PLAIN_PART, contentType: CT },
      ],
    }),
  )
  return file
}

const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }
const refused = (r: { code: number; stdout: string }) =>
  r.code !== 0 && /hidden from AI/.test(r.stdout)

describe.each(SPELLINGS)('a Word chart with a hidden title run: %s', (_name, spell) => {
  const part = spell(MARKED_PART)

  it('docs read hands over no word of it', async () => {
    const file = await chartDocx(part)
    const read = await run(['docs', 'read', file, '--full', '--html', '--json'])
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stderr).not.toContain(SECRET)
    if (read.code !== 0) return
    const items = read.json().detail.items as Array<{ kind?: string; text: string }>
    expect(items.find((i) => i.kind === 'chart' && i.text.includes(PLACEHOLDER))).toBeTruthy()
  })

  it('docs check, info and the attachment reader hand over no word of it', async () => {
    const file = await chartDocx(part)
    for (const argv of [
      ['docs', 'check', file, '--json'],
      ['info', file, '--json'],
    ]) {
      const r = await run(argv)
      expect(r.stdout, argv.join(' ')).not.toContain(SECRET)
    }
    const text = await docxToText(new Uint8Array(readFileSync(file))).catch((err: unknown) => {
      if (err instanceof RedactionMarkError) return ''
      throw err
    })
    expect(text).not.toContain(SECRET)
  })

  it.each(['md', 'html'])('convert to %s hands over no word of it', async (to) => {
    const file = await chartDocx(part)
    const out = join(tempDir(), `out.${to}`)
    const r = await run(['convert', file, '--to', to, '--out', out, '--json'], NO_APP)
    expect(r.stdout + r.stderr).not.toContain(SECRET)
    if (r.code === 0) expect(readFileSync(out, 'utf-8')).not.toContain(SECRET)
  })

  it.each(['pdf', 'odt', 'hwpx'])('convert to %s is refused', async (to) => {
    const out = join(tempDir(), `out.${to}`)
    const r = await run(
      ['convert', await chartDocx(part), '--to', to, '--out', out, '--json'],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
    expect(existsSync(out)).toBe(false)
  })

  it('render is refused', async () => {
    const r = await run(
      ['render', await chartDocx(part), '--out', join(tempDir(), 'png'), '--json'],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
  })
})

describe('a Word document whose charts hold no mark', () => {
  it('reads and converts as it did, the title of the chart included', async () => {
    const file = await chartDocx(PLAIN_PART)
    const out = join(tempDir(), 'out.md')
    const r = await run(['convert', file, '--to', 'md', '--out', out, '--json'], NO_APP)
    expect(r.code, r.stdout).toBe(0)
    const read = await run(['docs', 'read', file, '--full', '--html', '--json'])
    expect(read.code).toBe(0)
  })

  it('the plain chart beside a hidden one is not withheld', async () => {
    const file = await chartDocx(MARKED_PART)
    const read = await run(['docs', 'read', file, '--full', '--json'])
    const items = read.json().detail.items as Array<{ kind?: string; text: string }>
    const charts = items.filter((i) => i.kind === 'chart')
    expect(charts).toHaveLength(2)
    expect(charts.filter((c) => c.text.includes(PLACEHOLDER))).toHaveLength(1)
  })
})
