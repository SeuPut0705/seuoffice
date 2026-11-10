/**
 * The Docs state outside the ProseMirror document that a save writes, as
 * synced entries: one entry per group of App fields that change together
 * (a value and its dirty flag), and one entry per item of the lists people
 * add to at the same time (comments, notes, ink), so two users commenting at
 * once keep both comments.
 *
 * The App keeps this state in React; `context` is its FileActionContext,
 * refreshed on every render. Changes are found by polling the field
 * references (React state is replaced, never mutated), so the App needs no
 * hook of its own.
 */
import type { CollabAdapter, Json } from '@seuoffice/collab/client'
import type { Editor } from '@tiptap/core'
import { pendingNumberingDirty, type PendingNumbering } from '../renderer/doc-state'
import { buildDocBytes, type FileActionContext } from '../renderer/file-actions'
import { waitForFullContent } from '../renderer/phased-content'
import { createDocsAdapter, type DocsOp, type SideStore } from './collab-adapter'

/** What the renderer hands over once the co-edited document is on screen */
export interface DocsCollabHandles {
  editor: Editor
  /** the App state the file actions read, refreshed on every render */
  context: { readonly current: FileActionContext }
}

/**
 * The adapter for the document the page opened at `path`. `finish` turns the
 * editor's docx into the file the host stores (the open password goes back on).
 */
export async function openDocsCollab(
  handles: DocsCollabHandles,
  file: { path: string; fileName: string; finish(docx: Uint8Array): Promise<Uint8Array> },
): Promise<CollabAdapter<DocsOp>> {
  const { editor, context } = handles
  // a large document streams its tail in after the first render; the log starts from all of it
  await waitForFullContent()
  const doc = context.current.doc
  if (!doc || doc.filePath !== file.path || doc.format !== 'docx') {
    throw new Error('the editor does not show the co-edited document')
  }
  const side = docsSide(context)
  return createDocsAdapter({
    editor,
    side,
    produce: async (entries) => {
      await context.current.settleFontSettings?.()
      // the App's own settle hands back its live state, which would drop these entries
      const docx = await buildDocBytes({ ...side.contextWith(entries), settleFontSettings: undefined })
      if (!docx) throw new Error('the document could not be written')
      return { fileName: file.fileName, bytes: await file.finish(docx) }
    },
  })
}

/** App fields with a setter of the same name (`x` and `setX`) */
type Settable = {
  [K in keyof FileActionContext]-?: `set${Capitalize<K & string>}` extends keyof FileActionContext
    ? K
    : never
}[keyof FileActionContext]

/** Fields written together as one entry */
const GROUPS: Record<string, readonly Settable[]> = {
  section: ['section', 'sectionDirty'],
  sections: ['sections', 'sectionsDirty', 'trailingStartType'],
  pageColor: ['pageColor', 'pageColorDirty'],
  header: ['header', 'headerDirty'],
  footer: ['footer', 'footerDirty'],
  hfVariants: ['hfVariants', 'hfVariantsDirty'],
  sectionHfEdits: ['sectionHfEdits'],
  hfLinks: ['hfLinks'],
  titlePg: ['titlePg', 'titlePgDirty'],
  evenOddHf: ['evenOddHf', 'evenOddHfDirty'],
  mirrorMargins: ['mirrorMargins', 'mirrorMarginsDirty'],
  pgNum: ['pgNumEdit', 'pgNumDirtySections'],
  numbering: ['pendingNumbering'],
  styleUpserts: ['styleUpserts'],
  defaultFonts: ['defaultFonts'],
  watermark: ['watermark', 'watermarkDirty', 'watermarkStyle', 'watermarkPicture'],
  sources: ['sources', 'sourcesDirty'],
  zotero: ['zoteroDocumentData', 'zoteroDocumentDataDirty'],
  themeFonts: ['themeFonts', 'themeFontsDirty'],
  themeColors: ['themeColors', 'themeColorsDirty'],
  protection: ['protection', 'protectionDirty'],
  writeProtection: ['writeProtection', 'writeProtectionDirty'],
  removePersonalInfo: ['removePersonalInfo', 'removePersonalInfoDirty'],
}

/** Lists synced item by item; `dirty` is true once the list differs from the opened file's */
const LISTS = {
  comment: { field: 'comments', dirty: 'commentsDirty' },
  footnote: { field: 'footnotes', dirty: 'notesDirty' },
  endnote: { field: 'endnotes', dirty: 'notesDirty' },
  ink: { field: 'inkAnnotations', dirty: 'inksDirty' },
} as const satisfies Record<string, { field: Settable; dirty: Settable }>

type ListName = keyof typeof LISTS

const POLL_MS = 200

const plain = (value: unknown): Json => (value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json))

function listOf(name: ListName, entries: ReadonlyMap<string, Json>): Json[] {
  const prefix = `${name}:`
  const items: Json[] = []
  for (const [key, value] of entries) if (key.startsWith(prefix)) items.push(value)
  return items
}

/**
 * The FileActionContext fields that `entries` stand for, as the App would
 * hold them; `base` is each list as the document opened, which decides its
 * dirty flag.
 */
function fieldsOf(entries: ReadonlyMap<string, Json>, base: Record<ListName, string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [group, names] of Object.entries(GROUPS)) {
    const value = entries.get(group)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    // a field missing from the entry was undefined in the App (defaultFonts, for one)
    for (const name of names) fields[name] = value[name]
  }
  let notesDirty = false
  for (const name of Object.keys(LISTS) as ListName[]) {
    const { field, dirty } = LISTS[name]
    const items = listOf(name, entries)
    fields[field] = items
    const changed = JSON.stringify(items) !== base[name]
    if (dirty === 'notesDirty') notesDirty ||= changed
    else fields[dirty] = changed
  }
  fields.notesDirty = notesDirty
  if (fields.pendingNumbering) {
    fields.numberingDirty = pendingNumberingDirty(fields.pendingNumbering as PendingNumbering)
  }
  return fields
}

export interface DocsSide extends SideStore {
  /** the App state with `entries` in place of its own, for a save that must hold exactly them */
  contextWith(entries: ReadonlyMap<string, Json>): FileActionContext
}

export function docsSide(context: { readonly current: FileActionContext }): DocsSide {
  const read = (ctx: FileActionContext): Map<string, Json> => {
    const entries = new Map<string, Json>()
    for (const [group, names] of Object.entries(GROUPS)) {
      const value: Record<string, Json> = {}
      for (const name of names) if (ctx[name] !== undefined) value[name] = plain(ctx[name])
      entries.set(group, value)
    }
    for (const name of Object.keys(LISTS) as ListName[]) {
      const items = ctx[LISTS[name].field] as { id: string }[]
      for (const item of items) entries.set(`${name}:${item.id}`, plain(item))
    }
    return entries
  }

  const opened = read(context.current)
  const base = Object.fromEntries(
    (Object.keys(LISTS) as ListName[]).map((name) => [name, JSON.stringify(listOf(name, opened))]),
  ) as Record<ListName, string>
  const watched = (ctx: FileActionContext): unknown[] => [
    ...Object.values(GROUPS).flatMap((names) => names.map((name) => ctx[name])),
    ...Object.values(LISTS).map(({ field }) => ctx[field]),
  ]

  return {
    read: () => read(context.current),

    write(entries) {
      const ctx = context.current
      const fields = fieldsOf(entries, base)
      for (const [name, value] of Object.entries(fields)) {
        if (name === 'numberingDirty') continue
        // equal values keep the App's own objects, so nothing re-renders for them
        if (JSON.stringify(ctx[name as Settable]) === JSON.stringify(value)) continue
        const setter = ctx[`set${name[0].toUpperCase()}${name.slice(1)}` as keyof FileActionContext]
        if (typeof setter === 'function') (setter as (next: unknown) => void)(value)
      }
    },

    observe(changed) {
      let last = watched(context.current)
      const timer = setInterval(() => {
        const now = watched(context.current)
        if (now.every((value, i) => value === last[i])) return
        last = now
        changed()
      }, POLL_MS)
      return () => clearInterval(timer)
    },

    contextWith(entries) {
      return { ...context.current, ...fieldsOf(entries, base) }
    },
  }
}
