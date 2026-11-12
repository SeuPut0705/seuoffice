import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { getSlideAnimations, pruneTimingForSpids, type Slide } from '../src/index'

/**
 * Deleting a shape prunes its effects out of <p:timing> and splices the rest back. The rest is
 * document text (animation formulas use `$` as their variable), and it used to go back through a
 * replacement STRING, where `$&`, `$$`, `$1`, `` $` `` and `$'` are patterns.
 */
const DOLLAR_IN_XML = "A$&amp;B$$C$1D$`E$'F"

const slideOf = (bodySuffix: string): Slide => ({ bodySuffix, structureDirty: false }) as never

/** An entrance effect whose animation carries the `$` text in a formula attribute. */
const effectPar = (id: number, spid: number, fmla: string): string =>
  `<p:par><p:cTn id="${id}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect">` +
  '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
  `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${id + 1}" dur="500" fill="hold"/>` +
  `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr>` +
  `<p:tavLst><p:tav tm="0" fmla="${fmla}"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>` +
  '</p:childTnLst></p:cTn></p:par>'

const clickGroup = (id: number, inner: string): string =>
  `<p:par><p:cTn id="${id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
  `<p:par><p:cTn id="${id + 1}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>` +
  '</p:childTnLst></p:cTn></p:par>'

const timingOf = (body: string): string =>
  '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
  '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
  body +
  '</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'

const asPart = (bodySuffix: string): string =>
  `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld/>${bodySuffix}`

describe('pruneTimingForSpids keeps the $ sequences of the timing it writes back', () => {
  it('the surviving effect is byte-identical and the slide stays well-formed', () => {
    const kept = effectPar(30, 7, DOLLAR_IN_XML)
    const before =
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
      timingOf(clickGroup(10, effectPar(12, 5, '#ppt_x')) + clickGroup(20, kept)) +
      '</p:sld>'
    const slide = slideOf(before)

    expect(pruneTimingForSpids(slide, new Set([5]))).toBe(true)

    expect(XMLValidator.validate(asPart(slide.bodySuffix))).toBe(true)
    expect(slide.bodySuffix).toContain(kept)
    expect(slide.bodySuffix.split(DOLLAR_IN_XML)).toHaveLength(2)
    expect(slide.bodySuffix).not.toContain('<p:spTgt spid="5"')
    expect(getSlideAnimations(slide).map((a) => a.spid)).toEqual([7])
    // nothing outside the timing moved
    expect(slide.bodySuffix.startsWith('<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>')).toBe(
      true,
    )
    expect(slide.bodySuffix.endsWith('</p:timing></p:sld>')).toBe(true)
  })
})
