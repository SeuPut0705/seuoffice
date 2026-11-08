import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'

for (const body of [
  '<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr/>',
  '<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
  '<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>Section one</w:t></w:r></w:p><w:p><w:r><w:t>Section two</w:t></w:r></w:p><w:sectPr/>',
])
  it('counts addressable body blocks instead of hidden section bookkeeping', async () => {
    const zip = await JSZip.loadAsync(await buildBlankDocx()),
      xml = await zip.file('word/document.xml')!.async('string')
    zip.file(
      'word/document.xml',
      xml.replace(/<w:body>[\s\S]*<\/w:body>/, '<w:body>' + body + '</w:body>'),
    )
    const file = join(tempDir(), 'fixture.docx')
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
    const info = (await run(['info', file, '--json'])).json(),
      read = (await run(['docs', 'read', file, '--json'])).json()
    expect(info.detail.blocks).toBe(read.detail.blocks)
    expect(Object.values<number>(info.detail.block_types).reduce((a, b) => a + b, 0)).toBe(
      info.detail.blocks,
    )
  })
