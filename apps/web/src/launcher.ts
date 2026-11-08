import { openDocument, SeuofficeEmbedError, type EmbeddedDocument } from '@seuoffice/embed'

const viewer = document.getElementById('viewer')!
const status = document.getElementById('status')!
const input = document.getElementById('file') as HTMLInputElement
const editToggle = document.getElementById('edit') as HTMLInputElement
const saveButton = document.getElementById('save') as HTMLButtonElement
let current: EmbeddedDocument | undefined

/** The launcher is its own host: a saved document comes back as a download */
function download(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function open(file: File): Promise<void> {
  current?.destroy()
  viewer.replaceChildren()
  saveButton.hidden = true
  status.textContent = `${file.name} 여는 중`
  const base = {
    baseUrl: new URL('./', location.href).href,
    bytes: await file.arrayBuffer(),
    fileName: file.name,
  }
  current = editToggle.checked
    ? openDocument(viewer, {
        ...base,
        mode: 'edit',
        onSave: async (saved) => {
          download(saved.fileName, saved.bytes)
          status.textContent = `${saved.fileName} 저장함`
        },
        onDirtyChange: (dirty) => {
          status.textContent = dirty ? `${file.name} (저장 안 함)` : file.name
        },
      })
    : openDocument(viewer, base)
  try {
    await current.opened
    status.textContent = file.name
    saveButton.hidden = !editToggle.checked
  } catch (error) {
    const code = error instanceof SeuofficeEmbedError ? error.code : 'open_failed'
    status.textContent = `오류: ${code}`
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0]
  if (file) void open(file)
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
  if (file) void open(file)
})
