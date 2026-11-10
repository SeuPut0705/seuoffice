/**
 * The App's write paths without React: `applyEditOps` (refuse, plan over the
 * real registry, reduce each touched bucket, hand the result to the session),
 * undo and redo over whole snapshots, and the two things the session asks of
 * the App (show a snapshot, rewrite the history). The adapter under test is the
 * real one.
 */
import type { CollabAdapter, Json } from '@seuoffice/collab/client'
import {
  planEditOps,
  reduceBucket,
  type Op,
  type OpContext,
  type PlanResult,
} from '../../src/renderer/edit-ops'
import type { EditSnapshot } from '../../src/renderer/edit-state'
import {
  createPdfAdapter,
  type PdfHost,
  type PdfCollabLink,
  type Refusal,
} from '../../src/web/collab-adapter'
import { canonical, emptySnapshot, pageCount, type PdfOp } from '../../src/web/collab-model'

/** A test file: the opened document's page count and the edits it already holds */
export interface TestFile {
  pages: number
  snapshot: EditSnapshot
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function fileBytes(file: TestFile): Uint8Array {
  const s = file.snapshot
  const json = {
    pages: file.pages,
    snapshot: {
      ...s,
      formEdits: [...s.formEdits],
      formWidgetEdits: [...s.formWidgetEdits],
      rotations: [...s.rotations],
      deleted: [...s.deleted],
    },
  }
  // a fresh Uint8Array: jsdom's TextEncoder output is not this realm's (the server checks instanceof)
  return new Uint8Array(encoder.encode(JSON.stringify(json)))
}

export function readFile(bytes: Uint8Array): TestFile {
  const json = JSON.parse(decoder.decode(bytes)) as {
    pages: number
    snapshot: Record<string, unknown>
  }
  const s = json.snapshot
  return {
    pages: json.pages,
    snapshot: {
      ...(s as unknown as EditSnapshot),
      formEdits: new Map(s.formEdits as [string, never][]),
      formWidgetEdits: new Map(s.formWidgetEdits as [string, never][]),
      rotations: new Map(s.rotations as [number, number][]),
      deleted: new Set(s.deleted as number[]),
    },
  }
}

export const blankFile = (pages = 3): TestFile => ({ pages, snapshot: emptySnapshot() })

let clients = 0

export class HeadlessPdf implements PdfHost {
  state: EditSnapshot
  undoStack: EditSnapshot[] = []
  redoStack: EditSnapshot[] = []
  link: { current: PdfCollabLink | null } = { current: null }
  readonly refusals: Refusal[] = []
  readonly name = `c${++clients}`
  private serial = 0

  constructor(
    readonly basePages: number,
    state: EditSnapshot,
  ) {
    this.state = state
  }

  snapshot = (): EditSnapshot => this.state
  show = (s: EditSnapshot): void => {
    this.state = s
  }
  mapHistory = (map: (s: EditSnapshot) => EditSnapshot): void => {
    this.undoStack = this.undoStack.map(map)
    this.redoStack = this.redoStack.map(map)
  }

  /** what the App's newId mints: unique per page */
  newId = (): string => `${this.name}-${++this.serial}`

  context(): OpContext {
    const s = this.state
    return {
      readOnly: false,
      pageCount: pageCount(s, this.basePages),
      deleted: s.deleted,
      claimedImages: new Set(),
      fieldNames: new Set(s.formFields.map((f) => f.input.name)),
      radioGroups: new Set(
        s.formFields.filter((f) => f.input.kind === 'radio').map((f) => f.input.name),
      ),
    }
  }

  /** App.applyEditOps */
  apply(ops: Op[]): PlanResult {
    const refused = this.link.current?.refuse(ops)
    if (refused) return refused
    const plan = planEditOps(ops, this.context(), this.newId)
    if (plan.failures.length > 0 || plan.ops.length === 0) return plan
    this.undoStack = [...this.undoStack.slice(-49), this.state]
    this.redoStack = []
    const base = this.state
    const next: EditSnapshot = { ...base }
    for (const bucket of plan.touched) {
      ;(next as unknown as Record<string, unknown>)[bucket] = reduceBucket(
        bucket,
        base[bucket],
        plan.ops,
        base,
      )
    }
    this.state = next
    this.link.current?.changed(this.state)
    return plan
  }

  undo(): boolean {
    const top = this.undoStack.at(-1)
    if (!top || this.link.current?.blocks('history')) return false
    this.redoStack = [...this.redoStack, this.state]
    this.undoStack = this.undoStack.slice(0, -1)
    this.state = top
    this.link.current?.changed(top)
    return true
  }

  redo(): boolean {
    const top = this.redoStack.at(-1)
    if (!top || this.link.current?.blocks('history')) return false
    this.undoStack = [...this.undoStack, this.state]
    this.redoStack = this.redoStack.slice(0, -1)
    this.state = top
    this.link.current?.changed(top)
    return true
  }

  visible(): number[] {
    const s = this.state
    const order = s.order ?? Array.from({ length: pageCount(s, this.basePages) }, (_, i) => i)
    return order.filter((p) => !s.deleted.has(p))
  }
}

export const MAX_OP_BYTES = 64 * 1024

/** The real adapter over a headless App; `produce` writes the test file */
export interface Opened {
  app: HeadlessPdf
  adapter: CollabAdapter<PdfOp>
  /** run `act` as one tagged user action; true when it sent an op */
  tagged(id: string, act: () => unknown): boolean
  /** the App's edit state as canonical JSON */
  print(): string
}

export function openHeadless(bytes: Uint8Array, options: { maxOpBytes?: number } = {}): Opened {
  const file = readFile(bytes)
  const app = new HeadlessPdf(file.pages, file.snapshot)
  let nextId: string | null = null
  let sent = 0
  const inner = createPdfAdapter({
    host: app,
    basePages: file.pages,
    base: file.snapshot,
    produce: async (s) => ({
      fileName: 'shared.pdf',
      bytes: fileBytes({ pages: file.pages, snapshot: s }),
    }),
    refused: (reason) => {
      app.refusals.push(reason)
      return `refused: ${reason.kind}`
    },
    maxOpBytes: options.maxOpBytes ?? MAX_OP_BYTES,
    newId: () => nextId ?? app.newId(),
  })
  const adapter: CollabAdapter<PdfOp> = {
    ...inner,
    listen: (emit) =>
      inner.listen((ops) => {
        sent += ops.length
        emit(ops)
      }),
  }
  return {
    app,
    adapter,
    tagged(id, act) {
      const before = sent
      nextId = id
      try {
        act()
      } finally {
        nextId = null
      }
      return sent > before
    },
    print: () => canonical(app.state),
  }
}

/** One person's page in a `Room`: its headless App and the ops it has not had confirmed */
export interface RoomPage extends Opened {
  local: PdfOp[]
}

/**
 * The server's ordering without the network: each `settle` argument submits
 * everything it holds, in turn; the others integrate it, the sender has it
 * confirmed. A late joiner replays the whole log.
 */
export class Room {
  /** the changes as the server holds them: what each sender put on the wire */
  readonly log: Json[] = []
  readonly pages: RoomPage[] = []

  constructor(readonly file: TestFile = blankFile()) {}

  join(): RoomPage {
    const opened = openHeadless(fileBytes(this.file))
    const page: RoomPage = { ...opened, local: [] }
    opened.adapter.listen((ops) => page.local.push(...ops))
    if (this.log.length > 0)
      opened.adapter.integrate(
        this.log.map((wire) => opened.adapter.decode(wire)),
        [],
      )
    this.pages.push(page)
    return page
  }

  settle(...order: RoomPage[]): void {
    for (const sender of order) {
      const sent = sender.local
      if (sent.length === 0) continue
      sender.local = []
      // the wire: the sender encodes as it submits, every other page decodes what was sent
      const wire = sent.map((op) => JSON.parse(JSON.stringify(sender.adapter.encode(op))) as Json)
      this.log.push(...wire)
      sender.adapter.confirmed?.(sent)
      for (const other of this.pages) {
        if (other === sender) continue
        const remote = wire.map((json) => other.adapter.decode(json))
        other.local = other.adapter.integrate(remote, other.local)
      }
    }
  }

  /** a page that opens now and replays the log */
  late(): RoomPage {
    const page = this.join()
    this.pages.pop()
    return page
  }
}
