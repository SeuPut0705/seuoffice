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

function request(contents: { id: number } | null, permission: string, asked: Asked): boolean {
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
function check(contents: { id: number } | null, permission: string, asked: Asked): boolean {
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
