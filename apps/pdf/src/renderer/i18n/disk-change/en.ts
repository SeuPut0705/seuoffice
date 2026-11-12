import type { zh } from './zh'

export const en = {
  diskChanged: 'This file was changed. Reload it?',
  diskChangedUnsaved: 'This file was changed. Reloading discards your unsaved edits.',
  diskMissing: 'This file was deleted or renamed. What is on screen stays as it is.',
  diskReload: 'Reload',
  diskIgnore: 'Ignore',
  diskDismiss: 'OK',
  diskReloadFailed: 'Couldn’t reload the file: {detail}',
  diskChangedNoUndo:
    'Another program changed or removed this file, so Undo and Redo of this change were not applied.',
  pageOpNoUndoConfirm:
    'This file ({size}) is larger than the {limit} kept for Undo, so this page operation cannot be undone. Continue?',
  undoNoRedoConfirm:
    'The file as it is now ({size}) is larger than the {limit} kept for Redo, so this Undo cannot be redone. Continue?',
} satisfies Record<keyof typeof zh, string>
