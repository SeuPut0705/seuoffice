// Package-level parts: main document path, relationships, comments,
// protection settings and numbering definitions.
import JSZip from 'jszip'
import type { DocProtection, WriteProtection } from './types'
import { invoke } from './engine'
import { zipCall } from './engine-hand'

/**
 * Main document part: word/document.xml when present, else the package-level
 * officeDocument relationship target (LO corpus has e.g. word/trial.xml).
 */
export async function resolveMainDocumentPath(zip: JSZip): Promise<string | null> {
  return zipCall('resolveMainDocumentPath', zip, [], false) as never
}
export function resolveRelationshipTargetPath(sourcePath: string, target: string): string | null {
  return invoke('resolveRelationshipTargetPath', [sourcePath, target]) as never
}
/** w:documentProtection from word/settings.xml (editing restriction) */
export async function parseProtection(zip: JSZip): Promise<DocProtection | null> {
  return zipCall('parseProtection', zip, [], false) as never
}
/** w:writeProtection from word/settings.xml (password to modify / read-only recommended) */
export async function parseWriteProtection(zip: JSZip): Promise<WriteProtection | null> {
  return zipCall('parseWriteProtection', zip, [], false) as never
}
