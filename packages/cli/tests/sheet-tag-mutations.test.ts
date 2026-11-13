import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxSidecarPath } from '../src/resources'
import { PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir, type CapturedRun } from './helpers'
import { expectNoGiveaway, richHiddenXlsx, withDrawing } from './rich-hidden-xlsx'

const sidecar = Boolean(xlsxSidecarPath())

/**
 * Valid spellings of the same sheet XML that a pattern written against the
 * writer's own output (double quotes, tight tags, one namespace prefix) reads
 * wrong. Each one leaves the workbook the same to a real XML parser.
 */
export const TAG_MUTATIONS = {
  'single quotes': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  '> and /> inside values': (xml: string) =>
    xml.replace(
      /<(c|row|f|v|is|t|sheet|definedName|comment)(?=[\s>/])/g,
      '<$1 x="a/>b>c r=&quot;B2&quot;"',
    ),
  comments: (xml: string) =>
    xml
      .replace(/<\/v>/g, '<!-- </v> --></v>')
      .replace(/(<c\b[^>]*[^/]>)/g, '$1<!-- </c></row> <c r="B2"><v>1</v></c> -->'),
  CDATA: (xml: string) =>
    xml
      .replace(/<v>([^<]*)<\/v>/g, '<v><![CDATA[$1]]></v>')
      .replace(/<f>([^<]*)<\/f>/g, '<f><![CDATA[$1]]></f>')
      .replace(/<t( [^>]*)?>([^<]*)<\/t>/g, '<t$1><![CDATA[</c></row>]]><![CDATA[$2]]></t>'),
  // the hidden text is itself CDATA dressed as two more cells holding the number: a
  // pattern that takes them for markup reports them as cells of their own
  'fake markup in CDATA': (xml: string) =>
    xml.replace(
      new RegExp(`<t>${SECRET}</t>`, 'g'),
      `<t><![CDATA[</t></is></c><c r="Q9"><v>${SECRET}</v></c><c r="Q10" t="inlineStr"><is><t>${SECRET}]]></t>`,
    ),
  'space before > in end tags': (xml: string) => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  // the main namespace under a prefix of its own, on every element of the part
  'namespace prefix': (xml: string) =>
    xml
      .replace(/ xmlns="([^"]*)"/, ' xmlns:x="$1"')
      .replace(/(<\/?)(?![A-Za-z][\w.-]*:)([A-Za-z][\w.-]*)(?=[\s>/])/g, '$1x:$2'),
} satisfies Record<string, (xml: string) => string>

type Mutation = keyof typeof TAG_MUTATIONS | 'all' | 'none'
const MUTATIONS: Mutation[] = ['none', ...(Object.keys(TAG_MUTATIONS) as Mutation[]), 'all']

function mutate(xml: string, mutation: Mutation): string {
  if (mutation === 'none') return xml
  if (mutation !== 'all') return TAG_MUTATIONS[mutation](xml)
  return (
    [
      'single quotes',
      'spaces around =',
      'CDATA',
      'comments',
      '> and /> inside values',
      'space before > in end tags',
    ] as const
  ).reduce((out, name) => TAG_MUTATIONS[name](out), xml)
}

/** richHiddenXlsx with every xl/*.xml part rewritten by `mutation`; the phone sits in B2 as a number or as text. */
async function mutatedBook(
  dir: string,
  mutation: Mutation,
  phone: 'number' | 'text',
): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const file = await withDrawing(await richHiddenXlsx(dir, `${phone}.xlsx`))
  const zip = await JSZip.loadAsync(readFileSync(file))
  const sheetPart = 'xl/worksheets/sheet1.xml'
  let sheet = await zip.file(sheetPart)!.async('string')
  if (phone === 'text') {
    const before = sheet
    sheet = sheet.replace(
      `<c r="B2"><v>${SECRET}</v></c>`,
      `<c r="B2" t="inlineStr"><is><t>${SECRET}</t></is></c>`,
    )
    expect(sheet).not.toBe(before)
  }
  zip.file(sheetPart, sheet)
  for (const path of Object.keys(zip.files)) {
    if (!/^xl\/.+\.xml$/.test(path) || /theme/.test(path)) continue
    zip.file(path, mutate(await zip.file(path)!.async('string'), mutation))
  }
  const out = join(dir, `${mutation.replace(/\W+/g, '-')}-${phone}.xlsx`)
  writeFileSync(out, await zip.generateAsync({ type: 'uint8array' }))
  return out
}

/** A reader that refuses the file is a safe answer; one that answers must not carry the secret. */
function expectSafe(result: CapturedRun, what: string): void {
  if (process.env.MUTATION_TRACE && result.code)
    console.log(`${what}: exit ${result.code} ${(result.stdout + result.stderr).slice(0, 300)}`)
  expectNoGiveaway(result.stdout + result.stderr, what)
}

describe.skipIf(!sidecar)('xlsx readers over the same workbook spelled differently', () => {
  for (const mutation of MUTATIONS) {
    for (const phone of ['number', 'text'] as const) {
      it(`${mutation}, phone as ${phone}`, async () => {
        const dir = tempDir()
        const file = await mutatedBook(dir, mutation, phone)

        for (const flags of [
          [],
          ['--formats'],
          ['--where', 'text'],
          ['--stats'],
          ['--range', 'B2:D3'],
        ]) {
          const read = await run(['sheet', 'read', file, ...flags, '--json'])
          expectSafe(read, `sheet read ${flags.join(' ')}`)
          if (read.code === 0 && flags.length === 0) {
            expect(read.json().detail.rows[1][1]).toBe(PLACEHOLDER)
          }
        }

        expectSafe(await run(['sheet', 'check', file, '--json']), 'sheet check')
        expectSafe(await run(['sheet', 'links', file, '--json']), 'sheet links')
        expectSafe(await run(['info', file, '--json']), 'info')

        const csvPath = join(dir, 'out.csv')
        const csv = await run(['convert', file, '--to', 'csv', '--out', csvPath, '--json'])
        expectSafe(csv, 'convert csv output')
        if (csv.code === 0) {
          const text = readFileSync(csvPath, 'utf8')
          expectNoGiveaway(text, 'the csv')
          expect(text).toContain(PLACEHOLDER)
        }

        const odsPath = join(dir, 'out.ods')
        const ods = await run(['convert', file, '--to', 'ods', '--out', odsPath, '--json'])
        expectSafe(ods, 'convert ods output')
        expect(ods.code, 'an ods cannot withhold cells').not.toBe(0)
      })
    }
  }

  it('a save through sheet apply keeps the cell hidden', async () => {
    const dir = tempDir()
    for (const mutation of ['none', 'all'] as const) {
      const file = await mutatedBook(join(dir, mutation), mutation, 'number')
      const ops = join(dir, 'edit.json')
      writeFileSync(ops, JSON.stringify([{ op: 'set_cell', address: 'A3', value: 'Park' }]))
      const applied = await run(['sheet', 'apply', file, '--ops', ops, '--json'])
      expectSafe(applied, `sheet apply (${mutation})`)
      if (applied.code !== 0) continue
      const read = await run(['sheet', 'read', file, '--json'])
      expectSafe(read, `sheet read after apply (${mutation})`)
      expect(read.code).toBe(0)
      expect(read.json().detail.rows[1][1]).toBe(PLACEHOLDER)
      expect(read.json().detail.rows[2][0]).toBe('Park')
    }
  })
})
