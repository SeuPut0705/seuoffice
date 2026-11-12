// Throwaway measurement host for the shell prototypes (proto/README.md).
//
// The page frames the real Word editor web bundle (docs/index.html, the
// renderer behind the web desktop bridge) and speaks the @seuoffice/embed
// protocol to it, the way an embedding site does. Files come from and go to
// the shell through window.__shell, the only thing a shell has to provide:
//
//   config()                       -> { doc, mode, t0 }
//   openFile(path)                 -> { name, bytes: Uint8Array }
//   saveFile(path, bytes)          -> void
//   echo(bytes)                    -> Uint8Array (same bytes back)
//   report(object)                 -> void (shell appends one JSON line to BENCH_OUT)
//   printPdf(outPath, wIn, hIn)    -> { ok, error? }  (prints this top-level page)
//
// mode 'bench': open, wait for the layout to settle, report 'opened', idle
// IDLE_MS (the harness reads memory and takes the screenshot meanwhile),
// time IPC round trips, type into the editor, save through the shell, report
// 'done'. mode 'pdf': open, settle, copy the editor's DOM into this page,
// print it to PDF through the shell, report 'pdf'. mode 'interactive': open
// and leave the editor to the user; saves go back to the opened path.

const SOURCE = 'seuoffice'
const VERSION = 1
const IDLE_MS = 8000
const tHost = Date.now()
const perfNow = () => performance.timeOrigin + performance.now()

function tauriShell() {
  const { invoke } = window.__TAURI__.core
  const basename = (p) => p.split(/[\\/]/).pop()
  return {
    config: () => invoke('bench_config'),
    openFile: async (path) => {
      const res = await invoke('open_file', { path: path ?? null })
      return { name: basename(res.path), path: res.path, bytes: await readBytes(res.path) }
    },
    saveFile: (path, bytes) =>
      invoke('save_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } }),
    echo: async (bytes) => new Uint8Array(await invoke('echo', bytes)),
    report: (obj) => invoke('report', { line: JSON.stringify(obj) }),
    printPdf: (out, width, height) => invoke('print_pdf', { out, width, height }),
  }
  async function readBytes(path) {
    return new Uint8Array(await invoke('read_file', { path }))
  }
}

const shell = window.__shell ?? (window.__TAURI__ ? tauriShell() : null)
const frame = document.getElementById('editor')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const frames = (n = 2) =>
  new Promise((r) => {
    const step = (k) => (k === 0 ? r() : requestAnimationFrame(() => step(k - 1)))
    step(n)
  })

function post(message, transfer) {
  frame.contentWindow.postMessage({ source: SOURCE, version: VERSION, ...message }, '*', transfer)
}

const listeners = new Set()
window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== SOURCE || event.source !== frame.contentWindow) return
  for (const l of [...listeners]) l(data)
})
function nextMessage(pred, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      listeners.delete(l)
      reject(new Error('timeout waiting for message'))
    }, timeoutMs)
    const l = (data) => {
      if (!pred(data)) return
      clearTimeout(t)
      listeners.delete(l)
      resolve(data)
    }
    listeners.add(l)
  })
}

// saves the page sends: the shell writes them, the page hears saved or save_failed
let savePath = null
listeners.add(async (data) => {
  if (data.type !== 'save') return
  try {
    await shell.saveFile(savePath, new Uint8Array(data.bytes))
    post({ type: 'saved', saveId: data.saveId })
  } catch (error) {
    post({ type: 'save_failed', saveId: data.saveId, message: String(error) })
  }
})

const doc = () => frame.contentDocument
const editable = () => doc()?.querySelector('[contenteditable="true"]')
const hasText = (marker) => (editable()?.textContent ?? '').includes(marker)

async function waitFor(pred, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => requestAnimationFrame(r))
  }
}

async function settle() {
  await waitFor(() => hasText('BENCH-LAST-PARAGRAPH'))
  const tLast = perfNow()
  let height = -1
  let stableSince = Date.now()
  while (Date.now() - stableSince < 1500) {
    await sleep(100)
    const h = doc().documentElement.scrollHeight + scrollSize()
    if (h !== height) {
      height = h
      stableSince = Date.now()
    }
  }
  return { tLast, tSettled: perfNow() - 1500 }
}

// the editor scrolls inside its own container: the tallest scroll height in the frame
function scrollSize() {
  let max = 0
  for (const el of doc().querySelectorAll('div')) {
    if (el.scrollHeight > max && el.scrollHeight > el.clientHeight + 10) max = el.scrollHeight
  }
  return max
}

// the editor draws one long sheet with a gap element between pages
function pageCount() {
  return doc().querySelectorAll('.page-gap').length + 1
}

// which font families this engine resolves: a family that is not installed measures like the fallback
function fontProbe() {
  const ctx = document.createElement('canvas').getContext('2d')
  const sample = 'The quick brown fox 한글 가나다 0123'
  const width = (font) => {
    ctx.font = font
    return ctx.measureText(sample).width
  }
  const families = [
    'Calibri',
    'Malgun Gothic',
    '맑은 고딕',
    'Apple SD Gothic Neo',
    'AppleGothic',
    'Batang',
    'Gulim',
    'Segoe UI',
    'Helvetica Neue',
    'Arial',
    'Times New Roman',
    'Noto Sans KR',
    'Pretendard',
  ]
  const out = {}
  for (const f of families) {
    out[f] =
      width(`40px "${f}", monospace`) !== width('40px monospace') ||
      width(`40px "${f}", serif`) !== width('40px serif')
  }
  const p = [...(editable()?.querySelectorAll('p') ?? [])][1]
  const cs = p ? frame.contentWindow.getComputedStyle(p) : null
  return { available: out, bodyFontFamily: cs?.fontFamily ?? null, bodyFontSize: cs?.fontSize }
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] }
}

async function ipcBench() {
  const out = {}
  for (const [label, size, n] of [
    ['1KB', 1024, 50],
    ['10MB', 10 * 1024 * 1024, 10],
  ]) {
    const payload = new Uint8Array(size)
    for (let i = 0; i < size; i += 4096) payload[i] = i & 0xff
    await shell.echo(payload) // warm up
    const times = []
    let intact = true
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      const back = await shell.echo(payload)
      times.push(performance.now() - t)
      if (back.byteLength !== size || back[4096] !== payload[4096]) intact = false
    }
    out[label] = { ...stats(times), intact }
  }
  return out
}

// type at the end of the first paragraph the way a user's insertText does, then save through the shell
async function editAndSave() {
  const root = editable()
  const walker = doc().createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode()) && !node.data.includes('BENCH-FIRST-PARAGRAPH'));
  if (!node) return { ok: false, error: 'first paragraph not found' }
  root.focus()
  const sel = frame.contentWindow.getSelection()
  const range = doc().createRange()
  const at = node.data.indexOf('BENCH-FIRST-PARAGRAPH') + 'BENCH-FIRST-PARAGRAPH'.length
  range.setStart(node, at)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  const inserted = doc().execCommand('insertText', false, '편집ABC')
  await sleep(500)
  const typed = hasText('BENCH-FIRST-PARAGRAPH편집ABC')
  const t = performance.now()
  post({ type: 'request_save', requestId: 1 })
  const done = await nextMessage((d) => d.type === 'request_save_done' && d.requestId === 1)
  return {
    execCommandResult: inserted,
    typed,
    saveOk: done.ok === true,
    saveError: done.message ?? null,
    saveMs: performance.now() - t,
  }
}

// a static copy of the editor's DOM in this page, so the shell's print-to-PDF prints the document
function adoptEditorDom() {
  const src = doc()
  let css = ''
  for (const sheet of src.styleSheets) {
    try {
      for (const rule of sheet.cssRules) css += rule.cssText + '\n'
    } catch {
      /* cross-origin sheet: none expected */
    }
  }
  document.head.innerHTML = `<meta charset="UTF-8"><base href="${src.baseURI}"><style>${css}</style>`
  document.documentElement.className = src.documentElement.className
  document.body.className = src.body.className
  document.body.innerHTML = src.body.innerHTML
  document.documentElement.style.overflow = 'visible'
  document.body.style.overflow = 'visible'
  document.body.style.height = 'auto'
}

async function main() {
  if (!shell) throw new Error('no window.__shell')
  const config = await shell.config()
  const mode = config.mode || 'interactive'
  const opened = await shell.openFile(config.doc ?? null)
  savePath = mode === 'interactive' ? opened.path : `${opened.path}.saved.docx`
  const tBytes = perfNow()
  const ready = nextMessage((d) => d.type === 'ready')
  frame.src = `docs/index.html?mode=edit&lang=ko`
  await ready
  const tReady = perfNow()
  const copy = new Uint8Array(opened.bytes)
  const openedMsg = nextMessage((d) => d.type === 'opened' || d.type === 'error')
  post({ type: 'open', fileName: opened.name, bytes: copy.buffer, ai: false, collab: false }, [
    copy.buffer,
  ])
  const answer = await openedMsg
  if (answer.type === 'error') throw new Error(`editor error: ${answer.code} ${answer.message}`)
  const tOpened = perfNow()
  if (mode === 'interactive') return
  await waitFor(() => hasText('BENCH-FIRST-PARAGRAPH'))
  await frames(2)
  const tFirstPaint = perfNow()
  const { tLast, tSettled } = await settle()
  const t0 = config.t0 ?? performance.timeOrigin
  const ms = (t) => Math.round(t - t0)

  if (mode === 'pdf') {
    const pages = pageCount()
    adoptEditorDom()
    await frames(3)
    await sleep(500)
    const t = performance.now()
    const res = await shell.printPdf(`${opened.path}.${config.shellName ?? 'shell'}.pdf`, 8.27, 11.69)
    await shell.report({ kind: 'pdf', ...res, pages, printMs: performance.now() - t })
    return
  }

  await shell.report({
    kind: 'opened',
    userAgent: navigator.userAgent,
    t0IsSpawn: config.t0 != null,
    ms: {
      hostScript: ms(tHost),
      bytes: ms(tBytes),
      editorReady: ms(tReady),
      opened: ms(tOpened),
      firstPaint: ms(tFirstPaint),
      lastParagraphInDom: ms(tLast),
      settled: ms(tSettled),
    },
    pages: pageCount(),
    fonts: fontProbe(),
  })
  await sleep(IDLE_MS)
  const ipc = await ipcBench()
  const edit = await editAndSave()
  await shell.report({ kind: 'done', ipc, edit })
}

main().catch(async (error) => {
  console.error(error)
  try {
    await shell?.report({ kind: 'error', error: String(error?.stack ?? error) })
  } catch {
    /* no shell to tell */
  }
})
