import type { zh } from './zh'

export const it = {
  diskChanged: 'Questo file è stato modificato. Ricaricarlo?',
  diskChangedUnsaved:
    'Questo file è stato modificato. Ricaricandolo, le modifiche non salvate andranno perse.',
  diskMissing:
    'Questo file è stato eliminato o rinominato. Il contenuto sullo schermo resta invariato.',
  diskReload: 'Ricarica',
  diskIgnore: 'Ignora',
  diskDismiss: 'OK',
  diskReloadFailed: 'Impossibile ricaricare il file: {detail}',
  diskChangedNoUndo:
    'Un altro programma ha modificato o rimosso questo file, quindi Annulla e Ripeti non sono stati applicati a questa modifica.',
  pageOpNoUndoConfirm:
    'Questo file ({size}) supera la dimensione conservata per Annulla ({limit}), quindi questa operazione sulle pagine non potrà essere annullata. Continuare?',
  undoNoRedoConfirm:
    'Il file così com’è ora ({size}) supera la dimensione conservata per Ripeti ({limit}), quindi questo Annulla non potrà essere ripetuto. Continuare?',
} satisfies Record<keyof typeof zh, string>
