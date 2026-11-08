import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  ODT_ZIP_LIMITS,
  OdtEncryptedError,
  OdtNotTextError,
  OdtOpenError,
  detectGenerator,
  openOdt,
  readOdtPackage,
} from '../src/core'
import {
  HANCOM_DESKTOP_GENERATOR,
  HANCOM_SERVER_GENERATOR,
  buildOdt,
  buildOdtPackage,
} from './helpers/build-odt'
import { DEFAULT_ZIP_LIMITS } from '@genoffice/zip-gate'

describe('openOdt: lenient package reading', () => {
  it('opens a Hancom-like package: mimetype not first and deflated, no office:version', async () => {
    const built = await buildOdtPackage()
    expect(built.entries[0].name).toBe('META-INF/manifest.xml')
    const doc = await openOdt(built.bytes)

    expect(doc.officeVersion).toBeNull()
    expect(doc.pkg.mimetype).toBe('application/vnd.oasis.opendocument.text')
    expect(doc.pkg.mimetypeFirst).toBe(false)
    expect(doc.pkg.mimetypeStored).toBe(false)
    expect(doc.contentXml).toBe(built.contentXml)
    expect(doc.stylesXml).toBe(built.stylesXml)
    expect(doc.metaXml).toBe(built.metaXml)
  })

  it('keeps every entry in original archive order with its exact uncompressed bytes', async () => {
    const built = await buildOdtPackage({ pictures: { 'a.png': new Uint8Array([1, 2, 3]) } })
    const pkg = await readOdtPackage(built.bytes)
    expect(pkg.entries.map((e) => e.name)).toEqual(built.entries.map((e) => e.name))
    for (const [i, entry] of pkg.entries.entries()) {
      expect(entry.bytes).toEqual(built.entries[i].bytes)
      expect(entry.method).toBe(built.entries[i].compressed ? 8 : 0)
    }
    expect(pkg.get('Pictures/a.png')?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(pkg.get('missing')).toBeUndefined()
  })

  it('also opens a standard package (mimetype first and stored, office:version 1.3)', async () => {
    const doc = await openOdt(await buildOdt({ mimetypeFirst: true, officeVersion: '1.3' }))
    expect(doc.pkg.mimetypeFirst).toBe(true)
    expect(doc.pkg.mimetypeStored).toBe(true)
    expect(doc.officeVersion).toBe('1.3')
    expect(doc.pkg.entries[0].name).toBe('mimetype')
  })

  it('accepts schema errors (non-NCName style names, graphic properties in a paragraph style)', async () => {
    const doc = await openOdt(await buildOdt())
    expect(doc.styles.common('바탕글 1', 'paragraph')).toBeDefined()
    expect(doc.styles.common('+제목', 'paragraph')?.properties['style:graphic-properties']).toEqual(
      { 'draw:fill': 'none' },
    )
  })

  it('keeps a UTF-8 byte order mark so re-encoding the decoded part is byte-identical', async () => {
    const built = await buildOdtPackage()
    const withBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(built.contentXml),
    ])
    const pkg = await readOdtPackage(await buildOdt({ overrideParts: { 'content.xml': withBom } }))
    const text = pkg.text('content.xml') as string
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(new TextEncoder().encode(text)).toEqual(withBom)
  })

  it('opens a package with no mimetype entry when the manifest root says ODT text', async () => {
    const doc = await openOdt(await buildOdt({ mimetype: null }))
    expect(doc.pkg.mimetype).toBe('application/vnd.oasis.opendocument.text')
    expect(doc.pkg.mimetypeFirst).toBe(false)
  })
})

describe('openOdt: rejections', () => {
  it('rejects a password-protected ODT with a dedicated typed error', async () => {
    const bytes = await buildOdt({ encrypted: true })
    const err = await openOdt(bytes).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtEncryptedError)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('encrypted')
  })

  it('rejects a package whose mimetype is not ODT text', async () => {
    for (const mimetype of [
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.text-template',
    ]) {
      const err = await openOdt(await buildOdt({ mimetype })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(OdtNotTextError)
      expect((err as OdtOpenError).code).toBe('not-odt-text')
    }
  })

  it('tolerates whitespace around the mimetype content', async () => {
    const doc = await openOdt(
      await buildOdt({ mimetype: 'application/vnd.oasis.opendocument.text\r\n' }),
    )
    expect(doc.pkg.mimetype).toBe('application/vnd.oasis.opendocument.text')
  })

  it('rejects bytes that are not a zip as corrupt', async () => {
    const err = await openOdt(new TextEncoder().encode('not a zip at all')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('corrupt')
  })

  it('rejects a package without content.xml as corrupt', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
    const err = await openOdt(await zip.generateAsync({ type: 'uint8array' })).catch(
      (e: unknown) => e,
    )
    expect((err as OdtOpenError).code).toBe('corrupt')
  })
})

describe('openOdt: zip size gate (same limits as docx)', () => {
  it('uses the docx engine limits by default', () => {
    expect(ODT_ZIP_LIMITS).toEqual(DEFAULT_ZIP_LIMITS)
  })

  it('rejects an archive over the configured limits before materialising parts', async () => {
    const bytes = await buildOdt()
    const err = await openOdt(bytes, {
      limits: { maxParts: 3, maxPartBytes: 1 << 20, maxTotalBytes: 1 << 20 },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('zip-rejected')
  })

  it('rejects a part that inflates past its declared size (bomb-like)', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024)
    const bytes = await buildOdt({
      extraEntries: [{ name: 'Pictures/bomb.bin', data: zeros, mediaType: '' }],
    })
    // forge the declared uncompressed size of the bomb part down to 100 bytes
    const forged = forgeDeclaredSize(bytes, 'Pictures/bomb.bin', 100)
    const err = await openOdt(forged).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('zip-rejected')
    expect((err as Error).message).toMatch(/inflates past/)
  })

  it('rejects an honest part above the per-part limit', async () => {
    const bytes = await buildOdt({
      extraEntries: [{ name: 'Pictures/big.bin', data: new Uint8Array(300_000), mediaType: '' }],
    })
    const err = await openOdt(bytes, {
      limits: { maxParts: 100, maxPartBytes: 200_000, maxTotalBytes: 10_000_000 },
    }).catch((e: unknown) => e)
    expect((err as OdtOpenError).code).toBe('zip-rejected')
  })
})

describe('generator detection', () => {
  it('reads meta:generator and names the producer', async () => {
    const desktop = await openOdt(await buildOdt())
    expect(desktop.generator).toEqual({ name: HANCOM_DESKTOP_GENERATOR, producer: 'hancom' })
    const server = await openOdt(await buildOdt({ generator: HANCOM_SERVER_GENERATOR }))
    expect(server.generator).toEqual({ name: HANCOM_SERVER_GENERATOR, producer: 'hancom' })
    const none = await openOdt(await buildOdt({ generator: null }))
    expect(none.generator).toEqual({ name: null, producer: 'unknown' })
  })

  it('classifies other producers by their generator strings', () => {
    expect(
      detectGenerator(meta('LibreOffice/7.6.4.1$Windows_X86_64 LibreOffice_project/e19e')),
    ).toEqual({
      name: 'LibreOffice/7.6.4.1$Windows_X86_64 LibreOffice_project/e19e',
      producer: 'libreoffice',
    })
    expect(
      detectGenerator(meta('OpenOffice/4.1.15$Win32 OpenOffice.org_project/4115m1')).producer,
    ).toBe('openoffice')
    expect(detectGenerator(meta('MicrosoftOffice/16.0 MicrosoftWord')).producer).toBe('ms-word')
    expect(detectGenerator(meta('PolarisOffice')).producer).toBe('polaris')
    expect(detectGenerator(meta('Google Docs')).producer).toBe('google-docs')
    expect(detectGenerator(meta('Something &amp; Else')).name).toBe('Something & Else')
    expect(detectGenerator(meta('Something Else')).producer).toBe('other')
    expect(detectGenerator(null)).toEqual({ name: null, producer: 'unknown' })
  })
})

function meta(generator: string): string {
  return `<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator>${generator}</meta:generator></office:meta></office:document-meta>`
}

/** Rewrites the declared uncompressed size of `name` in both the local and central headers. */
function forgeDeclaredSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer)
  const target = new TextEncoder().encode(name)
  const matchesAt = (pos: number) => target.every((b, i) => out[pos + i] === b)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = view.getUint32(i, true)
    if (sig === 0x04034b50 && view.getUint16(i + 26, true) === target.length && matchesAt(i + 30)) {
      view.setUint32(i + 22, size, true)
    }
    if (sig === 0x02014b50 && view.getUint16(i + 28, true) === target.length && matchesAt(i + 46)) {
      view.setUint32(i + 24, size, true)
    }
  }
  return out
}
