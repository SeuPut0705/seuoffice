// Group genFields: the TOC, caption and INDEX paragraph builders of generate.ts.
import {
  generateCaptionXml,
  generateIndexFieldXml,
  generateTocFieldXml,
  type TocEntry,
} from '../../packages/docx-engine/src/generate'
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
    call: (_text, args) => generateIndexFieldXml(args.terms as string[]),
    fromDocument: (parts) => [{ args: { terms: termsOf(parts) } }],
    built: TERMS.map((terms) => ({ args: { terms } })),
    mutation: 'none',
  },
]
