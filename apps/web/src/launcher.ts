import {
  openDocument,
  SeuofficeEmbedError,
  type CollabEmbeddedDocument,
  type CollabRelay,
  type CollabSavedFile,
  type CollabStatus,
  type EmbeddedDocument,
  type LocalFile,
} from '@seuoffice/embed'

const viewer = document.getElementById('viewer')!
const status = document.getElementById('status')!
const input = document.getElementById('file') as HTMLInputElement
const editToggle = document.getElementById('edit') as HTMLInputElement
const saveButton = document.getElementById('save') as HTMLButtonElement
let current: EmbeddedDocument | undefined
/** set while the open document is co-edited: the rescue of what this person's page shows */
let rescue: CollabEmbeddedDocument | undefined

/**
 * Co-editing, asked for in the launcher's own query:
 * `?collab=<document id>&user=<id>&name=<shown name>&access=edit|view`. The
 * socket goes to the co-editing server on this origin (`/collab`), which the
 * browser tests start with the preview.
 */
interface CollabParams {
  documentId: string
  userId: string
  name: string
  canEdit: boolean
}

function collabParams(): CollabParams | null {
  const query = new URLSearchParams(location.search)
  const documentId = query.get('collab')
  if (!documentId) return null
  const userId = query.get('user') ?? crypto.randomUUID()
  return {
    documentId,
    userId,
    name: query.get('name') ?? userId,
    canEdit: query.get('access') !== 'view',
  }
}

interface StoredFile {
  fileName: string
  bytes: Uint8Array
  version: number | null
}

/** What a test reads back and drives; the launcher is the repository's reference host */
declare global {
  interface Window {
    seuLauncher?: {
      /** the session's latest status */
      collab: CollabStatus | null
      /** the file this host stores; a save of a lower version than it holds is refused */
      saved: StoredFile | null
      /** how the open document is edited, once `opened` settled */
      mode: 'collab' | 'locked' | 'view' | null
      /** the code of the last `opened` that rejected */
      openError: string | null
      /** saves that reached `onSave` and wait for `releaseSaves` */
      heldSaves: number
      /** make every later `onSave` wait: lets a test order the saves of two hosts */
      holdSaves(): void
      releaseSaves(): void
      /** `doc.save()`: null once stored, else the message it rejected with */
      save(): Promise<string | null>
      /** `doc.exportLocal()` of a co-edited document */
      exportLocal(): Promise<LocalFile>
    }
  }
}

let saveGate: { held: Promise<void>; release(): void } | null = null
const observed: NonNullable<Window['seuLauncher']> = {
  collab: null,
  saved: null,
  mode: null,
  openError: null,
  heldSaves: 0,
  holdSaves() {
    if (saveGate) return
    const { promise, resolve } = Promise.withResolvers<void>()
    saveGate = { held: promise, release: resolve }
  },
  releaseSaves() {
    saveGate?.release()
    saveGate = null
  },
  save,
  exportLocal() {
    if (!rescue) return Promise.reject(new Error('no co-edited document is open'))
    return rescue.exportLocal()
  },
}
window.seuLauncher = observed

function relay(params: CollabParams): CollabRelay {
  const url = new URL('collab', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = new URLSearchParams({
    doc: params.documentId,
    user: params.userId,
    name: params.name,
    access: params.canEdit ? 'edit' : 'view',
  }).toString()
  return {
    connect: () => new WebSocket(url),
    onStatus: (next) => {
      observed.collab = next
      document.body.dataset.collabPhase = next.phase
      document.body.dataset.collabVersion = String(next.version)
      // the session ended: the editor is read-only, and only `exportLocal` can keep its edits
      if (next.phase === 'failed') status.textContent = `공동 편집 멈춤(${next.failure}): 읽기 전용`
    },
  }
}

/** The launcher is its own host: a saved document comes back as a download */
function download(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function open(file: File, collab: CollabParams | null): Promise<void> {
  current?.destroy()
  rescue = undefined
  observed.mode = null
  viewer.replaceChildren()
  saveButton.hidden = true
  status.textContent = `${file.name} 여는 중`
  const base = {
    baseUrl: new URL('./', location.href).href,
    bytes: await file.arrayBuffer(),
    fileName: file.name,
  }
  // the page may report unsaved edits before `opened` (a late joiner's log): kept, shown once open
  let unsaved = false
  let shown = false
  const named = (): string => (unsaved ? `${file.name} (저장 안 함)` : file.name)
  const editing = {
    onDirtyChange: (dirty: boolean) => {
      unsaved = dirty
      if (shown && observed.collab?.phase !== 'failed') status.textContent = named()
    },
  }
  /** what a host must do (docs/seuoffice/공동-편집.md): never store a lower version over a higher one */
  const stored = async (saved: {
    fileName: string
    bytes: Uint8Array
    version?: number
  }): Promise<void> => {
    const gate = saveGate
    if (gate) {
      observed.heldSaves += 1
      await gate.held
      observed.heldSaves -= 1
    }
    const newest = observed.saved?.version ?? null
    if (saved.version !== undefined && newest !== null && saved.version < newest) {
      throw new Error(`version ${saved.version} is older than the stored version ${newest}`)
    }
    observed.saved = {
      fileName: saved.fileName,
      bytes: saved.bytes,
      version: saved.version ?? null,
    }
    download(saved.fileName, saved.bytes)
    status.textContent = `${saved.fileName} 저장함`
  }
  const edit = collab ? collab.canEdit && editToggle.checked : editToggle.checked
  if (collab && edit) {
    current = rescue = openDocument(viewer, {
      ...base,
      ...editing,
      mode: 'edit',
      collab: relay(collab),
      onSave: (saved: CollabSavedFile) => stored(saved),
    })
  } else if (collab) {
    current = rescue = openDocument(viewer, { ...base, collab: relay(collab) })
  } else if (edit) {
    current = openDocument(viewer, {
      ...base,
      ...editing,
      mode: 'edit',
      onSave: (saved) => stored(saved),
    })
  } else {
    current = openDocument(viewer, base)
  }
  try {
    await current.opened
    shown = true
    status.textContent = named()
    saveButton.hidden = !edit
    observed.mode = collab ? 'collab' : edit ? 'locked' : 'view'
  } catch (error) {
    const code = error instanceof SeuofficeEmbedError ? error.code : 'open_failed'
    observed.openError = code
    // the page cannot co-edit this file: open it the way it was opened before co-editing
    if (collab && code === 'collab_unavailable') return open(file, null)
    status.textContent = `오류: ${code}`
  }
}

async function save(): Promise<string | null> {
  if (!current) return 'nothing is open'
  try {
    await current.save()
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status.textContent = `저장 실패: ${message}`
    return message
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0]
  if (file) void open(file, collabParams())
})

saveButton.addEventListener('click', () => void save())

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (file) void open(file, collabParams())
})
