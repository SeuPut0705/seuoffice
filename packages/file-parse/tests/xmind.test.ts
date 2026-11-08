import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createXmindDocumentFromOutline } from '@genoffice/xmind-engine'
import { parseFileToText, xmindToText } from '../src'
import { writeFixture } from './helpers/fixtures'

const OUTLINE = [
  '# Trip',
  '',
  '- Summer trip',
  '  - Places [coast] <https://example.com/places>',
  '    > Book early.',
  '    - Old town 02139',
  '  - Budget',
  '',
].join('\n')

async function buildXmindFixture(): Promise<Uint8Array> {
  const document = await createXmindDocumentFromOutline(OUTLINE, { untitled: 'Untitled' })
  return document.save()
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('xmind', () => {
  it('reads a mind map as its outline text', async () => {
    const path = writeFixture('map.xmind', await buildXmindFixture())
    const parsed = await parseFileToText(path)
    expect(parsed).toEqual({ ok: true, kind: 'text', text: OUTLINE })
  })

  it('keeps characters as written', async () => {
    const text = await xmindToText(await buildXmindFixture())
    expect(text).toContain('Old town 02139')
    expect(text).toContain('<https://example.com/places>')
  })

  it('returns ok: false for a map whose content cannot be parsed', async () => {
    const bytes = await zipOf({
      'content.json': '[{"id":"s1","class":"sheet"',
      'metadata.json': '{}',
      'manifest.json': '{"file-entries":{}}',
    })
    const parsed = await parseFileToText(writeFixture('broken.xmind', bytes))
    expect(parsed.ok).toBe(false)
    expect(parsed.kind).toBe('text')
    expect(parsed.error).toContain('unreadable')
    expect(parsed.text).toBeUndefined()
  })

  it('returns ok: false for a legacy-format map', async () => {
    const bytes = await zipOf({ 'content.xml': '<xmap-content version="2.0"></xmap-content>' })
    const parsed = await parseFileToText(writeFixture('legacy.xmind', bytes))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('legacy-format')
  })

  it('returns ok: false for a map whose manifest flags encryption', async () => {
    const bytes = await zipOf({
      'content.json': 'not json: encrypted bytes',
      'metadata.json': '{}',
      'manifest.json': JSON.stringify({
        'file-entries': { 'content.json': { 'encryption-data': { 'algorithm-name': 'x' } } },
      }),
    })
    const parsed = await parseFileToText(writeFixture('locked.xmind', bytes))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('encrypted')
  })

  it('rejects a .xmind file that is not a zip', async () => {
    const parsed = await parseFileToText(writeFixture('fake.xmind', '# Trip\n\n- not a mind map\n'))
    expect(parsed).toEqual({
      ok: false,
      kind: 'text',
      error: 'Content mismatch: .xmind file has unknown magic bytes',
    })
  })

  it('refuses a map whose content lies about its size, before inflating it', async () => {
    const zip = new JSZip()
    zip.file('content.json', Buffer.alloc(1536 * 1024, 0x20))
    zip.file('metadata.json', '{}')
    zip.file('manifest.json', '{"file-entries":{}}')
    const bytes = (await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    })) as Buffer
    // the central directory record of content.json now claims 300 bytes
    const centralName = bytes.lastIndexOf(Buffer.from('content.json'))
    bytes.writeUInt32LE(300, centralName - 46 + 24)
    const parsed = await parseFileToText(writeFixture('bomb.xmind', new Uint8Array(bytes)))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('rejected')
  })

  it('xmindToText throws for a file that does not open', async () => {
    await expect(xmindToText(new TextEncoder().encode('nope'))).rejects.toThrow(
      /Cannot read mind map \(unreadable\)/,
    )
  })
})
