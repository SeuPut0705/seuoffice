import JSZip from 'jszip'
import { docxToOdt, isOdtOpenError } from '@genoffice/odt-engine'
import { describe, expect, it } from 'vitest'
import { odtToText, parseFileToText } from '../src/index'
import { buildDocxFixture, buildPdfFixture, writeFixture } from './helpers/fixtures'

const ODT_MIME = 'application/vnd.oasis.opendocument.text'

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"'

const cell = (text: string) => `<table:table-cell><text:p>${text}</text:p></table:table-cell>`

/** body: a paragraph, a plain table, a table Hancom-style inside a text box, a footnote */
const BODY =
  '<text:p>Opening paragraph 02139</text:p>' +
  '<table:table table:name="T1"><table:table-column table:number-columns-repeated="2"/>' +
  `<table:table-row>${cell('Metric')}${cell('Value')}</table:table-row>` +
  `<table:table-row>${cell('Revenue')}${cell('100')}</table:table-row>` +
  '</table:table>' +
  '<text:p><draw:frame draw:name="Box1" text:anchor-type="as-char" svg:width="5cm" svg:height="2cm">' +
  '<draw:text-box><table:table table:name="T2"><table:table-column/>' +
  `<table:table-row>${cell('Framed cell text')}</table:table-row>` +
  '</table:table></draw:text-box></draw:frame></text:p>' +
  '<text:p>Closing<text:note text:id="n1" text:note-class="footnote">' +
  '<text:note-citation>1</text:note-citation><text:note-body><text:p>Footnote body</text:p></text:note-body>' +
  '</text:note></text:p>'

interface OdtOptions {
  mimetype?: string
  encrypted?: boolean
}

async function buildOdt({ mimetype = ODT_MIME, encrypted = false }: OdtOptions = {}) {
  const zip = new JSZip()
  zip.file('mimetype', mimetype, { compression: 'STORE' })
  const encryption = encrypted
    ? '<manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="AAAA">' +
      '<manifest:algorithm manifest:algorithm-name="Blowfish CFB" manifest:initialisation-vector="AAAA"/>' +
      '<manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:iteration-count="1024" manifest:salt="AAAA"/>' +
      '</manifest:encryption-data>'
    : ''
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
      `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
      `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${encryption}</manifest:file-entry>` +
      '</manifest:manifest>',
  )
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.2">` +
      `<office:body><office:text>${BODY}</office:text></office:body></office:document-content>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('parseFileToText: odt', () => {
  it('extracts paragraphs, tables, a table inside a text box and notes', async () => {
    const result = await parseFileToText(writeFixture('report.odt', await buildOdt()))
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('text')
    const text = result.text ?? ''
    // leading zeros survive: text is not coerced
    expect(text).toContain('Opening paragraph 02139')
    expect(text).toContain('Metric\tValue')
    expect(text).toContain('Revenue\t100')
    expect(text).toContain('Framed cell text')
    expect(text).toContain('Closing1')
    expect(text).toContain('1 Footnote body')
  })

  it('reads an ODT the engine exported from a docx', async () => {
    const { odtBytes } = await docxToOdt(await buildDocxFixture())
    const result = await parseFileToText(writeFixture('exported.odt', odtBytes))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Annual Report')
    expect(result.text).toContain('First paragraph hello docx')
    expect(result.text).toContain('Metric')
    expect(result.text).toContain('Revenue')
    expect(result.text).toContain('100')
  })

  it('returns ok:false for a password-protected ODT without throwing', async () => {
    const result = await parseFileToText(
      writeFixture('locked.odt', await buildOdt({ encrypted: true })),
    )
    expect(result.ok).toBe(false)
    expect(result.text).toBeUndefined()
    expect(result.error).toContain('Password-protected')
  })

  it('rejects a non-zip named .odt with a content-mismatch error', async () => {
    const result = await parseFileToText(writeFixture('fake.odt', buildPdfFixture('hello')))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Content mismatch')
  })

  it('rejects a docx named .odt with a content-mismatch error', async () => {
    const result = await parseFileToText(writeFixture('docx-as.odt', await buildDocxFixture()))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Content mismatch')
  })

  it('rejects an OpenDocument spreadsheet named .odt with a content-mismatch error', async () => {
    const bytes = await buildOdt({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet' })
    const result = await parseFileToText(writeFixture('sheet-as.odt', bytes))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Content mismatch')
  })

  it('returns ok:false for a corrupt zip named .odt without throwing', async () => {
    const bytes = await buildOdt()
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2))
    const result = await parseFileToText(writeFixture('broken.odt', truncated))
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects an oversized declaration at the zip gate without throwing', async () => {
    const bytes = Buffer.from(await buildOdt())
    // rewrite content.xml's declared uncompressed size in its central record
    const centralName = bytes.lastIndexOf(Buffer.from('content.xml'))
    bytes.writeUInt32LE(600_000_000, centralName - 46 + 24)
    const result = await parseFileToText(writeFixture('bomb.odt', bytes))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/declares 600000000 uncompressed bytes/)
  })

  it('does not read ODT content saved under a .docx name', async () => {
    const result = await parseFileToText(writeFixture('odt-as.docx', await buildOdt()))
    expect(result.ok).toBe(false)
  })
})

describe('odtToText', () => {
  it('throws the engine error for a password-protected ODT', async () => {
    const err = await odtToText(await buildOdt({ encrypted: true })).catch((e: unknown) => e)
    expect(isOdtOpenError(err, 'encrypted')).toBe(true)
  })

  it('leaves the input bytes untouched', async () => {
    const bytes = await buildOdt()
    const copy = bytes.slice()
    await odtToText(bytes)
    expect(bytes).toEqual(copy)
  })
})
