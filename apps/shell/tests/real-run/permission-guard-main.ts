/**
 * Real-run check of the permission guard: the main process of a tiny Electron app that installs
 * the real guard and asks, from real pages, for what the editors ask for. Started by
 * permission-guard-run.ts (see there for how to run it and what it does to the clipboard).
 *
 * The pages are served on the app's renderer scheme the way the built editors are:
 *
 *   genoffice-app://hwp/index.html      the HWP page; the editor runs in a frame of it
 *                                       (./studio/index.html, as apps/hwp studioUrl), and a
 *                                       second, sandboxed frame stands for a document: one the
 *                                       page even delegated every feature to, so that its
 *                                       questions reach the guard instead of stopping in Blink
 *   genoffice-app://sheets/index.html   an editor that works in its top frame
 *   genoffice-app://slides/index.html   the editor that records, with a frame of its own
 */
import { app, BrowserWindow, clipboard, protocol, session } from 'electron'
import type { Session, WebFrameMain } from 'electron'
import { installPermissionGuard } from '../../../../packages/electron-utils/src/permission-guard'
import {
  RENDERER_SCHEME,
  RENDERER_SCHEME_PRIVILEGE,
} from '../../../../packages/electron-utils/src/renderer-scheme'

// a made-up microphone: the lease is checked without opening a real one
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
protocol.registerSchemesAsPrivileged([RENDERER_SCHEME_PRIVILEGE])

const MARKER = 'rhwp-studio-clipboard'
const PAGES: Record<string, string> = {
  'hwp/index.html':
    '<!doctype html><title>hwp</title><body>hwp' +
    '<iframe id="studio" src="./studio/index.html?chrome=embed&lang=ko"></iframe>' +
    '<iframe id="document" sandbox="allow-scripts"' +
    ' allow="clipboard-read; clipboard-write; local-fonts; microphone"' +
    ' src="./studio/index.html?document=1"></iframe>',
  'hwp/studio/index.html': '<!doctype html><title>studio</title><body>studio',
  'sheets/index.html': '<!doctype html><title>sheets</title><body>sheets',
  'slides/index.html':
    '<!doctype html><title>slides</title><body>slides<iframe id="inner" src="./inner.html"></iframe>',
  'slides/inner.html': '<!doctype html><title>inner</title><body>inner',
}

// ── what the pages run (each answers a short word, never throws) ──
const refused = '(e) => "refused:" + e.name + ": " + e.message'
/** rhwp-studio's copy: text and HTML through the async clipboard */
const COPY_HTML = `navigator.clipboard.write([new ClipboardItem({
  'text/plain': new Blob(['real run'], { type: 'text/plain' }),
  'text/html': new Blob(['<!-- ${MARKER}:real-run --><p>${MARKER} real run</p>'], { type: 'text/html' }),
})]).then(() => 'written', ${refused})`
const READ_HTML = `navigator.clipboard.read().then(async (items) => {
  for (const item of items) if (item.types.includes('text/html')) return (await item.getType('text/html')).text()
  return 'no html'
}, ${refused})`
const LIST_FONTS = `window.queryLocalFonts().then((fonts) => (fonts.length > 0 ? 'listed' : 'none'), ${refused})`
/** the sheet editor's range copy: text, a table and its picture */
const COPY_RANGE = `new Promise((resolve) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 4
  canvas.getContext('2d').fillRect(0, 0, 4, 4)
  canvas.toBlob(resolve, 'image/png')
}).then((png) => navigator.clipboard.write([new ClipboardItem({
  'text/plain': new Blob(['a\\tb\\tc'], { type: 'text/plain' }),
  'text/html': new Blob(['<table><tr><td>a</td><td>b</td><td>c</td></tr></table>'], { type: 'text/html' }),
  'image/png': png,
})])).then(() => 'written', ${refused})`
const WATCH_PASTE = `(document.addEventListener('paste', (event) => {
  window.__pasted = event.clipboardData.getData('text/plain') + '|' + event.clipboardData.getData('text/html')
}), 'watching')`
const MICROPHONE = `navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
  for (const track of stream.getTracks()) track.stop()
  return 'stream'
}, ${refused})`

const trace: string[] = []
const lines: string[] = []
let failures = 0

function expectThat(what: string, got: string | boolean, wanted: (got: string) => boolean): void {
  const ok = wanted(String(got))
  if (!ok) failures += 1
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${String(got).replace(/\s+/g, ' ').slice(0, 120)}`)
}

/** The guard's own handlers, with each answer written down as it is given. */
function traced(ses: Session): Session {
  return {
    setPermissionRequestHandler: (handler: (...args: unknown[]) => void) =>
      ses.setPermissionRequestHandler((contents, permission, callback, details) =>
        handler(
          contents,
          permission,
          (granted: boolean) => {
            trace.push(`request ${permission} ${JSON.stringify(details)} -> ${granted}`)
            callback(granted)
          },
          details,
        ),
      ),
    setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) =>
      ses.setPermissionCheckHandler((contents, permission, origin, details) => {
        const granted = handler(contents, permission, origin, details)
        trace.push(`check ${permission} ${JSON.stringify(details)} -> ${granted}`)
        return granted
      }),
  } as unknown as Session
}

const recording = new Set<number>()
// before ready, as the shell does
installPermissionGuard(
  app,
  {
    get defaultSession() {
      return traced(session.defaultSession)
    },
  },
  { pages: {}, microphoneOpen: (id) => recording.has(id) },
)

async function ask(frame: WebFrameMain, code: string): Promise<string> {
  try {
    return String(
      await Promise.race([
        frame.executeJavaScript(code, true),
        new Promise((resolve) => setTimeout(() => resolve('no answer'), 5000)),
      ]),
    )
  } catch (error) {
    return `threw ${error instanceof Error ? error.message : String(error)}`
  }
}

async function open(page: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL(`${RENDERER_SCHEME}://${page}`)
  win.webContents.focus()
  return win
}

/**
 * The frame of `win` whose address holds `part`, with the keyboard focus a person's click gives
 * it: the async clipboard answers no other frame.
 */
async function frameAt(win: BrowserWindow, id: string, part: string): Promise<WebFrameMain> {
  const frame = win.webContents.mainFrame.frames.find((candidate) => candidate.url.includes(part))
  if (!frame) throw new Error(`no frame at ${part}`)
  win.webContents.focus()
  await win.webContents.mainFrame.executeJavaScript(
    `document.getElementById(${JSON.stringify(id)}).focus()`,
    true,
  )
  await frame.executeJavaScript('window.focus()', true)
  for (let turn = 0; turn < 40; turn += 1) {
    if ((await frame.executeJavaScript('document.hasFocus()')) === true) return frame
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the frame at ${part} never took the focus`)
}

/**
 * What the system clipboard holds once `settled` says so, or what it holds after `ms`: a page's
 * write is answered before the system has it.
 */
async function onClipboard(
  read: () => string,
  settled: (got: string) => boolean,
  ms = 3000,
): Promise<string> {
  const until = Date.now() + ms
  while (!settled(read()) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return read()
}

function section(title: string): void {
  lines.push(`── ${title}`)
  trace.length = 0
}

function showTrace(): void {
  for (const row of trace) lines.push(`     ${row}`)
}

async function run(): Promise<void> {
  session.defaultSession.protocol.handle(RENDERER_SCHEME, (request) => {
    const { hostname, pathname } = new URL(request.url)
    const page = PAGES[`${hostname}${pathname}`]
    return page === undefined
      ? new Response(null, { status: 404 })
      : new Response(page, { headers: { 'content-type': 'text/html' } })
  })

  section('the HWP editor, in its frame of the HWP page')
  const hwp = await open('hwp/index.html')
  const studio = await frameAt(hwp, 'studio', 'chrome=embed')
  clipboard.clear()
  expectThat('copies text and HTML', await ask(studio, COPY_HTML), (got) => got === 'written')
  expectThat(
    'the system clipboard holds its HTML',
    await onClipboard(
      () => clipboard.readHTML(),
      (got) => got.includes(MARKER),
    ),
    (got) => got.includes(MARKER),
  )
  expectThat('reads the HTML back', await ask(studio, READ_HTML), (got) => got.includes(MARKER))
  expectThat('lists the fonts of this PC', await ask(studio, LIST_FONTS), (got) => got === 'listed')
  showTrace()

  section('a document frame at the same address (sandboxed, every feature delegated to it)')
  const documentFrame = await frameAt(hwp, 'document', 'document=1')
  clipboard.clear()
  expectThat('cannot copy', await ask(documentFrame, COPY_HTML), (got) => got.startsWith('refused'))
  expectThat(
    'left the system clipboard empty',
    await onClipboard(
      () => clipboard.readHTML(),
      (got) => got !== '',
      1000,
    ),
    (got) => got === '',
  )
  expectThat('cannot read the clipboard', await ask(documentFrame, READ_HTML), (got) =>
    got.startsWith('refused'),
  )
  expectThat('sees no fonts', await ask(documentFrame, LIST_FONTS), (got) => got !== 'listed')
  expectThat('cannot open the microphone', await ask(documentFrame, MICROPHONE), (got) =>
    got.startsWith('refused'),
  )
  expectThat(
    'it was the guard that said no',
    String(trace.filter((row) => row.endsWith('-> false')).length),
    (got) => Number(got) >= 3 && !trace.some((row) => row.endsWith('-> true')),
  )
  showTrace()

  section('the sheet editor, in its top frame')
  const sheets = await open('sheets/index.html')
  const sheet = sheets.webContents.mainFrame
  clipboard.clear()
  expectThat(
    'copies a range as text, a table and a picture',
    await ask(sheet, COPY_RANGE),
    (got) => got === 'written',
  )
  expectThat(
    'the system clipboard holds the table',
    await onClipboard(
      () => clipboard.readHTML(),
      (got) => got.includes('<td>a</td>'),
    ),
    (got) => got.includes('<td>a</td>'),
  )
  expectThat(
    'and the picture',
    await onClipboard(
      () => String(!clipboard.readImage().isEmpty()),
      (got) => got === 'true',
    ),
    (got) => got === 'true',
  )
  await ask(sheet, WATCH_PASTE)
  sheets.webContents.paste()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expectThat(
    'a paste hands the page the text and the table',
    await ask(sheet, 'window.__pasted'),
    (got) => got.startsWith('a\tb\tc|') && got.includes('<td>a</td>'),
  )
  showTrace()

  section('the microphone lease of the slides editor')
  const slides = await open('slides/index.html')
  const deck = slides.webContents.mainFrame
  const inner = await frameAt(slides, 'inner', 'inner.html')
  expectThat('shut when nothing records', await ask(deck, MICROPHONE), (got) =>
    got.startsWith('refused'),
  )
  recording.add(slides.webContents.id)
  expectThat('open to the recording editor', await ask(deck, MICROPHONE), (got) => got === 'stream')
  expectThat('shut to a frame inside it', await ask(inner, MICROPHONE), (got) =>
    got.startsWith('refused'),
  )
  expectThat('shut to another editor meanwhile', await ask(sheet, MICROPHONE), (got) =>
    got.startsWith('refused'),
  )
  showTrace()
}

void app.whenReady().then(async () => {
  // what a person had on the clipboard comes back; copied files and other formats do not
  const kept = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  }
  try {
    await run()
  } catch (error) {
    failures += 1
    lines.push(`FAIL the run stopped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clipboard.clear()
    clipboard.write({
      ...(kept.text ? { text: kept.text } : {}),
      ...(kept.html ? { html: kept.html } : {}),
      ...(kept.rtf ? { rtf: kept.rtf } : {}),
      ...(kept.image.isEmpty() ? {} : { image: kept.image }),
    })
  }
  lines.push(failures === 0 ? 'permission guard real run: passed' : `${failures} failed`)
  process.stdout.write(`${lines.join('\n')}\n`)
  app.exit(failures === 0 ? 0 : 1)
})
