/**
 * Relationship-aware cleanup for package parts dropped by slide mutations.
 *
 * A media/chart part cannot be removed merely because one shape stopped using it:
 * duplicated slides and copied objects may point at the same target. Cleanup first
 * removes only relationships no longer used by the owning XML, then collects the
 * now-unreachable resource subgraph.
 */
import type { Slide } from './types'
import { PackageArchive } from './zip'
import { call, slideIndex } from './engine'

export interface ResourceCleanupStats {
  relationshipsRemoved: number
  partsRemoved: number
  bytesRemoved: number
}
interface ResourceCleanupContext {
  archive: PackageArchive
  deck: { slides: Slide[] }
}
/**
 * Compare XML from before and after a slide mutation. Relationship ids that
 * disappeared from the live slide are pruned, then their unshared owned targets
 * are collected. Callers pass the fully patched current slide XML so pending
 * in-memory edits participate in the liveness check.
 */
export function cleanupSupersededSlideResources(
  opened: ResourceCleanupContext,
  slide: Slide,
  previousXml: string,
  currentXml: string,
): ResourceCleanupStats {
  return call('cleanupSupersededSlideResources', [opened, slideIndex(opened as never, slide), previousXml, currentXml], { mut: { 0: 'opened' } }) as never
}
/**
 * Delete a package part and collect resource parts that were owned exclusively by
 * it. Used by slide deletion after the presentation relationship is removed.
 */
export function removePartWithOwnedResources(
  archive: PackageArchive,
  partPath: string,
): ResourceCleanupStats {
  return call('removePartWithOwnedResources', [archive, partPath], { mut: { 0: 'archive' } }) as never
}