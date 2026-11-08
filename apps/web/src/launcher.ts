import { openDocument, SeuofficeEmbedError, type EmbeddedDocument } from '@seuoffice/embed'

const viewer = document.getElementById('viewer')!
const status = document.getElementById('status')!
const input = document.getElementById('file') as HTMLInputElement
let current: EmbeddedDocument | undefined

async function open(file: File): Promise<void> {
  current?.destroy()
  viewer.replaceChildren()
  status.textContent = `${file.name} 여는 중`
  current = openDocument(viewer, {
    baseUrl: new URL('./', location.href).href,
    bytes: await file.arrayBuffer(),
    fileName: file.name,
  })
  try {
    await current.opened
    status.textContent = file.name
  } catch (error) {
    const code = error instanceof SeuofficeEmbedError ? error.code : 'open_failed'
    status.textContent = `오류: ${code}`
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0]
  if (file) void open(file)
})

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files[0]
  if (file) void open(file)
})
