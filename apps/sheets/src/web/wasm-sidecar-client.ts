import {
  workbookFileSchema,
  workbookRangeResultSchema,
  workbookRedactionsResultSchema,
  type WorkbookRangeRequest,
  type WorkbookRangeResult,
  type WorkbookRedactionsResult,
} from '../shared/desktop-api'
import type { ResolvedWorkbookSave } from '../main/workbook-save-resolve'
import type { WorkerReply, WorkerRequest, WorkerSaveResult } from './xlsx-worker'

const PROTOCOL_VERSION = 1

// The engine does not know the digest or the read-only flag; the host adds them, as the desktop open does.
const sidecarOpenResultSchema = workbookFileSchema.omit({ sha256: true, readOnly: true })
export type SidecarOpenResult = ReturnType<typeof sidecarOpenResultSchema.parse>

interface SidecarResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

/** The sidecar client of the desktop build, backed by the xlsx engine running in a Web Worker. */
export class WasmSidecarClient {
  private readonly worker = new Worker(new URL('./xlsx-worker.ts', import.meta.url), {
    type: 'module',
  })
  private readonly pending = new Map<number, (reply: WorkerReply) => void>()
  private nextId = 0

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      this.pending.get(event.data.id)?.(event.data)
      this.pending.delete(event.data.id)
    })
    this.worker.addEventListener('error', (event) => {
      for (const resolve of this.pending.values())
        resolve({ id: -1, ok: false, error: event.message })
      this.pending.clear()
    })
  }

  private post(message: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []) {
    const id = this.nextId++
    return new Promise<WorkerReply>((resolve) => {
      this.pending.set(id, resolve)
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }

  private async send(command: string, fields: Record<string, unknown>): Promise<unknown> {
    const reply = await this.post({
      kind: 'call',
      request: { version: PROTOCOL_VERSION, requestId: String(this.nextId), command, ...fields },
    })
    if (!reply.ok) throw new Error(reply.error)
    const response = reply.result as SidecarResponse
    if (!response.ok) throw new Error(response.error?.message ?? `xlsx engine: ${command} failed`)
    return response.result
  }

  /** Makes the workbook readable by the engine as /work/<name>; the bytes are copied. */
  async put(name: string, bytes: Uint8Array): Promise<string> {
    const copy = bytes.slice().buffer
    const reply = await this.post({ kind: 'put', name, bytes: copy }, [copy])
    if (!reply.ok) throw new Error(reply.error)
    return `/work/${name}`
  }

  async open(path: string, locale: string, shortDateFormat?: string): Promise<SidecarOpenResult> {
    const result = await this.send('open', {
      path,
      locale,
      ...(shortDateFormat === undefined ? {} : { shortDateFormat }),
    })
    return sidecarOpenResultSchema.parse(result)
  }

  async readRange(request: WorkbookRangeRequest): Promise<WorkbookRangeResult> {
    const result = await this.send('read_range', {
      sessionId: request.sessionId,
      sheetId: request.sheetId,
      range: request.range,
    })
    return workbookRangeResultSchema.parse(result)
  }

  async close(sessionId: string): Promise<void> {
    await this.send('close', { sessionId })
  }

  /** Forgets /work/<name>; a workbook still open in the engine must be closed first */
  async drop(name: string): Promise<void> {
    const reply = await this.post({ kind: 'drop', name })
    if (!reply.ok) throw new Error(reply.error)
  }

  /** Writes /work/<target>: /work/<source> with the save's edits, untouched entries copied as they are */
  async save(
    source: string,
    target: string,
    save: ResolvedWorkbookSave,
  ): Promise<WorkerSaveResult> {
    const reply = await this.post({ kind: 'save', source, target, save })
    if (!reply.ok) throw new Error(reply.error)
    return reply.result as WorkerSaveResult
  }

  /** The cells the reader withheld from the model in /work/<source> (the desktop's readWorkbookRedactions) */
  async readRedactions(source: string): Promise<WorkbookRedactionsResult> {
    const reply = await this.post({ kind: 'redactions', source })
    if (!reply.ok) throw new Error(reply.error)
    return workbookRedactionsResultSchema.parse(reply.result)
  }
}
