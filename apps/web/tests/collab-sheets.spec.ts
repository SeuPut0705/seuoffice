/**
 * Co-editing one XLSX in two real browser pages. Cells are driven the way the
 * save specs drive them (jump with the name box, type, Enter), and every
 * result is checked in the file the host stored, read back as a package.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type FrameLocator } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { openCoEdited, settled, type CoEditor, type CoFile } from './collab'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../sheets/fixtures/generated/${name}`, import.meta.url))
// small enough to open fully loaded, which co-editing needs
const BASIC = fixture('compatibility-basic.xlsx')

test.setTimeout(240_000)

const freshDocument = (): string => `book-${Date.now()}-${Math.random().toString(36).slice(2)}`

const nameBox = (frame: FrameLocator) => frame.locator('input.univer-appearance-none').first()

async function open(
  browser: Browser,
  documentId: string,
  user: string,
  access: 'edit' | 'view' = 'edit',
  file: CoFile = BASIC,
): Promise<CoEditor> {
  const editor = await openCoEdited(browser, file, { documentId, user, access, ready: 'canvas' })
  await expect(nameBox(editor.frame)).toBeVisible({ timeout: 20_000 })
  await countOwnEdits(editor)
  return editor
}

/**
 * Count the edits this page itself reported, from now on: each one raises its
 * unconfirmed count, which a change from someone else never does. The session
 * version cannot tell the two apart: it rises with everyone's edits.
 */
async function countOwnEdits(editor: CoEditor): Promise<void> {
  await editor.page.evaluate(() => {
    const launcher = window.seuLauncher!
    const counted = window as unknown as { ownEdits: number }
    counted.ownEdits = 0
    let status = launcher.collab
    Object.defineProperty(launcher, 'collab', {
      configurable: true,
      get: () => status,
      set(next: typeof status) {
        if (next && status && next.unconfirmed > status.unconfirmed) {
          counted.ownEdits += next.unconfirmed - status.unconfirmed
        }
        status = next
      },
    })
  })
}

const ownEdits = (editor: CoEditor): Promise<number> =>
  editor.page.evaluate(() => {
    const counted = window as unknown as { ownEdits: number }
    return counted.ownEdits
  })

/** Select `cell` through the name box, as a person does */
async function select(editor: CoEditor, cell: string): Promise<void> {
  await nameBox(editor.frame).fill(cell)
  await nameBox(editor.frame).press('Enter')
  // the box sometimes keeps focus after the jump; the grid takes keys once it lets go
  await nameBox(editor.frame).blur()
}

/**
 * Type `text` into `cell` and commit it. A page that just went live drops keys
 * until the grid's cell editor holds the keyboard, so the text is typed only
 * then, and the whole step is tried again until this page reported an edit of
 * its own.
 */
async function typeInto(editor: CoEditor, cell: string, text: string): Promise<void> {
  // typing the same text into the same cell again changes nothing, so a retry is safe
  await expect(async () => {
    const before = await ownEdits(editor)
    await select(editor, cell)
    // Univer's in-cell editor: the element that takes the keys of a selected cell
    await expect(
      editor.frame.locator('[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]'),
    ).toBeFocused({
      timeout: 2_000,
    })
    await editor.page.keyboard.type(text)
    await editor.page.keyboard.press('Enter')
    await expect.poll(() => ownEdits(editor), { timeout: 3_000 }).toBeGreaterThan(before)
  }).toPass({ timeout: 30_000 })
}

/** Insert one row above `row` (1-based): select a cell of that row, then the ribbon's insert-row button */
async function insertRowAbove(editor: CoEditor, row: number): Promise<void> {
  const before = await ownEdits(editor)
  await select(editor, `A${row}`)
  await editor.frame.getByRole('button', { name: '행 삽입', exact: true }).first().click()
  await expect.poll(() => ownEdits(editor), { timeout: 10_000 }).toBeGreaterThan(before)
}

/**
 * Hold (or release, in order) the frames the host page sends on its co-editing
 * socket: the page keeps editing and receiving, the server hears it later.
 */
async function holdOutgoing(editor: CoEditor, hold: boolean): Promise<void> {
  await editor.page.evaluate((hold) => {
    const w = window as unknown as {
      heldFrames?: [WebSocket, Parameters<WebSocket['send']>[0]][]
      holding?: boolean
      realSend?: WebSocket['send']
    }
    if (!w.realSend) {
      const real = WebSocket.prototype.send
      w.realSend = real
      w.heldFrames = []
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (w.holding) w.heldFrames!.push([this, data])
        else real.call(this, data)
      }
    }
    w.holding = hold
    if (!hold) for (const [socket, data] of w.heldFrames!.splice(0)) w.realSend!.call(socket, data)
  }, hold)
}

interface SavedBook {
  version: number | null
  /** sheet name → A1 → shown text (`=` and the formula for formula cells) */
  sheets: Map<string, Map<string, string>>
  /** a part of the package as text; empty when the package has none at `path` */
  part(path: string): string
}

const unescape = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

function readBook(bytes: Uint8Array): Map<string, Map<string, string>> {
  const parts = unzipSync(bytes)
  const text = (path: string) => (parts[path] ? strFromU8(parts[path]!) : '')
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''),
  )
  const rels = new Map(
    [
      ...text('xl/_rels/workbook.xml.rels').matchAll(
        /<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g,
      ),
    ].map((m) => [m[1]!, m[2]!.replace(/^\/?(xl\/)?/, 'xl/')]),
  )
  const sheets = new Map<string, Map<string, string>>()
  for (const sheet of text('xl/workbook.xml').matchAll(
    /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g,
  )) {
    const cells = new Map<string, string>()
    for (const c of text(rels.get(sheet[2]!) ?? '').matchAll(
      /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const [, ref, attributes, body = ''] = c
      const formula = /<f[^>]*>([^<]*)<\/f>/.exec(body)?.[1]
      const value = /<v>([^<]*)<\/v>/.exec(body)?.[1]
      const inline = /<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/.exec(body)?.[1]
      const shown =
        /t="s"/.test(attributes!) && value !== undefined
          ? strings[Number(value)]
          : (inline ?? value)
      if (formula !== undefined) cells.set(ref!, `=${unescape(formula)}`)
      else if (shown !== undefined) cells.set(ref!, unescape(shown))
    }
    sheets.set(sheet[1]!, cells)
  }
  return sheets
}

/** The file the host stored after `after` (a save count), read back as a package */
async function savedBook(editor: CoEditor, previous: SavedBook | null = null): Promise<SavedBook> {
  const read = () =>
    editor.page.evaluate(() => {
      const file = window.seuLauncher?.saved
      return file ? { version: file.version, bytes: Array.from(file.bytes) } : null
    })
  await expect
    .poll(async () => (await read())?.version ?? null, { timeout: 60_000 })
    .not.toBe(previous?.version ?? null)
  const saved = (await read())!
  const bytes = new Uint8Array(saved.bytes)
  const parts = unzipSync(bytes)
  return {
    version: saved.version,
    sheets: readBook(bytes),
    part: (path) => (parts[path] ? strFromU8(parts[path]!) : ''),
  }
}

const firstSheet = (book: SavedBook) => [...book.sheets.values()][0]!

test('two people edit one xlsx at once; saves hold one exact version with everyone’s cells', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')

  // different cells, at the same time
  await Promise.all([typeInto(alice, 'H2', 'alice-one'), typeInto(bob, 'I5', 'bob-one')])
  await settled([alice, bob])

  // the same cell, at the same time: the one the server took second wins on both pages
  await Promise.all([typeInto(alice, 'J3', 'A-two'), typeInto(bob, 'J3', 'B-two')])
  await settled([alice, bob])

  // one inserts a row above a cell the other types into, and above a formula's reference. Bob's
  // frames to the server are held meanwhile, so both edits are made at the same version
  await holdOutgoing(bob, true)
  await typeInto(bob, 'K8', 'below-the-insert')
  // I5 holds bob-one when bob types this
  await typeInto(bob, 'L1', '=I5&"!"')
  await insertRowAbove(alice, 4)
  await settled([alice])
  await expect.poll(async () => (await bob.status()).version).toBe((await alice.status()).version)
  await holdOutgoing(bob, false)
  await settled([alice, bob])

  // a late joiner and a viewer catch up; the viewer cannot type
  const carol = await open(browser, documentId, 'carol')
  const viewer = await open(browser, documentId, 'dave', 'view')
  expect((await viewer.status()).canEdit).toBe(false)
  await select(viewer, 'M1')
  await viewer.page.keyboard.type('dave-typed')
  await viewer.page.keyboard.press('Enter')
  await viewer.page.waitForTimeout(1_000)
  const version = await settled([alice, bob, carol, viewer])

  // the host's save: one exact version, read back from the package
  await alice.page.locator('#save').click()
  const first = await savedBook(alice)
  expect(first.version).toBe(version)
  const cells = firstSheet(first)
  const shown = JSON.stringify([...cells])
  expect(cells.get('H2'), shown).toBe('alice-one')
  // row 5 moved to row 6 with alice's insert above row 4
  expect(cells.get('I6'), shown).toBe('bob-one')
  expect(['A-two', 'B-two']).toContain(cells.get('J3'))
  expect(cells.get('K9')).toBe('below-the-insert')
  expect(cells.get('L1')).toBe('=I6&"!"')
  expect([...cells.values()]).not.toContain('dave-typed')
  await expect.poll(async () => (await bob.status()).saved).toBe(version)

  // carol's Ctrl+S of the same version is the same workbook
  await select(carol, 'A1')
  await carol.page.keyboard.press('ControlOrMeta+s')
  const carolSaved = await savedBook(carol)
  expect(carolSaved.version).toBe(version)
  expect([...firstSheet(carolSaved)].sort()).toEqual([...cells].sort())

  // both keep editing after the save, and a second save holds the later edits too
  await Promise.all([typeInto(alice, 'H10', 'after-save-a'), typeInto(bob, 'H11', 'after-save-b')])
  const later = await settled([alice, bob, carol, viewer])
  expect(later).toBeGreaterThan(version)
  await bob.page.locator('#save').click()
  const second = await savedBook(bob)
  expect(second.version).toBe(later)
  const after = firstSheet(second)
  expect(after.get('H10')).toBe('after-save-a')
  expect(after.get('H11')).toBe('after-save-b')
  // bob's page reverted and replayed its edits around alice's insert; its file still holds every
  // earlier cell exactly where the first save had it
  for (const [ref, text] of cells) expect(after.get(ref), ref).toBe(text)
})

/**
 * The edit fixture with what a revert written into the file would get wrong:
 * A1's cell format is bold and unlocked (the lock flag lives only in the file),
 * and C4:D4 is merged.
 */
function styledAndMerged(): CoFile {
  const parts = unzipSync(readFileSync(fixture('compatibility-edit.xlsx')))
  const replace = (path: string, from: string, to: string): void => {
    const text = strFromU8(parts[path]!)
    if (!text.includes(from)) throw new Error(`${path} has no ${from}`)
    parts[path] = strToU8(text.replace(from, to))
  }
  replace(
    'xl/styles.xml',
    '<xf fontId="1" applyFont="1"/>',
    '<xf fontId="1" applyFont="1" applyProtection="1"><protection locked="0"/></xf>',
  )
  replace(
    'xl/worksheets/sheet1.xml',
    '</sheetData>',
    '</sheetData><mergeCells count="1"><mergeCell ref="C4:D4"/></mergeCells>',
  )
  return {
    name: 'styled-and-merged.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(zipSync(parts)),
  }
}

test('a page that took its own edits back around someone else’s change saves the file the others save', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const file = styledAndMerged()
  const alice = await open(browser, documentId, 'alice', 'edit', file)
  const bob = await open(browser, documentId, 'bob', 'edit', file)

  // alice's edits stay unconfirmed: a formatted cell typed over, and a row inserted above the merge
  await holdOutgoing(alice, true)
  await typeInto(alice, 'A1', 'typed-over')
  await insertRowAbove(alice, 3)
  // bob's edit is confirmed first: alice's page takes both of hers back, applies his, replays hers
  await typeInto(bob, 'F1', 'from-bob')
  await settled([bob])
  await expect.poll(async () => (await alice.status()).version).toBe((await bob.status()).version)
  await holdOutgoing(alice, false)
  const version = await settled([alice, bob])

  await alice.page.locator('#save').click()
  const hers = await savedBook(alice)
  expect(hers.version).toBe(version)
  await bob.page.locator('#save').click()
  const his = await savedBook(bob)
  expect(his.version).toBe(version)

  const sheet = hers.part('xl/worksheets/sheet1.xml')
  expect(firstSheet(hers).get('A1'), sheet).toBe('typed-over')
  expect(firstSheet(hers).get('F1'), sheet).toBe('from-bob')
  // the typed-over cell still has the file's own format (bold, unlocked): a revert written into
  // the file would have reset the cell first
  const styles = hers.part('xl/styles.xml')
  const formats = Array.from(
    /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/
      .exec(styles)![1]!
      .matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g),
    (xf) => xf[0],
  )
  const format = formats[Number(/<c r="A1"[^>]*\bs="(\d+)"/.exec(sheet)?.[1])]
  expect(format, styles).toContain('fontId="1"')
  expect(format, styles).toContain('<protection locked="0"/>')
  // the merge moved down with the inserted row and is in the file once
  expect(sheet.match(/<mergeCell [^>]*>/g)).toEqual(['<mergeCell ref="C5:D5"/>'])
  // the defined name the insert touched is written too, after the rows moved
  expect(hers.part('xl/workbook.xml')).toContain('<definedName name="Total">')
  // and it is the file bob's page writes for the same version
  expect(sheet).toBe(his.part('xl/worksheets/sheet1.xml'))
  expect(styles).toBe(his.part('xl/styles.xml'))
  expect(hers.part('xl/workbook.xml')).toBe(his.part('xl/workbook.xml'))
  // nobody's page was thrown out for showing something else than the others
  expect((await alice.status()).phase).toBe('live')
  expect((await bob.status()).phase).toBe('live')
})

/** The Insert tab's link button: an edit the renderer journals itself, outside Univer's commands */
async function openLinkDialog(frame: FrameLocator): Promise<void> {
  await frame
    .getByRole('tab', { name: '삽입' })
    .or(frame.getByText('삽입', { exact: true }))
    .first()
    .click()
  await frame.getByRole('button', { name: /링크/ }).first().click()
}

test('an edit only one page’s journal would hold is refused while co-editing and works without it', async ({
  browser,
  page,
}) => {
  // co-editing: the link dialog stays shut, the page says why, and nothing was edited
  const alice = await open(browser, freshDocument(), 'alice')
  await select(alice, 'B2')
  await openLinkDialog(alice.frame)
  await expect(alice.frame.locator('.app-toast.error')).toContainText(
    '함께 편집하는 동안에는 이 편집을 할 수 없습니다.',
  )
  await expect(alice.frame.getByRole('dialog', { name: '링크 삽입' })).toHaveCount(0)
  expect(await ownEdits(alice)).toBe(0)
  expect((await alice.status()).version).toBe(0)

  // the same workbook opened by one person alone: the link is set and the page has an edit to save
  await page.goto('/')
  await page.locator('#edit').setChecked(true)
  await page.setInputFiles('#file', BASIC)
  const frame = page.frameLocator('#viewer iframe')
  await expect(nameBox(frame)).toBeVisible({ timeout: 20_000 })
  await expect(frame.locator('footer.status-bar')).toContainText('모두 로드', { timeout: 20_000 })
  await openLinkDialog(frame)
  const address = frame.getByRole('dialog', { name: '링크 삽입' }).getByRole('textbox')
  await address.fill('https://example.com/')
  await address.press('Enter')
  await expect(page.locator('#status')).toContainText('저장 안 함')
  await expect(frame.locator('.app-toast.error')).toHaveCount(0)
})

const QUIET: Array<{ label: string; file: string }> = [
  { label: 'a plain workbook', file: BASIC },
  { label: 'formulas and edits', file: fixture('compatibility-edit.xlsx') },
  { label: 'several sheets', file: fixture('compatibility-sheets.xlsx') },
  { label: 'merged cells and structure', file: fixture('compatibility-structure.xlsx') },
  { label: 'the kitchen sink', file: fixture('compatibility-kitchen-sink.xlsx') },
]

for (const { label, file } of QUIET) {
  test(`two pages on ${label} write nothing of their own`, async ({ browser }) => {
    const documentId = `quiet-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const alice = await open(browser, documentId, 'alice', 'edit', file)
    const bob = await open(browser, documentId, 'bob', 'edit', file)
    // recalculation, autofit and fonts settle in this time; whatever they write must stay local
    await alice.page.waitForTimeout(5_000)
    expect(await settled([alice, bob])).toBe(0)
    // selecting cells writes nothing either
    await select(alice, 'C3')
    await select(bob, 'B2')
    await alice.page.waitForTimeout(2_000)
    expect(await settled([alice, bob])).toBe(0)
    await alice.page.context().close()
    await bob.page.context().close()
  })
}
