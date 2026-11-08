/**
 * A text box drawn in the editor and saved as .hwp (rhwp patch 0019, upstream #8172).
 * Hangul 2024 refuses an .hwp whose text box lacks the text-box bit in the shape
 * component's storage word, and refuses a plain shape that has it. This reads the saved
 * records and checks the bit against whether the shape holds a text box.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { LIST_HEADER, openHwp, recordsOf, SECTION, streamOf } from '../src/main/hwp5-file'

const require = createRequire(import.meta.url)
const SHAPE_COMPONENT = 76
/** Offset of the storage word after the two control ids, offsets, sizes and versions. */
const STORAGE_WORD = 36
const TEXT_BOX_BIT = 0x0100_0000

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

interface Placed {
  paraIdx: number
  controlIdx: number
}

function withShapes(kinds: string[], placed: Placed[] = []): HwpDocument {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  kinds.forEach((shapeType, i) => {
    const made = doc.createShapeControl(
      JSON.stringify({
        sectionIdx: 0,
        paraIdx: 0,
        charOffset: 0,
        width: 17008,
        height: 5669,
        horzOffset: i * 20000,
        vertOffset: 2000,
        treatAsChar: false,
        textWrap: 'TopAndBottom',
        shapeType,
      }),
    )
    const result = JSON.parse(made)
    expect(result).toMatchObject({ ok: true })
    placed.push(result)
  })
  return doc
}

/** Each saved shape component: whether a text box (list header) hangs under it, and its storage word. */
function savedShapes(hwp: Uint8Array): { textBox: boolean; word: number }[] {
  const opened = openHwp(hwp)
  if (!opened) throw new Error('not an HWP 5 file')
  const data = streamOf(opened, SECTION(0))
  const records = data && recordsOf(data)
  if (!records) throw new Error('unreadable section')
  return records.flatMap((record, i) => {
    if (record.tag !== SHAPE_COMPONENT) return []
    let textBox = false
    for (let j = i + 1; j < records.length && records[j].level > record.level; j++) {
      if (records[j].tag === LIST_HEADER) textBox = true
    }
    return [{ textBox, word: data.readUInt32LE(record.body + STORAGE_WORD) }]
  })
}

function expectBitMatchesTextBox(shapes: { textBox: boolean; word: number }[]): void {
  for (const { textBox, word } of shapes) {
    expect((word & TEXT_BOX_BIT) !== 0).toBe(textBox)
  }
}

describe('text box storage bit in .hwp', () => {
  it('is set on a drawn text box and not on a plain rectangle', () => {
    const shapes = savedShapes(withShapes(['rectangle', 'textbox']).exportHwp())
    expect(shapes.map((shape) => shape.textBox).sort()).toEqual([false, true])
    expectBitMatchesTextBox(shapes)
  })

  it('follows a text box attached to and detached from a shape', () => {
    const placed: Placed[] = []
    const doc = withShapes(['rectangle'], placed)
    const { paraIdx, controlIdx } = placed[0]
    expect(JSON.parse(doc.setTextBoxAt(paraIdx, controlIdx, true))).toMatchObject({ ok: true })
    const attached = savedShapes(doc.exportHwp())
    expect(attached.map((shape) => shape.textBox)).toEqual([true])
    expectBitMatchesTextBox(attached)

    expect(JSON.parse(doc.setTextBoxAt(paraIdx, controlIdx, false))).toMatchObject({ ok: true })
    const detached = savedShapes(doc.exportHwp())
    expect(detached.map((shape) => shape.textBox)).toEqual([false])
    expectBitMatchesTextBox(detached)
  })

  it('stays set after the saved file is opened and saved again', () => {
    const reopened = new HwpDocument(withShapes(['textbox']).exportHwp())
    const shapes = savedShapes(reopened.exportHwp())
    expect(shapes.map((shape) => shape.textBox)).toEqual([true])
    expectBitMatchesTextBox(shapes)
  })
})
