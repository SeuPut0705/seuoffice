// @vitest-environment node
/**
 * What a page may ask the system for. A document a tab shows (an HTML page, a
 * printed copy, a web address) gets nothing in any session the app creates;
 * the app's own pages get what their features use, and the microphone only
 * while the slides editor records.
 *
 * The fake `session` answers the way Electron 43 does (checked against the
 * real runtime): a session without a handler grants every request and every
 * check, and `session-created` fires inside `fromPartition` before it returns.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void
type CheckHandler = (
  contents: unknown,
  permission: string,
  origin: string,
  details: Record<string, unknown>,
) => boolean

interface FakeSession {
  partition: string
  requestHandler: RequestHandler | null
  checkHandler: CheckHandler | null
  setPermissionRequestHandler(handler: RequestHandler | null): void
  setPermissionCheckHandler(handler: CheckHandler | null): void
  setSpellCheckerEnabled(on: boolean): void
  protocol: { handle(): void }
  webRequest: { onBeforeRequest(): void }
}

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const created: FakeSession[] = []
  const byPartition = new Map<string, FakeSession>()
  const sessionOf = (partition: string): FakeSession => {
    const known = byPartition.get(partition)
    if (known) return known
    const made: FakeSession = {
      partition,
      requestHandler: null,
      checkHandler: null,
      setPermissionRequestHandler: (handler) => {
        made.requestHandler = handler
      },
      setPermissionCheckHandler: (handler) => {
        made.checkHandler = handler
      },
      setSpellCheckerEnabled: () => {},
      protocol: { handle: () => {} },
      webRequest: { onBeforeRequest: () => {} },
    }
    byPartition.set(partition, made)
    created.push(made)
    for (const listener of listeners.get('session-created') ?? []) listener(made)
    return made
  }
  return {
    created,
    app: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      whenReady: () => Promise.resolve(),
      getPath: (name: string) => `/nowhere/${name}`,
    },
    session: {
      get defaultSession(): FakeSession {
        return sessionOf('')
      },
      fromPartition: (partition: string) => sessionOf(partition),
    },
    // the hidden window the mind map prints from
    BrowserWindow: class {
      webContents = { printToPDF: async () => Buffer.from('%PDF') }
      constructor(readonly options: { webPreferences: { session: FakeSession } }) {}
      loadFile = async (): Promise<void> => {}
      isDestroyed = (): boolean => false
      destroy = (): void => {}
    },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  session: electron.session,
  BrowserWindow: electron.BrowserWindow,
  dialog: {},
  ipcMain: { handle: () => {} },
}))

import { diagramSession } from '../../diagram/src/main/diagram-session'
import { DIAGRAM_PARTITION } from '../../diagram/src/main/network-guard'
import { EXPORT_PARTITION, pageToPdf } from '../../mindmap/src/main/export-main'
import { installShellPermissionGuard } from '../src/main/permission-guard'

const RENDERER_DIR = join(tmpdir(), 'shell-permission-test', 'out', 'renderer')
const SLIDES_TAB = { id: 11 }
const DOCS_TAB = { id: 12 }
const HTML_TAB = { id: 13 }
const recording = new Set<number>()

/** A request the way Electron routes it: granted when the session has no handler */
function request(
  ses: FakeSession,
  contents: { id: number },
  permission: string,
  details: Record<string, unknown>,
): boolean {
  if (!ses.requestHandler) return true
  let answer: boolean | undefined
  ses.requestHandler(contents, permission, (granted) => (answer = granted), details)
  if (answer === undefined) throw new Error(`no answer to the ${permission} request`)
  return answer
}

/** A check the way Electron routes it: granted when the session has no handler */
function check(
  ses: FakeSession,
  contents: { id: number },
  permission: string,
  details: Record<string, unknown>,
): boolean {
  if (!ses.checkHandler) return true
  const url = typeof details.requestingUrl === 'string' ? details.requestingUrl : ''
  return ses.checkHandler(contents, permission, new URL(url).origin, details)
}

const mainFrame = (url: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  isMainFrame: true,
  requestingUrl: url,
  ...more,
})

/** Pages that are a document, not the app: a printed copy, a page the HTML tab shows, the web */
const DOCUMENT_PAGES = [
  pathToFileURL(join(tmpdir(), 'seuoffice-html-print-x', 'print.html')).toString(),
  'html-preview://7/index.html',
  'https://example.com/',
]

const sessionOf = (partition: string): FakeSession => {
  const found = electron.created.find((ses) => ses.partition === partition)
  if (!found) throw new Error(`the app created no session for "${partition}"`)
  return found
}

beforeAll(async () => {
  installShellPermissionGuard({
    microphoneOpen: (id) => recording.has(id),
    rendererDir: RENDERER_DIR,
    env: {},
  })
  // every session the app makes, through the code that makes it
  await Promise.resolve()
  void electron.session.defaultSession
  diagramSession({ rendererDir: RENDERER_DIR, drawioDir: '', bridgeFile: '', devOrigins: [] })
  await pageToPdf('<!doctype html><title>map</title>')
})

describe('every session the app creates', () => {
  it('is the default one, the diagram tab’s and the mind map’s export', () => {
    expect(electron.created.map((ses) => ses.partition).sort()).toEqual(
      ['', DIAGRAM_PARTITION, EXPORT_PARTITION].sort(),
    )
  })

  it('refuses a document the microphone, the camera, the location and notifications', () => {
    for (const ses of electron.created) {
      for (const url of DOCUMENT_PAGES) {
        const where = `${ses.partition || 'default'} session, ${url}`
        expect(
          request(ses, HTML_TAB, 'media', mainFrame(url, { mediaTypes: ['audio'] })),
          where,
        ).toBe(false)
        expect(
          request(ses, HTML_TAB, 'media', mainFrame(url, { mediaTypes: ['video'] })),
          where,
        ).toBe(false)
        expect(request(ses, HTML_TAB, 'geolocation', mainFrame(url)), where).toBe(false)
        expect(request(ses, HTML_TAB, 'notifications', mainFrame(url)), where).toBe(false)
        expect(check(ses, HTML_TAB, 'media', mainFrame(url, { mediaType: 'audio' })), where).toBe(
          false,
        )
        expect(check(ses, HTML_TAB, 'geolocation', mainFrame(url)), where).toBe(false)
      }
    }
  })

  it('guards a session nobody wrote a handler for from its first page', () => {
    const later = electron.session.fromPartition('persist:added-later')
    for (const url of DOCUMENT_PAGES) {
      expect(
        request(later, HTML_TAB, 'media', mainFrame(url, { mediaTypes: ['audio'] })),
        url,
      ).toBe(false)
      expect(check(later, HTML_TAB, 'local-fonts', mainFrame(url)), url).toBe(false)
    }
  })
})

describe('the app’s own pages in the default session', () => {
  const slides = 'genoffice-app://slides/index.html?mode=tab'
  const docs = 'genoffice-app://docs/index.html?mode=tab'
  const audio = { mediaTypes: ['audio'] }

  it('lets the slides editor open the microphone only while it records', () => {
    const ses = sessionOf('')
    expect(request(ses, SLIDES_TAB, 'media', mainFrame(slides, audio))).toBe(false)
    recording.add(SLIDES_TAB.id)
    try {
      expect(request(ses, SLIDES_TAB, 'media', mainFrame(slides, audio))).toBe(true)
      expect(check(ses, SLIDES_TAB, 'media', mainFrame(slides, { mediaType: 'audio' }))).toBe(true)
      // the camera, another editor and a document stay refused meanwhile
      expect(
        request(ses, SLIDES_TAB, 'media', mainFrame(slides, { mediaTypes: ['audio', 'video'] })),
      ).toBe(false)
      expect(request(ses, DOCS_TAB, 'media', mainFrame(docs, audio))).toBe(false)
      expect(request(ses, HTML_TAB, 'media', mainFrame(DOCUMENT_PAGES[1]!, audio))).toBe(false)
    } finally {
      recording.delete(SLIDES_TAB.id)
    }
    expect(request(ses, SLIDES_TAB, 'media', mainFrame(slides, audio))).toBe(false)
  })

  it('lets the Word editor list the installed fonts, paste and go full screen', () => {
    const ses = sessionOf('')
    expect(check(ses, DOCS_TAB, 'local-fonts', mainFrame(docs))).toBe(true)
    expect(request(ses, DOCS_TAB, 'clipboard-read', mainFrame(docs))).toBe(true)
    expect(request(ses, DOCS_TAB, 'clipboard-sanitized-write', mainFrame(docs))).toBe(true)
    expect(request(ses, DOCS_TAB, 'fullscreen', mainFrame(docs))).toBe(true)
    expect(request(ses, DOCS_TAB, 'geolocation', mainFrame(docs))).toBe(false)
  })

  it('lets the shell’s own windows copy, and no other file', () => {
    const ses = sessionOf('')
    const home = pathToFileURL(join(RENDERER_DIR, 'index.html')).toString()
    const elsewhere = pathToFileURL(join(RENDERER_DIR, '..', '..', 'page.html')).toString()
    expect(request(ses, { id: 1 }, 'clipboard-sanitized-write', mainFrame(home))).toBe(true)
    expect(request(ses, { id: 1 }, 'clipboard-sanitized-write', mainFrame(elsewhere))).toBe(false)
  })

  it('lets the HWP editor, which runs in a frame of its own page, copy and list the fonts', () => {
    const ses = sessionOf('')
    const studio = 'genoffice-app://hwp/studio/index.html?chrome=embed&lang=ko'
    const frames = (origin: string): { id: number; mainFrame: unknown } => {
      const top = {
        url: 'genoffice-app://hwp/index.html',
        origin: 'genoffice-app://hwp',
        parent: null,
        framesInSubtree: [] as unknown[],
      }
      top.framesInSubtree = [top, { url: studio, origin, parent: top }]
      return { id: 14, mainFrame: top }
    }
    const inFrame = { isMainFrame: false, requestingUrl: studio }
    const hwp = frames('genoffice-app://hwp')
    expect(request(ses, hwp, 'clipboard-sanitized-write', inFrame)).toBe(true)
    expect(request(ses, hwp, 'clipboard-read', inFrame)).toBe(true)
    expect(check(ses, hwp, 'local-fonts', inFrame)).toBe(true)
    expect(request(ses, hwp, 'media', { ...inFrame, mediaTypes: ['audio'] })).toBe(false)
    // the same address in a sandboxed frame is a document
    const boxed = frames('null')
    expect(request(ses, boxed, 'clipboard-sanitized-write', inFrame)).toBe(false)
    expect(check(ses, boxed, 'local-fonts', inFrame)).toBe(false)
  })
})
