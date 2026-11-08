/**
 * Click-here fields that share an id: a form whose fields were copied and pasted. The
 * engine sets a field's value by id, which reaches only the first of them; each field is
 * to be filled where it stands. Fixture: three fields, the first two with the same id.
 * The table case builds its form with the engine and gives the second field the first's id.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { agentPlugin, type AgentPluginHost } from '../studio-plugin/agent-plugin.mjs'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const FIXTURE = join(__dirname, 'fixtures', 'duplicate-field-ids.hwpx')

interface EngineField {
  fieldId: number
  value: string
}

function openForm(bytes: Uint8Array = readFileSync(FIXTURE)) {
  let doc = new HwpDocument(new Uint8Array(bytes))
  const host = {
    read: (fn: (d: never) => unknown) => fn(doc as never),
    transaction: (_label: string, fn: (tx: never) => unknown) => {
      const before = doc.exportHwp()
      try {
        return fn({ doc: () => doc, deferPagination: () => {} } as never)
      } catch (thrown) {
        doc = new HwpDocument(before)
        throw thrown
      }
    },
    events: { on: () => {} },
    automation: { execute: () => null },
  } as unknown as AgentPluginHost
  const plugin = agentPlugin.activate(host)
  return {
    plugin,
    doc: () => doc,
    fields: () => JSON.parse(doc.getFieldList()) as EngineField[],
  }
}

describe('fields that share an id', () => {
  it('start out sharing it', () => {
    const ids = openForm()
      .fields()
      .map((field) => field.fieldId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('fills the field asked for, not the first of its namesakes', () => {
    const form = openForm()
    expect(form.plugin.fillField(2, '총무과')).toMatchObject({ ok: true })
    expect(form.plugin.listFields().map((field) => field.value)).toEqual(['', '총무과', ''])
    expect(form.plugin.fillField(1, '홍길동')).toMatchObject({ ok: true })
    expect(form.plugin.fillField(3, '010-0000-0000')).toMatchObject({ ok: true })
    expect(form.plugin.listFields().map((field) => field.value)).toEqual([
      '홍길동',
      '총무과',
      '010-0000-0000',
    ])
  })

  it('writes over a value already there', () => {
    const form = openForm()
    form.plugin.fillField(1, '홍길동')
    form.plugin.fillField(2, '총무과')
    expect(form.plugin.fillField(2, '기획과')).toMatchObject({ ok: true })
    expect(form.plugin.listFields().map((field) => field.value)).toEqual(['홍길동', '기획과', ''])
  })

  it('keeps each value through saving as HWP and as HWPX', () => {
    const form = openForm()
    form.plugin.fillField(1, '홍길동')
    form.plugin.fillField(2, '총무과')
    for (const bytes of [form.doc().exportHwp(), form.doc().exportHwpx()]) {
      expect(
        openForm(bytes)
          .fields()
          .map((field) => field.value),
      ).toEqual(['홍길동', '총무과', ''])
    }
  })
})

const GUIDE = '이곳을 마우스로 누르고 내용을 입력하세요.'
const cellPath = (cell: number) =>
  JSON.stringify([{ controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }])

/** 성명 [field] 소속 [field] in one table row, both fields carrying the same id. */
async function tableFormWithTwins(): Promise<Uint8Array> {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, '신청서')
  doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0))
  doc.pasteHtml(0, 1, 0, '<table><tr><td>성명</td><td></td><td>소속</td><td></td></tr></table>')
  doc.insertClickHereFieldByPath(0, 1, cellPath(1), 0, GUIDE, '', '', true)
  doc.insertClickHereFieldByPath(0, 1, cellPath(3), 0, GUIDE, '', '', true)
  const zip = await JSZip.loadAsync(doc.exportHwpx())
  const name = 'Contents/section0.xml'
  const xml = await zip.file(name)!.async('string')
  const [first, second] = [...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1]!)
  zip.file(
    name,
    xml
      .replace(`<hp:fieldBegin id="${second}"`, `<hp:fieldBegin id="${first}"`)
      .replace(`beginIDRef="${second}"`, `beginIDRef="${first}"`),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('table-cell fields that share an id', () => {
  it('fills each cell through its own field, and keeps both through saving', async () => {
    const form = openForm(await tableFormWithTwins())
    const ids = form.fields().map((field) => field.fieldId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(
      form.plugin.fillCells(
        1,
        [
          { row: 1, col: 2, text: '홍길동' },
          { row: 1, col: 4, text: '총무과' },
        ],
        false,
      ),
    ).toMatchObject({ ok: true })
    expect(form.plugin.listFields().map((field) => field.value)).toEqual(['홍길동', '총무과'])
    expect(form.plugin.fillField(1, '김철수')).toMatchObject({ ok: true })
    for (const bytes of [form.doc().exportHwp(), form.doc().exportHwpx()]) {
      expect(
        openForm(bytes)
          .fields()
          .map((field) => field.value),
      ).toEqual(['김철수', '총무과'])
    }
  })
})
