import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  hiddenStoriesDocx,
  MARK_SPELLINGS,
  NAMESPACES,
  PLACEHOLDER,
  SECRET,
} from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

async function part(file: string, path: string): Promise<string> {
  return (await JSZip.loadAsync(readFileSync(file))).file(path)!.async('string')
}

function opsFile(dir: string, ops: unknown[]): string {
  const path = join(dir, `ops-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(ops))
  return path
}

describe('docs read: header, footer, comment and note text hidden from AI', () => {
  it.each(NAMESPACES)('reads as its placeholder when the label is under %s', async (_n, ns) => {
    const file = await hiddenStoriesDocx(tempDir(), ns)
    const read = await run([
      'docs',
      'read',
      file,
      '--header-footer',
      '--comments',
      '--notes',
      '--json',
    ])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    const detail = read.json().detail
    expect(detail.headerFooter.header).toBe(`Head ${PLACEHOLDER}`)
    expect(detail.headerFooter.footer).toBe(`Foot ${PLACEHOLDER}`)
    expect(detail.headerFooter.sections[0].header).toBe(`Head ${PLACEHOLDER}`)
    expect(detail.comments[0].text).toBe(`Note: ${PLACEHOLDER}`)
    expect(detail.notes[0].text).toBe(`See ${PLACEHOLDER}`)
  })
})

describe('docs read: the mark however its namespace is written', () => {
  it.each(MARK_SPELLINGS)('withholds a mark spelled %s', async (spelling) => {
    const file = await hiddenStoriesDocx(tempDir(), NAMESPACES[1]![1], 'spelled.docx', spelling)
    const read = await run([
      'docs',
      'read',
      file,
      '--full',
      '--header-footer',
      '--comments',
      '--notes',
      '--json',
    ])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    const detail = read.json().detail
    expect(detail.items[0].text).toBe(`Body text and ${PLACEHOLDER}`)
    expect(detail.headerFooter.header).toBe(`Head ${PLACEHOLDER}`)
    expect(detail.headerFooter.footer).toBe(`Foot ${PLACEHOLDER}`)
    expect(detail.comments[0].text).toBe(`Note: ${PLACEHOLDER}`)
    expect(detail.notes[0].text).toBe(`See ${PLACEHOLDER}`)
  })
})

describe('docs apply: a header or note holding text hidden from AI', () => {
  const ns = NAMESPACES[1]![1]

  it('set_header_footer keeps the hidden words where the model kept their placeholder', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, ns)
    const r = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [{ op: 'set_header_footer', kind: 'header', text: `Report ${PLACEHOLDER}` }]),
      '--json',
    ])
    expect(r.code).toBe(0)
    const header = await part(file, 'word/header1.xml')
    expect(header).toContain('Report ')
    expect(header).toContain(`${SECRET}H`)
    expect(header).toContain('go:redact')
    expect(header).not.toContain(PLACEHOLDER)
    const read = await run(['docs', 'read', file, '--header-footer', '--json'])
    expect(read.json().detail.headerFooter.header).toBe(`Report ${PLACEHOLDER}`)
  })

  it('set_header_footer that drops the placeholder is refused and writes nothing', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, ns)
    const before = readFileSync(file)
    const r = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [{ op: 'set_header_footer', kind: 'header', text: 'Report' }]),
      '--json',
    ])
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('placeholder')
    expect(readFileSync(file)).toEqual(before)
  })

  it('edit_note on a note holding hidden text is refused alike, whatever it looks for', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, ns)
    const before = readFileSync(file)
    const messages: string[] = []
    for (const find of ['See', SECRET.slice(0, 4), 'absent']) {
      const r = await run([
        'docs',
        'apply',
        file,
        '--ops',
        opsFile(dir, [{ op: 'edit_note', kind: 'footnote', id: '1', find, replace: 'x' }]),
        '--json',
      ])
      expect(r.code).not.toBe(0)
      expect(r.stdout).not.toContain(SECRET)
      messages.push(r.json().message)
    }
    // the same answer whether or not the hidden words contain what it looked for
    expect(new Set(messages).size).toBe(1)
    expect(readFileSync(file)).toEqual(before)
  })
})

describe('docs read: a content control holding text hidden from AI', () => {
  it('reports a pretty-printed control the same way', async () => {
    const dir = tempDir()
    const file = join(dir, 'control-spaced.docx')
    writeFileSync(
      file,
      await buildDocx({
        docRootExtraAttrs: `xmlns:go="${NAMESPACES[1]![1]}"`,
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
          '<w:sdt><w:sdtPr><w:tag w:val="phone"/></w:sdtPr><w:sdtContent>' +
          `<w:r>\n  <w:rPr><go:redact w:label="client phone"/></w:rPr>\n  <w:t>${SECRET}</w:t>\n</w:r>` +
          '</w:sdtContent></w:sdt></w:p>',
      }),
    )
    const read = await run(['docs', 'read', file, '--full', '--json'])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    expect(read.json().detail.items[0].inlineContentControls[0].text).toBe(PLACEHOLDER)
  })

  it('reports the control text with the placeholder', async () => {
    const dir = tempDir()
    const file = join(dir, 'control.docx')
    writeFileSync(
      file,
      await buildDocx({
        docRootExtraAttrs: `xmlns:go="${NAMESPACES[1]![1]}"`,
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
          '<w:sdt><w:sdtPr><w:tag w:val="phone"/></w:sdtPr><w:sdtContent>' +
          `<w:r><w:rPr><go:redact w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
          '</w:sdtContent></w:sdt></w:p>',
      }),
    )
    const read = await run(['docs', 'read', file, '--full', '--json'])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    expect(read.json().detail.items[0].inlineContentControls[0]).toMatchObject({
      tag: 'phone',
      text: PLACEHOLDER,
    })
  })
})

describe('docs read: a header layout table holding text hidden from AI', () => {
  it('lists the table with each hidden cell run as its placeholder', async () => {
    const ns = NAMESPACES[1]![1]
    const dir = tempDir()
    const file = join(dir, 'header-table.docx')
    writeFileSync(
      file,
      await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
        headerXml:
          '<w:p><w:r><w:t>Title</w:t></w:r></w:p>' +
          '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
          '<w:tr><w:tc><w:p><w:r><w:t>Left</w:t></w:r></w:p></w:tc><w:tc><w:p>' +
          `<w:r><w:rPr><go:redact xmlns:go="${ns}" w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
          '</w:p></w:tc></w:tr></w:tbl><w:p/>',
      }),
    )
    const read = await run(['docs', 'read', file, '--header-footer', '--json'])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    const hf = read.json().detail.headerFooter
    expect(hf.tables).toEqual({ header: `Left | ${PLACEHOLDER}` })
    expect(hf.sections[0].tables).toEqual({ header: `Left | ${PLACEHOLDER}` })
  })
})
