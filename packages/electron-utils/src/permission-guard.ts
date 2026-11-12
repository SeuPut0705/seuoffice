/// App-wide permission lockdown for every session in the suite.
///
/// Electron grants every permission a page asks for when its session has no
/// handler. Once the OS lets the app itself use the microphone (the slides
/// narration recording asks for it), a document a tab shows could open it too,
/// and the camera, the location and the rest, without a prompt. The guard
/// answers for the default session and for every session created after it:
/// no, unless the asking frame is the top frame of one of the app's own pages
/// and the permission is one those pages use.
///
/// A session that grants something else (the diagram tab's partition) sets its
/// own handlers once it has the session; that replaces these for it alone.
import type { App, Session, WebContents } from 'electron'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RENDERER_SCHEME } from './renderer-scheme'

/** Where the app's own pages are loaded from, besides the renderer scheme. */
export interface AppPages {
  /** a page name (a renderer host, or the shell's own name) to the dev server it is loaded from */
  devUrls?: Readonly<Record<string, string | undefined>>
  /** a page name to the folder its windows are loaded from as files */
  fileRoots?: Readonly<Record<string, string>>
}

export interface PermissionPolicy {
  pages: AppPages
  /** true while the slides editor in that webContents records narration */
  microphoneOpen: (webContentsId: number) => boolean
}

/** One request or check, in the terms the decision is made in. */
export interface PermissionAsk {
  permission: string
  webContentsId: number | undefined
  /** the last address the asking frame loaded */
  url: string | undefined
  isMainFrame: boolean
  /** `media` only: the devices asked for; none is a screen capture */
  media?: readonly string[] | undefined
}

/** The renderer host that records: its editor is the only page given `media`. */
const SLIDES_PAGE = 'slides'
const RENDERER_HOSTS: Readonly<Record<string, true | undefined>> = {
  docs: true,
  sheets: true,
  slides: true,
  pdf: true,
  markdown: true,
  html: true,
  mindmap: true,
  hwp: true,
  epub: true,
  diagram: true,
  help: true,
}

/** What the top frame of any of the app's own pages may use. */
const APP_PAGE_PERMISSIONS: Readonly<Record<string, true | undefined>> = {
  // navigator.clipboard.read/readText: Paste in the Word and the sheet editor
  'clipboard-read': true,
  // navigator.clipboard.writeText: the copy buttons of every editor and of the shell
  'clipboard-sanitized-write': true,
  // requestFullscreen: the slide show and the editors' presentation views
  fullscreen: true,
  // queryLocalFonts: the font lists (only ever checked, never requested)
  'local-fonts': true,
}

const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)

function originOf(address: string): string | null {
  try {
    const { origin } = new URL(address)
    // schemes without an origin of their own all read "null": never a match
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * Which of the app's own pages `address` is: its name, or null for anything
 * else (a document, a printed copy in a temp folder, a web address).
 */
export function appPageOf(pages: AppPages, address: string | undefined): string | null {
  if (!address) return null
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.protocol === `${RENDERER_SCHEME}:`)
    return RENDERER_HOSTS[url.hostname] === true ? url.hostname : null
  const origin = originOf(address)
  if (origin !== null) {
    for (const [page, devUrl] of Object.entries(pages.devUrls ?? {})) {
      if (devUrl && originOf(devUrl) === origin) return page
    }
  }
  if (url.protocol !== 'file:') return null
  let file: string
  try {
    file = fold(fileURLToPath(url))
  } catch {
    return null
  }
  for (const [page, root] of Object.entries(pages.fileRoots ?? {})) {
    if (file.startsWith(fold(resolve(root)) + sep)) return page
  }
  return null
}

export function permissionAllowed(policy: PermissionPolicy, ask: PermissionAsk): boolean {
  // A frame inside a page is a document (the HTML preview, a book chapter), whatever it loaded
  if (!ask.isMainFrame || ask.webContentsId === undefined) return false
  const page = appPageOf(policy.pages, ask.url)
  if (page === null) return false
  if (APP_PAGE_PERMISSIONS[ask.permission] === true) return true
  if (ask.permission !== 'media' || page !== SLIDES_PAGE || !ask.media) return false
  // Insert > Screen Recording (getDisplayMedia): Electron asks for `media` with no
  // device, then leaves the choice of screen to the session's display-media handler
  if (ask.media.length === 0) return true
  return ask.media.every((kind) => kind === 'audio') && policy.microphoneOpen(ask.webContentsId)
}

interface RequestDetails {
  isMainFrame: boolean
  requestingUrl?: string
  mediaTypes?: readonly string[]
}

interface CheckDetails {
  isMainFrame: boolean
  requestingUrl?: string
  mediaType?: string
}

/** The session's answer to a page asking for a permission. */
export function permissionRequestHandler(policy: PermissionPolicy) {
  return (
    contents: Pick<WebContents, 'id'> | null,
    permission: string,
    callback: (granted: boolean) => void,
    details: RequestDetails,
  ): void => {
    callback(
      permissionAllowed(policy, {
        permission,
        webContentsId: contents?.id,
        url: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        media: permission === 'media' ? details.mediaTypes : undefined,
      }),
    )
  }
}

/** The session's answer to a page asking whether it holds a permission: the same as to a request. */
export function permissionCheckHandler(policy: PermissionPolicy) {
  return (
    contents: Pick<WebContents, 'id'> | null,
    permission: string,
    _requestingOrigin: string,
    details: CheckDetails,
  ): boolean => {
    const device = details.mediaType
    return permissionAllowed(policy, {
      permission,
      webContentsId: contents?.id,
      url: details.requestingUrl,
      isMainFrame: details.isMainFrame,
      // a check names one device; one that names none is not the microphone
      media: device === 'audio' || device === 'video' ? [device] : undefined,
    })
  }
}

/**
 * Guard the default session and every session created from now on. Call
 * before app ready, so no session exists without its answer.
 */
export function installPermissionGuard(
  app: Pick<App, 'on' | 'whenReady'>,
  sessions: { readonly defaultSession: Session },
  policy: PermissionPolicy,
): void {
  const guard = (ses: Session): void => {
    ses.setPermissionRequestHandler(permissionRequestHandler(policy))
    ses.setPermissionCheckHandler(permissionCheckHandler(policy))
  }
  // fires inside session.fromPartition, before the caller can load a page in it
  app.on('session-created', guard)
  // the default session is only reachable once the app is ready
  void app.whenReady().then(() => guard(sessions.defaultSession))
}
