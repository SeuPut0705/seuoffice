import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { hiddenDocx, NAMESPACES, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

describe('docs read: a span hidden from AI', () => {
  it.each(NAMESPACES)('reads as its placeholder when the label is under %s', async (_n, ns) => {
    const file = await hiddenDocx(tempDir(), ns)
    for (const flags of [['--full'], ['--html'], ['--full', '--html', '--fields', '--comments']]) {
      const read = await run(['docs', 'read', file, ...flags, '--json'])
      expect(read.code).toBe(0)
      expect(read.stdout).not.toContain(SECRET)
    }
    const read = await run(['docs', 'read', file, '--full', '--html', '--json'])
    expect(read.json().detail.items[0].text).toBe(`Call ${PLACEHOLDER} now`)
    expect(read.json().detail.html).toContain(PLACEHOLDER)
  })

  it('a table cell holding one reads as its placeholder', async () => {
    const dir = tempDir()
    const bytes = await buildDocx({
      docRootExtraAttrs: `xmlns:go="${NAMESPACES[0]![1]}"`,
      bodyXml:
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><go:redact w:label="client phone"/></w:rPr>' +
        `<w:t>${SECRET}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>open</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    })
    const file = join(dir, 'table.docx')
    writeFileSync(file, bytes)
    const read = await run(['docs', 'read', file, '--full', '--json'])
    expect(read.stdout).not.toContain(SECRET)
    expect(read.json().detail.items[0].text).toBe(`${PLACEHOLDER} | open`)
  })

  it('an unmarked document reads exactly as before', async () => {
    const dir = tempDir()
    const file = join(dir, 'plain.docx')
    writeFileSync(
      file,
      await buildDocx({
        bodyXml:
          '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r><w:r><w:t>everyone</w:t></w:r></w:p>',
      }),
    )
    const read = await run(['docs', 'read', file, '--full', '--json'])
    expect(read.json().detail.items).toEqual([
      { index: 0, type: 'paragraph', text: 'Call everyone' },
    ])
  })
})
