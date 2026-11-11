import { describe, expect, it } from 'vitest'
import { elementFragments } from './fragments'

const rPr = (xml: string): string[] => elementFragments(xml, 'w:rPr')

describe('elementFragments', () => {
  it('returns every element of the name as a source slice, in closing order', () => {
    const xml = '<w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r><w:r><w:rPr/></w:r><w:rPr ></w:rPr >'
    expect(rPr(xml)).toEqual(['<w:rPr><w:b/></w:rPr>', '<w:rPr/>', '<w:rPr ></w:rPr >'])
  })

  it('returns a nested element and the one around it', () => {
    const inner = '<w:rPr><w:i/></w:rPr>'
    const outer = `<w:rPr><w:b/><w:rPrChange w:id="1">${inner}</w:rPrChange></w:rPr>`
    expect(rPr(`<w:r>${outer}</w:r>`)).toEqual([inner, outer])
  })

  it('reads a ">" inside an attribute value as part of the tag', () => {
    expect(rPr('<w:rPr x=">"/><w:t/>')).toEqual(['<w:rPr x=">"/>'])
    expect(rPr(`<w:rPr x='/>'><w:b a=">"/></w:rPr>`)).toEqual([
      `<w:rPr x='/>'><w:b a=">"/></w:rPr>`,
    ])
  })

  it('does not count markup inside comments, CDATA sections and processing instructions', () => {
    const xml =
      '<!-- <w:rPr/> --><w:t><![CDATA[<w:rPr><w:b/></w:rPr>]]></w:t><?pi <w:rPr/> ?><w:rPr><w:u/></w:rPr>'
    expect(rPr(xml)).toEqual(['<w:rPr><w:u/></w:rPr>'])
  })

  it('does not count a tag quoted inside another tag', () => {
    expect(rPr('<w:x a="<w:rPr/>"/><w:rPr/>')).toEqual(['<w:rPr/>'])
  })

  it('keeps a comment that sits inside a fragment', () => {
    const fragment = '<w:rPr><!-- </w:rPr> --><w:b/></w:rPr>'
    expect(rPr(fragment)).toEqual([fragment])
  })

  it('does not match longer names', () => {
    expect(rPr('<w:rPrChange/><w:rPrDefault></w:rPrDefault><w:rPrx/>')).toEqual([])
  })

  it('drops an element that never closes and ignores a closing tag with nothing open', () => {
    expect(rPr('</w:rPr><w:rPr/><w:rPr><w:b/>')).toEqual(['<w:rPr/>'])
  })

  it('stops at markup that never ends', () => {
    expect(rPr('<w:rPr/><!-- <w:rPr/>')).toEqual(['<w:rPr/>'])
    expect(rPr('<w:rPr/><w:rPr a="')).toEqual(['<w:rPr/>'])
  })
})
