/**
 * The conversion skeleton's extension points: block converters, inline
 * converters, run writers, injectors, containers and the safe defaults when
 * nothing is registered.
 */
import { parseDocx } from '@genoffice/docx-engine'
import { FULL_REGISTRY } from './helpers/full'
import { describe, expect, it } from 'vitest'
import { type BlockConverter, ConversionRegistry, blockSource } from '../src/core'
import { registerTextConverters } from '../src/text'
import { bodyOf, editOnly, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hPara, hParaWith, hRow, hCell, hTable } from './helpers/hancom-fragments'

const table = hTable('Table2', 1, [hRow([hCell(hPara('칸'))])])

describe('safe defaults', () => {
  // relies on tables having no converter
  it.skipIf(FULL_REGISTRY)(
    'blocks without a converter carry no OOXML and are written back verbatim around edits',
    async () => {
      const body = hPara('앞') + table + hPara('뒤') + '<!-- note -->'
      const bridge = await odtToBridge(await buildOdt({ body }))
      expect(bridge.map.blocks.map((b) => [b.name, b.owner, b.elements.length])).toEqual([
        ['text:p', 'text', 1],
        ['table:table', 'keep', 0],
        ['text:p', 'text', 1],
        ['#comment', 'keep', 0],
      ])
      expect(bridge.map.warnings).toContain('kept without conversion: table:table')
      const { bytes } = await editorSave(
        bridge.docx,
        editOnly({ 0: (g) => replaceText(g, 1, 1, '쪽'), 1: (g) => replaceText(g, 0, 0, '맨 ') }),
      )
      const wb = await writeBack(bridge, bytes)
      expect(bodyOf(wb.content)).toBe(hPara('앞쪽') + table + hPara('맨 뒤') + '<!-- note -->')
    },
  )

  it.skipIf(FULL_REGISTRY)('a deleted neighbour does not take a kept block with it', async () => {
    const body = hPara('앞') + table + hPara('뒤')
    const bridge = await odtToBridge(await buildOdt({ body }))
    const { bytes } = await editorSave(bridge.docx, () => [{ keep: 1 }])
    const wb = await writeBack(bridge, bytes)
    expect(bodyOf(wb.content)).toBe(table + hPara('뒤'))
  })

  it('sections without a converter are containers: children convert, the wrapper is kept', async () => {
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

describe('registered converters', () => {
  it('a block converter owns its block both ways', async () => {
    const calls: string[] = []
    const tables: BlockConverter = {
      id: 'table',
      match: (node) => node.kind === 'table',
      toOoxml(ctx, node) {
        ctx.ext('table', () => ({ tables: 0 }))
        ;(ctx.map.ext.table as { tables: number }).tables++
        return {
          elements: [
            {
              xml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
              kind: 'table',
            },
          ],
          data: { start: node.start },
        }
      },
      toOdf(rctx, block, items) {
        calls.push(`${block.name}:${items.length}:${items[0].unchanged}`)
        return blockSource(rctx, block).replace('칸', '바뀐 칸')
      },
      identify: (_rctx, item, candidates) =>
        item.blocks[0]?.type === 'table' && candidates.length ? candidates[0].id : null,
    }
    const registry = registerTextConverters(new ConversionRegistry()).addBlock(tables)
    const bridge = await odtToBridge(await buildOdt({ body: hPara('앞') + table }), registry)
    expect(bridge.map.ext.table).toEqual({ tables: 1 })
    expect(bridge.map.blocks[1]).toMatchObject({
      owner: 'table',
      data: { start: expect.any(Number) },
    })
    const parsed = await parseDocx(bridge.docx)
    expect(parsed.blocks.filter((b) => !b.hidden).map((b) => b.type)).toEqual([
      'paragraph',
      'table',
    ])

    // unchanged: copied verbatim, the converter is not asked
    const same = await editorSave(bridge.docx, editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }))
    let wb = await writeBack(bridge, same.bytes)
    expect(calls).toEqual([])
    expect(bodyOf(wb.content)).toBe(hPara('맨 앞') + table)

    // changed: an element the bridge never wrote is claimed through `identify`
    const changed = await editorSave(bridge.docx, () => [
      { keep: 0 },
      { xml: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>바뀐 칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' },
    ])
    wb = await writeBack(bridge, changed.bytes)
    expect(calls).toEqual(['table:table:1:false'])
    expect(bodyOf(wb.content)).toBe(hPara('앞') + table.replace('칸', '바뀐 칸'))
  })

  it('inline converters, run writers and injectors plug into paragraphs', async () => {
    const registry = registerTextConverters(new ConversionRegistry())
    registry.addInline({
      id: 'objects',
      names: ['draw:frame'],
      toOoxml: () => ({ kind: 'runs', runs: [{ text: '[그림]', bold: true }] }),
    })
    registry.addRunWriter({
      id: 'objects',
      match: (run) => run.text === '[그림]',
      toOdf: () => '<draw:frame draw:name="new"/>',
    })
    registry.addInjector({
      id: 'marks',
      inject: (_rctx, _para, env) => [
        { offset: env.text.length, xml: '<text:bookmark text:name="end"/>' },
      ],
    })
    const frame =
      '<draw:frame draw:name="old"><draw:image xlink:href="Pictures/a.png"/></draw:frame>'
    const bridge = await odtToBridge(await buildOdt({ body: hParaWith(`가${frame}나`) }), registry)
    const record = bridge.map.paragraphs[0]
    expect(record.text).toBe('가[그림]나')
    expect(record.markers).toMatchObject([
      { kind: 'handler', owner: 'objects', offset: 1, length: 4 },
    ])
    const parsed = await parseDocx(bridge.docx)
    expect(parsed.blocks[0].runs?.map((r) => [r.text, !!r.bold])).toEqual([
      ['가', false],
      ['[그림]', true],
      ['나', false],
    ])
    const { bytes } = await editorSave(bridge.docx, editOnly({ 0: (g) => (g.runs[2].text = '다') }))
    const wb = await writeBack(bridge, bytes)
    expect(bodyOf(wb.content)).toBe(
      '<text:p text:style-name="P1_0"><text:span text:style-name="T1">가<draw:frame draw:name="new"/>다<text:bookmark text:name="end"/></text:span></text:p>',
    )
  })
})
