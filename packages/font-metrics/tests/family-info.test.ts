// Korean names and Hangul coverage for the font pickers. The renderer's font
// enumeration reports every family in English and groups weight faces into one
// family, so the lookup has to pair each enumerated name with the right Korean
// name out of the font files.
import { describe, expect, it } from 'vitest'

import {
  declaresHangul,
  faceFamilies,
  parseFamilyNames,
  resolveFamilyInfo,
  type FaceFamily,
} from '../src/family-info'

const EN = 0x0409
const KO = 0x0412

/** a name table holding the given Windows-platform records */
function nameTable(records: Array<{ id: number; lang: number; text: string }>): Buffer {
  const strings = records.map((r) => Buffer.from(r.text, 'utf16le').swap16())
  const header = Buffer.alloc(6 + 12 * records.length)
  header.writeUInt16BE(records.length, 2)
  header.writeUInt16BE(header.length, 4)
  let off = 0
  records.forEach((r, i) => {
    const at = 6 + 12 * i
    header.writeUInt16BE(3, at) // Windows
    header.writeUInt16BE(1, at + 2) // Unicode BMP
    header.writeUInt16BE(r.lang, at + 4)
    header.writeUInt16BE(r.id, at + 6)
    header.writeUInt16BE(strings[i]!.length, at + 8)
    header.writeUInt16BE(off, at + 10)
    off += strings[i]!.length
  })
  return Buffer.concat([header, ...strings])
}

function os2(codePageRange1: number): Buffer {
  const buf = Buffer.alloc(86)
  buf.writeUInt32BE(codePageRange1 >>> 0, 78)
  return buf
}

describe('parseFamilyNames', () => {
  it('keeps family records only and marks the Korean-language ones', () => {
    const records = parseFamilyNames(
      nameTable([
        { id: 1, lang: EN, text: 'NanumGothic' },
        { id: 2, lang: EN, text: 'Regular' },
        { id: 1, lang: KO, text: '나눔고딕' },
        { id: 16, lang: EN, text: 'Nanum' },
      ]),
    )
    expect(records).toEqual([
      { id: 1, name: 'NanumGothic', korean: false },
      { id: 1, name: '나눔고딕', korean: true },
      { id: 16, name: 'Nanum', korean: false },
    ])
  })

  it('survives a truncated table', () => {
    const table = nameTable([{ id: 1, lang: EN, text: 'Arial' }])
    expect(parseFamilyNames(table.subarray(0, 10))).toEqual([])
    expect(parseFamilyNames(Buffer.alloc(2))).toEqual([])
  })
})

describe('declaresHangul', () => {
  it('reads the Korean code page bits', () => {
    expect(declaresHangul(os2(1 << 19))).toBe(true) // Wansung
    expect(declaresHangul(os2(1 << 21))).toBe(true) // Johab
    expect(declaresHangul(os2((1 << 17) | (1 << 18)))).toBe(false) // Japanese + Simplified Chinese
  })

  it('is false for a version 0 table, which has no code page range', () => {
    expect(declaresHangul(Buffer.alloc(78))).toBe(false)
    expect(declaresHangul(null)).toBe(false)
  })
})

describe('faceFamilies', () => {
  it('pairs a Korean name only with the spellings of the same nameID', () => {
    // typographic family `Paperlogy`, per-weight family `Paperlogy 7 Bold`
    const faces = faceFamilies(
      [
        { id: 1, name: 'Paperlogy 7 Bold', korean: false },
        { id: 1, name: '페이퍼로지 7 Bold', korean: true },
        { id: 16, name: 'Paperlogy', korean: false },
        { id: 16, name: '페이퍼로지', korean: true },
      ],
      true,
    )
    expect(faces.find((f) => f.name === 'Paperlogy')?.ko).toBe('페이퍼로지')
    expect(faces.find((f) => f.name === 'Paperlogy 7 Bold')?.ko).toBe('페이퍼로지 7 Bold')
  })

  it('ignores a Korean-language record that only repeats the English name', () => {
    const faces = faceFamilies(
      [
        { id: 1, name: 'Pretendard', korean: false },
        { id: 1, name: 'Pretendard', korean: true },
      ],
      true,
    )
    expect(faces).toEqual([{ name: 'Pretendard', hangul: true }])
  })

  it('counts a font with a Korean name as Hangul even without the code page bit', () => {
    const faces = faceFamilies(
      [
        { id: 1, name: 'OldFont', korean: false },
        { id: 1, name: '옛글꼴', korean: true },
      ],
      false,
    )
    expect(faces.every((f) => f.hangul)).toBe(true)
  })
})

describe('resolveFamilyInfo', () => {
  const faces: FaceFamily[] = [
    { name: 'NanumGothic', ko: '나눔고딕', hangul: true },
    { name: 'Pretendard', hangul: true },
    { name: 'Arial', hangul: false },
    { name: 'KoPubDotum Bold', ko: 'KoPub돋움체 Bold', hangul: true },
    { name: 'KoPubDotum Light', ko: 'KoPub돋움체 Light', hangul: true },
    { name: 'A2Z 1 Thin', ko: '에이투지체 1 Thin', hangul: true },
    { name: 'A2Z 2 ExtraLight', ko: '에이투지체 2 ExtraLight', hangul: true },
    { name: 'GulimChe', ko: '굴림체', hangul: true },
  ]
  const info = (family: string) => new Map(resolveFamilyInfo([family], faces)).get(family)

  it('matches the enumerated name whatever its spacing and case', () => {
    expect(info('Nanum Gothic')).toEqual({ ko: '나눔고딕', hangul: true })
  })

  it('reports a Hangul font that has no Korean name', () => {
    expect(info('Pretendard')).toEqual({ hangul: true })
  })

  it('leaves out families that are not Korean', () => {
    expect(resolveFamilyInfo(['Arial', 'Not Installed'], faces)).toEqual([])
  })

  it('finds a family the system named by dropping the style words', () => {
    expect(info('KoPubDotum')).toEqual({ ko: 'KoPub돋움체', hangul: true })
    expect(info('A2Z 1')).toEqual({ ko: '에이투지체 1', hangul: true })
    expect(info('A2Z 2')).toEqual({ ko: '에이투지체 2', hangul: true })
  })

  it('does not take a longer family name for a style suffix', () => {
    // `Gulim` is not installed here; `GulimChe` is another family, not Gulim + style
    expect(info('Gulim')).toBeUndefined()
  })
})
