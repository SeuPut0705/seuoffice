import { PAGE_MARK, TOTAL_PAGES_MARK, parseDocx, readSections } from '@genoffice/docx-engine'
import {
  joinCollab,
  type CollabLink,
  type CollabLinkEvent,
  type CollabSession,
  type Json,
} from '@seuoffice/collab/client'
import {
  createCollabServer,
  memoryStore,
  type CollabServer,
  type CollabStore,
} from '@seuoffice/collab/server'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { AI_REVISION_AUTHOR } from '../src/renderer/ai/revision-author'
import { executeTool } from '../src/renderer/ai/tools'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { editKey } from '../src/renderer/hf-sections'
import { openDocsCollab } from '../src/web/collab-side'
import { fakeApp, type FakeApp } from './helpers/collab-app'

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const BODY = para('alpha beta') + para('zeta eta')
const FORMAT = { name: 'docx', schema: 3 }
const DOCUMENT = 'memo'

/** a document whose settings say tracking is on, as Word leaves one saved with Track Changes on */
const trackedDocx = () =>
  buildDocx({
    bodyXml: BODY,
    extraParts: [
      {
        path: 'word/settings.xml',
        xml:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:trackRevisions/></w:settings>',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
      },
    ],
  })

let plain: Uint8Array
let tracked: Uint8Array
let store: CollabStore
let server: CollabServer
let pages: Page[] = []
/** the version each page last vouched for with a fingerprint */
let vouched = new Map<string, number>()

beforeAll(async () => {
  plain = new Uint8Array(await buildDocx({ bodyXml: BODY }))
  tracked = new Uint8Array(await trackedDocx())
})

// the side store polls the App on an interval and the engine fingerprints on a timer:
// the tests move that clock
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  })
  store = memoryStore()
  server = createCollabServer({ store })
  pages = []
  vouched = new Map()
})

afterEach(async () => {
  for (const page of pages) {
    page.session.close()
    page.editor.destroy()
  }
  vi.useRealTimers()
  await server.close()
})

/** A page's own socket to the server, as each browser has one */
function linkOf(name: string): CollabLink {
  let handler: ((event: CollabLinkEvent) => void) | null = null
  let toServer: ((frame: string | Uint8Array) => void) | null = null
  const events = (event: CollabLinkEvent) => handler?.(event)
  return {
    open: () => {
      if (toServer) return
      let receive: ((frame: string | Uint8Array) => void) | undefined
      server.accept(
        {
          send: (frame) =>
            queueMicrotask(() =>
              events({
                type: 'frame',
                frame: typeof frame === 'string' ? frame : new Uint8Array(frame),
              }),
            ),
          close: () => queueMicrotask(() => events({ type: 'close' })),
          onMessage: (next) => (receive = next),
          onClose: () => {},
        },
        { documentId: DOCUMENT, userId: name, name, canEdit: true },
      )
      queueMicrotask(() => events({ type: 'open' }))
      toServer = (frame) => receive?.(frame)
    },
    send: (frame) => {
      if (typeof frame === 'string') {
        const sent = JSON.parse(frame) as { t?: string; v?: number }
        if (sent.t === 'fingerprint') vouched.set(name, sent.v!)
      }
      toServer?.(typeof frame === 'string' ? frame : new Uint8Array(frame))
    },
    close: () => {
      toServer = null
    },
    subscribe: (next) => {
      handler = next
      return () => (handler = null)
    },
  }
}

interface Page {
  name: string
  editor: Editor
  app: FakeApp
  session: CollabSession
  /** the App's next render, and its effect that hands the tracking state to the recorder */
  show(): void
  tracking(): boolean
}

/**
 * One person's page on the session: the document the session gave it in a real
 * editor, the App state as opening that file leaves it, and the co-editing
 * adapter the web page builds (its saves write the real file).
 */
async function open(
  name: string,
  file: Uint8Array,
  fields: Parameters<typeof fakeApp>[0] = {},
): Promise<Page> {
  const join = await joinCollab(linkOf(name), { format: FORMAT, bytes: file })
  const parsed = await parseDocx(join.baseBytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editor.storage.trackChanges.author = name
  const path = `/${name}/memo.docx`
  const app = fakeApp({
    editor,
    doc: { filePath: path, fileName: 'memo.docx', format: 'docx', parsed },
    sections: readSections(parsed),
    // what opening the file sets (file-actions.ts)
    trackChanges: parsed.trackRevisions ?? false,
    trackRevisionsDirty: false,
    ...fields,
  })
  const show = (): void => {
    app.render()
    editor.storage.trackChanges.enabled = app.context.current.trackChanges
  }
  show()
  const adapter = await openDocsCollab(
    { editor, context: app.context },
    { path, fileName: 'memo.docx', finish: async (docx) => docx },
  )
  const page: Page = {
    name,
    editor,
    app,
    session: join.attach(adapter),
    show,
    tracking: () => app.context.current.trackChanges,
  }
  pages.push(page)
  await until(() => expect(page.session.status().phase).toBe('live'))
  return page
}

/** every page renders and time passes until `check` holds */
const until = (check: () => void): Promise<void> =>
  vi.waitFor(
    () => {
      for (const page of pages) page.show()
      vi.advanceTimersByTime(250)
      check()
    },
    { timeout: 10_000, interval: 20 },
  )

/**
 * Every page is live at one version with nothing of its own waiting, and the
 * server compared their fingerprints at that version: pages that held
 * different states would have been thrown out as diverged.
 */
async function agreed(): Promise<void> {
  let version = -1
  await until(() => {
    const statuses = pages.map((page) => page.session.status())
    version = statuses[0].version
    for (const status of statuses) expect(status).toMatchObject({ version, unconfirmed: 0 })
  })
  // a page fingerprints a version at most once in ten seconds
  vi.advanceTimersByTime(11_000)
  await until(() => {
    for (const page of pages) expect(vouched.get(page.name)).toBe(version)
  })
  // the server's answer to a fingerprint that differs
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  for (const page of pages) expect(page.session.status()).toMatchObject({ phase: 'live', version })
}

/** the Track Changes button (ribbon, status bar, shortcut) on `page` */
function switchTracking(page: Page, on: boolean): void {
  page.app.set('trackChanges', on)
  page.app.set('trackRevisionsDirty', true)
}

function positionOf(editor: Editor, text: string): number {
  let pos = -1
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isText && node.text!.includes(text)) pos = at + node.text!.indexOf(text)
    return pos < 0
  })
  if (pos < 0) throw new Error(`the document does not hold "${text}"`)
  return pos
}

const typeBefore = (page: Page, before: string, text: string): void => {
  page.editor.view.dispatch(page.editor.state.tr.insertText(text, positionOf(page.editor, before)))
}

/** each tracked insertion's text with its author */
const insertions = (page: Page): Record<string, string> => {
  const found: Record<string, string> = {}
  page.editor.state.doc.descendants((node) => {
    const ins = node.isText && node.marks.find((mark) => mark.type.name === 'ins')
    if (ins) found[node.text!] = ins.attrs.author as string
  })
  return found
}

const textOf = (page: Page): string => page.editor.state.doc.textContent

/** the file a host save of `page` stores */
async function saved(page: Page): Promise<Uint8Array> {
  let file: Uint8Array | undefined
  let failure: unknown
  page.session.save().then(
    (version) => (file = version.bytes),
    (error: unknown) => (failure = error),
  )
  await until(() => {
    if (failure) throw failure
    expect(file).toBeDefined()
  })
  return file!
}

/** the page total a saved file's footer shows before a viewer recomputes its fields */
async function cachedPageTotal(file: Uint8Array): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(file)
  const name = Object.keys(zip.files).find((part) => /^word\/footer\d*\.xml$/.test(part))
  const xml = name ? await zip.file(name)!.async('string') : ''
  return /NUMPAGES [\s\S]*?fldCharType="separate"\/><\/w:r><w:r><w:t>(\d+)<\/w:t>/.exec(xml)?.[1]
}

describe('track changes is one setting of the co-edited document', () => {
  it('a page follows the person who switched tracking, and its next typing is a revision', async () => {
    const alice = await open('Alice', plain)
    const bob = await open('Bob', plain)
    expect(bob.tracking()).toBe(false)

    switchTracking(alice, true)
    await until(() => expect(bob.tracking()).toBe(true))
    typeBefore(bob, 'zeta', 'from bob ')
    await until(() => expect(insertions(alice)).toEqual({ 'from bob ': 'Bob' }))
    expect(insertions(bob)).toEqual({ 'from bob ': 'Bob' })

    switchTracking(bob, false)
    await until(() => expect(alice.tracking()).toBe(false))
    typeBefore(alice, 'alpha', 'untracked ')
    await until(() => expect(textOf(bob)).toContain('untracked alpha'))
    expect(insertions(alice)).toEqual({ 'from bob ': 'Bob' })
    await agreed()
  })

  it('a page that joins later takes the value the session has', async () => {
    const alice = await open('Alice', plain)
    switchTracking(alice, true)
    await agreed()

    const carol = await open('Carol', plain)
    await until(() => expect(carol.tracking()).toBe(true))
    typeBefore(carol, 'zeta', 'from carol ')
    await until(() => expect(insertions(alice)).toEqual({ 'from carol ': 'Carol' }))
    await agreed()
  })

  it('writes the session’s value into the file whoever saves, and each saver’s own page total', async () => {
    const alice = await open('Alice', plain, { pageCount: 3 })
    const bob = await open('Bob', plain, { pageCount: 7 })
    const footer = `Page ${PAGE_MARK} of ${TOTAL_PAGES_MARK}`
    const final = alice.app.context.current.sections.at(-1)!.lastBlockIndex
    alice.app.set('sectionHfEdits', {
      [editKey(final, 'footer', 'default')]: {
        text: footer,
        pageNumber: false,
        paras: [{ runs: [{ text: footer }] }],
      },
    })
    switchTracking(alice, true)
    await agreed()

    const fromAlice = await saved(alice)
    const fromBob = await saved(bob)
    expect((await parseDocx(fromAlice)).trackRevisions).toBe(true)
    expect((await parseDocx(fromBob)).trackRevisions).toBe(true)
    expect(await cachedPageTotal(fromAlice)).toBe('3')
    expect(await cachedPageTotal(fromBob)).toBe('7')

    switchTracking(bob, false)
    await agreed()
    expect((await parseDocx(await saved(alice))).trackRevisions).toBeFalsy()
    expect((await parseDocx(await saved(bob))).trackRevisions).toBeFalsy()
  })

  it('keeps an AI edit a revision on a page whose tracking a peer switched off', async () => {
    const alice = await open('Alice', plain)
    const bob = await open('Bob', plain)
    switchTracking(alice, true)
    await until(() => expect(bob.tracking()).toBe(true))
    switchTracking(alice, false)
    await until(() => expect(bob.tracking()).toBe(false))

    const from = positionOf(bob.editor, 'beta')
    bob.editor.commands.setTextSelection({ from, to: from + 'beta'.length })
    const edit = await executeTool(
      bob.editor,
      { id: 'ai', name: 'replace_selection', input: { html: 'gamma' } },
      { bullet: null, ordered: null },
      { author: AI_REVISION_AUTHOR },
    )
    expect(edit.isError).toBeFalsy()
    await until(() => expect(insertions(alice)).toEqual({ gamma: AI_REVISION_AUTHOR }))
    // and the person's own typing on that page stays untracked
    typeBefore(bob, 'zeta', 'by hand ')
    await until(() => expect(textOf(alice)).toContain('by hand zeta'))
    expect(insertions(bob)).toEqual({ gamma: AI_REVISION_AUTHOR })
    await agreed()
  })

  it('does not share a recorder the App turned on by itself under a tracked-changes restriction', async () => {
    // the restriction's effect has run on one page and not yet on the other
    const alice = await open('Alice', plain, { trackChanges: true })
    const bob = await open('Bob', plain)
    await agreed()
    expect(alice.tracking()).toBe(true)
    expect(bob.tracking()).toBe(false)
    expect((await parseDocx(await saved(alice))).trackRevisions).toBeFalsy()
  })

  it('opens a session stored before tracking was shared with the document’s own value', async () => {
    // what an earlier build left in the store: the file and a log that never names tracking
    const scratch = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc((await parseDocx(tracked)).blocks) as never,
    })
    const typed = scratch.state.tr.insertText('earlier ', positionOf(scratch, 'alpha'))
    const ops: Json[] = [
      { kind: 'steps', steps: typed.steps.map((step) => step.toJSON() as Json) },
      { kind: 'side', key: 'titlePg', value: { titlePg: true, titlePgDirty: true } },
    ]
    scratch.destroy()
    await store.create(DOCUMENT, {
      id: 'earlier',
      format: FORMAT,
      baseHash: 'earlier',
      base: tracked,
    })
    await store.append(DOCUMENT, 'earlier', {
      base: 0,
      client: 'gone',
      seq: 1,
      author: 'Dana',
      ops,
    })

    const carol = await open('Carol', tracked)
    await until(() => expect(textOf(carol)).toContain('earlier alpha'))
    expect(carol.app.context.current.titlePg).toBe(true)
    expect(carol.tracking()).toBe(true)
    typeBefore(carol, 'zeta', 'from carol ')
    expect(insertions(carol)).toEqual({ 'from carol ': 'Carol' })
    await agreed()
    expect((await parseDocx(await saved(carol))).trackRevisions).toBe(true)

    // and the next person to switch it changes it for the session
    const bob = await open('Bob', tracked)
    expect(bob.tracking()).toBe(true)
    switchTracking(bob, false)
    await until(() => expect(carol.tracking()).toBe(false))
    await agreed()
    expect((await parseDocx(await saved(carol))).trackRevisions).toBeFalsy()
  })
})
