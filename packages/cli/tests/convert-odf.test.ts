import { existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

const ODF_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
  ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"' +
  ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
  ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"' +
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"' +
  ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"' +
  ' xmlns:xlink="http://www.w3.org/1999/xlink"'

async function buildZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, body] of Object.entries(files)) zip.file(path, body)
  return zip.generateAsync({ type: 'uint8array' })
}

async function entryText(path: string, entry: string): Promise<string> {
  const zip = await JSZip.loadAsync(
    await import('node:fs/promises').then((fs) => fs.readFile(path)),
  )
  const file = zip.file(entry)
  return file ? file.async('string') : ''
}

describe('genoffice convert ODF import filters', () => {
  it('converts .odp to .pptx headlessly', async () => {
    const dir = tempDir()
    const content =
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES} office:version="1.2">` +
      '<office:body><office:presentation>' +
      '<draw:page draw:name="p1">' +
      '<draw:frame svg:x="2cm" svg:y="1cm" svg:width="20cm" svg:height="3cm">' +
      '<draw:text-box><text:p>Slide one words</text:p></draw:text-box>' +
      '</draw:frame></draw:page>' +
      '</office:presentation></office:body></office:document-content>'
    const odp = join(dir, 'deck.odp')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(odp, await buildZip({ 'content.xml': content }))

    const out = join(dir, 'deck.pptx')
    const r = await run(['convert', odp, '--to', 'pptx', '--out', out, '--json'])
    expect(r.code).toBe(0)
    expect(existsSync(out)).toBe(true)
    const slide1 = await entryText(out, 'ppt/slides/slide1.xml')
    expect(slide1).toContain('Slide one words')
    expect(r.json().detail).toMatchObject({ slides: 1 })
  })

  it('converts the .otp template through the same filter as .odp', async () => {
    const dir = tempDir()
    const { writeFile } = await import('node:fs/promises')
    const presContent =
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES} office:version="1.2">` +
      '<office:body><office:presentation><draw:page draw:name="p1">' +
      '<draw:frame svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="2cm"><draw:text-box><text:p>Deck template</text:p></draw:text-box></draw:frame>' +
      '</draw:page></office:presentation></office:body></office:document-content>'
    const otp = join(dir, 'deck.otp')
    await writeFile(otp, await buildZip({ 'content.xml': presContent }))
    const otpOut = join(dir, 'deck.pptx')
    expect((await run(['convert', otp, '--to', 'pptx', '--out', otpOut, '--json'])).code).toBe(0)
    expect(await entryText(otpOut, 'ppt/slides/slide1.xml')).toContain('Deck template')
  })

  it('refuses ODF routes that do not exist', async () => {
    const dir = tempDir()
    const odp = join(dir, 'deck.odp')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(odp, await buildZip({ 'content.xml': '<?xml version="1.0"?><x/>' }))
    const r = await run(['convert', odp, '--to', 'docx', '--json'])
    expect(r.code).toBe(1)
    expect(r.json().message).toContain('cannot convert')
  })
})
