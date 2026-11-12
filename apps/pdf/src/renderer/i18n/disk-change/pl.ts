import type { zh } from './zh'

export const pl = {
  diskChanged: 'Ten plik został zmieniony. Wczytać go ponownie?',
  diskChangedUnsaved: 'Ten plik został zmieniony. Ponowne wczytanie odrzuci niezapisane zmiany.',
  diskMissing:
    'Ten plik został usunięty lub zmieniono jego nazwę. Zawartość na ekranie pozostaje bez zmian.',
  diskReload: 'Wczytaj ponownie',
  diskIgnore: 'Ignoruj',
  diskDismiss: 'OK',
  diskReloadFailed: 'Nie udało się ponownie wczytać pliku: {detail}',
  diskChangedNoUndo:
    'Inny program zmienił lub usunął ten plik, dlatego Cofnij i Ponów nie zostały wykonane dla tej zmiany.',
  pageOpNoUndoConfirm:
    'Ten plik ({size}) jest większy niż rozmiar przechowywany na potrzeby Cofnij ({limit}), dlatego tej operacji na stronach nie będzie można cofnąć. Kontynuować?',
} satisfies Record<keyof typeof zh, string>
