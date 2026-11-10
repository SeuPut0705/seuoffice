/**
 * The Docs state outside the ProseMirror document that a save writes, as
 * synced entries: one entry per group of App fields that change together
 * (a value and its dirty flag), and one entry per item of the lists and
 * records people add to at the same time (comments, notes, ink, styles,
 * section headers, list definitions, sections), so two users commenting or
 * starting a list at once keep both.
 *
 * The App keeps this state in React; `context` is its FileActionContext,
 * refreshed on every render. Changes are found by polling the field
 * references (React state is replaced, never mutated), so the App needs no
 * hook of its own.
 */
import { MAX_CHANGE_BYTES, type CollabAdapter, type Json } from '@seuoffice/collab/client'
import type { Editor } from '@tiptap/core'
import {
  numberingLevelFromCustom,
  type NumberingDef,
  type NumberingLevel,
  type SectionInfo,
} from '@genoffice/docx-engine'
import { pendingNumberingDirty, type PendingNumbering } from '../renderer/doc-state'
import { buildDocBytes, type FileActionContext } from '../renderer/file-actions'
import { showToast } from '../renderer/components/toast-bus'
import { getLang } from '../renderer/i18n/locale'
import { waitForFullContent } from '../renderer/phased-content'
import {
  createDocsAdapter,
  PENDING_DEF,
  renamedEntry,
  type DocsOp,
  type SideStore,
} from './collab-adapter'

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
  const side = docsSide(handles)
  return createDocsAdapter({
    editor,
    side,
    produce: async (entries) => {
      await context.current.settleFontSettings?.()
      // the App's own settle hands back its live state, which would drop these entries
      const docx = await buildDocBytes({
        ...side.contextWith(entries),
        settleFontSettings: undefined,
      })
      if (!docx) throw new Error('the document could not be written')
      return { fileName: file.fileName, bytes: await file.finish(docx) }
    },
    pendingEdit: () => {
      // a table typed in place keeps its cells' text in the DOM until focus leaves it
      const active = document.activeElement
      if (!active?.closest('td[contenteditable="true"]') || !editor.view.dom.contains(active)) {
        return null
      }
      let pos: number | null = null
      editor.state.doc.descendants((node, at) => {
        const dom = editor.view.nodeDOM(at)
        if (!(dom instanceof Node) || !dom.contains(active)) return false
        if (node.attrs.table || node.attrs.model) pos = at
        return true
      })
      if (pos === null) return null
      return { pos, commit: () => window.dispatchEvent(new Event('ai-docs-commit-tables')) }
    },
    // room for the submit frame and the op's own wrapper around its steps
    maxOpBytes: MAX_CHANGE_BYTES - 4096,
    commitDrafts: () => window.dispatchEvent(new Event('ai-docs-commit-tables')),
    refused: (reason) => showToast(refusedText(reason), 'error'),
    // a renumbered list must not take the id of a definition numbering.xml holds unused
    definedIds: (kind) => (kind === 'num' ? doc.parsed.numbering.keys() : []),
  })
}

/** The App's toast, in the two languages the web pages default to */
function refusedText(reason: 'too_large' | 'frozen'): string {
  const ko = getLang() === 'ko'
  if (reason === 'too_large')
    return ko
      ? '이 편집은 함께 편집하기에 너무 커서 적용하지 않았습니다.'
      : 'This edit is too large to share while co-editing and was not applied.'
  return ko
    ? '파일을 저장하는 동안 한 편집은 적용하지 않았습니다. 다시 해 주세요.'
    : 'An edit made while the file was being saved was not applied. Please make it again.'
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
  trailingStartType: ['trailingStartType'],
  pageColor: ['pageColor', 'pageColorDirty'],
  header: ['header', 'headerDirty'],
  footer: ['footer', 'footerDirty'],
  hfVariants: ['hfVariants', 'hfVariantsDirty'],
  hfLinks: ['hfLinks'],
  titlePg: ['titlePg', 'titlePgDirty'],
  evenOddHf: ['evenOddHf', 'evenOddHfDirty'],
  mirrorMargins: ['mirrorMargins', 'mirrorMarginsDirty'],
  pgNum: ['pgNumEdit'],
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

/** Records synced key by key: a style upsert by style id, a section's header or footer by `block:kind` */
const RECORDS = {
  style: 'styleUpserts',
  sectionHf: 'sectionHfEdits',
} as const satisfies Record<string, Settable>

/** The entries of the pending list definitions (see `numberingEntries`) */
const NUMBERING = /^num(Level|Pic)?:/

/** The App fields the section entries stand for */
const SECTION_FIELDS = ['sections', 'sectionsDirty', 'pgNumDirtySections'] as const

const POLL_MS = 200

const plain = (value: unknown): Json =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json)

/** `[key without the prefix, value]` of every entry under `prefix:` */
function prefixed<T>(entries: Iterable<[string, T]>, prefix: string): [string, T][] {
  const items: [string, T][] = []
  for (const [key, value] of entries)
    if (key.startsWith(`${prefix}:`)) items.push([key.slice(prefix.length + 1), value])
  return items
}

function listOf(name: ListName, entries: ReadonlyMap<string, Json>): Json[] {
  return prefixed(entries, name).map(([, value]) => value)
}

/**
 * The pending list definitions, one entry each: `num:<numId>` a new
 * definition or a restarted list (the restart names its `abstractNumId`),
 * `numLevel:<abstractNumId>:<ilvl>` a level of one of the file's definitions
 * rewritten, `numPic:<id>` a picture bullet.
 */
function numberingEntries(pending: PendingNumbering): [string, Json][] {
  return [
    ...pending.newDefs.map((def): [string, Json] => [`num:${def.numId}`, plain(def)]),
    ...pending.restartNums.map((num): [string, Json] => [`num:${num.numId}`, plain(num)]),
    ...pending.levelEdits.map((edit): [string, Json] => [
      `numLevel:${edit.abstractNumId}:${edit.ilvl}`,
      plain(edit),
    ]),
    ...pending.picBullets.map((pic): [string, Json] => [`numPic:${pic.id}`, plain(pic)]),
  ]
}

function numberingOf(entries: Iterable<[string, Json]>): PendingNumbering {
  const pending: PendingNumbering = { newDefs: [], restartNums: [], levelEdits: [], picBullets: [] }
  for (const [key, value] of entries) {
    const item = value as never
    if (key.startsWith('num:')) {
      if ('abstractNumId' in (value as object)) pending.restartNums.push(item)
      else pending.newDefs.push(item)
    } else if (key.startsWith('numLevel:')) pending.levelEdits.push(item)
    else if (key.startsWith('numPic:')) pending.picBullets.push(item)
  }
  return pending
}

/** One section as synced: the App's entry and whether a save rewrites its sectPr and page numbers */
interface SyncedSection {
  info: SectionInfo
  dirty: boolean
  pgNumDirty: boolean
}

/**
 * A section's key is its break paragraph's block (`lastBlockIndex`), which a
 * peer's new break before it does not shift, so two people setting up
 * different sections write different entries. The final section has no break
 * of its own. A break inserted this session borrows the block before it, so
 * it is told apart by its rank among such breaks after that block.
 */
function sectionEntries(ctx: FileActionContext): [string, Json][] {
  const ranks = new Map<number, number>()
  return ctx.sections.map((info, i) => {
    let key = `section:${info.lastBlockIndex}`
    if (i === ctx.sections.length - 1) key = 'section:final'
    else if (info.pendingBreak) {
      const rank = ranks.get(info.lastBlockIndex) ?? 0
      ranks.set(info.lastBlockIndex, rank + 1)
      key = `section:${info.lastBlockIndex}+${rank}`
    }
    const synced: SyncedSection = {
      info,
      dirty: ctx.sectionsDirty.includes(i),
      pgNumDirty: ctx.pgNumDirtySections.includes(i),
    }
    return [key, plain(synced)]
  })
}

/** The section fields the entries stand for, the sections in document order */
function sectionsOf(
  entries: Iterable<[string, Json]>,
): Pick<FileActionContext, (typeof SECTION_FIELDS)[number]> {
  const placed = prefixed(entries, 'section').map(([id, value]) => {
    const [block, rank] = id.split('+')
    const at = id === 'final' ? [Infinity, 0] : [Number(block), rank === undefined ? -1 : +rank]
    return { at, synced: value as unknown as SyncedSection }
  })
  placed.sort((a, b) => (a.at[0] === b.at[0] ? a.at[1] - b.at[1] : a.at[0] < b.at[0] ? -1 : 1))
  const indexes = (flag: 'dirty' | 'pgNumDirty') =>
    placed.flatMap(({ synced }, i) => (synced[flag] ? [i] : []))
  return {
    sections: placed.map(({ synced }) => synced.info),
    sectionsDirty: indexes('dirty'),
    pgNumDirtySections: indexes('pgNumDirty'),
  }
}

/**
 * The FileActionContext fields that `entries` stand for, as the App would
 * hold them; `base` is each list as the document opened, which decides its
 * dirty flag.
 */
function fieldsOf(
  entries: ReadonlyMap<string, Json>,
  base: Record<ListName, string>,
): Record<string, unknown> {
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
  for (const [prefix, field] of Object.entries(RECORDS))
    fields[field] = Object.fromEntries(prefixed(entries, prefix))
  const pendingNumbering = numberingOf(entries)
  fields.pendingNumbering = pendingNumbering
  fields.numberingDirty = pendingNumberingDirty(pendingNumbering)
  Object.assign(fields, sectionsOf(entries))
  return fields
}

/** A picture bullet's image: a pending one's bytes, else the file's (as numbering-actions.ts finds it) */
function pictureOf(
  id: number | undefined,
  pictures: PendingNumbering['picBullets'],
  fileDefs: Iterable<NumberingDef>,
): string | undefined {
  if (id === undefined) return undefined
  const pic = pictures.find((p) => p.id === id)
  if (pic) return `data:${pic.mime};base64,${pic.base64}`
  for (const def of fileDefs)
    for (const level of Object.values(def.levels))
      if (level.picBulletId === id && level.picBulletSrc) return level.picBulletSrc
  return undefined
}

/** A new list's marker definition, as numbering-actions.ts overlays it on the page that made it */
function newDefinition(
  def: PendingNumbering['newDefs'][number],
  picture: (id: number | undefined) => string | undefined,
): NumberingDef {
  const levels: NumberingLevel[] = def.levels
    ? def.levels.map((level) => numberingLevelFromCustom(level, picture(level.picBulletId)))
    : Array.from({ length: 5 }, (_, i) => ({
        numFmt: def.kind === 'bullet' ? 'bullet' : 'decimal',
        lvlText: def.kind === 'bullet' ? '' : `%${i + 1}.`,
        start: 1,
        indentLeft: 720 * (i + 1),
        hanging: 360,
      }))
  return {
    numId: def.numId,
    abstractNumId: `${PENDING_DEF}${def.numId}`,
    levels: Object.fromEntries(levels.map((level, i) => [i, level])),
    startOverrides: {},
  }
}

/**
 * Draw the markers of lists a peer started or changed: numbering-actions.ts
 * overlays the definitions this page makes on the editor's numbering table
 * (the file is re-read only after a save), and the peer's go there too. A
 * renamed own list keeps the overlay this page made for it.
 */
function showDefinitions(
  editor: Editor,
  context: FileActionContext,
  renames: ReadonlyMap<string, string>,
  changed: [string, Json | null][],
): void {
  const store = editor.storage.listNumbering as { defs: Map<string, NumberingDef> }
  const defs = new Map(store.defs)
  const moved = new Set<string>()
  for (const [from, to] of prefixed(renames, 'num')) {
    for (const [numId, def] of defs) {
      if (def.abstractNumId === `${PENDING_DEF}${from}`)
        defs.set(numId, { ...def, abstractNumId: `${PENDING_DEF}${to}` })
    }
    const own = defs.get(from)
    if (!own) continue
    defs.delete(from)
    defs.set(to, { ...own, numId: to })
    moved.add(to)
  }
  const pictures = [
    ...context.pendingNumbering.picBullets,
    ...prefixed(changed, 'numPic').flatMap(([, pic]) =>
      pic ? [pic as unknown as PendingNumbering['picBullets'][number]] : [],
    ),
  ]
  const fileDefs = context.doc?.parsed.numbering.values() ?? []
  const picture = (id: number | undefined) => pictureOf(id, pictures, fileDefs)
  const items = prefixed(changed, 'num').filter(([numId, value]) => value && !moved.has(numId))
  // new definitions first: a restart in the same change may point at one
  for (const [, value] of items) {
    const def = value as unknown as PendingNumbering['newDefs'][number]
    if (!('abstractNumId' in def)) defs.set(def.numId, newDefinition(def, picture))
  }
  for (const [, value] of items) {
    const num = value as unknown as PendingNumbering['restartNums'][number]
    if (!('abstractNumId' in num)) continue
    const source = [...defs.values()].find((def) => def.abstractNumId === num.abstractNumId)
    if (source)
      defs.set(num.numId, { ...source, numId: num.numId, startOverrides: num.startOverrides })
  }
  for (const [, value] of prefixed(changed, 'numLevel')) {
    if (!value) continue
    const edit = value as unknown as PendingNumbering['levelEdits'][number]
    const level = numberingLevelFromCustom(edit.level, picture(edit.level.picBulletId))
    for (const [numId, def] of defs) {
      if (def.abstractNumId === edit.abstractNumId)
        defs.set(numId, { ...def, levels: { ...def.levels, [edit.ilvl]: level } })
    }
  }
  store.defs = defs
  // the marker plugin redraws when it sees a new table on the next transaction; a change
  // without steps brings none, so one follows once the engine's turn is over
  queueMicrotask(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr)
  })
}

export interface DocsSide extends SideStore {
  /** the App state with `entries` in place of its own, for a save that must hold exactly them */
  contextWith(entries: ReadonlyMap<string, Json>): FileActionContext
}

export function docsSide({ editor, context }: DocsCollabHandles): DocsSide {
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
    for (const [prefix, field] of Object.entries(RECORDS)) {
      for (const [key, value] of Object.entries(ctx[field]))
        entries.set(`${prefix}:${key}`, plain(value))
    }
    for (const [key, value] of numberingEntries(ctx.pendingNumbering)) entries.set(key, value)
    for (const [key, value] of sectionEntries(ctx)) entries.set(key, value)
    return entries
  }

  const opened = read(context.current)
  const base = Object.fromEntries(
    (Object.keys(LISTS) as ListName[]).map((name) => [name, JSON.stringify(listOf(name, opened))]),
  ) as Record<ListName, string>
  const watched = (ctx: FileActionContext): unknown[] => [
    ...Object.values(GROUPS).flatMap((names) => names.map((name) => ctx[name])),
    ...Object.values(LISTS).map(({ field }) => ctx[field]),
    ...Object.values(RECORDS).map((field) => ctx[field]),
    ctx.pendingNumbering,
    ...SECTION_FIELDS.map((field) => ctx[field]),
  ]
  let awaiting: { refs: unknown[]; until: number } | null = null

  return {
    read: () => read(context.current),

    write({ renames, entries }) {
      const ctx = context.current
      const setterOf = (name: string) =>
        ctx[`set${name[0].toUpperCase()}${name.slice(1)}` as keyof FileActionContext] as
          ((next: unknown) => void) | undefined
      let wrote = false
      for (const [group, names] of Object.entries(GROUPS)) {
        const value = entries.get(group)
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        for (const name of names) {
          if (JSON.stringify(ctx[name]) === JSON.stringify(value[name])) continue
          setterOf(name)?.(value[name])
          wrote = true
        }
      }
      for (const name of Object.keys(LISTS) as ListName[]) {
        const own = prefixed(renames, name)
        const changed = prefixed(entries, name)
        if (own.length === 0 && changed.length === 0) continue
        // on the list as the App holds it now, so an item added since the last read stays
        setterOf(LISTS[name].field)?.((prev: Array<{ id: string; parentId?: string }>) => {
          const renamed = new Map(own)
          let items = prev.map((item) => {
            const id = renamed.get(item.id) ?? item.id
            const parentId = item.parentId && (renamed.get(item.parentId) ?? item.parentId)
            return id === item.id && parentId === item.parentId ? item : { ...item, id, parentId }
          })
          for (const [id, value] of changed) {
            // the entry replaces every item with its id: a lagging list may hold two
            const at = items.findIndex((item) => item.id === id)
            const rest = items.filter((item) => item.id !== id)
            if (value === null) items = rest
            else if (at < 0) items = [...rest, value as { id: string }]
            else items = [...rest.slice(0, at), value as { id: string }, ...rest.slice(at)]
          }
          return items
        })
        setterOf(LISTS[name].dirty)?.(true)
        wrote = true
      }
      for (const [prefix, field] of Object.entries(RECORDS)) {
        const changed = prefixed(entries, prefix)
        if (changed.length === 0) continue
        setterOf(field)?.((prev: Record<string, Json>) => {
          const next = { ...prev }
          for (const [key, value] of changed) {
            if (value === null) delete next[key]
            else next[key] = value
          }
          return next
        })
        wrote = true
      }
      const numbering = [...entries].filter(([key]) => NUMBERING.test(key))
      if (numbering.length > 0 || prefixed(renames, 'num').length > 0) {
        // on the definitions as the App holds them now: a list this page just started
        // keeps its definition under its new id
        setterOf('pendingNumbering')?.((prev: PendingNumbering) => {
          const next = new Map(
            numberingEntries(prev).map(([key, value]) => renamedEntry(key, value, renames)),
          )
          for (const [key, value] of numbering) {
            if (value === null) next.delete(key)
            else next.set(key, value)
          }
          return numberingOf(next)
        })
        showDefinitions(editor, ctx, renames, numbering)
        wrote = true
      }
      const sections = [...entries].filter(([key]) => key.startsWith('section:'))
      if (sections.length > 0) {
        const next = new Map(sectionEntries(ctx))
        for (const [key, value] of sections) {
          if (value === null) next.delete(key)
          else next.set(key, value)
        }
        const fields = sectionsOf(next)
        for (const name of SECTION_FIELDS) setterOf(name)?.(fields[name])
        wrote = true
      }
      // the App shows the write on its next render; until then a read is the old state
      if (wrote) awaiting = { refs: watched(ctx), until: Date.now() + 1000 }
    },

    observe(changed) {
      let last = watched(context.current)
      const timer = setInterval(() => {
        const now = watched(context.current)
        if (awaiting) {
          if (Date.now() < awaiting.until && now.every((value, i) => value === awaiting!.refs[i])) {
            return
          }
          awaiting = null
        }
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
