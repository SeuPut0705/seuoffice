import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  OdtEncryptedError,
  OdtNotTextError,
  OdtOpenError,
  isOdtOpenError,
  odtToDocx,
  odtToText,
  saveOdt,
} from '../src'
import { editOnly, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'
import {
  HANCOM_DESKTOP_GENERATOR,
  HANCOM_SERVER_GENERATOR,
  buildOdt,
  buildOdtPackage,
} from './helpers/build-odt'
import { hPara, hParagraphAutoStyle } from './helpers/hancom-fragments'
import { readArchive } from './helpers/odt-archive'
import { findStyle } from './helpers/odt-read'

describe('odtToDocx: lenient package reading', () => {
  it('opens a Hancom-like package: mimetype not first and deflated, no office:version', async () => {
    const built = await buildOdtPackage()
    expect(built.entries[0].name).toBe('META-INF/manifest.xml')
    const archive = await readArchive(built.bytes)
    expect(archive.mimetypeFirst).toBe(false)
    expect(archive.mimetypeStored).toBe(false)

    const bridge = await odtToBridge(built.bytes)
    expect(bridge.content).toBe(built.contentXml)
    expect(bridge.styles).toBe(built.stylesXml)
    expect(bridge.map.paragraphs.length).toBeGreaterThan(0)
    expect(bridge.map.generator).toBe(HANCOM_DESKTOP_GENERATOR)
    // nothing edited: the original bytes come back, the same object
    expect(
      (await saveOdt({ originalOdt: built.bytes, bridge: bridge.map, editedDocx: bridge.docx }))
        .odtBytes,
    ).toBe(built.bytes)
  })

  it('keeps every entry in original archive order with its exact uncompressed bytes', async () => {
    const built = await buildOdtPackage({ pictures: { 'a.png': new Uint8Array([1, 2, 3]) } })
    const bridge = await odtToBridge(built.bytes)
    const { bytes } = await editorSave(
      bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }),
    )
    const wb = await writeBack(bridge, bytes)
    // a re-pack puts mimetype first and stored, the rest in the original order
    expect(wb.archive.entries.map((e) => e.name)).toEqual([
      'mimetype',
      ...built.entries.map((e) => e.name).filter((name) => name !== 'mimetype'),
    ])
    expect(wb.archive.mimetypeFirst).toBe(true)
    expect(wb.archive.mimetypeStored).toBe(true)
    for (const entry of wb.archive.entries) {
      if (entry.name === 'content.xml') continue
      expect(entry.bytes, entry.name).toEqual(
        built.entries.find((e) => e.name === entry.name)?.bytes,
      )
    }
    expect(wb.archive.get('Pictures/a.png')?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(wb.archive.get('missing')).toBeUndefined()
  })

  it('also opens a standard package (mimetype first and stored, office:version 1.3)', async () => {
    const odt = await buildOdt({ mimetypeFirst: true, officeVersion: '1.3' })
    const archive = await readArchive(odt)
    expect(archive.mimetypeFirst).toBe(true)
    expect(archive.mimetypeStored).toBe(true)
    expect(archive.entries[0].name).toBe('mimetype')
    const bridge = await odtToBridge(odt)
    expect(bridge.map.paragraphs.length).toBeGreaterThan(0)
  })

  it('accepts schema errors (non-NCName style names, graphic properties in a paragraph style)', async () => {
    const bridge = await odtToBridge(await buildOdt())
    const names = bridge.map.styles.paragraph.map((e) => e.odfName)
    expect(names).toEqual(expect.arrayContaining(['바탕글', '바탕글 1', '+제목', '개요 1']))
    expect(findStyle(bridge.styles as string, '+제목', 'paragraph')?.properties).toHaveProperty(
      'style:graphic-properties',
    )
  })

  it('keeps a UTF-8 byte order mark: ranges count it and a save re-encodes the part identically', async () => {
    const built = await buildOdtPackage()
    const withBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(built.contentXml),
    ])
    const bridge = await odtToBridge(await buildOdt({ overrideParts: { 'content.xml': withBom } }))
    expect(bridge.content.charCodeAt(0)).toBe(0xfeff)
    const first = bridge.map.paragraphs[0]
    expect(bridge.content.slice(first.start, first.start + '<text:p'.length)).toBe('<text:p')

    const { bytes } = await editorSave(
      bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }),
    )
    const wb = await writeBack(bridge, bytes)
    const saved = wb.archive.get('content.xml')!.bytes
    expect([...saved.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(wb.content.slice(0, first.start)).toBe(bridge.content.slice(0, first.start))
  })

  it('opens a package with no mimetype entry when the manifest root says ODT text', async () => {
    const bridge = await odtToBridge(await buildOdt({ mimetype: null }))
    expect(bridge.map.paragraphs.length).toBeGreaterThan(0)
  })

  it('tolerates whitespace around the mimetype content', async () => {
    const odt = await buildOdt({ mimetype: 'application/vnd.oasis.opendocument.text\r\n' })
    await expect(odtToDocx(odt)).resolves.toBeDefined()
  })
})

describe('rejections', () => {
  const rejects = async (odt: Uint8Array) => {
    const errors: unknown[] = []
    for (const open of [
      () => odtToDocx(odt),
      () => odtToText(odt),
      async () => {
        // `saveOdt` opens the original again; any bridge and docx will do
        const good = await odtToDocx(await buildOdt())
        return saveOdt({ originalOdt: odt, bridge: good.bridge, editedDocx: good.docxBytes })
      },
    ])
      errors.push(await open().catch((e: unknown) => e))
    return errors
  }

  it('rejects a password-protected ODT with a dedicated typed error', async () => {
    for (const err of await rejects(await buildOdt({ encrypted: true }))) {
      expect(err).toBeInstanceOf(OdtEncryptedError)
      expect(err).toBeInstanceOf(OdtOpenError)
      expect((err as OdtOpenError).code).toBe('encrypted')
      expect(isOdtOpenError(err, 'encrypted')).toBe(true)
      expect(isOdtOpenError(err, 'corrupt')).toBe(false)
    }
  })

  it('rejects a package whose mimetype is not ODT text', async () => {
    for (const mimetype of [
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.text-template',
    ]) {
      for (const err of await rejects(await buildOdt({ mimetype }))) {
        expect(err).toBeInstanceOf(OdtNotTextError)
        expect((err as OdtOpenError).code).toBe('not-odt-text')
      }
    }
  })

  it('rejects bytes that are not a zip as corrupt', async () => {
    for (const err of await rejects(new TextEncoder().encode('not a zip at all'))) {
      expect(err).toBeInstanceOf(OdtOpenError)
      expect((err as OdtOpenError).code).toBe('corrupt')
    }
  })

  it('rejects a package without content.xml as corrupt', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
    for (const err of await rejects(await zip.generateAsync({ type: 'uint8array' })))
      expect((err as OdtOpenError).code).toBe('corrupt')
  })
})

describe('zip size gate (same limits as docx)', () => {
  it('rejects a part that inflates past its declared size (bomb-like)', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024)
    const bytes = await buildOdt({
      extraEntries: [{ name: 'Pictures/bomb.bin', data: zeros, mediaType: '' }],
    })
    // forge the declared uncompressed size of the bomb part down to 100 bytes
    const forged = forgeDeclaredSize(bytes, 'Pictures/bomb.bin', 100)
    const err = await odtToDocx(forged).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('zip-rejected')
    expect((err as Error).message).toMatch(/inflates past/)
  })

  it('rejects a part that declares more than the per-part limit before reading it', async () => {
    const bytes = await buildOdt({
      extraEntries: [{ name: 'Pictures/big.bin', data: new Uint8Array(300_000), mediaType: '' }],
    })
    const forged = forgeDeclaredSize(bytes, 'Pictures/big.bin', 0x7fffffff)
    const err = await odtToDocx(forged).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('zip-rejected')
  })
})

describe('generator', () => {
  it('reads meta:generator into the bridge map', async () => {
    const generator = async (options: Parameters<typeof buildOdt>[0]) =>
      (await odtToDocx(await buildOdt(options))).bridge.generator
    expect(await generator({})).toBe(HANCOM_DESKTOP_GENERATOR)
    expect(await generator({ generator: HANCOM_SERVER_GENERATOR })).toBe(HANCOM_SERVER_GENERATOR)
    expect(await generator({ generator: null })).toBeNull()
    expect(await generator({ generator: 'Something & Else' })).toBe('Something & Else')
  })
})

describe('new automatic styles', () => {
  it('get unused NCNames even when the original name is not one', async () => {
    // Hancom names the 27th column `[`, and puts spaces in style names
    const names = ['Table2.[', 'Spaced 1', '1st']
    const bridge = await odtToBridge(
      await buildOdt({
        body: names.map((name) => hPara(name, { style: name })).join(''),
        extraContentAutomaticStyles: names.map((name) => hParagraphAutoStyle(name)).join(''),
      }),
    )
    const centre = (g: { format?: object }) => (g.format = { ...g.format, align: 'center' })
    const { bytes } = await editorSave(bridge.docx, editOnly({ 0: centre, 1: centre, 2: centre }))
    const wb = await writeBack(bridge, bytes)
    const added = wb
      .newAutomaticStyles('content.xml')
      .map((x) => /style:name="([^"]*)"/.exec(x)?.[1])
    expect(added).toEqual(['Table2.__io1', 'Spaced_1_io1', '_1st_io1'])
    for (const name of added) expect(findStyle(wb.content, name as string)).toBeDefined()
  })
})

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
