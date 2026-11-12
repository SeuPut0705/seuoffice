/**
 * pptx package management — open the zip, archive the original by SHA-256, and read
 * parts and .rels.
 *
 * Byte fidelity: PackageArchive holds the original bytes of every entry; on save,
 * unmodified entries are written back byte-for-byte (handled by the patch layer).
 * This module only handles reading and metadata.
 */
import JSZip from 'jszip'
import type { SlideSize } from './types'
import { call } from './engine'

export interface Relationship {
  id: string
  type: string
  target: string
  targetMode?: string
}
/** Shared with the CLI's pre-open check so both layers accept the same files. */
export const PPTX_ZIP_LIMITS = {
  maxParts: 10000,
  maxPartBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1.5 * 1024 * 1024 * 1024,
} as const
/** Declared sizes from the central directory, checked before any part is inflated. */
export function assertZipWithinLimits(zip: JSZip): void {
  call('assertZipWithinLimits', [Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => ({
        name: f.name,
        usize: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      }))], { names: [""] })
}
export class PackageArchive {
  private constructor(
    /** Original bytes of every entry, keyed by path inside the zip */
    readonly entries: Map<string, Uint8Array>,
    readonly originalHash: string,
  ) {}

  /** An archive from what the engine answers: its entries in order, and the hash of the original. */
  static fromWire(wire: { entries: Array<[string, Uint8Array]>; originalHash: string }): PackageArchive {
    return new PackageArchive(new Map(wire.entries), wire.originalHash)
  }

  static async open(bytes: Uint8Array): Promise<PackageArchive> {
    return PackageArchive.fromWire(call('PackageArchive.open', [bytes]) as never)
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** Read a part as a UTF-8 string (for XML parts). */
  readText(path: string): string | null {
    const bytes = this.entries.get(path)
    if (!bytes) return null
    return Buffer.from(bytes).toString('utf8')
  }

  readBytes(path: string): Uint8Array | null {
    return this.entries.get(path) ?? null
  }

  /** The archive of the parts `keep` names: the engine reads these and not the media of the deck. */
  private parts(keep: (path: string) => boolean): PackageArchive {
    const entries = new Map([...this.entries].filter(([path]) => keep(path)))
    return new PackageArchive(entries, this.originalHash)
  }

  /**
   * Read a part's relationships file. partPath e.g. 'ppt/slides/slide1.xml' →
   * 'ppt/slides/_rels/slide1.xml.rels'.
   */
  readRels(partPath: string): Map<string, Relationship> {
    const relsPath = relsPathFor(partPath)
    return call('PackageArchive.readRels', [this.parts((path) => path === relsPath), partPath], {
      shape: { k: 'map' },
    }) as never
  }

  /**
   * Read the presentation's slide size and the slide part paths in order.
   */
  readPresentation(): { size: SlideSize; slidePaths: string[] } {
    return call('PackageArchive.readPresentation', [
      this.parts((path) => path === 'ppt/presentation.xml' || path === 'ppt/_rels/presentation.xml.rels'),
    ]) as never
  }

  /**
   * Resolve a slide's layout / master part paths (via the rels chain). The engine
   * reads the relationship parts, the presentation, the slide and the masters and
   * layouts (the layout a slide that lost its relationship falls back to).
   */
  resolveSlideChain(slidePath: string): {
    layoutPath?: string
    masterPath?: string
    themePath?: string
  } {
    const read = (path: string): boolean =>
      path.endsWith('.rels') ||
      path === 'ppt/presentation.xml' ||
      path === slidePath ||
      /\/(?:slideMasters|slideLayouts)\/[^/]+\.xml$/.test(path)
    return call('PackageArchive.resolveSlideChain', [this.parts(read), slidePath]) as never
  }
}
/** 'ppt/slides/slide1.xml' → 'ppt/slides/_rels/slide1.xml.rels' */
export function relsPathFor(partPath: string): string {
  return call('relsPathFor', [partPath]) as never
}
/**
 * Resolve a relative target into an absolute path inside the zip.
 * basePart is the referencing part's path (its directory is the base); target may be
 * something like '../slideLayouts/slideLayout1.xml'.
 */
export function resolveTarget(basePart: string, target: string): string {
  return call('resolveTarget', [basePart, target]) as never
}