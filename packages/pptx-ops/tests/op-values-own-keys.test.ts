/**
 * An op names a preset, a mode or a kind by a string the model wrote, and a run carries a font
 * name the deck wrote. Each is looked up among the table's own names: `constructor`,
 * `toString`, `__proto__` and the other names every object answers to are no entry. Before,
 * they passed validation as an entry of no properties and the op wrote what that gave.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  addElement,
  createBlankPptx,
  openPptx,
  type OpenedPptx,
  type Paragraph,
} from '@seuoffice/pptx-engine'
import { runTxn } from '../src/ops/executor'
import { applyEditParagraphs } from '../src/edit-text'
import '../src/ops/index'

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

let opened: OpenedPptx
let tableId: string
let ids: [string, string]

beforeEach(async () => {
  opened = await openPptx(await createBlankPptx())
  const r = runTxn(opened, {
    ops: [
      {
        op: 'addTable',
        target: { slide: 0 },
        rows: 2,
        cols: 2,
        offset: { x: 0, y: 2000000, cx: 1828800, cy: 914400 },
      },
    ],
  })
  expect(r.applied).toBe(true)
  const slide = opened.deck.slides[0]!
  tableId = slide.elements.find((el) => el.type === 'table')!.id
  const a = addElement(slide, { kind: 'rect', offset: { x: 0, y: 0, cx: 200000, cy: 100000 } })
  const b = addElement(slide, {
    kind: 'rect',
    offset: { x: 900000, y: 500000, cx: 200000, cy: 100000 },
  })
  ids = [a.id, b.id]
})

/** The op is refused with the guided error `message`, and the slide is as it was. */
function expectRefused(op: Record<string, unknown>, message: RegExp): void {
  const before = opened.archive.readText(opened.deck.slides[0]!.path)
  const r = runTxn(opened, { ops: [op as never] })
  expect(r.applied).toBe(false)
  expect(r.failures![0]!.error).toMatch(message)
  expect(opened.archive.readText(opened.deck.slides[0]!.path)).toBe(before)
}

describe.each(INHERITED)('the name "%s"', (name) => {
  it('is no table style preset', () => {
    expectRefused(
      { op: 'setTableStyle', target: { slide: 0, el: tableId }, styleName: name },
      /unknown styleName/,
    )
  })

  it('is no alignment mode', () => {
    expectRefused(
      { op: 'alignElements', target: { slide: 0 }, els: ids, mode: name },
      /needs "mode"/,
    )
  })

  it('is no connector kind', () => {
    expectRefused(
      { op: 'addConnector', target: { slide: 0 }, from: ids[0], to: ids[1], kind: name },
      /"kind" must be/,
    )
  })

  it('is no op with a usage line', () => {
    const r = runTxn(opened, { ops: [{ op: name } as never] })
    expect(r.applied).toBe(false)
    expect(r.failures![0]!.error).not.toMatch(/Usage:/)
  })

  it('as a font of the deck, edited only in case, is no font change', () => {
    const old: Paragraph[] = [
      { runs: [{ text: 'a', fontFamily: name, latinFont: name, fontImplicit: false }] } as never,
    ]
    const [edited] = applyEditParagraphs(old, [
      { srcPara: 0, runs: [{ text: 'a', fontFamily: name.toUpperCase() }] } as never,
    ])
    expect(edited!.runs[0]!.latinFont).toBe(name)
  })
})
