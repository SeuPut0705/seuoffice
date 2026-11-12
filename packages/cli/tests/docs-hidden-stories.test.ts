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

describe('docs read: a comment whose open tag is spelled another valid way', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  it.each([`w:id='1' w:author="K"`, `w:id = "1" w:author="K"`, `w:author="a/>b" w:id="1"`])(
    'withholds the hidden run of <w:comment %s>',
    async (attrs) => {
      const dir = tempDir()
      const file = join(dir, 'comment-tag.docx')
      writeFileSync(
        file,
        await buildDocx({
          bodyXml:
            '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Body</w:t></w:r><w:commentRangeEnd w:id="1"/>' +
            '<w:r><w:commentReference w:id="1"/></w:r></w:p>',
          extraParts: [
            {
              path: 'word/comments.xml',
              contentType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
              xml:
                `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>` +
                `<w:comment ${attrs}><w:p><w:r><w:t xml:space="preserve">Note: </w:t></w:r>` +
                `<w:r><w:rPr><go:redact xmlns:go="${NAMESPACES[1]![1]}" w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
                '</w:p></w:comment></w:comments>',
            },
          ],
        }),
      )
      const read = await run(['docs', 'read', file, '--comments', '--json'])
      expect(read.code).toBe(0)
      expect(read.stdout).not.toContain(SECRET)
    },
  )
})

describe('docs apply: add_comment and words hidden from AI', () => {
  it('answers a search for hidden words as it answers one for absent words', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, NAMESPACES[1]![1])
    const before = readFileSync(file)
    const messages: string[] = []
    for (const text of [`${SECRET}B`, 'absent words']) {
      const r = await run([
        'docs',
        'apply',
        file,
        '--ops',
        opsFile(dir, [{ op: 'add_comment', blockIndex: 0, text, comment: 'x' }]),
        '--json',
      ])
      expect(r.code).not.toBe(0)
      messages.push(r.json().message.replace(text, '<text>'))
    }
    expect(messages[0]).toBe(messages[1])
    expect(readFileSync(file)).toEqual(before)
  })

  it('reports the anchored block as a model may read it', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, NAMESPACES[1]![1])
    const r = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [{ op: 'add_comment', blockIndex: 0, comment: 'x' }]),
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(SECRET)
    expect(r.stdout).toContain(PLACEHOLDER)
  })
})
