/**
 * What a page may ask the system for: nothing for a document, the features
 * they use for the app's own pages, the microphone only for the slides editor
 * that is recording.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  appPageOf,
  installPermissionGuard,
  permissionCheckHandler,
  permissionRequestHandler,
  type PermissionPolicy,
} from '../src/permission-guard'

const SHELL_DIR = join(tmpdir(), 'permission-guard-test', 'out', 'renderer')
const SLIDES = 'genoffice-app://slides/index.html?mode=tab'
const DOCS = 'genoffice-app://docs/index.html?mode=tab'
const HOME = pathToFileURL(join(SHELL_DIR, 'index.html')).toString()
const PRINTED = pathToFileURL(join(tmpdir(), 'genoffice-html-print-1', 'print.html')).toString()
const PREVIEW = 'html-preview://7/index.html'
const WEB = 'https://example.com/page'

const SLIDES_TAB = { id: 21 }
const OTHER_SLIDES_TAB = { id: 22 }
const DOCS_TAB = { id: 23 }
const HTML_TAB = { id: 24 }

const recording = new Set<number>()
const policy: PermissionPolicy = {
  pages: {
    devUrls: { sheets: 'http://localhost:5174/', pdf: undefined },
    fileRoots: { shell: SHELL_DIR },
  },
  microphoneOpen: (id) => recording.has(id),
}
const onRequest = permissionRequestHandler(policy)
const onCheck = permissionCheckHandler(policy)

interface Asked {
  url: string
  isMainFrame?: boolean
  media?: string[]
}

type Asker = Parameters<typeof onRequest>[0]

function request(contents: Asker, permission: string, asked: Asked): boolean {
  let answer: boolean | undefined
  onRequest(contents, permission, (granted) => (answer = granted), {
    isMainFrame: asked.isMainFrame ?? true,
    requestingUrl: asked.url,
    ...(asked.media ? { mediaTypes: asked.media } : {}),
  })
  if (answer === undefined) throw new Error(`no answer to the ${permission} request`)
  return answer
}

/** The check Electron makes for the same thing; `media` checks name one device at a time */
function check(contents: Asker, permission: string, asked: Asked): boolean {
  const devices = asked.media ?? [undefined]
  return devices.every((mediaType) =>
    onCheck(contents, permission, new URL(asked.url).origin, {
      isMainFrame: asked.isMainFrame ?? true,
      requestingUrl: asked.url,
      ...(mediaType ? { mediaType } : {}),
    }),
  )
}

function whileRecording<T>(contents: { id: number }, run: () => T): T {
  recording.add(contents.id)
  try {
    return run()
  } finally {
    recording.delete(contents.id)
  }
}

describe('the microphone', () => {
  const audio = { url: SLIDES, media: ['audio'] }

  it('opens for the slides editor that is recording', () => {
    whileRecording(SLIDES_TAB, () => {
      expect(request(SLIDES_TAB, 'media', audio)).toBe(true)
      expect(check(SLIDES_TAB, 'media', audio)).toBe(true)
    })
  })

  it('stays shut when nothing records', () => {
    expect(request(SLIDES_TAB, 'media', audio)).toBe(false)
    expect(check(SLIDES_TAB, 'media', audio)).toBe(false)
  })

  it('stays shut for every other page while a slides editor records', () => {
    whileRecording(SLIDES_TAB, () => {
      // another slides tab, another editor, and documents in the recording tab's own process
      expect(request(OTHER_SLIDES_TAB, 'media', audio)).toBe(false)
      expect(request(DOCS_TAB, 'media', { url: DOCS, media: ['audio'] })).toBe(false)
      for (const url of [PRINTED, PREVIEW, WEB]) {
        expect(request(SLIDES_TAB, 'media', { url, media: ['audio'] }), url).toBe(false)
        expect(check(SLIDES_TAB, 'media', { url, media: ['audio'] }), url).toBe(false)
      }
      // a frame inside the slides editor, even one that loaded the editor's own address
      expect(request(SLIDES_TAB, 'media', { ...audio, isMainFrame: false })).toBe(false)
      expect(check(SLIDES_TAB, 'media', { ...audio, isMainFrame: false })).toBe(false)
      expect(request(null, 'media', audio)).toBe(false)
    })
  })

  it('never comes with the camera', () => {
    whileRecording(SLIDES_TAB, () => {
      expect(request(SLIDES_TAB, 'media', { url: SLIDES, media: ['audio', 'video'] })).toBe(false)
      expect(request(SLIDES_TAB, 'media', { url: SLIDES, media: ['video'] })).toBe(false)
      expect(check(SLIDES_TAB, 'media', { url: SLIDES, media: ['video'] })).toBe(false)
      // a check that names no device is not the microphone
      expect(check(SLIDES_TAB, 'media', { url: SLIDES })).toBe(false)
    })
  })
})

describe('what the app’s own pages use', () => {
  it('lets the Word editor list the installed fonts', () => {
    expect(check(DOCS_TAB, 'local-fonts', { url: DOCS })).toBe(true)
  })

  it('lets an editor and the shell’s own windows paste, copy and go full screen', () => {
    for (const url of [DOCS, SLIDES, HOME, 'http://localhost:5174/index.html']) {
      for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']) {
        expect(request(DOCS_TAB, permission, { url }), `${permission} ${url}`).toBe(true)
        expect(check(DOCS_TAB, permission, { url }), `${permission} ${url}`).toBe(true)
      }
    }
  })

  it('lets the slides editor record the screen, and no other editor', () => {
    expect(request(SLIDES_TAB, 'media', { url: SLIDES, media: [] })).toBe(true)
    expect(request(DOCS_TAB, 'media', { url: DOCS, media: [] })).toBe(false)
    expect(request(HTML_TAB, 'media', { url: PREVIEW, media: [] })).toBe(false)
  })

  it('gives them nothing they do not use', () => {
    for (const permission of [
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'pointerLock',
      'keyboardLock',
      'openExternal',
      'idle-detection',
      'window-management',
      'speaker-selection',
      'hid',
      'serial',
      'usb',
      'fileSystem',
      'unknown',
      'something-chromium-adds-later',
    ]) {
      expect(request(DOCS_TAB, permission, { url: DOCS }), permission).toBe(false)
      expect(check(DOCS_TAB, permission, { url: DOCS }), permission).toBe(false)
    }
  })
})

describe('a document', () => {
  it('gets nothing, whatever it asks for', () => {
    for (const url of [PRINTED, PREVIEW, WEB, 'about:blank', 'data:text/html,<p>x</p>']) {
      for (const permission of [
        'geolocation',
        'notifications',
        'clipboard-read',
        'clipboard-sanitized-write',
        'fullscreen',
        'local-fonts',
        'openExternal',
      ]) {
        expect(request(HTML_TAB, permission, { url }), `${permission} ${url}`).toBe(false)
        expect(check(HTML_TAB, permission, { url }), `${permission} ${url}`).toBe(false)
      }
    }
  })

  it('gets nothing as a frame inside one of the app’s pages', () => {
    for (const permission of ['clipboard-read', 'fullscreen', 'local-fonts', 'geolocation']) {
      expect(request(DOCS_TAB, permission, { url: DOCS, isMainFrame: false }), permission).toBe(
        false,
      )
      expect(check(DOCS_TAB, permission, { url: DOCS, isMainFrame: false }), permission).toBe(false)
    }
  })
})

describe('a frame inside one of the app’s pages', () => {
  const HWP = 'genoffice-app://hwp/index.html'
  const HWP_ORIGIN = 'genoffice-app://hwp'
  // the HWP editor itself runs in a frame of the HWP page (apps/hwp studioUrl)
  const STUDIO = 'genoffice-app://hwp/studio/index.html?chrome=embed&lang=ko'
  const OWN_USES = ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'local-fonts']

  interface FakeFrame {
    url: string
    origin: string
    parent: FakeFrame | null
    framesInSubtree: FakeFrame[]
  }

  /**
   * A tab the way Electron describes it: the page at the top (`origin` as Chromium reports it,
   * "null" for a sandboxed frame) and the frames inside it, each inside the frame at `inside`.
   */
  function tab(
    id: number,
    top: { url: string; origin: string },
    frames: Array<{ url: string; origin: string; inside?: number }>,
  ): { id: number; mainFrame: FakeFrame } {
    const all: FakeFrame[] = [{ ...top, parent: null, framesInSubtree: [] }]
    for (const frame of frames) {
      all.push({
        url: frame.url,
        origin: frame.origin,
        parent: all[frame.inside ?? 0]!,
        framesInSubtree: [],
      })
    }
    all[0]!.framesInSubtree = all
    return { id, mainFrame: all[0]! }
  }

  const frameOf = (url: string, media?: string[]): Asked => ({
    url,
    isMainFrame: false,
    ...(media ? { media } : {}),
  })

  it('lets the HWP editor’s own frame copy, paste, list the fonts and go full screen', () => {
    const hwp = tab(31, { url: HWP, origin: HWP_ORIGIN }, [{ url: STUDIO, origin: HWP_ORIGIN }])
    for (const permission of OWN_USES) {
      expect(request(hwp, permission, frameOf(STUDIO)), permission).toBe(true)
      expect(check(hwp, permission, frameOf(STUDIO)), permission).toBe(true)
    }
    expect(request(hwp, 'geolocation', frameOf(STUDIO))).toBe(false)
    expect(check(hwp, 'notifications', frameOf(STUDIO))).toBe(false)
  })

  it('keeps the microphone, the camera and the screen with the top frame', () => {
    const inner = 'genoffice-app://slides/index.html?frame=1'
    const slides = tab(21, { url: SLIDES, origin: 'genoffice-app://slides' }, [
      { url: inner, origin: 'genoffice-app://slides' },
    ])
    whileRecording(slides, () => {
      expect(request(slides, 'media', { url: SLIDES, media: ['audio'] })).toBe(true)
      expect(request(slides, 'media', frameOf(inner, ['audio']))).toBe(false)
      expect(check(slides, 'media', frameOf(inner, ['audio']))).toBe(false)
      expect(request(slides, 'media', frameOf(inner, ['video']))).toBe(false)
      expect(request(slides, 'media', frameOf(inner, []))).toBe(false)
    })
  })

  it('gives a document frame nothing, even one that sent itself to an address of the app', () => {
    // the HTML tab's preview frame is sandboxed: whatever it loads, its origin is its own
    const html = tab(
      32,
      { url: 'genoffice-app://html/index.html', origin: 'genoffice-app://html' },
      [
        { url: PREVIEW, origin: 'null' },
        { url: 'genoffice-app://html/index.html?again=1', origin: 'null' },
        { url: 'about:srcdoc', origin: 'genoffice-app://html' },
      ],
    )
    for (const url of [PREVIEW, 'genoffice-app://html/index.html?again=1', 'about:srcdoc']) {
      for (const permission of [...OWN_USES, 'geolocation']) {
        expect(request(html, permission, frameOf(url)), `${permission} ${url}`).toBe(false)
        expect(check(html, permission, frameOf(url)), `${permission} ${url}`).toBe(false)
      }
    }
  })

  it('gives the editor’s frame nothing when a document frame holds it', () => {
    const held = tab(33, { url: HWP, origin: HWP_ORIGIN }, [
      { url: PREVIEW, origin: 'null' },
      { url: STUDIO, origin: HWP_ORIGIN, inside: 1 },
    ])
    for (const permission of OWN_USES) {
      expect(request(held, permission, frameOf(STUDIO)), permission).toBe(false)
      expect(check(held, permission, frameOf(STUDIO)), permission).toBe(false)
    }
  })

  it('gives it nothing in another editor’s page or in a page that is not the app’s', () => {
    const inHtml = tab(
      34,
      { url: 'genoffice-app://html/index.html', origin: 'genoffice-app://html' },
      [{ url: STUDIO, origin: HWP_ORIGIN }],
    )
    const onTheWeb = tab(35, { url: WEB, origin: 'https://example.com' }, [
      { url: STUDIO, origin: HWP_ORIGIN },
    ])
    for (const contents of [inHtml, onTheWeb]) {
      for (const permission of OWN_USES) {
        expect(request(contents, permission, frameOf(STUDIO)), permission).toBe(false)
        expect(check(contents, permission, frameOf(STUDIO)), permission).toBe(false)
      }
    }
  })

  it('refuses when a document frame is at the same address as the editor’s', () => {
    const twins = tab(36, { url: HWP, origin: HWP_ORIGIN }, [
      { url: STUDIO, origin: HWP_ORIGIN },
      { url: STUDIO, origin: 'null' },
    ])
    expect(request(twins, 'clipboard-read', frameOf(STUDIO))).toBe(false)
    expect(check(twins, 'local-fonts', frameOf(STUDIO))).toBe(false)
  })

  it('refuses a frame that is not in the tab, or whose tab went away while it asked', () => {
    const hwp = tab(37, { url: HWP, origin: HWP_ORIGIN }, [{ url: STUDIO, origin: HWP_ORIGIN }])
    expect(request(hwp, 'clipboard-read', frameOf(`${STUDIO}&other=1`))).toBe(false)
    const gone = {
      id: 38,
      get mainFrame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    }
    expect(request(gone, 'clipboard-read', frameOf(STUDIO))).toBe(false)
    expect(check(gone, 'local-fonts', frameOf(STUDIO))).toBe(false)
  })
})

describe('appPageOf', () => {
  it('names the app’s own pages', () => {
    expect(appPageOf(policy.pages, SLIDES)).toBe('slides')
    expect(appPageOf(policy.pages, 'http://localhost:5174/src/main.tsx')).toBe('sheets')
    expect(appPageOf(policy.pages, HOME)).toBe('shell')
  })

  it('names nothing else', () => {
    for (const address of [
      undefined,
      '',
      'not an address',
      'genoffice-app://not-an-editor/index.html',
      WEB,
      'http://localhost:5175/',
      'https://localhost:5174/',
      PRINTED,
      // a folder that only starts like the shell's, and a way out of it
      pathToFileURL(join(`${SHELL_DIR}-other`, 'index.html')).toString(),
      `${pathToFileURL(SHELL_DIR).toString()}/../../page.html`,
      pathToFileURL(SHELL_DIR).toString(),
      'file://remote-host/share/out/renderer/index.html',
    ]) {
      expect(appPageOf(policy.pages, address), String(address)).toBeNull()
    }
  })
})

describe('installPermissionGuard', () => {
  interface FakeSession {
    requestHandler: unknown
    checkHandler: unknown
    setPermissionRequestHandler(handler: unknown): void
    setPermissionCheckHandler(handler: unknown): void
  }
  const fakeSession = (): FakeSession => {
    const ses: FakeSession = {
      requestHandler: null,
      checkHandler: null,
      setPermissionRequestHandler: (handler) => {
        ses.requestHandler = handler
      },
      setPermissionCheckHandler: (handler) => {
        ses.checkHandler = handler
      },
    }
    return ses
  }

  it('answers for the default session once the app is ready and for each session created', async () => {
    const listeners = new Map<string, (ses: FakeSession) => void>()
    let ready = (): void => {}
    const whenReady = new Promise<void>((resolve) => (ready = resolve))
    const defaultSession = fakeSession()
    let defaultReads = 0
    installPermissionGuard(
      {
        on: (event: string, listener: (ses: FakeSession) => void) => listeners.set(event, listener),
        whenReady: () => whenReady,
      } as never,
      {
        get defaultSession() {
          defaultReads += 1
          return defaultSession
        },
      } as never,
      policy,
    )
    // Electron has no default session to hand out before the app is ready
    expect(defaultReads).toBe(0)
    ready()
    await whenReady
    await Promise.resolve()
    expect(typeof defaultSession.requestHandler).toBe('function')
    expect(typeof defaultSession.checkHandler).toBe('function')

    const partition = fakeSession()
    listeners.get('session-created')!(partition)
    expect(typeof partition.requestHandler).toBe('function')
    expect(typeof partition.checkHandler).toBe('function')
  })
})
