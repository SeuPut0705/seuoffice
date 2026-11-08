/**
 * Builds the small memo fixtures used by the built-app checks.
 *
 * The files hold one memo in the body, one in a table cell and one in a text
 * box, each with a different author. They are made with this app's engine, not
 * with Hancom Hangul: the Hancom-made HWP sample is `memo-source.hwp`, and a
 * Hancom-made HWPX sample is not available on this PC (see
 * `docs/tracking/status.md`).
 *
 * Run from the repository root:
 *   node apps/hwp/scripts/make-memo-fixtures.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import init, { HwpDocument } from '@rhwp/core'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')
const require = createRequire(import.meta.url)
const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
await init({ module_or_path: readFileSync(wasm) })

const doc = HwpDocument.createEmpty()
doc.createBlankDocument()
doc.insertText(0, 0, 0, '본문 메모 앵커')

// body paragraph 0 → an empty paragraph 1 for the table
doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0))
doc.pasteHtml(0, 1, 0, '<table><tr><td>표칸</td></tr></table>')

const box = JSON.parse(
  doc.createShapeControl(
    JSON.stringify({
      sectionIdx: 0,
      paraIdx: 0,
      charOffset: 8,
      width: 8000,
      height: 3000,
      shapeType: 'textbox',
      textWrap: 'Square',
    }),
  ),
)
doc.insertTextInCellByPath(
  0,
  0,
  JSON.stringify([{ controlIndex: box.controlIdx, cellIndex: 0, cellParaIndex: 0 }]),
  0,
  '상자 글',
)

const insert = (section, para, path, start, end, author, text) =>
  JSON.parse(
    doc.insertMemoByPath(section, para, path, start, end, JSON.stringify({ author, text })),
  )

insert(
  0,
  0,
  JSON.stringify([{ controlIndex: box.controlIdx, cellIndex: 0, cellParaIndex: 0 }]),
  0,
  2,
  '상자작성자',
  '글상자 메모입니다.',
)
insert(
  0,
  1,
  JSON.stringify([{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]),
  0,
  2,
  '표작성자',
  '표 칸 메모입니다.',
)
JSON.parse(
  doc.insertMemo(
    0,
    0,
    0,
    2,
    JSON.stringify({ author: '본문작성자', text: '본문 메모입니다.\n두 번째 문단입니다.' }),
  ),
)

const expected = JSON.parse(doc.getMemoList())
if (expected.length !== 3) throw new Error(`expected 3 memos, got ${expected.length}`)
if (
  expected
    .map((memo) => memo.place)
    .sort()
    .join(',') !== 'body,tableCell,textBox'
) {
  throw new Error(`unexpected places: ${expected.map((memo) => memo.place).join(',')}`)
}

for (const [name, bytes] of [
  ['memo.hwp', doc.exportHwp()],
  ['memo.hwpx', doc.exportHwpx()],
]) {
  const file = join(fixtures, name)
  writeFileSync(file, bytes)
  const reopened = new HwpDocument(new Uint8Array(readFileSync(file)))
  const memos = JSON.parse(reopened.getMemoList())
  if (memos.length !== 3) throw new Error(`${name}: expected 3 memos, got ${memos.length}`)
  console.log(
    `${name}: ${memos.map((memo) => `${memo.place}/${memo.author}/${JSON.stringify(memo.text)}`).join(' | ')}`,
  )
}
