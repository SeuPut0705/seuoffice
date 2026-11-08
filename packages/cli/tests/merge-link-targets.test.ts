import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function template(label: string, target: string) {
  const dir = tempDir()
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const paragraph = `<w:p><w:hyperlink r:id="rIdTrial"><w:r><w:t>${label}</w:t></w:r></w:hyperlink></w:p>`
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${paragraph}<w:p/></w:body>`),
  )
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
  zip.file(
    'word/_rels/document.xml.rels',
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdTrial" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`,
    ),
  )
  const input = join(dir, 'template.docx')
  const output = join(dir, 'filled.docx')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  return { input, output, bytes }
}

describe('Word merge hyperlink targets', () => {
  it.each(['Ada\nLovelace', 'A & B\n<tag>', '{{other}}\n"quoted"'])(
    'keeps a literal placeholder in a link target for %j',
    async (value) => {
      const target = 'https://example.com/{{name}}'
      const { input, output, bytes } = await template('{{name}}', target)
      const r = await run([
        'merge',
        input,
        '--data',
        JSON.stringify({ name: value }),
        '--out',
        output,
        '--strict',
        '--json',
      ])
      expect(r.code, r.stdout).toBe(0)
      expect(r.json().detail).toMatchObject({ filled: 1, unresolved_placeholders: [] })
      const saved = await JSZip.loadAsync(readFileSync(output))
      const rels = await saved.file('word/_rels/document.xml.rels')!.async('string')
      expect(rels).toContain(`Target="${target}"`)
      const read = await run(['docs', 'read', output, '--full', '--json'])
      expect(
        read
          .json()
          .detail.items.map((b: { text: string }) => b.text)
          .join('\n'),
      ).toContain(value)
      expect(readFileSync(input)).toEqual(bytes)
    },
  )

  it('does not treat a target-only placeholder as a visible merge key', async () => {
    const { input, output, bytes } = await template(
      'Company website',
      'https://example.com/{{name}}',
    )
    const r = await run([
      'merge',
      input,
      '--data',
      '{"name":"Ada"}',
      '--out',
      output,
      '--strict',
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json().detail).toMatchObject({ filled: 0, unused_keys: ['name'] })
    expect(readFileSync(output)).toEqual(bytes)
  })

  it('keeps missing visible values subject to strict validation', async () => {
    const { input, output } = await template('{{missing}}', 'https://example.com/{{name}}')
    const r = await run([
      'merge',
      input,
      '--data',
      '{"name":"Ada"}',
      '--out',
      output,
      '--strict',
      '--json',
    ])
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unresolved_placeholder')
    expect(existsSync(output)).toBe(false)
  })

  it('keeps the single-line replacement route and hyperlink target intact', async () => {
    const target = 'https://example.com/{{name}}'
    const { input, output } = await template('{{name}}', target)
    const r = await run([
      'merge',
      input,
      '--data',
      JSON.stringify({ name: '<tag> & "quoted" {{other}}' }),
      '--out',
      output,
      '--strict',
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    const saved = await JSZip.loadAsync(readFileSync(output))
    expect(await saved.file('word/_rels/document.xml.rels')!.async('string')).toContain(
      `Target="${target}"`,
    )
    const read = await run(['docs', 'read', output, '--full', '--json'])
    expect(
      read
        .json()
        .detail.items.map((b: { text: string }) => b.text)
        .join('\n'),
    ).toContain('<tag> & "quoted" {{other}}')
  })
})
