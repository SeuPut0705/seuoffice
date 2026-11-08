import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readBasicWorkbook } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { csvInfo } from '../src/formats/csv'
import { run, tempDir } from './helpers'

const prose = 'note\nalpha;beta\ngamma\ndelta;epsilon;zeta\n'
const tabProse = prose.replaceAll(';', '\t')
const cases = [
  { name: 'semicolon prose', text: prose, rows: 4, columns: 1, delimiter: ',', a2: 'alpha;beta' },
  { name: 'tab prose', text: tabProse, rows: 4, columns: 1, delimiter: ',', a2: 'alpha\tbeta' },
  {
    name: 'mixed prose',
    text: 'note\nalpha;beta\ngamma\tdelta\nplain\n',
    rows: 4,
    columns: 1,
    delimiter: ',',
    a2: 'alpha;beta',
  },
  {
    name: 'quoted prose',
    text: 'note\n"alpha;beta"\ngamma\n"delta;epsilon;zeta"\n',
    rows: 4,
    columns: 1,
    delimiter: ',',
    a2: 'alpha;beta',
  },
  {
    name: 'comma table',
    text: 'name,amount\nApple,12\nPear,15\n',
    rows: 3,
    columns: 2,
    delimiter: ',',
    a2: 'Apple',
  },
  {
    name: 'semicolon table',
    text: 'name;amount\nApple;12\nPear;15\n',
    rows: 3,
    columns: 2,
    delimiter: ';',
    a2: 'Apple',
  },
  {
    name: 'tab table',
    text: 'name\tamount\nApple\t12\nPear\t15\n',
    rows: 3,
    columns: 2,
    delimiter: '\t',
    a2: 'Apple',
  },
  {
    name: 'title above a semicolon table',
    text: 'Report\nname;amount\nApple;12\nPear;15\n',
    rows: 4,
    columns: 2,
    delimiter: ';',
    a2: 'name',
  },
  {
    name: 'explicit semicolon',
    text: 'sep=;\n' + prose,
    rows: 4,
    columns: 3,
    delimiter: ';',
    a2: 'alpha',
  },
  {
    name: 'explicit tab',
    text: 'sep=\t\n' + tabProse,
    rows: 4,
    columns: 3,
    delimiter: '\t',
    a2: 'alpha',
  },
  {
    name: 'explicit comma',
    text: 'sep=,\n' + prose,
    rows: 4,
    columns: 1,
    delimiter: ',',
    a2: 'alpha;beta',
  },
  {
    name: 'quoted multiline fields',
    text: 'name,note\nA,"alpha;beta\ngamma\tdelta"\nB,"text, ""quoted"""\n',
    rows: 3,
    columns: 2,
    delimiter: ',',
    a2: 'A',
  },
  {
    name: 'UTF-8 BOM and CRLF prose',
    text: '\ufeff' + prose.replaceAll('\n', '\r\n'),
    rows: 4,
    columns: 1,
    delimiter: ',',
    a2: 'alpha;beta',
  },
] as const

async function sheetCells(path: string) {
  return (await readBasicWorkbook(readFileSync(path))).snapshot.sheets[0]!.cells
}

describe('CSV delimiter consistency across CLI routes', () => {
  for (const fixture of cases) {
    it(`keeps info, create and convert consistent for ${fixture.name}`, async () => {
      const dir = tempDir()
      const input = join(dir, 'input.csv')
      const created = join(dir, 'created.xlsx')
      const converted = join(dir, 'converted.xlsx')
      const original = Buffer.from(fixture.text, 'utf-8')
      writeFileSync(input, original)

      const create = await run([
        'create',
        '--type',
        'xlsx',
        '--from',
        input,
        '--out',
        created,
        '--json',
      ])
      const convert = await run(['convert', input, '--to', 'xlsx', '--out', converted, '--json'])
      const info = await run(['info', input, '--json'])
      expect(create.code).toBe(0)
      expect(convert.code).toBe(0)
      expect(info.code).toBe(0)
      const expectedInfo = {
        rows: fixture.rows,
        columns: fixture.columns,
        delimiter: fixture.delimiter,
      }
      expect(csvInfo(original)).toEqual(expectedInfo)
      expect(info.json().detail).toMatchObject(expectedInfo)

      const a = await sheetCells(created)
      const b = await sheetCells(converted)
      expect(a).toEqual(b)
      expect(a.A2?.value).toBe(fixture.a2)
      if (fixture.name === 'quoted multiline fields') {
        expect(a.B2?.value).toBe('alpha;beta\ngamma\tdelta')
        expect(a.B3?.value).toBe('text, "quoted"')
      }
      if (fixture.name.endsWith(' table') && fixture.a2 === 'Apple') {
        expect(a.B2?.value).toBe(12)
      }
      expect(readFileSync(input)).toEqual(original)
    })
  }

  for (const [name, text] of [
    ['semicolon', prose],
    ['tab', tabProse],
  ]) {
    it(`keeps --header filters on one column for ${name} prose`, async () => {
      const dir = tempDir()
      const input = join(dir, 'notes.csv')
      const output = join(dir, 'notes.xlsx')
      writeFileSync(input, text!)
      const result = await run([
        'create',
        '--type',
        'xlsx',
        '--from',
        input,
        '--out',
        output,
        '--header',
        '--json',
      ])
      expect(result.code).toBe(0)
      const zip = await JSZip.loadAsync(readFileSync(output))
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
      expect(xml).toMatch(/<autoFilter\b[^>]*\bref="A1:A4"/)
      expect(xml).toContain('ySplit="1"')
      expect((await sheetCells(output)).A2?.value).toBe(
        name === 'semicolon' ? 'alpha;beta' : 'alpha\tbeta',
      )
    })
  }

  it('keeps empty CSV metadata empty', () => {
    expect(csvInfo(Buffer.from(''))).toEqual({ rows: 0, columns: 0, delimiter: ',' })
  })
})
