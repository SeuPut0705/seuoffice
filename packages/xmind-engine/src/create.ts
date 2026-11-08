import { PRODUCT_NAME } from '@genoffice/i18n'
import { buildArchive } from './archive'
import { serializeSheets } from './content'
import type { XmindDocument } from './document'
import { CONTENT_ENTRY, MANIFEST_ENTRY, METADATA_ENTRY } from './entry-names'
import { newXmindId } from './ids'
import { openXmind } from './open'
import { checkContentStructure } from './structure-check'
import type { XmindSheet, XmindTopic } from './types'

/**
 * The version written as the creator's when the caller names none. Kept equal
 * to this package's version by a test.
 */
export const XMIND_ENGINE_VERSION = '0.1.0'

/** Writes a theme onto a sheet that was just made, in the properties the format defines. */
export type SheetThemeWriter = (sheet: XmindSheet) => void

let defaultSheetTheme: SheetThemeWriter | null = null

/**
 * Sets what dresses every new sheet (`newSheet`, and through it a new file).
 * The engine has no theme data of its own; until a writer is set, new sheets
 * carry no theme. The theme module registers the default theme here, so the
 * functions below never need to change for it. Pass null to clear.
 */
export function setDefaultSheetTheme(writer: SheetThemeWriter | null): void {
  defaultSheetTheme = writer
}

/** A new topic with a fresh id. */
export function newTopic(title: string): XmindTopic {
  return { id: newXmindId(), title }
}

export interface NewSheetOptions {
  title: string
  rootTitle: string
}

/**
 * A new sheet with one central topic: the smallest sheet the format accepts,
 * with keys in the order the format's own writer uses, and the default theme
 * when one is registered. No font name is written, and no structure class:
 * the central topic then uses the format's default arrangement.
 */
export function newSheet(options: NewSheetOptions): XmindSheet {
  const sheet: XmindSheet = {
    id: newXmindId(),
    class: 'sheet',
    rootTopic: { id: newXmindId(), class: 'topic', title: options.rootTitle },
    title: options.title,
  }
  defaultSheetTheme?.(sheet)
  return sheet
}

export interface CreateXmindOptions {
  /** the app version to record as the creator's; `XMIND_ENGINE_VERSION` when left out */
  creatorVersion?: string
  /** timestamp for the archive entries; the current time when left out */
  now?: Date
}

/**
 * A new map file: one sheet, one central topic. The titles come from the
 * caller, which knows the user's language.
 */
export function createXmindDocument(
  options: { sheetTitle: string; rootTitle: string } & CreateXmindOptions,
): Promise<XmindDocument> {
  const sheet = newSheet({ title: options.sheetTitle, rootTitle: options.rootTitle })
  return createXmindDocumentFromSheets([sheet], options)
}

/**
 * A new map file around sheets built by the caller (see `newSheet` and
 * `newTopic`). Throws when the sheets fail the structure check that opening
 * applies.
 *
 * The archive holds the three entries the format requires and nothing else:
 * `content.json`, `metadata.json` naming the product as the creator, and
 * `manifest.json` listing the two. Nothing in it is taken from a file written
 * by another program.
 */
export async function createXmindDocumentFromSheets(
  sheets: XmindSheet[],
  options: CreateXmindOptions = {},
): Promise<XmindDocument> {
  const check = checkContentStructure(sheets)
  if (!check.ok) throw new Error(`xmind: cannot create, ${check.problem}`)
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
  const metadata = {
    creator: { name: PRODUCT_NAME, version: options.creatorVersion ?? XMIND_ENGINE_VERSION },
  }
  const manifest = { 'file-entries': { [CONTENT_ENTRY]: {}, [METADATA_ENTRY]: {} } }
  const bytes = await buildArchive(
    [
      [CONTENT_ENTRY, encode(serializeSheets(sheets))],
      [METADATA_ENTRY, encode(JSON.stringify(metadata))],
      [MANIFEST_ENTRY, encode(JSON.stringify(manifest))],
    ],
    options.now ?? new Date(),
  )
  // Through the front door: a created document is exactly what opening its own
  // bytes gives, so it is unchanged until someone edits it.
  const opened = await openXmind(bytes)
  if (opened.status !== 'ok') throw new Error(`xmind: cannot create, ${opened.detail}`)
  return opened.document
}
