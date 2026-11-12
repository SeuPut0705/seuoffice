import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import { failed } from '../docx-diff/engine'
import { type Comparison, engine } from '../docx-diff/harness'
import { keyOrderDifference } from '../docx-diff/key-order'

type Opened = { refused: string } | { hash: string; entries: string[] }

export async function comparePackage(
  comparison: Comparison,
  bytesCompared: Comparison,
  where: string,
  bytes: Uint8Array,
): Promise<PackageArchive | null> {
  const { header, blobs } = engine.call<Opened>({ cmd: 'pptxPackage' }, [bytes])
  if (failed(header)) throw new Error(`pptxPackage failed: ${header.error.message}`)
  const archive = await PackageArchive.open(bytes).catch((error: unknown) => String(error))
  if (typeof archive === 'string') {
    comparison.typescriptThrew += 1
    comparison.record(
      'refused' in header ? null : `${where}: TypeScript refused ${archive}, Rust opened`,
    )
    return null
  }
  if ('refused' in header) {
    comparison.record(`${where}: TypeScript opened, Rust refused ${header.refused}`)
    return archive
  }
  const typescript = {
    hash: archive.originalHash,
    entries: [...archive.entries.keys()],
  }
  const same = isDeepStrictEqual(typescript, header)
  const order = same ? keyOrderDifference('pptxPackage.open', typescript, header) : null
  comparison.record(
    same
      ? order
      : `${where}: package metadata\n      typescript ${JSON.stringify(typescript)}\n      rust ${JSON.stringify(header)}`,
    order !== null,
  )
  let index = 0
  for (const [name, expected] of archive.entries) {
    const actual = blobs[index++]
    const identical = actual !== undefined && Buffer.from(expected).equals(Buffer.from(actual))
    bytesCompared.record(
      identical
        ? null
        : `${where}: entry ${name}, expected sha256 ${createHash('sha256').update(expected).digest('hex')}, Rust ${actual === undefined ? 'missing' : createHash('sha256').update(actual).digest('hex')}`,
    )
  }
  bytesCompared.record(
    blobs.length === archive.entries.size
      ? null
      : `${where}: expected ${archive.entries.size} entry blobs, Rust ${blobs.length}`,
  )
  return archive
}
