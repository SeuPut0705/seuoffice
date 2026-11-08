import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

describe('ieumoffice docs read: table text', () => {
  it('keeps cells and rows apart in the text of a table block', async () => {
    const dir = tempDir()
    const md = join(dir, 'quote.md')
    writeFileSync(
      md,
      '| 품목 | 수량 | 금액 |\n| --- | --- | --- |\n| 커피 | 1 | 200 |\n| 라떼 | 12 | 00 |\n',
    )
    const docx = join(dir, 'quote.docx')
    expect((await run(['create', '--type', 'docx', '--from', md, '--out', docx])).code).toBe(0)
    const r = await run(['docs', 'read', docx, '--json'])
    expect(r.code).toBe(0)
    const table = r.json().detail.items.find((b: { type: string }) => b.type === 'table')
    // before: "품목수량금액커피1200라떼1200" — both rows read as 1200
    expect(table.text).toBe('품목 | 수량 | 금액\n커피 | 1 | 200\n라떼 | 12 | 00')
  })

  it('keeps the lines of a paragraph apart', async () => {
    const dir = tempDir()
    const docx = join(dir, 'lines.docx')
    const md = join(dir, 'lines.md')
    writeFileSync(md, '첫 줄\n')
    expect((await run(['create', '--type', 'docx', '--from', md, '--out', docx])).code).toBe(0)
    const ops = join(dir, 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([
        {
          op: 'replace_blocks',
          startBlockIndex: 0,
          endBlockIndex: 0,
          html: '<p>테스트 문서<br>10월 매출 100</p>',
        },
      ]),
    )
    expect((await run(['docs', 'apply', docx, '--ops', ops, '--json'])).code).toBe(0)
    const r = await run(['docs', 'read', docx, '--json'])
    expect(r.json().detail.items[0].text).toBe('테스트 문서\n10월 매출 100')
  })
})
