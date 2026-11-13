import { existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { openOdtBytes, saveOdtBytes } from '../src/formats/odt'
import { CliError } from '../src/result'
import { hiddenDocx, OWN_REDACT_NS, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'
import { formOdt } from './odt-fixtures'

/**
 * An ODT cannot keep the mark that hides content from AI: every route of the
 * command line that writes an ODT refuses a document holding one, and writes
 * nothing, whatever stopped it first.
 */

const messageOf = (stdout: string): string => {
  try {
    return (JSON.parse(stdout) as { message?: string }).message ?? ''
  } catch {
    return ''
  }
}

describe('a document hidden from AI is never written as ODT', () => {
  it('convert docx to odt is refused and leaves no file', async () => {
    const dir = tempDir()
    const file = await hiddenDocx(dir, OWN_REDACT_NS)
    const out = join(dir, 'out.odt')
    const r = await run(['convert', file, '--to', 'odt', '--out', out, '--json'])
    expect(r.code).not.toBe(0)
    expect(messageOf(r.stdout)).toContain('hidden from AI')
    expect(r.stdout + r.stderr).not.toContain(SECRET)
    expect(existsSync(out)).toBe(false)
  })

  it('saving an edited ODT whose docx gained a marked run is refused', async () => {
    const { docxBytes, origin } = await openOdtBytes(await formOdt())
    const zip = await JSZip.loadAsync(docxBytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const marked =
      `<w:p><w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client"/></w:rPr>` +
      `<w:t>${SECRET}</w:t></w:r></w:p>`
    zip.file('word/document.xml', xml.replace('<w:body>', `<w:body>${marked}`))
    const edited = await zip.generateAsync({ type: 'uint8array' })
    const refusal = await saveOdtBytes(origin, edited).catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(CliError)
    expect((refusal as CliError).message).toContain('hidden from AI')
    // the same docx without the mark saves
    zip.file(
      'word/document.xml',
      xml.replace('<w:body>', `<w:body><w:p><w:r><w:t>${SECRET}</w:t></w:r></w:p>`),
    )
    const plain = await zip.generateAsync({ type: 'uint8array' })
    expect((await saveOdtBytes(origin, plain)).byteLength).toBeGreaterThan(0)
  })
})
