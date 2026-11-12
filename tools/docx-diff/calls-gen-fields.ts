// Group genFields: the TOC, caption and INDEX paragraph builders of generate.ts.
import {
  generateCaptionXml,
  generateIndexFieldXml,
  generateTocFieldXml,
  type TocEntry,
} from './reference/generate'
import type { CallSpec, Input } from './calls-spec'

interface Para {
  level: number | undefined
  text: string
}

/** Paragraphs of word/document.xml: heading level (pStyle HeadingN / outlineLvl) and text. */
function parasOf(parts: ReadonlyMap<string, string>): Para[] {
  const xml = parts.get('word/document.xml') ?? ''
  const out: Para[] = []
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0]
    const style = /<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? ''
    const outline = /<w:outlineLvl w:val="(\d+)"/.exec(p)?.[1]
    const heading = /^(?:heading|Heading|标题)\s*(\d)$/.exec(style)?.[1]
    const level = heading ? Number(heading) : outline !== undefined ? Number(outline) + 1 : undefined
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')
    out.push({ level, text })
  }
  return out
}

/** XE terms of instrText, and short paragraph texts: the strings an index sorts. */
function termsOf(parts: ReadonlyMap<string, string>): string[] {
  const xml = parts.get('word/document.xml') ?? ''
  const xe = [...xml.matchAll(/<w:instrText[^>]*>\s*XE\s+"([^"]*)"/g)].map((m) => m[1])
  const texts = parasOf(parts)
    .map((p) => Array.from(p.text).slice(0, 12).join(''))
    .filter((t) => t.trim() !== '')
    .slice(0, 200)
  return [...xe, ...texts]
}

const TERMS: string[][] = [
  [],
  ['', '  ', '\uFEFF'],
  ['banana', 'Apple', 'apple', ' apple ', 'Äpfel', 'zebra', '10', '9', 'a-b', 'ab'],
  ['张三', '李四', '王五', '赵六', '阿', '啊', '安', '中国', '中文', '重庆', '长城', '银行', '行走'],
  ['北京', 'Beijing', 'beijing', '北', 'b', 'Z', '①', '１', '1', 'ａ', 'α', 'Ω', 'я'],
  ['単語', '단어', '汉字', '漢字', 'かな', 'カナ', 'ㄅ', 'ㄆ', '〇', '零', '一', '二', '十'],
  ['e\u0301', '\u00e9', 'e', 'E', 'é', 'ê', 'ë', 'ē', 'ě', 'è'],
  ['<tag>', 'a&b', '"q"', "'s'", '\t tab', '😀', '𠀀', '𪚥', '龘', '丂'],
  ['ǎ', 'à', 'ā', 'á', 'a', 'lü', 'lv', 'nü', '女', '绿', '律'],
  // Hangul syllables against conjoining (U+1100..) and compatibility (U+3131..) jamo
  ['가', '\u1100\u1161', '\u3131', '\u1100', '각', '\u1100\u1161\u11A8', '나', '\u3134', '\u314F', '\u1161', '힣', '\u11A8', '\u3165'],
  // precomposed against decomposed syllables
  ['한', '\u1112\u1161\u11AB', '하', '\u1112\u1161', '한글', '\u1112\u1161\u11AB\u1100\u1173\u11AF', '할', '\u1112\u1161\u11AF', '함'],
  // Hangul mixed with Latin and digits
  ['한국어', 'Korea', '1번', '10번', '2번', '가나다', 'ABC', 'abc', '서울', '부산', 'seoul', '대한민국', '0'],
  // hiragana against katakana of the same sound
  ['あ', 'ア', 'か', 'カ', 'が', 'ガ', 'ぱ', 'パ', 'は', 'ハ', 'ば', 'バ', 'ゔ', 'ヴ', 'う'],
  // half-width katakana
  ['ｱ', 'ア', 'ｶﾞ', 'ガ', 'ﾊﾟ', 'パ', 'ｰ', 'ー', 'ｶ', 'カ', 'ｧ', 'ァ'],
  // voiced and semi-voiced marks, combining (U+3099/309A) and spacing (U+309B/309C), against precomposed
  ['が', 'か\u3099', 'か\u309B', 'ぱ', 'は\u309A', 'は\u309C', 'ガ', 'カ\u3099', 'か', 'は', 'ば', 'は\u3099'],
  // the prolonged sound mark and small kana
  ['コーヒー', 'コオヒイ', 'こーひー', 'キャ', 'キヤ', 'きゃ', 'きや', 'ッ', 'ツ', 'っ', 'つ', 'ァ', 'ア', 'ー'],
  // kana against kanji
  ['にほん', 'ニホン', '\u65E5\u672C', '\u4E2D\u56FD', 'ちゅうごく', '\u6771\u4EAC', 'とうきょう', 'あ', '\u4E9C', '\u963F'],
  // kanji in pinyin order (a, ba, cai, da, er, fa, ge) against stroke-adjacent ones (U+4E00..)
  ['\u963F', '\u516B', '\u624D', '\u5927', '\u4E8C', '\u53D1', '\u4E2A', '\u4E00', '\u4E01', '\u4E03', '\u4E07', '\u4E08', '\u4E09', '\u4E0A', '\u4E0B', '\u4E0C', '\u4E42'],
  // Japanese-only kanji and simplified against traditional forms
  ['\u7551', '\u8FBC', '\u5CE0', '\u8FBB', '\u50CD', '\u56FD', '\u570B', '\u5B66', '\u5B78', '\u6C17', '\u6C23', '\u6C14'],
  // Latin with and without accents and case, NFC against NFD, digits
  ['résumé', 'resume', 'Resume', 'RÉSUMÉ', 're\u0301sume\u0301', 'r\u00e9sum\u00e9', 'Ångström', 'A\u030Angstro\u0308m', 'angstrom', '1', '１', '①', '01', 'z', 'Z'],
  // punctuation, CJK punctuation and emoji outside the BMP
  ['!', '?', '・', '･', '、', ',', '.', '。', '(', '（', '【', '~', '〜', '～', '_', '😀', '🎉', '\u{1F600}a', 'a'],
  // leading and trailing white space the function trims (U+3000, U+FEFF, NBSP, em space) or keeps (U+200B, U+0085)
  ['\u3000\u6F22\u5B57\u3000', '\u6F22\u5B57', '\uFEFF\u6F22\u5B57', '\t\u6F22\u5B57\n', '\u00A0a', 'a\u00A0', 'a', '\u2003b', 'b', '\u200Bc', 'c', '\u0085d', 'd', '\u3000', '\uFEFF\u3000'],
]

const TOCS: TocEntry[][] = [
  [],
  [{ level: 1, text: 'Intro' }],
  [
    { level: 1, text: 'One', pageNo: 1 },
    { level: 2, text: 'One & <two>', pageNo: 2.5 },
    { level: 3, text: '三', pageNo: 0 },
  ],
  [
    { level: 12, text: 'deep' },
    { level: 0, text: 'zero', pageNo: -1 },
    { level: -3, text: 'neg' },
    { level: 1.5, text: 'half', pageNo: 1e21 },
  ],
  [{ level: 4, text: '' }],
]

const CAPTIONS: Array<[string, number, string]> = [
  ['Figure', 1, 'System architecture'],
  ['Table', 12, ''],
  ['图', 3.25, '系统 & <结构>'],
  ['', 0, ' '],
  ['Eq"n', -1, 'x'],
  ['Figure', 1e21, 'big'],
]

export const GEN_FIELDS: CallSpec[] = [
  {
    fn: 'genFields.generateTocFieldXml',
    argMutation: true,
    call: (_text, args) => generateTocFieldXml(args.entries as TocEntry[]),
    fromDocument: (parts) => {
      const entries = parasOf(parts)
        .filter((p) => p.level !== undefined)
        .slice(0, 100)
        .map((p, i): TocEntry => ({ level: p.level as number, text: p.text, pageNo: i % 3 === 0 ? undefined : i }))
      return [{ args: { entries } }]
    },
    built: TOCS.map((entries) => ({ args: { entries } })),
    mutation: 'none',
  },
  {
    fn: 'genFields.generateCaptionXml',
    argMutation: true,
    call: (text, args) => generateCaptionXml(args.label as string, args.number as number, text),
    fromDocument: (parts) =>
      parasOf(parts)
        .filter((p) => p.text !== '')
        .slice(0, 5)
        .map((p, i): Input => ({ text: p.text, args: { label: i % 2 ? '图' : 'Figure', number: i + 1 } })),
    built: CAPTIONS.map(([label, number, text]) => ({ text, args: { label, number } })),
  },
  {
    fn: 'genFields.generateIndexFieldXml',
    argMutation: true,
    call: (_text, args) =>
      args.locale === undefined
        ? generateIndexFieldXml(args.terms as string[])
        : generateIndexFieldXml(args.terms as string[], String(args.locale)),
    fromDocument: (parts) => [{ args: { terms: termsOf(parts) } }],
    built: [
      ...TERMS.map((terms) => ({ args: { terms } })),
      // the locale of the document's language; a tag Intl refuses throws once two terms compare
      ...TERMS.slice(0, 6).flatMap((terms) =>
        ['ko-KR', 'ja-JP', 'en-US', 'de-u-co-phonebk', 'zh-CN-u-co-stroke', 'xx', 'en_US', ''].map((locale) => ({ args: { terms, locale } })),
      ),
    ],
    mutation: 'none',
  },
]
