/**
 * remove_parts: drop metadata-carrying package parts (customXml stores and
 * web-extension/add-in parts) from a saved .docx, with the package wiring that
 * would otherwise dangle (relationships, [Content_Types].xml entries, empty
 * folders). Used by the docs `remove_parts` op for pre-filing scrubs.
 *
 * The pass is deliberately narrow: it only removes the parts that were asked
 * for, plus their own relationship parts and now-dangling relationship
 * elements / content-type entries. Every other part keeps its bytes.
 *
 * A removed customXml store can back block-level content controls through
 * w:dataBinding/w:storeItemID. By default the save refuses (the control would
 * be orphaned); `dataBinding: "strip"` removes the w:dataBinding element and
 * keeps the control with its current text.
 */
import JSZip from 'jszip'
import { invoke, invokeAsync } from './engine'
import { zipCall } from './engine-hand'

/** Metadata-carrying part families the docs remove_parts op can target. */
export const REMOVE_PARTS_KINDS = ['customXml', 'webExtensions'] as const
export type RemovePartsKind = (typeof REMOVE_PARTS_KINDS)[number]
export interface RemovePartsOptions {
  /** explicit package paths (relative to the package root, no leading slash); unknown paths are reported and ignored */
  paths?: string[]
  /** whole part families to remove */
  kinds?: RemovePartsKind[]
  /** what to do when a removed customXml store backs a w:dataBinding control: refuse (default) or strip */
  dataBinding?: 'refuse' | 'strip'
}
/** One content control bound to a customXml store that is being removed. */
export interface RemovedPartBinding {
  /** story part carrying the control (word/document.xml, word/header1.xml, ...) */
  part: string
  /** w:sdtPr/w:tag of the control, when present */
  tag?: string
  /** w:sdtPr/w:id of the control, when present */
  controlId?: string
  /** ds:itemID the control is bound to, as written in w:storeItemID */
  storeItemID: string
  /** the customXml/itemProps*.xml part declaring that itemID */
  itemPropsPath: string
}
export interface RemovePartsPlan {
  /** package paths removal drops (or has already dropped), sorted */
  removedPaths: string[]
  /** explicit paths that are not present in the package (not a part, a folder or a glob) */
  unknownPaths: string[]
  /** explicit paths naming parts the package depends on; the save refuses rather than damaging the file */
  refusedPaths: string[]
  /** content controls bound to removed customXml stores */
  dataBindings: RemovedPartBinding[]
}
/** The guided error a 'refuse' save throws when bound controls would be orphaned (the CLI reports the same text). */
export function removePartsRefusalMessage(bindings: RemovedPartBinding[]): string {
  return invoke('removePartsRefusalMessage', [bindings]) as never
}
/** The error for explicit paths naming parts the package depends on. */
export function removePartsRefusalMessageFor(refusedPaths: string[]): string {
  return invoke('removePartsRefusalMessageFor', [refusedPaths]) as never
}
/**
 * Plan a remove_parts pass without changing anything: which package parts would
 * go, which explicit paths are missing, and which content controls are bound to
 * the removed customXml stores. Never throws: a caller that previews a 'refuse'
 * plan reports the bindings (and removePartsRefusalMessage) instead of writing.
 */
export async function planRemoveParts(
  bytes: Uint8Array,
  options: RemovePartsOptions,
): Promise<RemovePartsPlan> {
  return invokeAsync('planRemoveParts', [bytes, options]) as never
}
/**
 * Apply a remove_parts pass to an assembled save zip: drop the selected parts,
 * their own rels parts, dangling relationship elements, content-type entries
 * and empty folders. Other parts keep their bytes. Throws when a bound control
 * would be orphaned and dataBinding is 'refuse'.
 */
export async function applyRemoveParts(
  zip: JSZip,
  options: RemovePartsOptions,
): Promise<RemovePartsPlan> {
  return zipCall('applyRemoveParts', zip, [options], true) as never
}
