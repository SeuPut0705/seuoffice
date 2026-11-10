/**
 * Co-editing one PPTX in real browser pages. Text boxes, slides and notes are driven the way
 * save-slides.spec.ts drives them (double-click a box, thumbnails, the new-slide chord), and
 * every result is read from the renderer's own slides and from the file the host stored.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSlideNotes, openPptx, type SlideElement } from '@genoffice/pptx-engine'
import { expect, test, type Browser, type Frame, type Locator } from '@playwright/test'
import { openCoEdited, settled, type CoEditor } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE = resolve(repo, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')

test.setTimeout(240_000)

const freshDocument = (): string => `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** What these tests read of the renderer's slides (pptx-render RenderSlide) */
interface ShownSlide {
  widthPx: number
  nodes: Array<{
    type: string
    box: { centerX: number; centerY: number }
    text?: { lines: Array<{ runs: Array<{ text: string }> }> }
  }>
}

type SlidesPage = Window & { slidesApi: { getRenderSlides(): Promise<ShownSlide[] | null> } }

const viewerFrame = (editor: CoEditor): Frame =>
  editor.page.frames().find((candidate) => candidate !== editor.page.mainFrame())!

/**
 * What the session answers a person whose edit it does not take, as the page throws it (the
 * renderer's call is rejected, the way an edit is on a page opened for viewing)
 */
const REFUSALS = [
  'This presentation is view only.',
  'This edit is not available while editing together. You can change text, add and delete slides, and write speaker notes.',
]

/** Every page this test opened, closed when it ends, and what any of them threw */
const opened: CoEditor[] = []
const pageErrors: string[] = []

/** Errors no refusal explains */
const unexpectedErrors = (): string[] =>
  pageErrors.filter((error) => !REFUSALS.some((refusal) => error.endsWith(refusal)))

test.afterEach(async () => {
  pageErrors.length = 0
  await Promise.all(opened.splice(0).map((editor) => editor.page.context().close()))
})

async function open(
  browser: Browser,
  documentId: string,
  user: string,
  access: 'edit' | 'view' = 'edit',
  file: string = FIXTURE,
): Promise<CoEditor> {
  const editor = await openCoEdited(browser, file, { documentId, user, access, ready: 'canvas' })
  opened.push(editor)
  editor.page.on('pageerror', (error) => pageErrors.push(`${user}: ${error.message}`))
  await expect(editor.frame.locator('.thumb').first()).toBeVisible({ timeout: 20_000 })
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

/** Run `act` and wait until the page reported the edit it made: only then can `settled` see it */
async function edit(editor: CoEditor, act: () => Promise<void>): Promise<void> {
  const before = await ownEdits(editor)
  await act()
  await expect.poll(() => ownEdits(editor), { timeout: 10_000 }).toBeGreaterThan(before)
}

/** Hold (or release, in order) the frames the host page sends on its co-editing socket */
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

/**
 * Let every page in `editors` edit while none of their frames reach the server, so all the edits
 * are made at one version; then release the frames and wait for the pages to agree.
 */
async function atOnce(editors: CoEditor[], act: () => Promise<void>): Promise<number> {
  await Promise.all(editors.map((editor) => holdOutgoing(editor, true)))
  try {
    await act()
  } finally {
    await Promise.all(editors.map((editor) => holdOutgoing(editor, false)))
  }
  return settled(editors)
}

/** Every slide's text boxes as the renderer draws them now */
async function shownDeck(editor: CoEditor): Promise<string[][]> {
  return viewerFrame(editor).evaluate(async () => {
    const slides = await (window as unknown as SlidesPage).slidesApi.getRenderSlides()
    return (slides ?? []).map((slide) =>
      slide.nodes.flatMap((node) =>
        node.text
          ? [node.text.lines.map((line) => line.runs.map((run) => run.text).join('')).join('')]
          : [],
      ),
    )
  })
}

const thumbs = (editor: CoEditor): Locator => editor.frame.locator('.thumb')
const textEditor = (editor: CoEditor): Locator => editor.frame.locator('.slide-text-editor')
const notesBox = (editor: CoEditor): Locator => editor.frame.locator('.notes-pane textarea')

/** The position of the slide the page shows */
const shownSlide = (editor: CoEditor): Promise<number> =>
  thumbs(editor).evaluateAll((all) => all.findIndex((thumb) => thumb.classList.contains('active')))

async function showSlide(editor: CoEditor, index: number): Promise<void> {
  await thumbs(editor).nth(index).click()
  await expect(thumbs(editor).nth(index)).toHaveClass(/active/)
}

/** Where on the page slide `index` draws the node `wanted` picks */
async function nodeAt(
  editor: CoEditor,
  index: number,
  wanted: { text: string } | { type: string },
): Promise<{ x: number; y: number }> {
  const at = await viewerFrame(editor).evaluate(
    async ({ index, wanted }) => {
      const stage = document.querySelector('.stage-rel')!.getBoundingClientRect()
      const slides = await (window as unknown as SlidesPage).slidesApi.getRenderSlides()
      const slide = slides![index]!
      const node = slide.nodes.find((candidate) =>
        'type' in wanted
          ? candidate.type === wanted.type
          : candidate.text?.lines.some((line) =>
              line.runs
                .map((run) => run.text)
                .join('')
                .includes(wanted.text),
            ),
      )
      if (!node) throw new Error(`slide ${index + 1} draws no ${JSON.stringify(wanted)}`)
      const k = stage.width / slide.widthPx
      return { x: stage.x + node.box.centerX * k, y: stage.y + node.box.centerY * k }
    },
    { index, wanted },
  )
  const viewer = (await editor.page.locator('#viewer iframe').boundingBox())!
  return { x: viewer.x + at.x, y: viewer.y + at.y }
}

/** Show slide `index`, open the text box that shows `text` and replace its text with `typed` */
async function typeInto(
  editor: CoEditor,
  index: number,
  text: string,
  typed: string,
): Promise<void> {
  await showSlide(editor, index)
  const at = await nodeAt(editor, index, { text })
  await editor.page.mouse.dblclick(at.x, at.y)
  await expect(textEditor(editor)).toBeFocused()
  await expect(textEditor(editor)).toHaveText(text)
  await editor.page.keyboard.press('ControlOrMeta+A')
  await editor.page.keyboard.type(typed, { delay: 10 })
  await expect(textEditor(editor)).toHaveText(typed)
}

/** Leave the open text box, which commits it */
async function leaveBox(editor: CoEditor): Promise<void> {
  await edit(editor, () => notesBox(editor).click())
  await expect(textEditor(editor)).toHaveCount(0)
}

/** Replace the whole text of the box that shows `text` on slide `index`, and commit it */
async function retype(editor: CoEditor, index: number, text: string, typed: string): Promise<void> {
  await typeInto(editor, index, text, typed)
  await leaveBox(editor)
}

/** Write notes for slide `index`; leaving the slide commits them */
async function writeNotes(
  editor: CoEditor,
  index: number,
  text: string,
  leaveTo: number,
): Promise<void> {
  await showSlide(editor, index)
  await notesBox(editor).click()
  await editor.page.keyboard.type(text)
  await edit(editor, () => showSlide(editor, leaveTo))
}

/** A blank slide after slide `index` */
async function addSlideAfter(editor: CoEditor, index: number): Promise<void> {
  await showSlide(editor, index)
  const mac = await viewerFrame(editor).evaluate(() => /mac/i.test(navigator.platform))
  await edit(editor, () => editor.page.keyboard.press(mac ? 'Meta+Shift+N' : 'Control+M'))
}

async function deleteSlide(editor: CoEditor, index: number): Promise<void> {
  await showSlide(editor, index)
  await edit(editor, () => editor.page.keyboard.press('Delete'))
}

interface SavedDeck {
  version: number | null
  slides: Array<{ texts: string[]; notes: string }>
}

/** The file the host stored last, once it is newer than `previous`, read back with the engine */
async function savedDeck(editor: CoEditor, previous: SavedDeck | null = null): Promise<SavedDeck> {
  const read = () =>
    editor.page.evaluate(() => {
      const file = window.seuLauncher?.saved
      return file ? { version: file.version, bytes: Array.from(file.bytes) } : null
    })
  await expect
    .poll(async () => (await read())?.version ?? null, { timeout: 60_000 })
    .not.toBe(previous?.version ?? null)
  const saved = (await read())!
  const opened = await openPptx(new Uint8Array(saved.bytes))
  const texts = (elements: SlideElement[]): string[] =>
    elements.flatMap((el) =>
      el.type === 'group'
        ? texts(el.children)
        : 'text' in el && el.text
          ? [el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')]
          : [],
    )
  return {
    version: saved.version,
    slides: opened.deck.slides.map((slide) => ({
      texts: texts(slide.elements),
      notes: getSlideNotes(opened.archive, slide.path),
    })),
  }
}

/**
 * The left three quarters of the slide as the page draws it now, with its selection frame. The
 * rest is left out: a floating AI button there changes with the pointer.
 */
async function slidePicture(editor: CoEditor): Promise<string> {
  const stage = (await editor.frame.locator('.stage-rel').boundingBox())!
  const clip = { x: stage.x, y: stage.y, width: stage.width * 0.75, height: stage.height }
  return (await editor.page.screenshot({ clip })).toString('base64')
}

/** The page mints ids with the browser's own generator again: no edit left its seeded one behind */
async function expectRealIds(editor: CoEditor): Promise<void> {
  const ids = await viewerFrame(editor).evaluate(() => ({
    own: Object.hasOwn(crypto, 'randomUUID'),
    native: /\[native code\]/.test(String(crypto.randomUUID)),
    differ: crypto.randomUUID() !== crypto.randomUUID(),
  }))
  expect(ids).toEqual({ own: false, native: true, differ: true })
}

const AGENDA_BODY = 'Financial results\nProduct updates\nRoadmap'

test('two people edit one pptx at once: different boxes, one slide, one box, slides coming and going', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')

  // different boxes on different slides, at the same time
  await Promise.all([
    retype(alice, 0, 'Fiscal Year 2026', 'Fiscal Year 2027'),
    retype(bob, 1, 'Agenda', 'Agenda by bob'),
  ])
  await settled([alice, bob])
  for (const editor of [alice, bob]) {
    await expect.poll(async () => (await shownDeck(editor))[0]).toContain('Fiscal Year 2027')
    await expect.poll(async () => (await shownDeck(editor))[1]).toContain('Agenda by bob')
  }

  // alice is still typing when bob's edit of another slide lands: her box stays open with what
  // she typed, and leaving it commits it
  await typeInto(alice, 2, 'Key Results', 'Results by alice')
  await retype(bob, 3, 'Revenue by Region', 'Revenue by bob')
  await settled([alice, bob])
  await expect.poll(async () => (await shownDeck(alice))[3]).toContain('Revenue by bob')
  await expect(textEditor(alice)).toHaveText('Results by alice')
  await leaveBox(alice)
  // and the same on one slide: she types the title while he commits the subtitle
  await typeInto(alice, 0, 'Q3 Business Review', 'Title by alice')
  await retype(bob, 0, 'Fiscal Year 2027', 'Year by bob')
  await settled([alice, bob])
  await expect.poll(async () => (await shownDeck(alice))[0]).toContain('Year by bob')
  await expect(textEditor(alice)).toHaveText('Title by alice')
  await leaveBox(alice)
  await settled([alice, bob])
  for (const editor of [alice, bob]) {
    await expect
      .poll(() => shownDeck(editor))
      .toEqual([
        ['Title by alice', 'Year by bob'],
        ['Agenda by bob', '•Financial results•Product updates•Roadmap'],
        ['', 'Results by alice'],
        ['Revenue by bob'],
        ['Thank you', 'Questions?'],
      ])
  }

  // the same box at one version: the edit the server ordered last is the text on both pages,
  // whole (text is not merged)
  await atOnce([alice, bob], async () => {
    await retype(alice, 0, 'Title by alice', 'Title A')
    await retype(bob, 0, 'Title by alice', 'Title B')
  })
  const title = (await shownDeck(alice))[0]![0]!
  expect(['Title A', 'Title B']).toContain(title)
  await expect.poll(() => shownDeck(bob)).toEqual(await shownDeck(alice))

  // at one version, one adds a blank slide after the first while the other deletes the last
  await atOnce([alice, bob], async () => {
    await addSlideAfter(alice, 0)
    await deleteSlide(bob, 4)
  })
  for (const editor of [alice, bob]) await expect(thumbs(editor)).toHaveCount(5)
  await expect.poll(() => shownDeck(bob)).toEqual(await shownDeck(alice))
  expect((await shownDeck(alice)).map((slide) => slide[0] ?? null)).toEqual([
    title,
    null,
    'Agenda by bob',
    '',
    'Revenue by bob',
  ])

  // a slide comes in before the one alice is typing on: she stays on her slide, her box stays
  // open, and what she typed lands in it
  await typeInto(alice, 3, 'Results by alice', 'Results, again')
  await addSlideAfter(bob, 0)
  await settled([alice, bob])
  await expect(thumbs(alice)).toHaveCount(6)
  expect(await shownSlide(alice)).toBe(4)
  await expect(textEditor(alice)).toHaveText('Results, again')
  await leaveBox(alice)
  // and with notes she is writing for it when a slide before it goes: they stay with her slide
  await notesBox(alice).click()
  await alice.page.keyboard.type('Notes by alice')
  const written = await ownEdits(alice)
  await deleteSlide(bob, 1)
  await settled([bob])
  await expect(thumbs(alice)).toHaveCount(5)
  await expect.poll(() => shownSlide(alice)).toBe(3)
  await expect(notesBox(alice)).toHaveValue('Notes by alice')
  // moving with her slide wrote the notes for it; leaving the slide later writes nothing more
  await expect.poll(() => ownEdits(alice)).toBe(written + 1)
  await showSlide(alice, 0)
  await settled([alice, bob])
  expect(await ownEdits(alice)).toBe(written + 1)

  // notes someone else writes for the slide a person looks at appear in their notes box
  await writeNotes(bob, 0, 'Notes by bob', 2)
  await settled([alice, bob])
  await expect(notesBox(alice)).toHaveValue('Notes by bob')
  await showSlide(bob, 3)
  await expect(notesBox(bob)).toHaveValue('Notes by alice')

  // nothing keeps writing once the people stop
  const quiet = await settled([alice, bob])
  await alice.page.waitForTimeout(3_000)
  expect(await settled([alice, bob])).toBe(quiet)
  expect(await shownDeck(bob)).toEqual(await shownDeck(alice))

  // the host's save: one exact version, which reopens with everything both of them did
  await alice.page.locator('#save').click()
  const saved = await savedDeck(alice)
  expect(saved.version).toBe(quiet)
  // bob's own save of that version is the same deck: his page holds what hers does, which the
  // server also checks from the two pages' fingerprints of one version
  await showSlide(bob, 0)
  await bob.page.keyboard.press('ControlOrMeta+S')
  const his = await savedDeck(bob)
  expect(his.version).toBe(quiet)
  expect(his.slides).toEqual(saved.slides)
  await bob.page.waitForTimeout(1_000)
  expect(saved.slides).toEqual([
    { texts: [title, 'Year by bob'], notes: 'Notes by bob' },
    { texts: [], notes: '' },
    { texts: ['Agenda by bob', AGENDA_BODY], notes: '' },
    { texts: ['', 'Results, again'], notes: 'Notes by alice' },
    { texts: ['Revenue by bob'], notes: '' },
  ])
  for (const editor of [alice, bob]) {
    expect((await editor.status()).phase).toBe('live')
    await expectRealIds(editor)
  }
  expect(unexpectedErrors()).toEqual([])
})

test('a late joiner and a viewer follow; saves hold one exact version; editing goes on after a save', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')
  await Promise.all([
    retype(alice, 0, 'Fiscal Year 2026', 'Fiscal Year 2027'),
    retype(bob, 1, 'Agenda', 'Agenda by bob'),
  ])
  await addSlideAfter(alice, 0)
  await writeNotes(bob, 0, 'Notes by bob', 2)
  await settled([alice, bob])
  const before = [
    ['Q3 Business Review', 'Fiscal Year 2027'],
    [],
    ['Agenda by bob', '•Financial results•Product updates•Roadmap'],
    ['', 'Key Results'],
    ['Revenue by Region'],
    ['Thank you', 'Questions?'],
  ]
  for (const editor of [alice, bob]) await expect.poll(() => shownDeck(editor)).toEqual(before)

  // a late joiner opens the same deck, notes included
  const carol = await open(browser, documentId, 'carol')
  await settled([alice, bob, carol])
  expect(await shownDeck(carol)).toEqual(before)
  await showSlide(carol, 0)
  await expect(notesBox(carol)).toHaveValue('Notes by bob')

  // a viewer sees it too, and later edits
  const viewer = await open(browser, documentId, 'dave', 'view')
  expect((await viewer.status()).canEdit).toBe(false)
  expect(await shownDeck(viewer)).toEqual(before)
  await retype(alice, 4, 'Revenue by Region', 'Revenue by alice')
  const version = await settled([alice, bob, carol, viewer])
  const after = before.map((slide, index) => (index === 4 ? ['Revenue by alice'] : slide))
  for (const editor of [bob, carol, viewer]) {
    await expect.poll(() => shownDeck(editor)).toEqual(after)
  }

  // the viewer types into a box, deletes a slide and adds one: each is refused with a message,
  // and the deck stays as it is on every page
  await typeInto(viewer, 2, 'Agenda by bob', 'dave-typed')
  await notesBox(viewer).click()
  await expect(viewer.frame.getByText('이 프레젠테이션은 보기만 할 수 있습니다.')).toBeVisible()
  await showSlide(viewer, 5)
  await viewer.page.keyboard.press('Delete')
  const mac = await viewerFrame(viewer).evaluate(() => /mac/i.test(navigator.platform))
  await viewer.page.keyboard.press(mac ? 'Meta+Shift+N' : 'Control+M')
  await viewer.page.keyboard.press('ControlOrMeta+S')
  await viewer.page.waitForTimeout(1_000)
  expect(await ownEdits(viewer)).toBe(0)
  expect(await viewer.status()).toMatchObject({ phase: 'live', version, unconfirmed: 0 })
  await expect(thumbs(viewer)).toHaveCount(6)
  for (const editor of [alice, bob, carol, viewer]) expect(await shownDeck(editor)).toEqual(after)
  expect(await viewer.page.evaluate(() => window.seuLauncher?.saved ?? null)).toBeNull()

  // the host's save: the file of one version, which reopens with everyone's edits
  await alice.page.locator('#save').click()
  const saved = await savedDeck(alice)
  expect(saved.version).toBe(version)
  expect(saved.slides).toEqual([
    { texts: ['Q3 Business Review', 'Fiscal Year 2027'], notes: 'Notes by bob' },
    { texts: [], notes: '' },
    { texts: ['Agenda by bob', AGENDA_BODY], notes: '' },
    { texts: ['', 'Key Results'], notes: '' },
    { texts: ['Revenue by alice'], notes: '' },
    { texts: ['Thank you', 'Questions?'], notes: '' },
  ])
  await expect.poll(async () => (await bob.status()).saved).toBe(version)
  for (const editor of [alice, bob, carol]) {
    await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
  }

  // carol's own save of the same version is the same deck
  await showSlide(carol, 0)
  await carol.page.keyboard.press('ControlOrMeta+S')
  const hers = await savedDeck(carol)
  expect(hers.version).toBe(version)
  expect(hers.slides).toEqual(saved.slides)

  // both keep editing after the saves, and a second save holds the later edits too
  await Promise.all([
    retype(alice, 3, 'Key Results', 'Results, later'),
    retype(bob, 5, 'Questions?', 'Questions, later'),
  ])
  const later = await settled([alice, bob, carol, viewer])
  expect(later).toBeGreaterThan(version)
  await expect(alice.page.locator('#status')).toContainText('저장 안 함')
  await bob.page.locator('#save').click()
  const second = await savedDeck(bob)
  expect(second.version).toBe(later)
  expect(second.slides).toEqual(
    saved.slides.map((slide, index) =>
      index === 3
        ? { texts: ['', 'Results, later'], notes: '' }
        : index === 5
          ? { texts: ['Thank you', 'Questions, later'], notes: '' }
          : slide,
    ),
  )
  for (const editor of [alice, bob, carol, viewer]) {
    expect((await editor.status()).phase).toBe('live')
    await expectRealIds(editor)
  }
  expect(unexpectedErrors()).toEqual([])
})

test('the app’s own save saves the co-edited version, and editing goes on after it', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')
  await retype(bob, 0, 'Fiscal Year 2026', 'from bob')
  const version = await settled([alice, bob])
  await expect.poll(async () => (await shownDeck(alice))[0]).toContain('from bob')
  await expect(alice.page.locator('#status')).toContainText('저장 안 함')

  await showSlide(alice, 0)
  await alice.page.keyboard.press('ControlOrMeta+S')
  const first = await savedDeck(alice)
  expect(first.version).toBe(version)
  expect(first.slides[0]!.texts).toEqual(['Q3 Business Review', 'from bob'])
  await expect(alice.frame.getByText('저장했습니다').first()).toBeVisible()
  await expect.poll(async () => (await bob.status()).saved).toBe(version)
  for (const editor of [alice, bob]) {
    await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
  }

  // the page keeps showing the session's deck, and both pages still agree
  await retype(alice, 1, 'Agenda', 'after the save')
  const later = await settled([alice, bob])
  await expect.poll(() => shownDeck(bob)).toEqual(await shownDeck(alice))
  await showSlide(bob, 0)
  await bob.page.keyboard.press('ControlOrMeta+S')
  const second = await savedDeck(bob)
  expect(second.version).toBe(later)
  expect(second.slides[1]!.texts).toEqual(['after the save', AGENDA_BODY])
  expect(second.slides[0]!.texts).toEqual(['Q3 Business Review', 'from bob'])
  expect(unexpectedErrors()).toEqual([])
})

test('typing on a slide someone deletes at the same moment is dropped on every page, with a message', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')

  // bob's frames wait, so his edit and alice's delete are made at the same version
  await holdOutgoing(bob, true)
  await retype(bob, 3, 'Revenue by Region', 'Revenue by bob')
  await deleteSlide(alice, 3)
  await expect(thumbs(alice)).toHaveCount(4)
  await settled([alice])
  await expect.poll(async () => (await bob.status()).version).toBe((await alice.status()).version)
  await expect(bob.frame.getByText(/다른 사람이 지운 슬라이드나 개체에 한 편집은/)).toBeVisible()
  await holdOutgoing(bob, false)
  await settled([alice, bob])

  for (const editor of [alice, bob]) await expect(thumbs(editor)).toHaveCount(4)
  expect(await shownDeck(bob)).toEqual(await shownDeck(alice))
  expect(JSON.stringify(await shownDeck(alice))).not.toContain('Revenue by')
  await alice.page.locator('#save').click()
  const saved = await savedDeck(alice)
  expect(saved.slides.map((slide) => slide.texts[0])).toEqual([
    'Q3 Business Review',
    'Agenda',
    '',
    'Thank you',
  ])
  expect(unexpectedErrors()).toEqual([])
})

test('undo and an edit the session cannot carry are refused with a message and change nothing on either page', async ({
  browser,
}) => {
  const documentId = freshDocument()
  const alice = await open(browser, documentId, 'alice')
  const bob = await open(browser, documentId, 'bob')
  await retype(alice, 0, 'Fiscal Year 2026', 'Fiscal Year 2027')
  const version = await settled([alice, bob])
  const deck = await shownDeck(alice)
  await expect.poll(() => shownDeck(bob)).toEqual(deck)
  const own = await ownEdits(alice)

  // undo would restore a whole-deck snapshot no other page has
  await showSlide(alice, 0)
  await alice.page.keyboard.press('ControlOrMeta+Z')
  await expect(alice.frame.getByText(/실행 취소와 다시 실행을 쓸 수 없습니다/)).toBeVisible()
  // moving an object is an edit the session does not carry: the table goes back where it was
  await showSlide(alice, 3)
  const table = await nodeAt(alice, 3, { type: 'table' })
  await alice.page.mouse.click(table.x, table.y)
  const picture = await slidePicture(alice)
  await alice.page.mouse.down()
  await alice.page.mouse.move(table.x + 120, table.y + 60, { steps: 8 })
  await alice.page.mouse.up()
  await expect(
    alice.frame.getByText(/함께 편집하는 동안에는 이 편집을 쓸 수 없습니다/),
  ).toBeVisible()
  await alice.page.mouse.move(table.x, table.y)
  await expect.poll(() => slidePicture(alice)).toBe(picture)
  // and so is deleting it
  await alice.page.keyboard.press('Delete')
  await alice.page.waitForTimeout(1_000)
  await expect.poll(() => slidePicture(alice)).toBe(picture)

  expect(await ownEdits(alice)).toBe(own)
  expect(await settled([alice, bob])).toBe(version)
  for (const editor of [alice, bob]) expect(await shownDeck(editor)).toEqual(deck)
  await expect(bob.frame.locator('.app-toast')).toHaveCount(0)
  // the table is still drawn where it was, and it is in the file the session writes
  await nodeAt(alice, 3, { type: 'table' })
  await bob.page.locator('#save').click()
  const saved = await savedDeck(bob)
  expect(saved.version).toBe(version)
  expect(saved.slides.map((slide) => slide.texts)).toEqual([
    ['Q3 Business Review', 'Fiscal Year 2027'],
    ['Agenda', AGENDA_BODY],
    ['', 'Key Results'],
    ['Revenue by Region'],
    ['Thank you', 'Questions?'],
  ])
  expect(unexpectedErrors()).toEqual([])
})

const QUIET: Array<{ label: string; file: string }> = [
  { label: 'a business deck', file: FIXTURE },
  {
    label: 'CJK and emoji text',
    file: resolve(repo, 'packages/pptx-engine/tests/fixtures/05_unicode_cjk_emoji.pptx'),
  },
  {
    label: 'a new blank presentation',
    file: resolve(repo, 'apps/shell/build/shell-new/blank.pptx'),
  },
]

for (const { label, file } of QUIET) {
  test(`two pages on ${label} write nothing of their own`, async ({ browser }) => {
    const documentId = freshDocument()
    const alice = await open(browser, documentId, 'alice', 'edit', file)
    const bob = await open(browser, documentId, 'bob', 'edit', file)
    // layout, fonts and autofit settle in this time; whatever they write must stay local
    await alice.page.waitForTimeout(5_000)
    expect(await settled([alice, bob])).toBe(0)
    // looking through the slides writes nothing either
    const count = await thumbs(alice).count()
    for (let i = 0; i < count; i++) {
      await showSlide(alice, i)
      await showSlide(bob, count - 1 - i)
    }
    await alice.page.waitForTimeout(2_000)
    expect(await settled([alice, bob])).toBe(0)
    for (const editor of [alice, bob]) {
      expect(await ownEdits(editor)).toBe(0)
      await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
    }
    expect(await shownDeck(bob)).toEqual(await shownDeck(alice))
    expect(unexpectedErrors()).toEqual([])
  })
}
