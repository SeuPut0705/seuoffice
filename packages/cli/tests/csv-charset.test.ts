import { readFileSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCsv, legacyCsvCharset } from '../src/formats/csv'
import { run, tempDir } from './helpers'

// "품목,금액\n라떼,5000\n" as Korean Excel saves CSV: code page 949, no BOM
const CP949 = new Uint8Array([
  199, 176, 184, 241, 44, 177, 221, 190, 215, 10, 182, 243, 182, 188, 44, 53, 48, 48, 48, 10,
])

describe('CSV in the legacy charset of the machine', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('picks the charset from GENOFFICE_LANG, then the locale variables', () => {
    expect(legacyCsvCharset({ GENOFFICE_LANG: 'ko' })).toBe('euc-kr')
    expect(legacyCsvCharset({ LANG: 'ko_KR.UTF-8' })).toBe('euc-kr')
    expect(legacyCsvCharset({ LC_ALL: 'ja_JP.UTF-8', LANG: 'ko_KR.UTF-8' })).toBe('shift_jis')
    expect(legacyCsvCharset({ GENOFFICE_LANG: 'zh' })).toBe('gb18030')
    expect(legacyCsvCharset({ GENOFFICE_LANG: 'en' })).toBeUndefined()
  })

  it('reads a Korean Excel CSV as Korean on a Korean machine', async () => {
    vi.stubEnv('GENOFFICE_LANG', 'ko')
    const dir = tempDir()
    const csv = join(dir, 'menu.csv')
    writeFileSync(csv, CP949)
    const conv = await run(['convert', csv, '--to', 'xlsx', '--json'])
    expect(conv.code).toBe(0)
    // the workbook is checked as XML: reading it back needs the Rust xlsx engine
    const zip = await JSZip.loadAsync(readFileSync(conv.json().output_path))
    const xml = Object.keys(zip.files)
      .filter((name) => name.startsWith('xl/') && name.endsWith('.xml'))
      .map((name) => zip.file(name)!.async('string'))
    const text = (await Promise.all(xml)).join('')
    for (const word of ['품목', '금액', '라떼']) expect(text).toContain(word)
  })

  it('reads a Korean Excel CSV as Korean on a non-Korean machine', async () => {
    vi.stubEnv('GENOFFICE_LANG', '')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_MESSAGES', '')
    vi.stubEnv('LANG', 'C.UTF-8')
    expect(decodeCsv(CP949)).toBe('품목,금액\n라떼,5000\n')
    const dir = tempDir()
    const csv = join(dir, 'menu.csv')
    writeFileSync(csv, CP949)
    const conv = await run(['convert', csv, '--to', 'xlsx', '--json'])
    expect(conv.code).toBe(0)
    const zip = await JSZip.loadAsync(readFileSync(conv.json().output_path))
    const xml = Object.keys(zip.files)
      .filter((name) => name.startsWith('xl/') && name.endsWith('.xml'))
      .map((name) => zip.file(name)!.async('string'))
    const text = (await Promise.all(xml)).join('')
    for (const word of ['품목', '금액', '라떼']) expect(text).toContain(word)
  })

  it('reads a 3000-row Korean address-code CSV on a non-Korean machine', () => {
    vi.stubEnv('GENOFFICE_LANG', '')
    vi.stubEnv('LC_ALL', '')
    vi.stubEnv('LC_MESSAGES', '')
    vi.stubEnv('LANG', 'C.UTF-8')
    // code page 949 bytes of the words in a legal-dong code list
    const word = {
      header: [
        185, 253, 193, 164, 181, 191, 196, 218, 181, 229, 44, 185, 253, 193, 164, 181, 191, 184,
        237, 44, 198, 243, 193, 246, 191, 169, 186, 206,
      ],
      seoul: [188, 173, 191, 239, 198, 175, 186, 176, 189, 195],
      jongno: [193, 190, 183, 206, 177, 184],
      cheongun: [195, 187, 191, 238, 181, 191],
      exists: [193, 184, 192, 231],
    }
    const bytes: number[] = [...word.header, 10]
    for (let i = 0; i < 3000; i += 1) {
      const code = [...String(1111010100 + i)].map((c) => c.charCodeAt(0))
      bytes.push(...code, 44, ...word.seoul, 32, ...word.jongno, 32, ...word.cheongun, 44)
      bytes.push(...word.exists, 10)
    }
    const lines = decodeCsv(new Uint8Array(bytes)).trimEnd().split('\n')
    expect(lines).toHaveLength(3001)
    expect(lines[0]).toBe('법정동코드,법정동명,폐지여부')
    lines
      .slice(1)
      .forEach((line, i) => expect(line).toBe(`${1111010100 + i},서울특별시 종로구 청운동,존재`))
  })
})
