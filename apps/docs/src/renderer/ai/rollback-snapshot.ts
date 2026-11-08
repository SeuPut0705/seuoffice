import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TABLE_TRAILING_SKIP } from '../editor/extensions'

/**
 * The roll-back point of an AI run: the document node itself, not a JSON copy.
 * The node is immutable and shares every part the run leaves untouched with the
 * live document, so keeping it costs about what changed after it. The agent
 * loop asks for one before each tool until the run's first edit, so a run that
 * reads several times before editing no longer copies the whole document each
 * time.
 */
export function captureRollbackSnapshot(editor: Editor): ProseMirrorNode {
  return editor.state.doc
}

/** Put the document back to a roll-back point. */
export function restoreRollbackSnapshot(editor: Editor, snapshot: ProseMirrorNode): void {
  editor
    .chain()
    .setMeta(TABLE_TRAILING_SKIP, true)
    // a snapshot from an editor instance since replaced goes through JSON into this schema
    .setContent(snapshot.type.schema === editor.schema ? snapshot : snapshot.toJSON())
    .run()
}
