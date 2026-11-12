import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ensureTableStyleXml, TABLE_STYLE_PRESETS } from '../src/index'
import { resolveTableStyle } from '../src/table-style'

/**
 * String.prototype.replace reads `$&`, `$$`, `$1`, `` $` `` and `$'` in a replacement STRING as
 * patterns. The attributes of the deck's own <a:tblStyleLst/> are document text, and they used to
 * be spliced back through a replacement string.
 */
const DOLLAR = "A$&B$$C$1D$`E$'F"
const DOLLAR_IN_XML = DOLLAR.replace(/&/g, '&amp;')

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

describe('ensureTableStyleXml keeps the $ sequences of the tblStyleLst it expands', () => {
  const preset = TABLE_STYLE_PRESETS['headerDarkBlue']!

  it('writes the original attributes back exactly and leaves the part well-formed', () => {
    const src =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${DOLLAR_IN_XML}"/>`

    const out = ensureTableStyleXml(src, preset.styleId!, preset.styleDefXml!)

    expect(XMLValidator.validate(out)).toBe(true)
    const list = parser.parse(out)['a:tblStyleLst']
    expect(list['@_def']).toBe(DOLLAR)
    // the definition landed once, readable by the style reader
    expect(out.match(/<a:tblStyle\b/g)).toHaveLength(1)
    const def = resolveTableStyle(preset.styleId!, out, undefined)
    expect(def?.firstRow?.fill).toEqual({ type: 'solid', color: '#1F3864' })
  })
})
