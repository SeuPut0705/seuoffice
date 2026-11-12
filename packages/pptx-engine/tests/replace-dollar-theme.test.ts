import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  applyThemeToArchive,
  createBlankPptx,
  openPptx,
  savePptx,
  type ThemeSpec,
} from '../src/index'
import { parseTheme } from '../src/theme'

/**
 * A theme name and its font names are typed by the user (or sent by the model). They used to be
 * spliced into theme1.xml through a replacement STRING, where `$&`, `$$`, `$1`, `` $` `` and `$'`
 * are patterns: "Cost $$" lost a `$`, and `$&` pasted the matched tag into the attribute.
 */
const DOLLAR = "A$&B$$C$1D$`E$'F"

const COLORS = {
  dk1: '111111',
  lt1: 'FEFEFE',
  dk2: '222222',
  lt2: 'EEEEEE',
  accent1: 'AA0000',
  accent2: '00AA00',
  accent3: '0000AA',
  accent4: 'AAAA00',
  accent5: '00AAAA',
  accent6: 'AA00AA',
  hlink: '0563C1',
  folHlink: '954F72',
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

const THEME_PATH = 'ppt/theme/theme1.xml'

async function themeAfter(spec: ThemeSpec): Promise<string> {
  const opened = await openPptx(await createBlankPptx())
  expect(applyThemeToArchive(opened, spec)).toBeGreaterThan(0)
  const reopened = await openPptx(await savePptx(opened))
  return reopened.archive.readText(THEME_PATH)!
}

const schemeName = (xml: string): unknown =>
  parser.parse(xml)['a:theme']['a:themeElements']['a:clrScheme']['@_name']

describe('applyThemeToArchive keeps the $ sequences of a theme name and its fonts', () => {
  it('a theme name comes back exactly', async () => {
    const xml = await themeAfter({ name: DOLLAR, colors: COLORS })
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(schemeName(xml)).toBe(DOLLAR)
  })

  it('"Cost $$" keeps both dollar signs', async () => {
    const xml = await themeAfter({ name: 'Cost $$', colors: COLORS })
    expect(schemeName(xml)).toBe('Cost $$')
  })

  it('the heading and body fonts come back exactly', async () => {
    const xml = await themeAfter({
      name: 'Plain',
      colors: COLORS,
      majorFont: `Major ${DOLLAR}`,
      minorFont: `Minor ${DOLLAR}`,
    })
    expect(XMLValidator.validate(xml)).toBe(true)
    const theme = parseTheme(xml)
    expect(theme.majorFont).toBe(`Major ${DOLLAR}`)
    expect(theme.minorFont).toBe(`Minor ${DOLLAR}`)
    expect(schemeName(xml)).toBe('Plain')
  })
})
