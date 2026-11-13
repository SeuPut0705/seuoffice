/**
 * An element that is rewritten gets a creation id in the extension list of its own
 * <p:cNvPr>. The schema allows one <a:extLst> there, so an existing list takes the id,
 * however another producer wrote that list (empty, or with white space in its end tag).
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { elementDurableId, ensureCreationId } from '../src/identity'
import type { SlideElement } from '../src/types'

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const OTHER = '<a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><keep me="1"/></a:ext>'
const LINK_LIST = '<a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"/></a:extLst>'

/** A whole element around `originalXml`: the engine reads a model, not a partial one. */
const elementOf = (originalXml: string): SlideElement => ({
  id: 'el',
  type: 'passthrough',
  kind: 'unknown',
  anchor: { spIndex: 0, originalXml, range: [0, originalXml.length] },
  transform: { offset: { x: 0, y: 0, cx: 0, cy: 0 }, rot: 0, flipH: false, flipV: false },
})

/** The shape after it was given a creation id, with <p:cNvPr> holding `inner`. */
function minted(inner: string): string {
  const element = elementOf(
    `<p:sp ${NS}><p:nvSpPr><p:cNvPr id="2" name="Box">${inner}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`,
  )
  ensureCreationId(element)
  const xml = element.anchor!.originalXml
  expect(XMLValidator.validate(xml)).toBe(true)
  // the id is the element's own: the reader finds it
  expect(elementDurableId(element)).toMatch(/^e_[0-9a-f]{8}$/)
  return xml
}

/** The children of <p:cNvPr>, with nested hyperlink elements taken out. */
function ownChildren(xml: string): string {
  const inner = /<p:cNvPr\b[^>]*>([\s\S]*)<\/p:cNvPr>/.exec(xml)![1]!
  return inner.replace(/<a:hlink(Click|Hover)\b[\s\S]*?<\/a:hlink\1>/g, '')
}

const listsIn = (xml: string) => xml.match(/<a:extLst\b/g)?.length ?? 0

describe('the creation id goes into the one extension list of the element', () => {
  it.each([
    ['an empty list', '<a:extLst/>'],
    ['an empty list with a space', '<a:extLst />'],
    ['a list whose end tag has a space', `<a:extLst>${OTHER}</a:extLst >`],
    ['a list whose end tag has a line break', `<a:extLst>${OTHER}</a:extLst\n>`],
    ['a list followed by white space', `<a:extLst>${OTHER}</a:extLst>\n  `],
    ['a list as PowerPoint writes it', `<a:extLst>${OTHER}</a:extLst>`],
  ])('%s', (_what, list) => {
    const xml = minted(list)
    expect(listsIn(ownChildren(xml))).toBe(1)
    if (list.includes(OTHER)) expect(xml).toContain(OTHER)
  })

  it('no list: one is added after the hyperlink, whose own list is left alone', () => {
    for (const linkList of [LINK_LIST, '<a:extLst/>']) {
      const link = `<a:hlinkClick r:id="rId1">${linkList}</a:hlinkClick>`
      const xml = minted(link)
      expect(xml).toContain(link)
      expect(listsIn(ownChildren(xml))).toBe(1)
    }
  })

  it('a hyperlink with a list and a list of its own: the own one takes the id', () => {
    const link = `<a:hlinkClick r:id="rId1">${LINK_LIST}</a:hlinkClick>`
    const xml = minted(`${link}<a:extLst/>`)
    expect(xml).toContain(link)
    expect(listsIn(ownChildren(xml))).toBe(1)
  })
})
