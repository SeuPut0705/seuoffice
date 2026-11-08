import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function fixture(kind: string) {
  const dir = tempDir(),
    input = join(dir, 'template.docx'),
    output = join(dir, 'result.docx'),
    zip = await JSZip.loadAsync(await buildBlankDocx())
  const hf = kind === 'header' || kind === 'footer',
    partName = hf ? kind + 'Trial.xml' : kind + 's.xml',
    path = 'word/' + partName,
    tag = kind === 'header' ? 'hdr' : kind === 'footer' ? 'ftr' : kind + 's'
  const entry = '<w:p><w:r><w:t>{{side}}</w:t></w:r></w:p>'
  const side = `<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${hf ? entry : `<w:${kind} w:id="4">${entry}</w:${kind}>`}</w:${tag}>`
  zip.file(path, side)
  const type = hf ? kind : kind + 's'
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
  zip.file(
    'word/_rels/document.xml.rels',
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdSideTrial" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${partName}"/></Relationships>`,
    ),
  )
  const ct = await zip.file('[Content_Types].xml')!.async('string')
  zip.file(
    '[Content_Types].xml',
    ct.replace(
      '</Types>',
      `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/></Types>`,
    ),
  )
  const xml = await zip.file('word/document.xml')!.async('string'),
    reference = hf ? `<w:${kind}Reference w:type="default" r:id="rIdSideTrial"/>` : ''
  const note = hf ? '' : `<w:r><w:${kind}Reference w:id="4"/></w:r>`
  zip.file(
    'word/document.xml',
    xml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body><w:p><w:r><w:t>{{body}}</w:t></w:r>${note}</w:p><w:sectPr>${reference}</w:sectPr></w:body>`,
    ),
  )
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  return { input, output, bytes, path, side }
}
for (const kind of ['header', 'footer', 'footnote', 'endnote']) {
  it(`strict mode detects an inaccessible ${kind} placeholder`, async () => {
    const { input, output, bytes } = await fixture(kind)
    writeFileSync(output, 'keep existing')
    const r = await run([
      'merge',
      input,
      '--data',
      '{"body":"Filled","side":"Not reachable"}',
      '--out',
      output,
      '--strict',
      '--force',
      '--json',
    ])
    expect(r.code, r.stdout).toBe(1)
    expect(r.json().error).toBe('unresolved_placeholder')
    expect(r.json().detail.unresolved_placeholders).toEqual([
      expect.objectContaining({ key: 'side', reason: 'unsupported_location' }),
    ])
    expect(readFileSync(output, 'utf8')).toBe('keep existing')
    expect(readFileSync(input)).toEqual(bytes)
  })
  it(`non-strict mode preserves and reports the ${kind} placeholder`, async () => {
    const { input, output, path, side } = await fixture(kind)
    const r = await run([
      'merge',
      input,
      '--data',
      '{"body":"Filled","side":"Not reachable"}',
      '--out',
      output,
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json().detail.filled).toBe(1)
    expect(r.json().detail.unresolved_placeholders).toHaveLength(1)
    expect(r.json().warnings[0].suggestion).toMatch(/headers|footers|notes/)
    expect(await (await JSZip.loadAsync(readFileSync(output))).file(path)!.async('string')).toBe(
      side,
    )
  })
}
it('does not invent side-part placeholders in a body-only template', async () => {
  const dir = tempDir(),
    input = join(dir, 'blank.docx'),
    output = join(dir, 'result.docx')
  writeFileSync(input, await buildBlankDocx())
  const r = await run(['merge', input, '--data', '{}', '--out', output, '--strict', '--json'])
  expect(r.code, r.stdout).toBe(0)
  expect(existsSync(output)).toBe(true)
})
