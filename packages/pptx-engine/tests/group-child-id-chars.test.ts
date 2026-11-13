import { describe, expect, it } from 'vitest'
import { groupChildDurableId } from '../src/index'
import type { SlideElement } from '../src/types'

/**
 * A group child's durable id is found by looking its <p:cNvPr id> up in the group's bytes. The id
 * is whatever the deck says, and it used to be pasted into a RegExp as it stood: `(` threw, `.`
 * matched any character (so another child answered), and `$` anchored and matched nothing.
 */

const GUID_X = '11111111-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const GUID_Y = '22222222-BBBB-4BBB-8BBB-BBBBBBBBBBBB'

const creationId = (guid: string) =>
  '<a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}">' +
  `<a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{${guid}}"/>` +
  '</a:ext></a:extLst>'

const childSp = (cNvPr: string) =>
  `<p:sp><p:nvSpPr>${cNvPr}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`

/** A whole element around `originalXml`: the engine reads a model, not a partial one. */
const elementOf = (originalXml: string, nvId?: string): SlideElement => ({
  id: 'el',
  type: 'passthrough',
  kind: 'unknown',
  anchor: { spIndex: 0, originalXml, range: [0, originalXml.length] },
  transform: { offset: { x: 0, y: 0, cx: 0, cy: 0 }, rot: 0, flipH: false, flipV: false },
  ...(nvId === undefined ? {} : { nvId }),
})

/** A group holding a decoy child (GUID_X) ahead of the child under test (GUID_Y). */
function groupWith(decoyCNvPr: string, childCNvPr: string): SlideElement {
  const originalXml =
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    childSp(decoyCNvPr) +
    childSp(childCNvPr) +
    '</p:grpSp>'
  return elementOf(originalXml)
}

const child = (nvId: string) => elementOf('', nvId)
const idOf = (guid: string) => `e_${guid.slice(0, 8).toLowerCase()}`

describe('groupChildDurableId looks an id up as text, not as a pattern', () => {
  it('an id holding "(" does not throw and finds its child', () => {
    const grp = groupWith(
      `<p:cNvPr id="ab" name="decoy">${creationId(GUID_X)}</p:cNvPr>`,
      `<p:cNvPr id="a(b" name="child">${creationId(GUID_Y)}</p:cNvPr>`,
    )
    expect(groupChildDurableId(grp, child('a(b'))).toBe(idOf(GUID_Y))
  })

  it('"a.b" is not answered by the child whose id is "axb"', () => {
    const grp = groupWith(
      `<p:cNvPr id="axb" name="decoy">${creationId(GUID_X)}</p:cNvPr>`,
      `<p:cNvPr id="a.b" name="child">${creationId(GUID_Y)}</p:cNvPr>`,
    )
    expect(groupChildDurableId(grp, child('a.b'))).toBe(idOf(GUID_Y))
    expect(groupChildDurableId(grp, child('axb'))).toBe(idOf(GUID_X))
  })

  it('an id ending in "$" finds its child', () => {
    const grp = groupWith(
      `<p:cNvPr id="a" name="decoy">${creationId(GUID_X)}</p:cNvPr>`,
      `<p:cNvPr id="a$" name="child">${creationId(GUID_Y)}</p:cNvPr>`,
    )
    expect(groupChildDurableId(grp, child('a$'))).toBe(idOf(GUID_Y))
    expect(groupChildDurableId(grp, child('a'))).toBe(idOf(GUID_X))
  })

  it('a self-closing <p:cNvPr> with such an id falls back to the id itself', () => {
    const grp = groupWith(
      `<p:cNvPr id="a.b" name="decoy">${creationId(GUID_X)}</p:cNvPr>`,
      '<p:cNvPr id="a(b" name="child"/>',
    )
    expect(groupChildDurableId(grp, child('a(b'))).toBe('e_a(b')
  })

  it('a numeric id still finds its own child and not one that contains it', () => {
    const grp = groupWith(
      `<p:cNvPr id="15" name="decoy">${creationId(GUID_X)}</p:cNvPr>`,
      `<p:cNvPr name="child" id='5'>${creationId(GUID_Y)}</p:cNvPr>`,
    )
    expect(groupChildDurableId(grp, child('5'))).toBe(idOf(GUID_Y))
    expect(groupChildDurableId(grp, child('15'))).toBe(idOf(GUID_X))
  })
})
