/**
 * The PDF tools window (decision 0030): a small separate BrowserWindow above
 * the shell window, opened from Home's "PDF tools" card. The user picks a task,
 * then its PDFs, then gets a new file; tasks that need the editor's view open
 * the file in a PDF tab instead.
 *
 * Paths never come from the window. Inputs are picked in a main-process open
 * dialog and handed to the window as opaque ids; outputs are picked in a
 * main-process save dialog, may not be a source, and come back as ids too.
 * Sources are only read. No AI and no network: tools.ts runs the editor's own
 * page functions here in the main process, as the editor's ribbon does.
 *
 * One window at a time; opening it again focuses it.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { productName, type Lang } from '@genoffice/i18n'
import {
  safeExternalUrl,
  saveAsSuggestion,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
} from '@genoffice/electron-utils'
import { fileHasUnsavedChanges } from '@genoffice/electron-utils/unsaved-files'
import { writePdfAtomically } from '../../../../pdf/src/main/atomic-write'
import { uniqueGeneratedPdfPath } from '../../../../pdf/src/main/generated-output'
import {
  PDF_TOOLS_CHANNELS,
  type PdfBlankPagesResult,
  type PdfPickResult,
  type PdfToolInput,
  type PdfToolAccept,
  type PdfToolInputKind,
  type PdfToolOptions,
  type PdfToolRunResult,
  type PdfToolsStart,
  type PdfToolsTheme,
} from '../../shared/pdf-tools-api'
import { PDF_TOOLS_HOME_CHANNELS } from '../../shared/pdf-tools-home-channels'
import type { StructureJob } from '../pdf-structure/protocol'
import { pdfToolsText } from '../../renderer/src/i18n/strings-pdf-tools'
import {
  MAX_TOOL_INPUT_BYTES,
  PdfToolRefusal,
  checkOptions,
  encryptedPageCount,
  foundBlankPagesOf,
  inspectImage,
  inspectPdf,
  isPdfToolId,
  jobBytesOf,
  jobFor,
  outputNames,
  runPdfTool,
  toolAccepts,
  toolInputKind,
  toolMinInputs,
  toolOutputExtension,
  toolRunsAsJob,
  toolTakesMany,
  type InspectResult,
} from './tools'
import { recodeWithChromium } from './image-recode'

export interface PdfToolsWindowDeps {
  /** the window the tools window sits above */
  parentWindow(): BrowserWindow | null
  lang(): Lang
  theme(): PdfToolsTheme
  /**
   * Open a file this window just wrote. An open PDF tab on that path is
   * reloaded from disk; run() never writes over a file open with unsaved
   * changes, so nothing is lost.
   */
  openResult(path: string): boolean
  /** Open a PDF the user picked for an editor-only tool; an open tab is only focused */
  openForEditing(path: string): boolean
  /**
   * Run a page-rendering job in a process of its own, ended when it answers,
   * is cancelled, or `owner` goes away (pdf-structure-ipc.ts runWindowJob)
   */
  runJob(
    owner: WebContents,
    jobId: string,
    job: StructureJob,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
  cancelJob(owner: number, jobId: string): boolean
}

interface PickedInput extends PdfToolInput {
  path: string
}

let deps: PdfToolsWindowDeps | null = null
let win: BrowserWindow | null = null
let ipcRegistered = false
let running = false
/** this window's inputs and outputs by id; cleared when it closes */
const inputs = new Map<string, PickedInput>()
const results = new Map<string, string>()
/** pages the blank-page search found, by input id: the only pages blankPages removes */
const blankFound = new Map<string, Set<number>>()
/** the running blank-page search's job id */
let finding: string | null = null
/** stops the running tool when the window asks */
let runStop: AbortController | null = null
/** the running add-password, remove-password or repair job's id */
let runningJob: string | null = null
/** a task the PDF editor's ribbon asked for, until the window takes it */
let pendingStart: PdfToolsStart | null = null

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] }
const IMAGE_FILTER = { name: 'JPG, PNG', extensions: ['jpg', 'jpeg', 'png'] }
const OUTPUT_FILTERS: Record<'pdf' | 'txt', { name: string; extensions: string[] }> = {
  pdf: PDF_FILTER,
  txt: { name: 'TXT', extensions: ['txt'] },
}

export function configurePdfToolsWindow(next: PdfToolsWindowDeps): void {
  deps = next
  registerIpc()
}

function fromWindow(event: IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && event.sender === win.webContents
}

/** two paths name the same file (Windows paths ignore case) */
function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

async function pickInputs(
  multi: boolean,
  kind: PdfToolInputKind,
  accept: PdfToolAccept,
): Promise<PdfPickResult> {
  const owner = win
  const empty: PdfPickResult = { inputs: [], rejected: [] }
  if (!owner) return empty
  const picked = await showOpenDialogWithMemory(dialog, owner, {
    filters: [kind === 'image' ? IMAGE_FILTER : PDF_FILTER],
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  })
  if (picked.canceled) return empty
  return inputsFrom(picked.filePaths, kind, accept)
}

/**
 * How many pages a picked file has for a tool that takes `accept`, or why the
 * tool cannot take it: password-protected PDFs only for "remove password",
 * files pdf-lib cannot read only for "repair" (their page count unknown, 0).
 */
async function pagesFor(
  bytes: Uint8Array,
  kind: PdfToolInputKind,
  accept: PdfToolAccept,
): Promise<InspectResult> {
  if (kind === 'image') return inspectImage(bytes)
  const info = await inspectPdf(bytes)
  if (info.ok) return accept === 'encrypted' ? { ok: false, problem: 'not-encrypted' } : info
  if (info.problem === 'encrypted' && accept === 'encrypted') {
    return { ok: true, pages: await encryptedPageCount(bytes) }
  }
  if (info.problem === 'unreadable' && accept === 'damaged') return { ok: true, pages: 0 }
  return info
}

/** Files the main process chose (a dialog, the editor's own file), read and handed out as ids */
async function inputsFrom(
  paths: string[],
  kind: PdfToolInputKind,
  accept: PdfToolAccept = 'pdf',
): Promise<PdfPickResult> {
  const out: PdfPickResult = { inputs: [], rejected: [] }
  for (const path of paths) {
    const name = basename(path)
    try {
      const size = (await stat(path)).size
      if (size > MAX_TOOL_INPUT_BYTES) {
        out.rejected.push({ name, problem: 'too-large' })
        continue
      }
      const bytes = await readFile(path)
      const info = await pagesFor(bytes, kind, accept)
      if (!info.ok) {
        out.rejected.push({ name, problem: info.problem })
        continue
      }
      const input: PickedInput = { id: randomUUID(), kind, name, pages: info.pages, size, path }
      inputs.set(input.id, input)
      out.inputs.push({ id: input.id, kind, name, pages: input.pages, size })
    } catch {
      out.rejected.push({ name, problem: 'unreadable' })
    }
  }
  return out
}

async function run(raw: unknown): Promise<PdfToolRunResult> {
  const owner = win
  if (!owner) return { ok: false, error: 'failed' }
  const req = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const tool = req.tool
  if (!isPdfToolId(tool)) return { ok: false, error: 'failed' }
  const ids = Array.isArray(req.inputIds) ? req.inputIds : []
  // only files picked for this kind of tool: a picture never reaches a PDF tool
  const kind = toolInputKind(tool)
  const chosen = ids
    .map((id) => (typeof id === 'string' ? inputs.get(id) : undefined))
    .filter((input): input is PickedInput => !!input && input.kind === kind)
  if (chosen.length === 0) return { ok: false, error: 'no-input' }
  const sources = toolTakesMany(tool) ? chosen : chosen.slice(0, 1)
  if (sources.length < toolMinInputs(tool)) return { ok: false, error: 'need-two' }
  // overlay reads a second PDF, picked on its own as the background
  if (tool === 'overlay') {
    const background =
      typeof req.backgroundId === 'string' ? inputs.get(req.backgroundId) : undefined
    if (!background || background.kind !== 'pdf') return { ok: false, error: 'need-background' }
    sources.push(background)
  }
  if (running) return { ok: false, error: 'busy' }
  running = true
  try {
    let total = 0
    const bytes: Uint8Array[] = []
    for (const source of sources) {
      if (!existsSync(source.path)) return { ok: false, error: 'missing' }
      total += (await stat(source.path)).size
      if (total > MAX_TOOL_INPUT_BYTES) return { ok: false, error: 'too-large' }
      bytes.push(await readFile(source.path))
    }
    // read again: the file may have changed since it was picked
    const first = await pagesFor(bytes[0]!, kind, toolAccepts(tool))
    if (!first.ok) return { ok: false, error: 'failed' }
    const backgroundInfo = tool === 'overlay' ? await inspectPdf(bytes[1]!) : null
    if (backgroundInfo && !backgroundInfo.ok) return { ok: false, error: 'failed' }
    const checked = checkOptions(
      tool,
      req.options,
      first.pages,
      backgroundInfo?.ok ? backgroundInfo.pages : 1,
    )
    if (!checked.ok) return { ok: false, error: checked.error }
    if (tool === 'blankPages') {
      // only pages the search showed the user: nothing else is removed
      const found = blankFound.get(sources[0]!.id)
      const chosen = (checked.options.removePages ?? '').split(',').map(Number)
      if (!found || chosen.some((page) => !found.has(page))) {
        return { ok: false, error: 'not-found' }
      }
    }
    let made: Uint8Array[]
    if (toolRunsAsJob(tool)) {
      const job = await runToolJob(owner, tool, sources[0]!.path, checked.options)
      if (!job.ok) return job
      made = [job.bytes]
    } else {
      try {
        const stop = new AbortController()
        runStop = stop
        const contents = owner.webContents
        made = await runPdfTool(tool, bytes, checked.options, {
          recode: recodeWithChromium,
          signal: stop.signal,
          onProgress: (done, total) => {
            if (!contents.isDestroyed()) contents.send(PDF_TOOLS_CHANNELS.progress, { done, total })
          },
        })
      } catch (err) {
        if (err instanceof PdfToolRefusal) return { ok: false, error: err.reason }
        if (runStop?.signal.aborted) return { ok: false, canceled: true }
        throw err
      }
    }
    const names = outputNames(tool, sources[0]!.name, made.length, checked.options)
    const targets = await pickTargets(owner, sources[0]!.path, names, toolOutputExtension(tool))
    if (!targets) return { ok: false, canceled: true }
    for (const target of targets) {
      if (sources.some((source) => samePath(source.path, target))) {
        return { ok: false, error: 'same-as-source' }
      }
      if (await fileHasUnsavedChanges(target)) return { ok: false, error: 'unsaved-target' }
    }
    const outputs: { id: string; name: string; size: number }[] = []
    for (let i = 0; i < made.length; i++) {
      await writePdfAtomically(targets[i]!, made[i]!)
      const id = randomUUID()
      results.set(id, targets[i]!)
      outputs.push({ id, name: basename(targets[i]!), size: made[i]!.length })
    }
    return { ok: true, outputs }
  } catch {
    return { ok: false, error: 'failed' }
  } finally {
    running = false
    runStop = null
    runningJob = null
  }
}

/**
 * Add a password, remove one or repair a file in the PDF job process (qpdf,
 * PDFium), and check its answer is what the tool promises: a file that asks
 * for a password, or one that opens without one. The password goes to that
 * process with the job and nowhere else; no error carries it.
 */
async function runToolJob(
  owner: BrowserWindow,
  tool: 'encrypt' | 'decrypt' | 'repair',
  path: string,
  options: PdfToolOptions,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: 'failed' | 'wrong-password' }
  | { ok: false; canceled: true }
> {
  if (!deps) return { ok: false, error: 'failed' }
  const jobId = randomUUID()
  runningJob = jobId
  const outcome = await deps.runJob(owner.webContents, jobId, jobFor(tool, path, options), () => {})
  if (!outcome.ok) {
    if (outcome.error === 'cancelled') return { ok: false, canceled: true }
    return { ok: false, error: outcome.error === 'password-required' ? 'wrong-password' : 'failed' }
  }
  const bytes = jobBytesOf(outcome.value)
  if (!bytes) return { ok: false, error: 'failed' }
  const info = await inspectPdf(bytes)
  const asPromised = tool === 'encrypt' ? !info.ok && info.problem === 'encrypted' : info.ok
  return asPromised ? { ok: true, bytes } : { ok: false, error: 'failed' }
}

/**
 * Where to write: one file asks with a save dialog next to the source; several
 * files (split) ask for a folder and take free names in it. Null: canceled.
 */
async function pickTargets(
  owner: BrowserWindow,
  sourcePath: string,
  names: string[],
  extension: 'pdf' | 'txt',
): Promise<string[] | null> {
  if (names.length === 1) {
    const saved = await showSaveDialogWithMemory(dialog, owner, {
      defaultPath: saveAsSuggestion(sourcePath, names[0]!),
      filters: [OUTPUT_FILTERS[extension]],
    })
    if (saved.canceled || !saved.filePath) return null
    const ending = `.${extension}`
    return [
      saved.filePath.toLowerCase().endsWith(ending) ? saved.filePath : `${saved.filePath}${ending}`,
    ]
  }
  const folder = await showOpenDialogWithMemory(
    dialog,
    owner,
    { defaultPath: dirname(sourcePath), properties: ['openDirectory', 'createDirectory'] },
    dirname(sourcePath),
  )
  const dir = folder.filePaths[0]
  if (folder.canceled || !dir) return null
  const taken = new Set<string>()
  return names.map((name) => {
    const target = uniqueGeneratedPdfPath(dir, name, (p) => existsSync(p) || taken.has(p))
    taken.add(target)
    return target
  })
}

/** a candidate's thumbnail as a PNG data URL */
function thumbUrl(thumb: { width: number; height: number; bgra: Uint8Array }): string {
  const buffer = Buffer.from(thumb.bgra.buffer, thumb.bgra.byteOffset, thumb.bgra.byteLength)
  return nativeImage
    .createFromBitmap(buffer, { width: thumb.width, height: thumb.height })
    .toDataURL()
}

async function findBlankPages(inputId: unknown): Promise<PdfBlankPagesResult> {
  const owner = win
  if (!owner || !deps) return { ok: false, error: 'failed' }
  const input = typeof inputId === 'string' ? inputs.get(inputId) : undefined
  if (!input || input.kind !== 'pdf') return { ok: false, error: 'no-input' }
  if (!existsSync(input.path)) return { ok: false, error: 'missing' }
  if (finding || running) return { ok: false, error: 'busy' }
  const jobId = randomUUID()
  finding = jobId
  try {
    const contents = owner.webContents
    const outcome = await deps.runJob(
      contents,
      jobId,
      { op: 'blankPages', source: { pdfPath: input.path } },
      (done, total) => {
        if (!contents.isDestroyed()) contents.send(PDF_TOOLS_CHANNELS.progress, { done, total })
      },
    )
    if (!outcome.ok) {
      return outcome.error === 'cancelled'
        ? { ok: false, canceled: true }
        : { ok: false, error: 'failed' }
    }
    const found = foundBlankPagesOf(outcome.value)
    if (!found) return { ok: false, error: 'failed' }
    blankFound.set(input.id, new Set(found.candidates.map((c) => c.page)))
    return {
      ok: true,
      pageCount: found.pageCount,
      candidates: found.candidates.map((c) => ({
        page: c.page,
        reason: c.reason,
        thumb: c.thumb ? thumbUrl(c.thumb) : null,
      })),
    }
  } catch {
    return { ok: false, error: 'failed' }
  } finally {
    finding = null
  }
}

/**
 * The PDF editor's ribbon: open the window on `tool` with the view's own
 * file picked (the editor checked the file is the view's and saved it).
 * False for a task that does not take one PDF.
 */
export function openPdfToolsWithFile(path: string, tool: unknown): boolean {
  if (!deps || !isPdfToolId(tool) || toolInputKind(tool) !== 'pdf') return false
  void inputsFrom([path], 'pdf', toolAccepts(tool)).then((picked) => {
    pendingStart = { tool, inputs: picked.inputs, rejected: picked.rejected }
    const open = !!win && !win.isDestroyed()
    openPdfToolsWindow()
    // a fresh window takes the task as it loads; an open one is told it waits
    if (open) win?.webContents.send(PDF_TOOLS_CHANNELS.startReady)
  })
  return true
}

async function openInEditor(): Promise<void> {
  const owner = win
  if (!owner || !deps) return
  const picked = await showOpenDialogWithMemory(dialog, owner, {
    filters: [PDF_FILTER],
    properties: ['openFile'],
  })
  const path = picked.filePaths[0]
  if (!picked.canceled && path) deps.openForEditing(path)
}

function registerIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle(PDF_TOOLS_CHANNELS.getInit, (event) => {
    if (!fromWindow(event) || !deps) return null
    return { lang: deps.lang(), theme: deps.theme() }
  })
  ipcMain.handle(
    PDF_TOOLS_CHANNELS.pickInputs,
    (event, multi: unknown, kind: unknown, accept: unknown) => {
      if (!fromWindow(event)) return { inputs: [], rejected: [] }
      return pickInputs(
        multi === true,
        kind === 'image' ? 'image' : 'pdf',
        accept === 'encrypted' || accept === 'damaged' ? accept : 'pdf',
      )
    },
  )
  ipcMain.handle(PDF_TOOLS_CHANNELS.run, (event, request: unknown) => {
    if (!fromWindow(event)) return { ok: false, error: 'failed' }
    return run(request)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.openResult, (event, id: unknown) => {
    const path = fromWindow(event) && typeof id === 'string' ? results.get(id) : undefined
    if (path && existsSync(path)) deps?.openResult(path)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.revealResult, (event, id: unknown) => {
    const path = fromWindow(event) && typeof id === 'string' ? results.get(id) : undefined
    if (path && existsSync(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.openInEditor, (event) => {
    if (fromWindow(event)) return openInEditor()
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.findBlankPages, (event, inputId: unknown) => {
    if (!fromWindow(event)) return { ok: false, error: 'failed' }
    return findBlankPages(inputId)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.cancelRun, (event) => {
    if (!fromWindow(event)) return
    runStop?.abort()
    if (runningJob) deps?.cancelJob(event.sender.id, runningJob)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.cancelFind, (event) => {
    if (fromWindow(event) && finding) deps?.cancelJob(event.sender.id, finding)
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.takeStart, (event) => {
    if (!fromWindow(event)) return null
    const start = pendingStart
    pendingStart = null
    return start
  })
  ipcMain.handle(PDF_TOOLS_CHANNELS.close, (event) => {
    if (fromWindow(event)) win?.close()
  })
  ipcMain.handle(PDF_TOOLS_HOME_CHANNELS.open, (event) => {
    const parent = deps?.parentWindow()
    if (!parent || parent.isDestroyed() || event.sender !== parent.webContents) return
    openPdfToolsWindow()
  })
}

export function openPdfToolsWindow(): void {
  const d = deps
  if (!d) throw new Error('the PDF tools window is not configured')
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  const lang = d.lang()
  const parent = d.parentWindow()
  const next = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 520,
    minHeight: 520,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    show: false,
    center: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: `${pdfToolsText(lang, 'windowTitle')} - ${productName(lang)}`,
    webPreferences: {
      preload: join(__dirname, '../preload/pdf-tools.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win = next
  next.removeMenu()
  next.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  next.once('ready-to-show', () => next.show())
  next.on('closed', () => {
    if (win !== next) return
    win = null
    inputs.clear()
    results.clear()
    blankFound.clear()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void next.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pdf-tools.html`)
  } else {
    void next.loadFile(join(__dirname, '../renderer/pdf-tools.html'))
  }
}
