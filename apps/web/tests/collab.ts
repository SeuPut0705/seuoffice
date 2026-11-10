/** Helpers for specs that open one document in several pages, one co-editing user each */
import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test'
import { WebSocket as NodeSocket } from 'ws'

export interface CoEditor {
  page: Page
  frame: FrameLocator
  /** the editor's text as the page shows it */
  text(): Promise<string>
  /** the session status the host last heard */
  status(): Promise<{
    phase: string
    /** why a `failed` session ended */
    failure?: string
    version: number
    unconfirmed: number
    saved: number
    canEdit: boolean
  }>
}

/** a file on disk, or one a spec made in memory */
export type CoFile = string | { name: string; mimeType: string; buffer: Buffer }

/**
 * Open `file` in a fresh browser context as user `user` of co-edited document
 * `documentId`, and wait until the page is live in the session.
 */
export async function openCoEdited(
  browser: Browser,
  file: CoFile,
  options: {
    documentId: string
    user: string
    access?: 'edit' | 'view'
    /** what shows the document: the docs editor (default) or a grid canvas */
    ready?: 'editor' | 'canvas'
    /** what a person does before the document shows, such as typing its password */
    unlock?(frame: FrameLocator): Promise<void>
  },
): Promise<CoEditor> {
  const access = options.access ?? 'edit'
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const query = new URLSearchParams({
    collab: options.documentId,
    user: options.user,
    name: options.user,
    access,
  })
  await page.goto(`/?${query}`)
  await page.locator('#edit').setChecked(access === 'edit')
  await page.setInputFiles('#file', file)
  const frame = page.frameLocator('#viewer iframe')
  // a protected file shows only after its password, and the page says it opened only then
  await options.unlock?.(frame)
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  await expect(page.locator('#status')).not.toContainText('오류')
  const shown = options.ready === 'canvas' ? frame.locator('canvas') : frame.locator('.ProseMirror')
  await expect(shown.first()).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-collab-phase', 'live', {
    timeout: 30_000,
  })
  return {
    page,
    frame,
    text: () => frame.locator('.ProseMirror').first().innerText(),
    status: () =>
      page.evaluate(() => {
        const status = window.seuLauncher?.collab
        if (!status) throw new Error('no co-editing status yet')
        return status
      }),
  }
}

/** Wait until every page is live at one version with nothing of its own unconfirmed */
export async function settled(editors: CoEditor[]): Promise<number> {
  let version = -1
  await expect
    .poll(
      async () => {
        const statuses = await Promise.all(editors.map((editor) => editor.status()))
        version = statuses[0].version
        return statuses.every(
          (status) =>
            status.phase === 'live' && status.unconfirmed === 0 && status.version === version,
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  return version
}

/** Type at the end of the paragraph that holds `anchor` (click into it, then the line-end key) */
export async function typeAfter(editor: CoEditor, anchor: string, text: string): Promise<void> {
  await editor.frame.locator('.ProseMirror').first().getByText(anchor).first().click()
  await editor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await editor.page.keyboard.type(text, { delay: 20 })
}

/**
 * The file of exactly what `editor`'s page shows, asked the way an embedding host asks: the
 * launcher's `doc.exportLocal()` of @seuoffice/embed. Nothing is stored by it.
 */
export async function exportedFile(editor: CoEditor): Promise<Buffer> {
  const bytes = await editor.page.evaluate(async () =>
    Array.from((await window.seuLauncher!.exportLocal()).bytes),
  )
  return Buffer.from(bytes)
}

/** The launcher's `doc.save()`: null once the host stored it, else the message it failed with */
export const hostSave = (editor: CoEditor): Promise<string | null> =>
  editor.page.evaluate(() => window.seuLauncher!.save())

/** The file the launcher stores for this page, when it stored one */
export async function storedFile(
  editor: CoEditor,
): Promise<{ version: number | null; bytes: Buffer } | null> {
  const file = await editor.page.evaluate(() => {
    const saved = window.seuLauncher?.saved
    return saved ? { version: saved.version, bytes: Array.from(saved.bytes) } : null
  })
  return file && { version: file.version, bytes: Buffer.from(file.bytes) }
}

/**
 * Count the edits this page itself reported, from now on: each one raises its
 * unconfirmed count, which a change from someone else never does. The session
 * version cannot tell the two apart: it rises with everyone's edits.
 */
export async function countOwnEdits(editor: CoEditor): Promise<void> {
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

export const ownEdits = (editor: CoEditor): Promise<number> =>
  editor.page.evaluate(() => (window as unknown as { ownEdits: number }).ownEdits)

/** Run `act` and wait until the page reported an edit of its own (`countOwnEdits` first) */
export async function edited(editor: CoEditor, act: () => Promise<void>): Promise<void> {
  const before = await ownEdits(editor)
  await act()
  await expect.poll(() => ownEdits(editor), { timeout: 10_000 }).toBeGreaterThan(before)
}

/** What the test server does on a spec's word (tests/collab-server.ts) */
export type ServerHook = 'cut' | 'hold' | 'release' | 'diverge' | 'reset'

export async function serverHook(
  op: ServerHook,
  documentId: string,
  user?: string,
): Promise<Record<string, unknown>> {
  const url = new URL('collab-test', test.info().project.use.baseURL)
  url.protocol = 'ws:'
  url.search = new URLSearchParams({ op, doc: documentId, ...(user ? { user } : {}) }).toString()
  const socket = new NodeSocket(url)
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>()
  socket.on('message', (data) => {
    const answer = JSON.parse(String(data)) as Record<string, unknown>
    if (answer.ok === true) resolve(answer)
    else reject(new Error(`the test server could not ${op}: ${String(answer.error)}`))
  })
  socket.on('error', reject)
  // after an answer this changes nothing
  socket.on('close', () => reject(new Error(`the test server closed before it answered ${op}`)))
  return promise
}

/** How the recovery scenarios drive one format; every format's editor is driven its own way */
export interface RecoveryDriver {
  /** the format, as the test titles name it */
  label: string
  file(): Promise<{ name: string; mimeType: string; buffer: Buffer }>
  /** open `file` as `user`, wait until the page takes input, and `countOwnEdits` */
  open(browser: Browser, file: CoFile, documentId: string, user: string): Promise<CoEditor>
  /**
   * Leave `text` in the document at `place`, and wait until the page reported the edit as its
   * own. Places 0 to 9 are one person's, 10 to 19 another's: no two people write at one place.
   */
  write(editor: CoEditor, place: number, text: string): Promise<void>
  /** what `write` does as a person, without waiting for a report: for a page that must refuse it */
  tryWrite(editor: CoEditor, place: number, text: string): Promise<void>
  /** all the text a file of this format holds, as one string */
  textOf(bytes: Uint8Array): Promise<string>
}

const occurrences = (text: string, word: string): number => text.split(word).length - 1

const phaseOf = (editor: CoEditor) => async () => {
  const { phase, failure } = await editor.status()
  return failure ? `${phase}:${failure}` : phase
}

/**
 * The paths where people could lose work, in two real pages on the test server: a connection
 * held down while a person types, a connection dropped in a burst of typing, a session that
 * ends as `diverged`, the rescue file of an offline page, an older save that reaches the host
 * after a newer one, and the host's `reset`.
 */
export function recoveryTests(driver: RecoveryDriver): void {
  const { label } = driver
  const fresh = (): string =>
    `${label}-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const shownText = async (editor: CoEditor): Promise<string> =>
    driver.textOf(new Uint8Array(await exportedFile(editor)))
  const storedText = async (editor: CoEditor): Promise<string> => {
    const stored = await storedFile(editor)
    expect(stored, 'the host stored a file').not.toBeNull()
    return driver.textOf(new Uint8Array(stored!.bytes))
  }
  const opened: CoEditor[] = []
  test.afterEach(async () => {
    await Promise.all(opened.splice(0).map((editor) => editor.page.context().close()))
  })
  const open = async (
    browser: Browser,
    file: CoFile,
    documentId: string,
    user: string,
  ): Promise<CoEditor> => {
    const editor = await driver.open(browser, file, documentId, user)
    opened.push(editor)
    return editor
  }
  /** a document no other test used, opened by alice and then bob */
  const pair = async (browser: Browser) => {
    const file = await driver.file()
    const documentId = fresh()
    const alice = await open(browser, file, documentId, 'alice')
    const bob = await open(browser, file, documentId, 'bob')
    return { file, documentId, alice, bob }
  }

  test(`${label}: typing while the connection is held down reaches everyone once it is back; a save holds both`, async ({
    browser,
  }) => {
    const { documentId, alice, bob } = await pair(browser)

    expect((await serverHook('hold', documentId, 'alice')).dropped).toBe(1)
    await expect.poll(phaseOf(alice)).toBe('offline')
    await driver.write(alice, 0, 'offlinealice')
    await driver.write(bob, 10, 'onlinebob')
    await settled([bob])
    expect(await alice.status()).toMatchObject({ phase: 'offline' })
    expect((await alice.status()).unconfirmed).toBeGreaterThan(0)

    await serverHook('release', documentId, 'alice')
    const version = await settled([alice, bob])
    for (const editor of [alice, bob]) {
      const shown = await shownText(editor)
      expect(occurrences(shown, 'offlinealice'), shown).toBe(1)
      expect(occurrences(shown, 'onlinebob'), shown).toBe(1)
    }
    expect(await hostSave(alice)).toBeNull()
    expect((await storedFile(alice))!.version).toBe(version)
    const stored = await storedText(alice)
    expect(occurrences(stored, 'offlinealice'), stored).toBe(1)
    expect(occurrences(stored, 'onlinebob'), stored).toBe(1)
  })

  test(`${label}: a connection dropped in a burst of typing loses nothing and applies nothing twice`, async ({
    browser,
  }) => {
    const { documentId, alice, bob } = await pair(browser)
    const aliceWords = Array.from({ length: 6 }, (_, i) => `a${i}burst`)
    const bobWords = Array.from({ length: 3 }, (_, i) => `b${i}burst`)

    const bobTyping = (async () => {
      for (const [i, word] of bobWords.entries()) await driver.write(bob, 10 + i, word)
    })()
    for (const [i, word] of aliceWords.entries()) {
      if (i === 2 || i === 4) {
        // the server drops her socket while she is in the middle of this word
        await expect.poll(phaseOf(alice)).toBe('live')
        const writing = driver.write(alice, i, word)
        await alice.page.waitForTimeout(150)
        expect((await serverHook('cut', documentId, 'alice')).dropped).toBe(1)
        await writing
      } else {
        await driver.write(alice, i, word)
      }
    }
    await bobTyping
    await settled([alice, bob])

    expect(await hostSave(bob)).toBeNull()
    const texts = [await shownText(alice), await shownText(bob), await storedText(bob)]
    for (const text of texts) {
      for (const word of [...aliceWords, ...bobWords]) {
        expect(occurrences(text, word), `${word} in ${text}`).toBe(1)
      }
    }
  })

  test(`${label}: a session that ends as diverged leaves both pages read-only; the rescue file holds the person’s edits and the stored file stays`, async ({
    browser,
  }) => {
    const { documentId, alice, bob } = await pair(browser)
    await driver.write(alice, 0, 'keptalice')
    await settled([alice, bob])
    expect(await hostSave(alice)).toBeNull()
    const kept = (await storedFile(alice))!
    await driver.write(alice, 1, 'pendingalice')
    await driver.write(bob, 11, 'pendingbob')
    const version = await settled([alice, bob])

    expect((await serverHook('diverge', documentId)).v).toBe(version)
    for (const editor of [alice, bob]) {
      await expect.poll(phaseOf(editor)).toBe('failed:diverged')
      await expect(editor.page.locator('#status')).toContainText('diverged')
      await expect(editor.page.locator('#status')).toContainText('읽기 전용')
    }
    // a read-only page may refuse the gesture itself (a disabled tool), or take it and change nothing
    await driver.tryWrite(alice, 2, 'afterdiverged').catch(() => {})
    await driver.tryWrite(bob, 12, 'afterdiverged').catch(() => {})

    const rescued = await shownText(alice)
    for (const word of ['keptalice', 'pendingalice', 'pendingbob']) {
      expect(occurrences(rescued, word), `${word} in ${rescued}`).toBe(1)
    }
    expect(rescued).not.toContain('afterdiverged')
    expect(await shownText(bob)).not.toContain('afterdiverged')

    // a failed session saves nothing: the host keeps the last file it stored
    expect(await hostSave(alice)).not.toBeNull()
    const stored = (await storedFile(alice))!
    expect(stored.version).toBe(kept.version)
    expect(stored.bytes.equals(kept.bytes)).toBe(true)
    expect(await storedFile(bob)).toBeNull()
  })

  test(`${label}: the rescue file of an offline page holds what the person typed there`, async ({
    browser,
  }) => {
    const { documentId, alice, bob } = await pair(browser)

    await serverHook('hold', documentId, 'alice')
    await expect.poll(phaseOf(alice)).toBe('offline')
    await driver.write(alice, 0, 'rescuedalice')
    expect((await alice.status()).unconfirmed).toBeGreaterThan(0)
    const rescued = await shownText(alice)
    expect(occurrences(rescued, 'rescuedalice'), rescued).toBe(1)
    expect(await storedFile(alice)).toBeNull()
    expect(await shownText(bob)).not.toContain('rescuedalice')

    // the rescue told the server nothing: the edit goes out once, when the connection is back
    await serverHook('release', documentId, 'alice')
    await settled([alice, bob])
    const shown = await shownText(bob)
    expect(occurrences(shown, 'rescuedalice'), shown).toBe(1)
  })

  test(`${label}: a save of an older version that reaches the host after a newer one is refused; the page says so and goes on`, async ({
    browser,
  }) => {
    const { file, alice, bob } = await pair(browser)
    await driver.write(alice, 0, 'olderalice')
    const older = await settled([alice, bob])

    // alice's save is made at `older` and waits at her host
    await alice.page.evaluate(() => window.seuLauncher!.holdSaves())
    const aliceSave = hostSave(alice)
    await expect.poll(() => alice.page.evaluate(() => window.seuLauncher!.heldSaves)).toBe(1)

    await driver.write(bob, 10, 'newerbob')
    const newer = await settled([alice, bob])
    expect(newer).toBeGreaterThan(older)
    expect(await hostSave(bob)).toBeNull()
    const bobStored = (await storedFile(bob))!
    expect(bobStored.version).toBe(newer)

    // both hosts write one store: bob's newer file is in it when alice's older one arrives
    await alice.page.evaluate(
      ({ bytes, version, name }) => {
        window.seuLauncher!.saved = { fileName: name, bytes: new Uint8Array(bytes), version }
        window.seuLauncher!.releaseSaves()
      },
      { bytes: Array.from(bobStored.bytes), version: newer, name: file.name },
    )
    expect(await aliceSave).toContain(`version ${older} is older than the stored version ${newer}`)
    const stored = (await storedFile(alice))!
    expect(stored.version).toBe(newer)
    expect(stored.bytes.equals(bobStored.bytes)).toBe(true)
    await expect(alice.page.locator('#status')).toContainText('저장 실패')

    // the session goes on: the server holds bob's save as the stored version, and alice types on
    expect(await alice.status()).toMatchObject({ phase: 'live', saved: newer })
    await driver.write(alice, 1, 'afterrefusal')
    await settled([alice, bob])
    expect(occurrences(await shownText(bob), 'afterrefusal')).toBe(1)
  })

  test(`${label}: a reset while people are connected ends their sessions read-only; reopening starts from the stored file`, async ({
    browser,
  }) => {
    const { file, documentId, alice, bob } = await pair(browser)
    await driver.write(alice, 0, 'storedalice')
    await settled([alice, bob])
    expect(await hostSave(alice)).toBeNull()
    const stored = (await storedFile(alice))!
    await driver.write(bob, 10, 'lostbob')
    await settled([alice, bob])

    await serverHook('reset', documentId)
    for (const editor of [alice, bob]) {
      await expect.poll(phaseOf(editor)).toBe('failed:reset')
      await expect(editor.page.locator('#status')).toContainText('reset')
    }
    await driver.tryWrite(alice, 1, 'afterreset').catch(() => {})
    expect(await shownText(alice)).not.toContain('afterreset')

    const carol = await open(
      browser,
      { name: file.name, mimeType: file.mimeType, buffer: stored.bytes },
      documentId,
      'carol',
    )
    expect(await carol.status()).toMatchObject({ phase: 'live', version: 0 })
    const reopened = await shownText(carol)
    expect(occurrences(reopened, 'storedalice'), reopened).toBe(1)
    expect(reopened).not.toContain('lostbob')
  })
}
