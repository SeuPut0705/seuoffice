import { parseDocx } from '@genoffice/docx-engine'
import { MAX_CHANGE_BYTES, type CollabAdapter, type Json } from '@seuoffice/collab/client'
import { Editor } from '@tiptap/core'
import { buildDocx } from '../../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../../src/renderer/editor/convert'
import { editorExtensions } from '../../src/renderer/editor/extensions'
import { createDocsAdapter, type DocsOp } from '../../src/web/collab-adapter'

export interface CollabPage {
  editor: Editor
  adapter: CollabAdapter<DocsOp>
  /** the ops this page handed the engine, oldest first */
  sent: DocsOp[]
  /** why an edit of this person's was not applied, one entry per refused edit */
  refused: string[]
  /** the App's outside state (headers, comments), and this person's change to it */
  entries(): Map<string, Json>
  set(key: string, value: Json): void
}

/** The editor's document for a docx whose body is `bodyXml`, as opening the file makes it */
export async function openedBody(bodyXml: string): Promise<unknown> {
  return blocksToPmDoc((await parseDocx(await buildDocx({ bodyXml }))).blocks)
}

/**
 * One person's page in a co-editing session: a real editor on `content` and
 * the adapter that judges its edits. The caller destroys the editor.
 */
export function collabPage(content: unknown): CollabPage {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: content as never,
  })
  let entries = new Map<string, Json>()
  let changed: (() => void) | null = null
  const refused: string[] = []
  const adapter = createDocsAdapter({
    editor,
    side: {
      read: () => new Map(entries),
      write: ({ entries: next }) => {
        entries = new Map(entries)
        for (const [key, value] of next) {
          if (value === null) entries.delete(key)
          else entries.set(key, value)
        }
      },
      observe: (handler) => {
        changed = handler
        return () => (changed = null)
      },
    },
    produce: async () => ({ fileName: 'memo.json', bytes: new Uint8Array() }),
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
    refused: (reason) => refused.push(reason),
  })
  const sent: DocsOp[] = []
  adapter.listen((ops) => sent.push(...ops))
  return {
    editor,
    adapter,
    sent,
    refused,
    entries: () => entries,
    set(key, value) {
      entries = new Map(entries).set(key, value)
      changed?.()
    },
  }
}

/** `to` takes `ops` from `from` over the wire, as confirmed changes it did not make */
export function carry(ops: DocsOp[], from: CollabPage, to: CollabPage): void {
  to.adapter.integrate(
    ops.map((op) => to.adapter.decode(from.adapter.encode(op))),
    [],
  )
  from.adapter.confirmed?.(ops)
}
