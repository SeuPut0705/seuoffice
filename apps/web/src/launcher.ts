import {
  openDocument,
  SeuofficeEmbedError,
  type CollabRelay,
  type CollabSavedFile,
  type CollabStatus,
  type EmbeddedDocument,
} from '@seuoffice/embed'

const viewer = document.getElementById('viewer')!
const status = document.getElementById('status')!
const input = document.getElementById('file') as HTMLInputElement
const editToggle = document.getElementById('edit') as HTMLInputElement
const saveButton = document.getElementById('save') as HTMLButtonElement
let current: EmbeddedDocument | undefined

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

/** What a test reads back: the session's latest status and the latest stored save */
declare global {
  interface Window {
    seuLauncher?: {
      collab: CollabStatus | null
      saved: { fileName: string; bytes: Uint8Array; version: number | null } | null
    }
  }
}
const observed: NonNullable<Window['seuLauncher']> = { collab: null, saved: null }
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
  viewer.replaceChildren()
  saveButton.hidden = true
  status.textContent = `${file.name} 여는 중`
  const base = {
    baseUrl: new URL('./', location.href).href,
    bytes: await file.arrayBuffer(),
    fileName: file.name,
  }
  const editing = {
    onDirtyChange: (dirty: boolean) => {
      status.textContent = dirty ? `${file.name} (저장 안 함)` : file.name
    },
  }
  const stored = (saved: { fileName: string; bytes: Uint8Array; version?: number }): void => {
    observed.saved = { fileName: saved.fileName, bytes: saved.bytes, version: saved.version ?? null }
    download(saved.fileName, saved.bytes)
    status.textContent = `${saved.fileName} 저장함`
  }
  const edit = collab ? collab.canEdit && editToggle.checked : editToggle.checked
  if (collab && edit) {
    current = openDocument(viewer, {
      ...base,
      ...editing,
      mode: 'edit',
      collab: relay(collab),
      onSave: async (saved: CollabSavedFile) => stored(saved),
    })
  } else if (collab) {
    current = openDocument(viewer, { ...base, collab: relay(collab) })
  } else if (edit) {
    current = openDocument(viewer, {
      ...base,
      ...editing,
      mode: 'edit',
      onSave: async (saved) => stored(saved),
    })
  } else {
    current = openDocument(viewer, base)
  }
  try {
    await current.opened
    status.textContent = file.name
    saveButton.hidden = !edit
  } catch (error) {
    const code = error instanceof SeuofficeEmbedError ? error.code : 'open_failed'
    // the page cannot co-edit this file: open it the way it was opened before co-editing
    if (collab && code === 'collab_unavailable') return open(file, null)
    status.textContent = `오류: ${code}`
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0]
  if (file) void open(file, collabParams())
})

saveButton.addEventListener('click', () => {
  current?.save().catch((error: unknown) => {
    status.textContent = `저장 실패: ${error instanceof Error ? error.message : String(error)}`
  })
})

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (file) void open(file, collabParams())
})
