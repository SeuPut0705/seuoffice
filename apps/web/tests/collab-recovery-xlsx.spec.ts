/**
 * The co-editing recovery paths (collab.ts `recoveryTests`) on an XLSX in the sheets editor.
 * Cells are driven as collab-sheets.spec.ts drives them: jump with the name box, wait until the
 * cell editor holds the keyboard, type, Enter, and wait until the page reported its own edit.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type FrameLocator } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { countOwnEdits, openCoEdited, ownEdits, recoveryTests, type CoEditor } from './collab'

// small enough to open fully loaded, which co-editing needs
const BASIC = fileURLToPath(
  new URL('../../sheets/fixtures/generated/compatibility-basic.xlsx', import.meta.url),
)

test.setTimeout(240_000)

const nameBox = (frame: FrameLocator) => frame.locator('input.univer-appearance-none').first()

/** One person's places are the cells H2..H11, the other's I2..I11 */
const cellOf = (place: number): string => `${'HI'[Math.floor(place / 10)]}${(place % 10) + 2}`

async function select(editor: CoEditor, cell: string, timeout?: number): Promise<void> {
  await nameBox(editor.frame).fill(cell, { timeout })
  await nameBox(editor.frame).press('Enter', { timeout })
  // the box sometimes keeps focus after the jump; the grid takes keys once it lets go
  await nameBox(editor.frame).blur({ timeout })
}

/** Every cell's shown text (`=` and the formula for formula cells), sheet after sheet */
function cellsOf(bytes: Uint8Array): string {
  const parts = unzipSync(bytes)
  const text = (path: string) => (parts[path] ? strFromU8(parts[path]!) : '')
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''),
  )
  const shown: string[] = []
  for (const path of Object.keys(parts).filter((name) =>
    /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  )) {
    for (const cell of text(path).matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, attributes, body = ''] = cell
      const formula = /<f[^>]*>([^<]*)<\/f>/.exec(body)?.[1]
      const value = /<v>([^<]*)<\/v>/.exec(body)?.[1]
      const inline = /<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/.exec(body)?.[1]
      if (formula !== undefined) shown.push(`=${formula}`)
      else if (/t="s"/.test(attributes!) && value !== undefined) shown.push(strings[Number(value)]!)
      else if ((inline ?? value) !== undefined) shown.push((inline ?? value)!)
    }
  }
  return shown.join('\n')
}

recoveryTests({
  label: 'xlsx',
  file: async () => ({
    name: 'compatibility-basic.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: readFileSync(BASIC),
  }),
  async open(browser, file, documentId, user) {
    const editor = await openCoEdited(browser, file, { documentId, user, ready: 'canvas' })
    await expect(nameBox(editor.frame)).toBeVisible({ timeout: 20_000 })
    await countOwnEdits(editor)
    return editor
  },
  async write(editor, place, text) {
    // typing the same text into the same cell again changes nothing, so a retry is safe
    await expect(async () => {
      const before = await ownEdits(editor)
      await select(editor, cellOf(place))
      // Univer's in-cell editor: the element that takes the keys of a selected cell
      await expect(
        editor.frame.locator('[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]'),
      ).toBeFocused({ timeout: 2_000 })
      await editor.page.keyboard.type(text)
      await editor.page.keyboard.press('Enter')
      await expect.poll(() => ownEdits(editor), { timeout: 3_000 }).toBeGreaterThan(before)
    }).toPass({ timeout: 30_000 })
  },
  async tryWrite(editor, place, text) {
    await select(editor, cellOf(place), 3_000)
    await editor.page.keyboard.type(text)
    await editor.page.keyboard.press('Enter')
  },
  textOf: async (bytes) => cellsOf(bytes),
})
