/**
 * What the bridge does with blocks no converter handles: they carry no OOXML,
 * stay in place byte for byte around edits, and survive a deleted neighbour;
 * sections are containers whose children convert while the wrapper is kept.
 */
import { describe, expect, it } from 'vitest'
import { bodyOf, editOnly, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hPara } from './helpers/hancom-fragments'

const comment = '<!-- note -->'

describe('blocks without OOXML', () => {
  it('carry no OOXML and are written back verbatim around edits', async () => {
    const body = hPara('앞') + comment + hPara('뒤')
    const bridge = await odtToBridge(await buildOdt({ body }))
    expect(bridge.map.blocks.map((b) => [b.name, b.owner, b.elements.length])).toEqual([
      ['text:p', 'text', 1],
      ['#comment', 'keep', 0],
      ['text:p', 'text', 1],
    ])
    const { bytes } = await editorSave(
      bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 1, 1, '쪽'), 1: (g) => replaceText(g, 0, 0, '맨 ') }),
    )
    const wb = await writeBack(bridge, bytes)
    expect(bodyOf(wb.content)).toBe(hPara('앞쪽') + comment + hPara('맨 뒤'))
  })

  it('a deleted neighbour does not take a kept block with it', async () => {
    const body = hPara('앞') + comment + hPara('뒤')
    const bridge = await odtToBridge(await buildOdt({ body }))
    const { bytes } = await editorSave(bridge.docx, () => [{ keep: 1 }])
    const wb = await writeBack(bridge, bytes)
    expect(bodyOf(wb.content)).toBe(comment + hPara('뒤'))
  })
})

describe('sections', () => {
  it('are containers: children convert, the wrapper is kept', async () => {
    const section = `<text:section text:style-name="Sect1" text:name="S1">${hPara('구역 안')}${hPara('둘째')}</text:section>`
    const bridge = await odtToBridge(await buildOdt({ body: hPara('밖') + section }))
    expect(bridge.map.blocks.map((b) => [b.name, b.owner, b.parent])).toEqual([
      ['text:p', 'text', null],
      ['text:section', 'container', null],
      ['text:p', 'text', 1],
      ['text:p', 'text', 1],
    ])
    const { bytes } = await editorSave(
      bridge.docx,
      editOnly({ 2: (g) => replaceText(g, 0, 0, '바뀐 ') }),
    )
    const wb = await writeBack(bridge, bytes)
    expect(bodyOf(wb.content)).toBe(
      hPara('밖') +
        `<text:section text:style-name="Sect1" text:name="S1">${hPara('구역 안')}${hPara('바뀐 둘째')}</text:section>`,
    )
  })
})
