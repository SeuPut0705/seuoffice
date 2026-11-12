import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx } from '@genoffice/docx-engine'
import { expect, test } from '@playwright/test'
import { hostSave, openCoEdited, settled, storedFile, typeAfter, type CoEditor } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const SIMPLE = resolve(repo, 'fixtures/generated/simple.docx')

// the fixture's two paragraphs: "first paragraph." / "second paragraph."
const FIRST = '\u7b2c\u4e00\u6bb5\u3002'
const SECOND = '\u7b2c\u4e8c\u6bb5\u3002'

test.setTimeout(180_000)

/** the status bar's Track Changes readout, which is also its switch */
const trackButton = (editor: CoEditor) => editor.frame.locator('.status-track')

/** the text `editor`'s page shows as tracked insertions */
const inserted = async (editor: CoEditor): Promise<string> =>
  (await editor.frame.locator('.ProseMirror .doc-ins').allInnerTexts()).join('')

/** whether the file `editor`'s host stores on a save says tracking is on */
async function savedTracking(editor: CoEditor): Promise<boolean> {
  expect(await hostSave(editor)).toBeNull()
  const file = await storedFile(editor)
  return (await parseDocx(new Uint8Array(file!.bytes))).trackRevisions === true
}

test('track changes switched by one person is on for everyone, in the file too, and no viewer switches it', async ({
  browser,
}) => {
  const documentId = `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const alice = await openCoEdited(browser, SIMPLE, { documentId, user: 'alice' })
  const bob = await openCoEdited(browser, SIMPLE, { documentId, user: 'bob' })
  await expect(trackButton(bob)).toHaveAttribute('aria-pressed', 'false')

  await trackButton(alice).click()
  await expect(trackButton(bob)).toHaveAttribute('aria-pressed', 'true')
  await typeAfter(bob, SECOND, ' bob-tracked')
  await settled([alice, bob])
  await expect.poll(() => inserted(bob)).toContain('bob-tracked')
  await expect.poll(() => inserted(alice)).toContain('bob-tracked')

  // someone who joins now, and someone who only views
  const carol = await openCoEdited(browser, SIMPLE, { documentId, user: 'carol' })
  await expect(trackButton(carol)).toHaveAttribute('aria-pressed', 'true')
  const viewer = await openCoEdited(browser, SIMPLE, { documentId, user: 'dave', access: 'view' })
  await expect(trackButton(viewer)).toHaveAttribute('aria-pressed', 'true')
  await expect(trackButton(viewer)).toBeDisabled()
  await viewer.frame.locator('.ProseMirror').first().click()
  await viewer.page.keyboard.press('ControlOrMeta+Shift+E')
  await viewer.page.waitForTimeout(1_000)
  await expect(trackButton(viewer)).toHaveAttribute('aria-pressed', 'true')
  await expect(trackButton(alice)).toHaveAttribute('aria-pressed', 'true')

  // whoever saves, the file says what the session says
  await settled([alice, bob, carol, viewer])
  expect(await savedTracking(bob)).toBe(true)
  await trackButton(carol).click()
  await expect(trackButton(alice)).toHaveAttribute('aria-pressed', 'false')
  await expect(trackButton(viewer)).toHaveAttribute('aria-pressed', 'false')
  await typeAfter(alice, FIRST, ' alice-plain')
  await settled([alice, bob, carol, viewer])
  expect(await inserted(alice)).not.toContain('alice-plain')
  expect(await savedTracking(alice)).toBe(false)
})
