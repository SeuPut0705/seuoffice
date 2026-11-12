// The web save, run inside the engine worker: the gateway plans the patched
// entries against the engine's copy of the workbook, and the engine's
// save_archive writes the new package with untouched entries raw-copied.
// Mirrors saveWorkbookViaSidecar (xlsx-package-io), which needs Node's file system.
import { planCellEditsToXlsx, type EntrySource } from '@seuoffice/xlsx-gateway/gateway/xlsx-gateway'
import {
  assertManifestPreserved,
  type ArchiveEntry,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-package-io'
import { MAX_PATCH_ENTRY_BYTES } from '@seuoffice/xlsx-gateway/shared/edit-schemas'
import { File } from '@seuoffice/web-platform/wasi'
import type { ResolvedWorkbookSave } from '../main/workbook-save-resolve'
import { readEntryText, type EngineFiles } from './xlsx-entries'

export interface SavedWorkbook {
  readonly bytes: Uint8Array
  readonly touchedEntries: readonly string[]
}

const encoder = new TextEncoder()

/** Writes /work/<target> from /work/<source> with the edits applied and returns its bytes */
export async function saveWorkbook(
  engine: EngineFiles,
  source: string,
  target: string,
  save: ResolvedWorkbookSave,
): Promise<SavedWorkbook> {
  const sourcePath = `/work/${source}`
  try {
    const { entries: manifest } = (await engine.command('archive_manifest', {
      path: sourcePath,
    })) as { entries: ArchiveEntry[] }
    const plan = await planCellEditsToXlsx(
      entrySource(engine, sourcePath, manifest),
      save.edits,
      save.structuralOps ?? [],
      save.chartEdits ?? [],
      save.sheetPlan,
      save.filterStates ?? [],
      save.hyperlinkEdits ?? [],
      save.cfStates ?? [],
      save.dvStates ?? [],
      save.sheetProtections ?? [],
      save.definedNamesState ?? null,
      save.visualAdditions ?? [],
      save.pageSetupStates ?? [],
      save.noteStates ?? [],
      save.tableAdditions ?? [],
      save.pivotAdditions ?? [],
      save.pivotCacheRefreshPaths ?? [],
      save.pivotRefreshUpdates ?? [],
      save.visualEdits ?? [],
      save.sparklineAdditions ?? [],
      save.formulaValues ?? [],
      save.themeState ?? null,
      save.workbookProtectionState ?? null,
      save.protectedRangeStates ?? [],
      save.bulkConstantFills ?? [],
      save.tabColorStates ?? [],
      save.tableEdits ?? [],
      save.cellImageAdditions ?? [],
      save.externalLinkOps ?? null,
      save.redactionStates ?? null,
      save.slicerState ?? null,
    )
    const result = (await engine.command('save_archive', {
      sourcePath,
      targetPath: `/work/${target}`,
      replacements: stage(engine.scratch, 'replace', plan.replaced),
      removals: plan.removedEntries,
      additions: [
        ...stage(engine.scratch, 'add', plan.added),
        ...stage(engine.scratch, 'add-bin', plan.addedBinary),
      ],
    })) as { beforeEntries: ArchiveEntry[]; afterEntries: ArchiveEntry[] }
    assertManifestPreserved(plan, result.beforeEntries, result.afterEntries)
    const saved = engine.work.get(target)
    if (!saved) throw new Error('The xlsx engine wrote no workbook.')
    // a copy: the engine keeps reading its own file once the saved workbook reopens
    return { bytes: saved.data.slice(), touchedEntries: plan.touchedEntries }
  } catch (error) {
    engine.work.delete(target)
    throw error
  } finally {
    engine.scratch.clear()
  }
}
/** The entries of the engine's copy, read through the engine (as createSidecarEntrySource does) */
function entrySource(
  engine: EngineFiles,
  sourcePath: string,
  manifest: readonly ArchiveEntry[],
): EntrySource {
  const entryByName = new Map(manifest.map((entry) => [entry.name, entry]))
  const cache = new Map<string, string>()
  return {
    paths: async () => manifest.map((entry) => entry.name),
    has: async (path) => entryByName.has(path),
    canPatch: async (path) =>
      (entryByName.get(path)?.uncompressedSize ?? 0) <= MAX_PATCH_ENTRY_BYTES,
    containsText: async (path, needle) => {
      const { matches } = (await engine.command('scan_entries', {
        path: sourcePath,
        entries: [path],
        needle,
      })) as { matches: string[] }
      return matches.includes(path)
    },
    releaseText: (path) => {
      cache.delete(path)
    },
    readText: async (path) => {
      const cached = cache.get(path)
      if (cached !== undefined) return cached
      if (!entryByName.has(path)) throw new Error(`Workbook is missing ${path}.`)
      const content = await readEntryText(engine, sourcePath, path)
      cache.set(path, content)
      return content
    },
  }
}

/** Puts planned contents into /save for save_archive, one file per entry */
function stage(
  scratch: Map<string, File>,
  prefix: string,
  contents: ReadonlyMap<string, string | Uint8Array>,
): { name: string; contentPath: string }[] {
  return [...contents].map(([name, content], index) => {
    const file = `${prefix}-${index}.bin`
    scratch.set(file, new File(typeof content === 'string' ? encoder.encode(content) : content))
    return { name, contentPath: `/save/${file}` }
  })
}
