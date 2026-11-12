/// Copying a slide between two decks. A bundle carries the slide's XML plus every
/// package part it depends on (media, charts and their embedded workbooks, …) so
/// the target deck can be a different file — or a different process.
///
/// Two things keep this simple. Relationship ids only have to be unique inside one
/// part's .rels, so the copied slide keeps the source's rIds verbatim and its XML
/// never needs rewriting. And the layout is not copied: the slide is re-pointed at
/// a layout in the destination, which is what PowerPoint's "use destination theme"
/// paste does.
import { PackageArchive, type Relationship } from './zip'
import { call } from './engine'

export interface SlideBundleRel {
  readonly id: string
  readonly type: string
  /** absolute source path for internal targets; the raw target for external ones */
  readonly target: string
  readonly external?: boolean
  /** true for the slideLayout rel, which the destination re-points */
  readonly layout?: boolean
}
/** The source layout→master→theme chain, for "keep source formatting" pastes. */
export interface SlideBundleChain {
  readonly layoutPath: string
  readonly masterPath: string
  readonly themePath?: string
  /** the chain parts and everything they reference, base64 like `parts` */
  readonly parts: Readonly<Record<string, string>>
  readonly contentTypes: Readonly<Record<string, string>>
}
export interface SlideBundle {
  readonly slideXml: string
  readonly rels: readonly SlideBundleRel[]
  /** every dependency part, base64 so the bundle survives IPC and JSON */
  readonly parts: Readonly<Record<string, string>>
  /** ContentType per dependency: keyed by lower-case extension or by part path */
  readonly contentTypes: Readonly<Record<string, string>>
  /** cSld/@name of the source layout, used to find its counterpart by name */
  readonly layoutName?: string
  /** source deck's slide size, so the caller can warn about a mismatch */
  readonly slideSize?: { cx: number; cy: number }
  readonly chain?: SlideBundleChain
}
/** Walks a part's rel graph, collecting bytes + content types for everything reachable. */
export function collectPart(
  archive: PackageArchive,
  partPath: string,
  parts: Record<string, string>,
  contentTypes: Record<string, string>,
): void {
  return call('collectPart', [archive, partPath, parts, contentTypes], { mut: { 2: 'json', 3: 'json' }, undef: true }) as never
}
/**
 * Snapshot a slide and its dependencies. `slideXml` is passed in so callers can
 * hand over the patched (unsaved-edits-included) XML.
 */
export function collectSlideBundle(
  archive: PackageArchive,
  slidePath: string,
  slideXml: string,
): SlideBundle {
  return call('collectSlideBundle', [archive, slidePath, slideXml]) as never
}
/** All layout paths in the target, with their display names. */
export function listLayouts(archive: PackageArchive): { path: string; name?: string }[] {
  return call('listLayouts', [archive]) as never
}
/**
 * Lands an element-clipboard's dependency parts in `archive` (paste target).
 * Byte-identical parts already present are shared — a same-deck paste writes
 * nothing; a cross-deck paste imports media/charts under non-conflicting names.
 * Returns the source→destination path map.
 */
export function importClipboardParts(
  archive: PackageArchive,
  parts: Readonly<Record<string, string>>,
  contentTypes: Readonly<Record<string, string>>,
): Map<string, string> {
  return call('importClipboardParts', [archive, parts, contentTypes], { mut: { 0: 'archive' }, shape: {"k":"map"} }) as never
}
export function materializeSlideBundle(
  archive: PackageArchive,
  bundle: SlideBundle,
  slidePath: string,
  layoutPath: string,
): string {
  return call('materializeSlideBundle', [archive, bundle, slidePath, layoutPath], { mut: { 0: 'archive' } }) as never
}
/**
 * "Keep source formatting": land the bundled layout→master→theme chain in the
 * target (registering the master) and return the layout path the pasted slide
 * should point at. Returns null when the bundle has no chain or the target's
 * presentation.xml can't take another master — callers fall back to chooseLayout.
 */
export function importSourceLayout(archive: PackageArchive, bundle: SlideBundle): string | null {
  return call('importSourceLayout', [archive, bundle], { mut: { 0: 'archive' } }) as never
}
/** The destination layout for a pasted slide: same name first, else the neighbour's. */
export function chooseLayout(
  archive: PackageArchive,
  bundle: SlideBundle,
  neighbourSlidePath?: string,
): string | null {
  return call('chooseLayout', [archive, bundle, neighbourSlidePath]) as never
}
export type { Relationship }