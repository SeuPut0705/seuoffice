// Group genRpr: the run property builders of generate.ts (RPR_CHILD_ORDER
// through mergeRPrModel). runRPrXml is not exported; mergeRPrModel over an
// unrecognizable rPr ('' or '<w:rPr/>') takes its no-raw path.
import { mergeRPrModel } from './reference/generate'
import type { Run } from './reference/types'
import type { CallSpec, Input } from './calls-spec'
import { rprModelInputs } from './generate-model-inputs'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** Every w:rPr of a part, nested ones (inside w:rPrChange) whole with their parent. */
function rPrsOf(xml: string): string[] {
  const out: string[] = []
  const tag = /<w:rPr(?: [^>]*)?(\/?)>|<\/w:rPr>/g
  let depth = 0
  let start = -1
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[0] === '</w:rPr>') {
      depth--
      if (depth === 0 && start >= 0) out.push(xml.slice(start, m.index + m[0].length))
    } else if (m[1] === '/') {
      if (depth === 0) out.push(m[0])
    } else {
      if (depth === 0) start = m.index
      depth++
    }
  }
  return out
}

const attr = (xml: string, tag: string, name: string): string | undefined => {
  const el = new RegExp(`<${tag}(?: [^>]*)?/?>`).exec(xml)?.[0]
  if (!el) return undefined
  return new RegExp(` ${name}="([^"]*)"`).exec(el)?.[1] ?? ''
}
const on = (xml: string, tag: string): boolean | undefined => {
  const v = attr(xml, tag, 'w:val')
  if (v === undefined) return undefined
  return v === '' || !['0', 'false', 'off', 'none'].includes(v)
}
const int = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? undefined : n
}

/** A run model read loosely from the raw rPr, as the parse side roughly would. */
function runOf(raw: string): Run {
  const top = raw.replace(/<w:rPrChange[\s\S]*<\/w:rPrChange>/, '')
  const run: Run = { text: 'x', rawRPr: raw } as Run
  const set = <K extends keyof Run>(k: K, v: Run[K] | undefined) => {
    if (v !== undefined) run[k] = v
  }
  set('styleId', attr(top, 'w:rStyle', 'w:val'))
  const ascii = attr(top, 'w:rFonts', 'w:ascii') ?? attr(top, 'w:rFonts', 'w:hAnsi')
  set('fontAscii', ascii)
  set('font', attr(top, 'w:rFonts', 'w:eastAsia') ?? ascii)
  set('fontCs', attr(top, 'w:rFonts', 'w:cs'))
  set('rtl', on(top, 'w:rtl') || undefined)
  const cs = !!run.rtl
  set('bold', on(top, cs ? 'w:bCs' : 'w:b') || undefined)
  set('italic', on(top, cs ? 'w:iCs' : 'w:i') || undefined)
  set('strike', on(top, 'w:strike') || undefined)
  const caps = on(top, 'w:caps')
  const small = on(top, 'w:smallCaps')
  set(
    'caps',
    caps ? 'all' : small ? 'small' : caps === false || small === false ? 'none' : undefined,
  )
  set('dstrike', on(top, 'w:dstrike'))
  set('vanishOwn', on(top, 'w:vanish'))
  const color = attr(top, 'w:color', 'w:val')
  set('color', color === '' ? undefined : color)
  set('charSpacingTwips', int(attr(top, 'w:spacing', 'w:val')))
  const w = int(attr(top, 'w:w', 'w:val'))
  set('charScalePct', w && w !== 100 ? w : undefined)
  set('kernHalfPoints', int(attr(top, 'w:kern', 'w:val')))
  set('positionHalfPoints', int(attr(top, 'w:position', 'w:val')) || undefined)
  set('sizeHalfPoints', int(attr(top, cs ? 'w:szCs' : 'w:sz', 'w:val')) || undefined)
  const hl = attr(top, 'w:highlight', 'w:val')
  set('highlight', hl && hl !== 'none' ? hl : undefined)
  const u = attr(top, 'w:u', 'w:val')
  set('underline', u && u !== 'none' ? true : undefined)
  const fill = attr(top, 'w:shd', 'w:fill')
  set('shading', fill && fill !== 'auto' ? fill : undefined)
  const va = attr(top, 'w:vertAlign', 'w:val')
  set('vertAlign', va === 'superscript' || va === 'subscript' ? va : undefined)
  if (raw.includes('<w:rPrChange')) {
    run.rPrChange = {
      author: attr(raw, 'w:rPrChange', 'w:author') ?? '',
      id: attr(raw, 'w:rPrChange', 'w:id'),
      oldRPr: '',
    }
  }
  return run
}

/** The runs a raw rPr is merged with: as read (a no-op), and edited one field at a time. */
function runsOf(raw: string): Run[] {
  const base = JSON.parse(JSON.stringify(runOf(raw))) as Run
  return [
    base,
    { ...base, bold: !base.bold },
    { ...base, font: 'Edited Font', fontAscii: 'Edited Font' },
    { ...base, sizeHalfPoints: (base.sizeHalfPoints ?? 22) + 2, color: 'FF0000' },
    { ...base, caps: base.caps === 'small' ? 'all' : 'small', underline: !base.underline },
    { text: 'x' } as Run,
  ]
}

const inputsOf = (raw: string, insideLink = false): Input[] =>
  runsOf(raw).map((run) => ({ text: raw, args: { run, insideLink } }))

const R = (inner: string, open = '<w:rPr>'): string => `${open}${inner}</w:rPr>`

const RAWS = [
  '',
  '<w:rPr/>',
  '<w:rPr />',
  '<w:rPr>',
  R(''),
  R('<w:rStyle w:val="Strong"/>'),
  R('<w:rStyle w:val="Hyperlink"/>'),
  R('<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'),
  R(
    '<w:rFonts w:ascii="Arial" w:eastAsia="SimSun" w:hAnsi="Arial" w:cs="Arial" w:hint="eastAsia"/>',
  ),
  R(
    '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>',
  ),
  R('<w:rFonts w:cs="Times New Roman"/><w:rtl/><w:bCs/><w:iCs/><w:szCs w:val="28"/>'),
  R('<w:b/><w:bCs/><w:i w:val="0"/><w:iCs/>'),
  R('<w:b w:val="false"/><w:i w:val="OFF"/><w:strike w:val="1"/>'),
  R('<w:caps/><w:smallCaps w:val="0"/>'),
  R('<w:caps w:val="0"/>'),
  R('<w:smallCaps/>'),
  R('<w:dstrike w:val="none"/><w:vanish/>'),
  R('<w:vanish w:val="0"/><w:webHidden/>'),
  R('<w:color w:val="FF0000" w:themeColor="accent1"/>'),
  R('<w:color w:val="auto"/>'),
  R('<w:spacing w:val="-20"/><w:w w:val="150"/><w:kern w:val="28"/><w:position w:val="6"/>'),
  R('<w:spacing w:val="x"/><w:w w:val="100"/><w:kern w:val="abc"/><w:position w:val="0"/>'),
  R('<w:sz w:val="24"/><w:szCs w:val="24"/>'),
  R('<w:sz w:val=""/><w:szCs w:val="0"/>'),
  R('<w:highlight w:val="yellow"/><w:u w:val="double" w:color="FF0000"/>'),
  R('<w:highlight w:val="none"/><w:u w:color="00FF00"/>'),
  R('<w:u w:val="none"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/>'),
  R('<w:shd w:val="pct10" w:color="auto" w:fill="D9D9D9" w:themeFill="background1"/>'),
  R('<w:vertAlign w:val="superscript"/>'),
  R('<w:vertAlign w:val="baseline"/>'),
  R(
    '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:em w:val="dot"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>',
  ),
  R(
    '<w14:textOutline w14:w="9525"><w14:solidFill><w14:srgbClr w14:val="000000"/></w14:solidFill></w14:textOutline><w:b/>',
  ),
  R('<w:noProof/><w:x-unknown w:val="1"/><w:b/><w:oMath/>'),
  R('<w:eastAsianLayout w:id="1" w:combine="1"/><w:specVanish/><w:sz w:val="20"/>'),
  R(
    '<w:b/><w:rPrChange w:id="5" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr><w:i/></w:rPr></w:rPrChange>',
  ),
  R('<w:sz w:val="20"/><w:b/><w:rFonts w:ascii="Z"/>'),
  R('<w:b/>', `<w:rPr ${W}>`),
  R('<w:rStyle w:val="a&amp;b"/><w:color w:val="1&quot;2"/>'),
]

const OLD_RUNS: Run[] = [
  {
    text: 'x',
    bold: true,
    rPrChange: {
      author: 'Ann',
      id: '7',
      date: '2024-02-02T00:00:00Z',
      dateUtc: '2024-02-02T00:00:00Z',
      old: {},
    },
  } as Run,
  {
    text: 'x',
    italic: true,
    rPrChange: {
      author: 'B<"&>',
      old: {
        styleId: 'S"1',
        font: 'Old',
        fontAscii: 'OldA',
        bold: true,
        italic: true,
        strike: true,
        color: '00FF00',
        charSpacingTwips: -10,
        charScalePct: 80,
        sizeHalfPoints: 21.5,
        highlight: 'cyan',
        underline: true,
        vertAlign: 'subscript',
      },
    },
  } as Run,
  { text: 'x', rPrChange: { author: 'C', oldRPr: '<w:b/><w:sz w:val="20"/>' } } as Run,
  { text: 'x', rPrChange: { author: 'C', oldRPr: '' } } as Run,
  { text: 'x', rPrChange: { author: 'D', old: { font: 'Only' } } } as Run,
]

const MODEL_RUNS: Run[] = [
  { text: 'x' } as Run,
  {
    text: 'x',
    styleId: 'Emphasis',
    bold: true,
    italic: true,
    strike: true,
    underline: true,
    rtl: true,
  } as Run,
  { text: 'x', font: 'Arial' } as Run,
  { text: 'x', font: 'Arial', fontAscii: 'Arial' } as Run,
  { text: 'x', font: 'SimSun', fontAscii: 'Arial', fontCs: 'Arial' } as Run,
  { text: 'x', fontAscii: 'Arial', eastAsiaFont: 'MS Mincho' } as Run,
  { text: 'x', fontCs: 'Traditional Arabic' } as Run,
  { text: 'x', font: 'A&B"', eastAsiaFont: 'A&B"' } as Run,
  { text: 'x', caps: 'all', dstrike: true, vanishOwn: false } as Run,
  { text: 'x', caps: 'small', dstrike: false, vanishOwn: true } as Run,
  { text: 'x', caps: 'none' } as Run,
  {
    text: 'x',
    color: 'auto',
    charSpacingTwips: 0,
    charScalePct: 100,
    kernHalfPoints: 0,
    positionHalfPoints: 0,
    sizeHalfPoints: 0,
  } as Run,
  {
    text: 'x',
    color: '1F497D',
    themeColor: '1F497D',
    charSpacingTwips: 1.5,
    charScalePct: 90,
    kernHalfPoints: 32,
    positionHalfPoints: -4,
    sizeHalfPoints: 25,
  } as Run,
  { text: 'x', highlight: 'yellow', shading: 'D9D9D9', vertAlign: 'superscript' } as Run,
  {
    text: 'x',
    highlight: 'none',
    shading: 'auto',
    vertAlign: 'subscript',
    cs: true,
    bold: true,
    sizeHalfPoints: 28,
  } as Run,
  {
    text: 'x',
    font: 'Calibri',
    fontAscii: 'Calibri',
    themeRFonts: { font: 'Calibri', fontAscii: 'Calibri' },
  } as Run,
  {
    text: 'x',
    font: 'SimSun',
    fontAscii: 'Calibri',
    themeRFonts: { font: 'DengXian', fontAscii: 'Calibri' },
  } as Run,
  { text: 'x', link: { href: 'h', rId: 'rId9' } } as Run,
  { text: 'x', link: { href: 'h', plain: true } } as Run,
  { text: 'x', link: { href: 'h' }, styleId: 'Own' } as Run,
  ...OLD_RUNS,
]

/** rFonts whose eastAsia slot is a theme ref only, merged with a run whose font equals the literal
 *  primary: only the theme attribute says the slot existed, so w:eastAsia is written. */
const THEME_EAST_ASIA: Input[] = [
  '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>',
  '<w:rFonts w:ascii="Arial" w:eastAsiaTheme="minorEastAsia" w:hAnsi="Arial" w:cstheme="minorBidi"/>',
  '<w:rFonts w:eastAsiaTheme="minorEastAsia"/>',
  '<w:rFonts w:ascii="Arial" w:eastAsiaTheme="minorEastAsia"/>',
].flatMap((rFonts) => {
  const raw = R(`${rFonts}<w:b/>`)
  const runs: Run[] = [
    { text: 'x', bold: true, font: 'Arial', fontAscii: 'Times New Roman' },
    {
      text: 'x',
      bold: true,
      font: 'Arial',
      fontAscii: 'Arial',
      themeRFonts: { fontAscii: 'Calibri' },
    },
    { text: 'x', bold: true, font: 'Arial' },
    { text: 'x', bold: true, font: 'Times New Roman', fontAscii: 'Times New Roman' },
    { text: 'x', bold: true, eastAsiaFont: 'SimSun' },
    { text: 'x', bold: true, font: 'Arial', fontAscii: 'Times New Roman', fontCs: 'Arial' },
  ] as Run[]
  return runs.map((run) => ({
    text: raw,
    args: { run: { ...run, rawRPr: raw }, insideLink: false },
  }))
})

const BUILT: Input[] = [
  ...RAWS.flatMap((raw) => [...inputsOf(raw), ...inputsOf(raw, true)]),
  ...RAWS.flatMap((raw) =>
    MODEL_RUNS.flatMap((run) => [
      { text: raw, args: { run: { ...run, rawRPr: raw }, insideLink: false } },
      { text: raw, args: { run: { ...run, rawRPr: raw }, insideLink: true } },
    ]),
  ),
  ...THEME_EAST_ASIA,
]

export const GEN_RPR: CallSpec[] = [
  {
    fn: 'genRpr.mergeRPrModel',
    argMutation: true,
    call: (text, args) => mergeRPrModel(text, args.run as Run, args.insideLink as boolean),
    fromDocument: (parts) => {
      const raws = new Set<string>()
      for (const [name, xml] of parts) {
        if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes|styles)\.xml$/.test(name))
          continue
        for (const raw of rPrsOf(xml)) {
          if (raws.size >= 60) break
          raws.add(raw)
        }
      }
      return [...raws].flatMap((raw, i) => inputsOf(raw, i % 5 === 0))
    },
    built: BUILT,
    fromModel: rprModelInputs,
  },
]
