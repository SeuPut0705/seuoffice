/**
 * What a co-editing page takes from the wire. A peer's change is JSON from a page that may run
 * other code than this one: `decodeOp` throws on anything the app itself never sends, and the
 * engine then stops this page's session instead of applying the change.
 */
import { describe, expect, it } from 'vitest'
import type { EditParagraph } from '@seuoffice/pptx-ops'
import { GONE, WIRE_LIMITS, decodeOp, encodeOp, unshareable } from '../src/web/collab-wire'

const AT = { slide: 's_1', el: 'e_1a2b3c4d' }
const para = (
  text: string,
  run: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
) => ({
  runs: [{ text, ...run }],
  ...more,
})
const textOp = (paragraphs: unknown, at: unknown = AT, more: Record<string, unknown> = {}) => ({
  id: 'op-1',
  edit: { kind: 'text', at, paragraphs, ...more },
})
const withRun = (run: Record<string, unknown>) => textOp([para('x', run)])
const withPara = (more: Record<string, unknown>) => textOp([para('x', {}, more)])

describe('what the app itself sends is taken', () => {
  it.each([
    ['plain text', textOp([para('hello')])],
    ['text in a group', textOp([para('hello')], { ...AT, el: 'e_12', group: 'e_0f0f0f0f' })],
    [
      'a run as the text editor reads it back',
      withRun({
        bold: true,
        italic: false,
        underline: false,
        strike: false,
        baseline: 30,
        fontSize: 18.5,
        fontFamily: 'Malgun Gothic',
        color: '#FF8800',
        highlight: null,
        letterSpacing: 1.5,
        srcRun: 0,
        redact: null,
        link: null,
      }),
    ],
    ['a highlighted, withheld run', withRun({ highlight: '#FFFF00', redact: 'client name' })],
    ['a field run', withRun({ field: 'slidenum' })],
    ['an outlined run', withRun({ outline: { color: '#000000', widthEmu: 12700 } })],
    ['a link to a web page', withRun({ link: { kind: 'url', url: 'https://example.com/a?b=c' } })],
    ['a link to a mail address', withRun({ link: { kind: 'url', url: 'mailto:a@example.com' } })],
    ['a link to a slide', withRun({ link: { kind: 'slide', slideIndex: 3 } })],
    ['a link that ends the show', withRun({ link: { kind: 'action', action: 'endshow' } })],
    [
      'a paragraph with its format',
      withPara({
        align: 'center',
        level: 2,
        srcPara: 1,
        bullet: 'number',
        numType: 'arabicPeriod',
        startAt: 3,
        lineSpacingPct: 120,
        spaceBeforePt: 6,
        spaceAfterPt: 0,
        rtl: false,
      }),
    ],
    ['a character bullet', withPara({ bullet: 'char', bulletChar: '•', bulletFont: 'Arial' })],
    [
      'a picture bullet',
      withPara({ bullet: 'blip', bulletImage: { base64: 'iVBORw0KGgoAAAANSUhEUg==', ext: 'png' } }),
    ],
    ['an empty box', textOp([{ runs: [{ text: '' }] }])],
    [
      'a box that grew',
      textOp([para('x')], AT, {
        autofit: { offset: { x: 457200, y: 1100000, cx: 3600000, cy: 365760 } },
      }),
    ],
    [
      'a box that shrank its text',
      textOp([para('x')], AT, { autofit: { fontScale: 0.9, lnSpcReduction: 0.1 } }),
    ],
    [
      'a copied slide',
      { id: 'o', edit: { kind: 'duplicateSlide', slide: 's_2', clearText: false, made: 's_7' } },
    ],
    [
      'a new slide',
      { id: 'o', edit: { kind: 'blankSlide', slide: 's_2', before: true, made: 's_7' } },
    ],
    ['deleted slides', { id: 'o', edit: { kind: 'deleteSlides', slides: ['s_2', 's_3'] } }],
    ['notes', { id: 'o', edit: { kind: 'notes', slide: 's_2', text: 'say hello\nthen go on' } }],
    [
      'an edit a peer’s delete emptied',
      { id: 'o', edit: { kind: 'notes', slide: GONE, text: 'x' } },
    ],
    [
      'a slide whose part is not numbered',
      { id: 'o', edit: { kind: 'notes', slide: 's_ppt_slides_intro_xml', text: '' } },
    ],
  ])('%s', (_name, op) => {
    expect(decodeOp(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('an edit reads the same after the wire', () => {
    const op = {
      id: 'o',
      edit: { kind: 'text' as const, at: AT, paragraphs: [para('x')] as EditParagraph[] },
    }
    expect(decodeOp(encodeOp(op))).toEqual(op)
  })
})

describe('ids are the names every page gives, nothing else', () => {
  it.each([
    ['a part path for a slide', textOp([para('x')], { slide: 'ppt/slides/slide1.xml', el: 'e_1' })],
    [
      'a master or layout part',
      textOp([para('x')], { slide: '../slideMasters/slideMaster1.xml', el: 'e_1' }),
    ],
    ['a position for a slide', textOp([para('x')], { slide: 0, el: 'e_1' })],
    ['an id a page made while parsing', textOp([para('x')], { slide: 's_1', el: 'sp_1a' })],
    [
      'an element id with something after it',
      textOp([para('x')], { slide: 's_1', el: 'e_12/../x' }),
    ],
    ['a group that is not an element id', textOp([para('x')], { ...AT, group: 'grp_3' })],
    [
      'a target with a part',
      textOp([para('x')], { ...AT, part: 'ppt/slideLayouts/slideLayout1.xml' }),
    ],
    [
      'a slide to copy that is a path',
      {
        id: 'o',
        edit: {
          kind: 'duplicateSlide',
          slide: 'ppt/slides/slide1.xml',
          clearText: false,
          made: 's_7',
        },
      },
    ],
    [
      'a made slide that is a path',
      {
        id: 'o',
        edit: { kind: 'blankSlide', slide: 's_1', before: false, made: 'ppt/slides/slide9.xml' },
      },
    ],
    [
      'a made slide that is no slide',
      { id: 'o', edit: { kind: 'blankSlide', slide: 's_1', before: false, made: GONE } },
    ],
    [
      'a deleted slide that is a path',
      { id: 'o', edit: { kind: 'deleteSlides', slides: ['s_1', 'ppt/slides/slide2.xml'] } },
    ],
    [
      'notes of a part',
      { id: 'o', edit: { kind: 'notes', slide: 'ppt/notesSlides/notesSlide1.xml', text: 'x' } },
    ],
    [
      'an op id that is not a short text',
      { id: 'x'.repeat(500), edit: { kind: 'notes', slide: 's_1', text: '' } },
    ],
  ])('%s', (_name, op) => {
    expect(() => decodeOp(op)).toThrow()
  })
})

describe('only the edits and the fields the app writes', () => {
  it.each([
    ['an edit of an unknown kind', { id: 'o', edit: { kind: 'setFill', at: AT, fill: '#FF0000' } }],
    [
      'an op with something beside its edit',
      { id: 'o', edit: { kind: 'notes', slide: 's_1', text: '' }, as: 'admin' },
    ],
    [
      'an edit with a field the app does not write',
      { id: 'o', edit: { kind: 'notes', slide: 's_1', text: '', html: '<b>x</b>' } },
    ],
    ['a run with a field the app does not write', withRun({ onclick: 'x' })],
    ['a paragraph with a field the app does not write', withPara({ xml: '<a:p/>' })],
    ['a run without text', textOp([{ runs: [{ bold: true }] }])],
    ['a colour that is not a hex colour', withRun({ color: 'red" /><a:evil x="' })],
    ['a highlight that is not a hex colour', withRun({ highlight: 'url(x)' })],
    ['a font name with markup in it', withRun({ fontFamily: 'Arial"/><a:latin typeface="x' })],
    ['a font name with a control character', withRun({ fontFamily: 'Ari\u0000al' })],
    ['a font size that is not a number', withRun({ fontSize: '18' })],
    ['a font size no text has', withRun({ fontSize: 1e9 })],
    ['a field of an unknown shape', withRun({ field: 'slidenum" type="x' })],
    [
      'a numbering scheme of an unknown shape',
      withPara({ bullet: 'number', numType: 'arabic" x="' }),
    ],
    ['a bullet of an unknown kind', withPara({ bullet: 'script' })],
    ['a level a deck does not have', withPara({ level: 12 })],
    ['an alignment the editor does not set', withPara({ align: 'distributed' })],
    [
      'a picture bullet that is not base64',
      withPara({ bullet: 'blip', bulletImage: { base64: '<svg onload=x>', ext: 'png' } }),
    ],
    [
      'a picture bullet with a path for its type',
      withPara({ bullet: 'blip', bulletImage: { base64: 'AAAA', ext: '../../x' } }),
    ],
    [
      'an autofit size that is not a number',
      textOp([para('x')], AT, { autofit: { offset: { x: 0, y: 0, cx: 'wide', cy: 1 } } }),
    ],
    [
      'an autofit with a field the app does not write',
      textOp([para('x')], AT, { autofit: { rotate: 90 } }),
    ],
    ['a slide deletion of nothing', { id: 'o', edit: { kind: 'deleteSlides', slides: [] } }],
  ])('%s', (_name, op) => {
    expect(() => decodeOp(op)).toThrow()
  })
})

describe('a link on a run', () => {
  // which addresses a box may link to takes the deck the edit lands on: collab-slides.test.ts
  it.each(['tel:+82-2-0000-0000', '../docs/plan.docx', 'ftp://example.com/x'])(
    'an address a file may already hold is read: %s',
    (url) => {
      const op = withRun({ link: { kind: 'url', url } })
      expect(decodeOp(op)).toEqual(op)
    },
  )

  it.each([
    ['a link of an unknown kind', { kind: 'macro', name: 'x' }],
    ['a show action the app does not have', { kind: 'action', action: 'runprogram' }],
    ['a slide that is not a position', { kind: 'slide', slideIndex: -1 }],
    [
      'a slide link with an address as well',
      { kind: 'slide', slideIndex: 1, url: 'https://example.com' },
    ],
    [
      'an address longer than any real one',
      { kind: 'url', url: `https://example.com/${'a'.repeat(WIRE_LIMITS.url)}` },
    ],
    ['an address with a control character', { kind: 'url', url: 'https://example.com/\u0000' }],
    ['an empty address', { kind: 'url', url: '' }],
    ['an address that is not text', { kind: 'url', url: 7 }],
  ])('%s is not taken', (_name, link) => {
    expect(() => decodeOp(withRun({ link }))).toThrow()
  })
})

describe('one change cannot be made large enough to hang a page', () => {
  const long = (chars: number): string => 'x'.repeat(chars)

  it('more text than a text box holds', () => {
    expect(() => decodeOp(textOp([para(long(WIRE_LIMITS.text + 1))]))).toThrow()
  })

  it('text spread over runs and paragraphs counts together', () => {
    const paragraphs = Array.from({ length: 20 }, () => ({
      runs: Array.from({ length: 20 }, () => ({ text: long(WIRE_LIMITS.text / 300) })),
    }))
    expect(() => decodeOp(textOp(paragraphs))).toThrow()
  })

  it('more paragraphs than a text box holds', () => {
    const paragraphs = Array.from({ length: WIRE_LIMITS.paragraphs + 1 }, () => para(''))
    expect(() => decodeOp(textOp(paragraphs))).toThrow()
  })

  it('more runs than a paragraph holds', () => {
    const runs = Array.from({ length: WIRE_LIMITS.runs + 1 }, () => ({ text: 'x' }))
    expect(() => decodeOp(textOp([{ runs }]))).toThrow()
  })

  it('notes longer than notes are', () => {
    expect(() =>
      decodeOp({
        id: 'o',
        edit: { kind: 'notes', slide: 's_1', text: long(WIRE_LIMITS.text + 1) },
      }),
    ).toThrow()
  })

  it('more slides deleted than a deck has', () => {
    const slides = Array.from({ length: WIRE_LIMITS.slides + 1 }, (_, i) => `s_${i + 1}`)
    expect(() => decodeOp({ id: 'o', edit: { kind: 'deleteSlides', slides } })).toThrow()
  })

  it('a picture bullet larger than a bullet is', () => {
    const base64 = 'A'.repeat(WIRE_LIMITS.bulletImage + 4)
    expect(() =>
      decodeOp(withPara({ bullet: 'blip', bulletImage: { base64, ext: 'png' } })),
    ).toThrow()
  })

  it('a font name, a bullet or a label longer than the app makes', () => {
    expect(() => decodeOp(withRun({ fontFamily: long(1000) }))).toThrow()
    expect(() => decodeOp(withRun({ redact: long(5000) }))).toThrow()
    expect(() => decodeOp(withPara({ bullet: 'char', bulletChar: long(100) }))).toThrow()
  })
})

describe('why a person’s own edit would not be taken', () => {
  const text = (paragraphs: unknown) =>
    ({ kind: 'text', at: AT, paragraphs }) as Parameters<typeof unshareable>[0]

  it('nothing, for what the app sends', () => {
    expect(
      unshareable(text([para('hello', { link: { kind: 'url', url: 'https://example.com' } })])),
    ).toBeNull()
    expect(unshareable({ kind: 'notes', slide: 's_1', text: 'hello' })).toBeNull()
  })

  it('its length', () => {
    expect(unshareable(text([para('x'.repeat(WIRE_LIMITS.text + 1))]))).toBe('size')
    expect(
      unshareable({ kind: 'notes', slide: 's_1', text: 'x'.repeat(WIRE_LIMITS.text + 1) }),
    ).toBe('size')
  })
})
