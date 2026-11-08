import { describe, expect, it } from 'vitest'
import { MAX_SAFE_NAME_BYTES, safeName } from '../src/mcp/files'

// CJK samples are written with \u escapes on purpose: literal Han characters are
// rejected outside locale files, and comments must stay ASCII/English.
const REPORT_CJK = '\u5831\u544a\u66f8 2.docx'

describe('safeName', () => {
  it('keeps letters of any script and still reduces a name to one safe segment', () => {
    // an ASCII-only class folded these to r_sum_.pdf, collapsing distinct
    // upload names onto the same path segment
    expect(safeName('résumé.pdf')).toBe('résumé.pdf')
    expect(safeName('rçsumé.pdf')).toBe('rçsumé.pdf')
    expect(safeName('résumé.pdf')).not.toBe(safeName('rçsumé.pdf'))
    expect(safeName(REPORT_CJK)).toBe(REPORT_CJK)
    expect(safeName('Q3 rapport (final).docx')).toBe('Q3 rapport (final).docx')
    // path safety is unchanged
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('.bashrc')).toBe('bashrc')
    expect(safeName('we:ird*name?.txt')).toBe('we_ird_name_.txt')
  })

  it('keeps combining marks so an NFD name is not folded', () => {
    // macOS volumes and many mac clients emit NFD; dropping the marks folded
    // this onto re_sume_.pdf
    const nfd = 'résumé.pdf'.normalize('NFD')
    expect(nfd).not.toBe('résumé.pdf')
    expect(safeName(nfd)).toBe(nfd)
    // and it stays distinct from the name it used to collide with
    expect(safeName(nfd)).not.toBe('re_sume_.pdf')
  })

  it('shortens a long name to bytes a file system accepts, keeping the extension whole', () => {
    // 100 Hangul letters are 300 bytes: well under 128 characters, over a 255-byte file name
    const long = `${'가'.repeat(100)}.docx`
    const name = safeName(long)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES)
    expect(name.endsWith('.docx')).toBe(true)
    expect(name.startsWith('가')).toBe(true)
    // short names and ASCII names near the character limit are untouched
    expect(safeName('가'.repeat(60) + '.docx')).toBe('가'.repeat(60) + '.docx')
    expect(safeName('a'.repeat(120) + '.pdf')).toBe('a'.repeat(120) + '.pdf')
    expect(safeName('a'.repeat(200) + '.pdf')).toBe('a'.repeat(124) + '.pdf')
  })

  it('never cuts a letter outside the BMP in half', () => {
    // each of these letters is a surrogate pair in UTF-16
    const name = safeName(`${'\u{20BB7}'.repeat(70)}.docx`)
    expect(Buffer.from(name).toString('utf-8')).toBe(name)
    expect(name.endsWith('.docx')).toBe(true)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES)
  })
})
