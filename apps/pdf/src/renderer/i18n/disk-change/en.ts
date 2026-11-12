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
} satisfies Record<keyof typeof zh, string>
