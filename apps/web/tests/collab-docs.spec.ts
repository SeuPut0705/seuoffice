import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx } from '@seuoffice/docx-engine'
import { expect, test } from '@playwright/test'
import { openCoEdited, settled, typeAfter, type CoEditor } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const SIMPLE = resolve(repo, 'fixtures/generated/simple.docx')

// the fixture's two paragraphs: "first paragraph." / "second paragraph."
const FIRST = '\u7b2c\u4e00\u6bb5\u3002'
const SECOND = '\u7b2c\u4e8c\u6bb5\u3002'

test.setTimeout(180_000)

/** a document id no earlier test used: the server keeps its sessions for the whole run */
const freshDocument = (): string => `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Whether `text` is `a` and `b` mixed: every character of both, each one's own in the order it
 * was typed. Two people typing at one spot may alternate letter by letter (a cursor steps past
 * what arrives exactly at it), so their words need not stay whole; nothing is lost or doubled.
 */
function isMixOf(text: string, a: string, b: string): boolean {
  if (text.length !== a.length + b.length) return false
  // reach[j]: the first i + j characters of text are the first i of a mixed with the first j of b
  let reach = Array.from({ length: b.length + 1 }, (_, j) => text.slice(0, j) === b.slice(0, j))
  for (let i = 1; i <= a.length; i++) {
    const next: boolean[] = []
    for (let j = 0; j <= b.length; j++) {
      const char = text[i + j - 1]
      next[j] = (reach[j] && char === a[i - 1]) || (j > 0 && next[j - 1] && char === b[j - 1])
    }
    reach = next
  }
  return reach[b.length]
}

/** what follows bob's first words in the second paragraph, in `text` */
const afterBobOne = (text: string): string =>
  (text.split(`${SECOND} bob-one`)[1] ?? '').split('\n')[0]

/** the file the host stored last, once there is one */
async function savedTexts(editor: CoEditor): Promise<{ version: number | null; texts: string[] }> {
  const read = () =>
    editor.page.evaluate(() => {
      const file = window.seuLauncher?.saved
      return file ? { version: file.version, bytes: Array.from(file.bytes) } : null
    })
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull()
  const saved = await read()
  const parsed = await parseDocx(new Uint8Array(saved!.bytes))
  return {
    version: saved!.version,
    texts: parsed.blocks.map((block) => (block.runs ?? []).map((run) => run.text).join('')),
  }
}

test('two people edit one docx at once, a late joiner and a viewer follow, a save holds both', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await openCoEdited(browser, SIMPLE, { documentId, user: 'alice' })
  const bob = await openCoEdited(browser, SIMPLE, { documentId, user: 'bob' })

  // different places, at the same time
  await Promise.all([typeAfter(alice, FIRST, ' alice-one'), typeAfter(bob, SECOND, ' bob-one')])
  await settled([alice, bob])
  for (const editor of [alice, bob]) {
    await expect.poll(() => editor.text()).toContain(`${FIRST} alice-one`)
    await expect.poll(() => editor.text()).toContain(`${SECOND} bob-one`)
  }

  // the same place, at the same time
  await Promise.all([typeAfter(alice, SECOND, ' A-two'), typeAfter(bob, SECOND, ' B-two')])
  await settled([alice, bob])
  const shown = await alice.text()
  expect(await bob.text()).toBe(shown)
  expect(isMixOf(afterBobOne(shown), ' A-two', ' B-two'), shown).toBe(true)

  // nothing keeps writing once the people stop: no edit bounces between the pages
  const quiet = await settled([alice, bob])
  await alice.page.waitForTimeout(3_000)
  expect(await settled([alice, bob])).toBe(quiet)

  const carol = await openCoEdited(browser, SIMPLE, { documentId, user: 'carol' })
  await settled([alice, bob, carol])
  expect(await carol.text()).toBe(shown)

  const viewer = await openCoEdited(browser, SIMPLE, { documentId, user: 'dave', access: 'view' })
  expect((await viewer.status()).canEdit).toBe(false)
  await expect(viewer.frame.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')
  await typeAfter(alice, FIRST, ' alice-three')
  await settled([alice, bob, carol, viewer])
  await expect.poll(() => viewer.text()).toContain(' alice-three')
  await typeAfter(viewer, FIRST, ' dave-typed')
  await viewer.page.waitForTimeout(1_000)
  expect(await viewer.text()).not.toContain('dave-typed')
  expect(await alice.text()).not.toContain('dave-typed')

  // the host's save: the file of one version, which reopens with everyone's text
  const version = await settled([alice, bob, carol, viewer])
  await alice.page.locator('#save').click()
  const saved = await savedTexts(alice)
  expect(saved.version).toBe(version)
  const all = saved.texts.join('\n')
  expect(all).toContain(`${FIRST} alice-one`)
  expect(all).toContain(`${SECOND} bob-one`)
  expect(isMixOf(afterBobOne(all), ' A-two', ' B-two'), all).toBe(true)
  expect(all).toContain('alice-three')
  expect(all).not.toContain('dave-typed')
  await expect.poll(async () => (await bob.status()).saved).toBe(version)
})

test('the app’s own save button saves the co-edited version through the host', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await openCoEdited(browser, SIMPLE, { documentId, user: 'alice' })
  const bob = await openCoEdited(browser, SIMPLE, { documentId, user: 'bob' })
  await typeAfter(bob, FIRST, ' from-bob')
  await settled([alice, bob])
  await expect.poll(() => alice.text()).toContain('from-bob')

  await alice.frame.getByRole('button', { name: /^저장 \((⌘|Ctrl\+)S\)$/ }).click()
  const saved = await savedTexts(alice)
  expect(saved.texts.join('\n')).toContain(`${FIRST} from-bob`)
  // the page keeps showing the session's document, and both pages still agree
  await typeAfter(alice, SECOND, ' after-save')
  await settled([alice, bob])
  expect(await bob.text()).toBe(await alice.text())
  expect(await bob.text()).toContain('after-save')
})
