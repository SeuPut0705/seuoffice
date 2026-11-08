/**
 * The File-menu entries every editor gets for spec 8.2 and 9: "make another
 * document from this one" (opens the make window with the open document),
 * "View Sources" (shown when the open document is a made one) and "Documents
 * Made from This" (shown when it is a source of one). A listed file that is
 * not on disk is dimmed and cannot be picked; the record stays.
 *
 * Only Electron's types are imported, so the tests build the entries as is.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { DocumentLinkMenuModel, LinkMenuEntry } from './document-links'

export interface DocumentLinkMenuLabels {
  make: string
  sources: string
  derived: string
}

export interface DocumentLinkMenuInput {
  model: DocumentLinkMenuModel
  labels: DocumentLinkMenuLabels
  /** macOS shows no sublabel; elsewhere the full path sits under the name */
  isMac: boolean
  onMake(): void
  onOpen(path: string): void
}

function fileItems(
  entries: LinkMenuEntry[],
  input: DocumentLinkMenuInput,
): MenuItemConstructorOptions[] {
  return entries.map((entry) => ({
    label: entry.name,
    ...(input.isMac ? {} : { sublabel: entry.path }),
    toolTip: entry.path,
    enabled: !entry.missing,
    click: () => input.onOpen(entry.path),
  }))
}

/** the entries, led by their own separator */
export function documentLinkMenuItems(input: DocumentLinkMenuInput): MenuItemConstructorOptions[] {
  const { model, labels } = input
  return [
    { type: 'separator' },
    { id: 'document-links-make', label: labels.make, click: () => input.onMake() },
    ...(model.sources.length > 0
      ? [
          {
            id: 'document-links-sources',
            label: labels.sources,
            submenu: fileItems(model.sources, input),
          },
        ]
      : []),
    ...(model.derived.length > 0
      ? [
          {
            id: 'document-links-derived',
            label: labels.derived,
            submenu: fileItems(model.derived, input),
          },
        ]
      : []),
  ]
}
