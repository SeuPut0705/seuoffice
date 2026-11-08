/**
 * What an ODT document may not do in the Word editor, in one place.
 *
 * An ODT tab edits the bridge docx of its ODT (`doc.odt`), and saving writes
 * that docx back into the ODT. Features the ODT write-back cannot carry are
 * switched off for the tab: every entry point (ribbon, menus, shortcuts,
 * context menus, AI tools, in-app MCP operations) asks here, and a refused
 * action tells the user why (`appOdtOff`). A docx tab never gets a session, so
 * nothing here changes how docx documents behave.
 *
 * The session is module state (one document per editor renderer) so that
 * editor plugins, the AI tool executor and React components read the same
 * answer; components subscribe with `useOdtSession`.
 */
import { useSyncExternalStore } from 'react'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { ParsedDocFull } from '@genoffice/docx-engine'
import {
  parseKeepName,
  type BridgeMap,
  type ObjectKind,
  type ObjectsExt,
} from '@genoffice/odt-engine'
import { showToast } from './components/toast-bus'
import { t, type StringKey } from './i18n/locale'

/** the features an ODT document switches off (the spec list) */
export const ODT_OFF_FEATURES = [
  'comment',
  'trackChanges',
  'compare',
  'watermark',
  'ink',
  'toc',
  'equation',
  'shape',
  'textbox',
  'chart',
  'columns',
  'citation',
  'caption',
  'pageColor',
  'password',
  'editRestriction',
  'readOnlyRecommended',
  'theme',
  'mirrorMargins',
] as const
export type OdtOffFeature = (typeof ODT_OFF_FEATURES)[number]

export interface OdtSession {
  /** the bridge map of the ODT as opened (never replaced by saves) */
  bridge: BridgeMap
  /** the docx the editor's `docxIndex` attributes currently point into */
  parsed: ParsedDocFull
  /**
   * true while `docxIndex` still addresses the bridge docx itself (the open
   * document); false once a save re-based the editor on the saved docx
   */
  bridgeIndexes: boolean
  /** placeholder id -> it shows a preview stored in the file (false = neutral picture) */
  previews: Map<string, boolean>
  /** comment ids the ODT already had (existing comments stay; new ones are refused) */
  commentIds: Set<string>
  /** the print / PDF notice about label boxes was shown for this document */
  labelNoticeShown: boolean
}

let session: OdtSession | null = null
let version = 0
const listeners = new Set<() => void>()

function changed(): void {
  version++
  for (const fn of listeners) fn()
}

function previewsOf(bridge: BridgeMap): Map<string, boolean> {
  const ext = bridge.ext.objects as unknown as ObjectsExt | undefined
  return new Map((ext?.placeholders ?? []).map((p) => [p.id, p.preview]))
}

/**
 * Start (ODT document) or end (anything else) the session for the document
 * the editor is about to show. Call before the editor content is set: the
 * placeholder labels are drawn while the content renders.
 */
export function beginOdtSession(
  odt: { bridge: BridgeMap } | undefined | null,
  parsed: ParsedDocFull,
): void {
  if (!odt) {
    if (session === null) return
    session = null
    changed()
    return
  }
  session = {
    bridge: odt.bridge,
    parsed,
    bridgeIndexes: true,
    previews: previewsOf(odt.bridge),
    commentIds: new Set(parsed.comments.map((c) => c.id)),
    labelNoticeShown: false,
  }
  blockXmlCache = null
  changed()
}

/** End any session (new blank documents, tests). */
export function endOdtSession(): void {
  if (session === null) return
  session = null
  changed()
}

/**
 * A save re-based the editor on the docx it just wrote: `docxIndex` now
 * addresses that docx. Call before the editor content is replaced.
 */
export function rebaseOdtSession(parsed: ParsedDocFull): void {
  if (!session) return
  session = { ...session, parsed, bridgeIndexes: false }
  blockXmlCache = null
  changed()
}

export function odtSession(): OdtSession | null {
  return session
}

/** true for an ODT document: every `OdtOffFeature` is off */
export function isOdtSession(): boolean {
  return session !== null
}

export function odtFeatureOff(_feature: OdtOffFeature): boolean {
  return session !== null
}

/** the notice a switched-off control shows */
export function odtOffNotice(): string {
  return t('appOdtOff')
}

let lastNotice = { text: '', at: 0 }

/** Toast `key`, but not the same text twice within a moment (key repeat, drags). */
export function notifyOdt(key: StringKey): void {
  const text = t(key)
  const now = Date.now()
  if (lastNotice.text === text && now - lastNotice.at < 1500) return
  lastNotice = { text, at: now }
  showToast(text, 'error')
}

/**
 * The guard for an action entry point: true (and the user told why) when the
 * feature is off for this document, false when the action may run.
 */
export function refuseInOdt(feature: OdtOffFeature): boolean {
  if (!odtFeatureOff(feature)) return false
  notifyOdt('appOdtOff')
  return true
}

/** React: re-render when a document of the other kind is opened. */
export function useOdtSession(): boolean {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => version,
  )
  return session !== null
}

/**
 * Props that switch a ribbon / menu button off for an ODT document. Spread
 * them after the button's own `disabled`: off, it is disabled and its screen
 * tip carries the notice under the command name.
 */
export function odtOffProps(
  off: boolean,
  /** the command name, for a control that has no screen tip of its own */
  tip?: string,
): {
  disabled?: boolean
  'data-tip'?: string
  'data-tip-detail'?: string
  'aria-disabled'?: boolean
} {
  if (!off) return {}
  return {
    disabled: true,
    ...(tip ? { 'data-tip': tip } : {}),
    'data-tip-detail': odtOffNotice(),
    'aria-disabled': true,
  }
}

// ---- locked placeholders (`odt-keep:<id>:<kind>` pictures) ----

export interface KeepInfo {
  id: string
  kind: ObjectKind
  /** no preview picture in the file: the editor draws a label for it */
  neutral: boolean
}

let blockXmlCache: Map<number, string> | null = null

function blockXmlByIndex(): Map<number, string> {
  if (blockXmlCache) return blockXmlCache
  const map = new Map<number, string>()
  for (const block of session?.parsed.blocks ?? []) {
    if (block.docxIndex !== null && block.originalXml) map.set(block.docxIndex, block.originalXml)
  }
  blockXmlCache = map
  return map
}

/** the `wp:docPr` name of the first drawing in a fragment */
export function docPrNameOf(xml: string): string | null {
  const m = /<wp:docPr\b[^>]*?\bname="([^"]*)"/.exec(xml)
  return m ? m[1] : null
}

/** every `wp:docPr` name in a fragment, in order */
export function docPrNamesOf(xml: string): string[] {
  return [...xml.matchAll(/<wp:docPr\b[^>]*?\bname="([^"]*)"/g)].map((m) => m[1])
}

function keepOfName(name: string | null): KeepInfo | null {
  if (!session || !name) return null
  const parsed = parseKeepName(name)
  if (!parsed) return null
  return { ...parsed, neutral: session.previews.get(parsed.id) === false }
}

/**
 * The placeholder a picture node stands for, or null (no ODT session, or an
 * ordinary picture). Inline pictures carry their drawing XML; block pictures
 * are looked up through `docxIndex` in the docx the editor is based on.
 */
export function keepOfNode(node: PmNode): KeepInfo | null {
  if (!session) return null
  if (node.type.name === 'docInlineImage')
    return keepOfName(docPrNameOf(String(node.attrs.xml ?? '')))
  if (node.type.name === 'docProtected' && node.attrs.blockType === 'image') {
    const index = node.attrs.docxIndex
    if (typeof index !== 'number') return null
    return keepOfName(docPrNameOf(blockXmlByIndex().get(index) ?? ''))
  }
  return null
}

/** the localized label of a placeholder kind, e.g. "Equation (shown in Hancom)" */
export const LABEL_KEYS: Record<ObjectKind, StringKey> = {
  equation: 'appOdtLabelEquation',
  shape: 'appOdtLabelShape',
  textbox: 'appOdtLabelTextbox',
  toc: 'appOdtLabelToc',
  chart: 'appOdtLabelChart',
  revision: 'appOdtLabelRevision',
  object: 'appOdtLabelObject',
}

export function labelText(kind: ObjectKind): string {
  return t(LABEL_KEYS[kind])
}

/** the document has placeholders the editor draws as label boxes */
export function hasLabelPlaceholders(): boolean {
  if (!session) return false
  for (const preview of session.previews.values()) if (!preview) return true
  return false
}

/**
 * Before printing or exporting to PDF: once per document, say that label
 * boxes may differ from how Hancom shows those objects.
 */
export function noticeLabelsBeforeOutput(): void {
  if (!session || session.labelNoticeShown || !hasLabelPlaceholders()) return
  session.labelNoticeShown = true
  showToast(t('appOdtLabelNotice'), 'error')
}

// ---- refusals the editor guard records for the AI / MCP tool executor ----

export type OdtRefusal = 'protectedCell' | 'lockedObject'

let refusal: OdtRefusal | null = null

/** the editor guard refused a transaction (read and cleared by the tool executor) */
export function recordOdtRefusal(kind: OdtRefusal): void {
  refusal = kind
}

export function takeOdtRefusal(): OdtRefusal | null {
  const kind = refusal
  refusal = null
  return kind
}
