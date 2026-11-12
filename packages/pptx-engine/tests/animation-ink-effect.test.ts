import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import {
  buildTimingXml,
  getSlideAnimations,
  setSlideAnimations,
  type Slide,
  type SlideAnimation,
} from '../src/index'

/**
 * An ink replay effect targets <p:inkTgt>, not a shape, so the reader does not list it. The
 * incremental writer used to count it anyway when it looked for "the nth effect": editing one
 * animation then replaced the wrong effect, losing it and leaving a shape with two effects.
 */

const A1: SlideAnimation = {
  spid: 4,
  effect: 'fade',
  trigger: 'onClick',
  durationMs: 500,
  delayMs: 0,
}
const A2: SlideAnimation = {
  spid: 5,
  effect: 'flyIn',
  trigger: 'onClick',
  durationMs: 1000,
  delayMs: 0,
}

/** A click group holding one ink replay effect, as PowerPoint writes it. */
const INK =
  '<p:par><p:cTn id="900" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>' +
  '<p:par><p:cTn id="901" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
  '<p:par><p:cTn id="902" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect">' +
  '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
  '<p:set><p:cBhvr><p:cTn id="903" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>' +
  '<p:tgtEl><p:inkTgt spid="9"/></p:tgtEl>' +
  '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>' +
  '<p:to><p:strVal val="visible"/></p:to></p:set>' +
  '</p:childTnLst></p:cTn></p:par>' +
  '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>'

/** A slide whose main sequence runs the ink effect first, then the two shape effects. */
function slideWithInkFirst(): Slide {
  const timing = buildTimingXml([A1, A2])
  const seq = timing.indexOf('nodeType="mainSeq"')
  const open = '<p:childTnLst>'
  const at = timing.indexOf(open, seq) + open.length
  const bodySuffix =
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    timing.slice(0, at) +
    INK +
    timing.slice(at) +
    '</p:sld>'
  return { bodySuffix, structureDirty: false } as never
}

/** The <p:par> of the effect cTn that targets `spid`, by its bytes. */
function effectPars(bodySuffix: string, spid: number): string[] {
  const pars = bodySuffix.match(
    /<p:par><p:cTn\b[^>]*\bpresetClass="[^"]*"[^>]*>(?:(?!<p:par>)[\s\S])*?<\/p:cTn><\/p:par>/g,
  )
  return (pars ?? []).filter((par) => par.includes(`<p:spTgt spid="${spid}"`))
}

describe('editing an animation beside an ink replay effect', () => {
  it('the reader lists the two shape effects, not the ink effect', () => {
    expect(getSlideAnimations(slideWithInkFirst())).toMatchObject([A1, A2])
  })

  for (const [label, index] of [
    ['first', 0],
    ['second', 1],
  ] as const) {
    it(`editing the ${label} listed effect changes that one and nothing else`, () => {
      const slide = slideWithInkFirst()
      const before = slide.bodySuffix
      const listed = getSlideAnimations(slide)
      const other = 1 - index
      const otherSpid = listed[other]!.spid
      const editedSpid = listed[index]!.spid

      const next = listed.map((a, i) => (i === index ? { ...a, durationMs: 2500 } : a))
      setSlideAnimations(slide, next)

      const after = slide.bodySuffix
      expect(XMLValidator.validate(`<p:sld xmlns:p="urn:p" xmlns:a="urn:a">${after}`)).toBe(true)
      // the ink effect keeps its bytes
      expect(after).toContain(INK)
      // the effect that was not edited keeps its bytes, and neither shape gained a second one
      expect(effectPars(after, otherSpid)).toEqual(effectPars(before, otherSpid))
      expect(effectPars(after, otherSpid)).toHaveLength(1)
      expect(effectPars(after, editedSpid)).toHaveLength(1)
      expect(effectPars(after, editedSpid)).not.toEqual(effectPars(before, editedSpid))
      expect(after.match(/\bpresetClass="/g)).toHaveLength(3)
      // and the reader sees the edit
      const read = getSlideAnimations(slide)
      expect(read).toHaveLength(2)
      expect(read[index]).toMatchObject({ spid: editedSpid, durationMs: 2500 })
      expect(read[other]).toMatchObject(listed[other]!)
    })
  }
})
