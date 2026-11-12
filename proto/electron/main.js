// Baseline for the shell measurement: the same host page and editor bundle the
// Rust prototypes load, in Electron 43.8.3 (the app's version). Same contract
// (proto/README.md); BENCH_DIST names the folder from proto/common/stage-dist.sh.
// BENCH_MODE=seed only writes proto-shell-started.json into the userData folder.
const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const env = process.env
const dist = path.resolve(env.BENCH_DIST || path.join(__dirname, 'dist'))

// the installed app's folder and keychain name (apps/shell/src/main/index.ts)
app.setName('seuoffice')
app.setPath('userData', env.BENCH_USER_DATA || path.join(app.getPath('appData'), 'seuoffice'))

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

function report(obj) {
  if (env.BENCH_OUT) fs.appendFileSync(env.BENCH_OUT, JSON.stringify(obj) + '\n')
}

function startupNote() {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'proto-shell-started.json'),
    JSON.stringify({ shell: 'electron', version: app.getVersion(), args: process.argv, time: Date.now() }),
  )
  report({
    kind: 'startup',
    shell: 'electron',
    pid: process.pid,
    userDataDir: dir,
    userDataEntries: fs.readdirSync(dir),
  })
}

const argDoc = process.argv.slice(1).find((a) => /\.docx$/i.test(a))

app.whenReady().then(() => {
  startupNote()
  if (env.BENCH_MODE === 'seed') return app.quit()
  protocol.handle('app', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname)
    const file = path.join(dist, rel)
    if (!file.startsWith(dist)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  ipcMain.handle('bench_config', () => ({
    doc: env.BENCH_DOC || argDoc || null,
    mode: env.BENCH_DOC ? env.BENCH_MODE || 'interactive' : 'interactive',
    t0: env.BENCH_T0 ? Number(env.BENCH_T0) : null,
    shellName: 'electron',
  }))
  ipcMain.handle('open_file', async (event, p) => {
    if (!p) {
      const res = await dialog.showOpenDialog({ filters: [{ name: 'Word', extensions: ['docx'] }] })
      if (res.canceled) throw new Error('canceled')
      p = res.filePaths[0]
    }
    return { path: p, name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) }
  })
  ipcMain.handle('save_file', (event, p, bytes) => fs.writeFileSync(p, bytes))
  ipcMain.handle('echo', (event, bytes) => bytes)
  ipcMain.handle('report', (event, obj) => report(obj))
  ipcMain.handle('print_pdf', async (event, out, width, height) => {
    try {
      const pdf = await event.sender.printToPDF({
        printBackground: true,
        pageSize: { width, height },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      })
      fs.writeFileSync(out, pdf)
      return { ok: true, bytes: pdf.length }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
    title: 'SeuOffice',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  win.loadURL('app://bundle/host.html')
})

app.on('window-all-closed', () => app.quit())
