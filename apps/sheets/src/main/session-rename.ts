/**
 * Session bookkeeping for a workbook file renamed on disk (Home row rename,
 * tab double-click rename, folder-tree move).
 *
 * A session does not always point at the file the user sees. A .csv opens as
 * a converted copy in the temp dir with the original kept in `csvSourcePath`
 * (Save writes values back there); .xls/.tsv open the same way with the
 * original's .xlsx sibling kept in `suggestSaveAs`; a crash-recovery restore
 * keeps the original in `restoreTarget`. Renaming only `path` would leave the
 * next Save writing to the old name, recreating a file the user just renamed
 * away — so every field that names the original moves together.
 *
 * An .ods opens as a converted copy too, and the original it must never be
 * exported over is kept in `odsSourcePath`. That field follows the rename as
 * well: left at the old name, the protection would guard a path that no
 * longer exists while the export's default name pointed straight at the
 * renamed original.
 */
export interface RenamableSession {
  readonly path: string
  readonly suggestSaveAs?: string
  readonly csvSourcePath?: string
  readonly restoreTarget?: string
  readonly odsSourcePath?: string
}

/** Replace the extension of `path` with `.xlsx` — mirrors the Save As default for converted copies. */
export function xlsxSiblingOf(path: string): string {
  return path.replace(/\.[^.]+$/, '.xlsx')
}

/**
 * The session as it should look after `oldPath` was renamed to `newPath`, or
 * null when the session has nothing to do with `oldPath`.
 */
export function sessionAfterRename<S extends RenamableSession>(
  session: S,
  oldPath: string,
  newPath: string,
): S | null {
  let next: S | null = null
  const patch = (fields: Partial<RenamableSession>): void => {
    next = { ...(next ?? session), ...fields }
  }
  if (session.path === oldPath) patch({ path: newPath })
  if (session.csvSourcePath === oldPath) patch({ csvSourcePath: newPath })
  if (session.restoreTarget === oldPath) patch({ restoreTarget: newPath })
  if (session.odsSourcePath === oldPath) patch({ odsSourcePath: newPath })
  // A converted .xls/.tsv copy is tied to its original only through the Save
  // As default derived from it; re-derive from the new name.
  if (
    session.suggestSaveAs !== undefined &&
    session.path !== oldPath &&
    session.suggestSaveAs === xlsxSiblingOf(oldPath)
  ) {
    patch({ suggestSaveAs: xlsxSiblingOf(newPath) })
  }
  return next
}
