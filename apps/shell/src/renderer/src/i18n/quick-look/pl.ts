import type { zh } from './zh'

export const pl = {
  windowTitle: 'Szybki podgląd',
  openInEditor: 'Otwórz w GenOffice',
  revealInFolder: 'Pokaż w folderze',
  close: 'Zamknij',
  prevFile: 'Poprzedni plik (↑)',
  nextFile: 'Następny plik (↓)',
  shortcutHint: 'Spacja / Esc zamknij · ↑↓ przełącz · Enter otwórz',
  loading: 'Ładowanie podglądu…',
  empty: 'Ten dokument nie zawiera tekstu do podglądu.',
  encrypted: 'Dokument chroniony hasłem. Otwórz w GenOffice, aby odblokować.',
  unsupported: 'Tego formatu pliku nie można podejrzeć bezpośrednio.',
  failed: 'Nie udało się odczytać podglądu pliku.',
  truncated: 'Wyświetlono początek dokumentu. Otwórz w GenOffice, aby zobaczyć całość.',
  slideLabel: 'Slajd {n}',
  sheetCount: '{n} arkuszy',
  slideCount: '{n} slajdów',
  lineCount: '{n} wierszy',
  charCount: '{n} znaków',
  tabThumbnail: 'Obraz podglądu',
  tabContent: 'Treść dokumentu',
  setQuickLookTitle: 'Szybki podgląd (Spacja)',
  setQuickLookHint:
    'Naciśnij Spację na pliku na liście GenOffice, aby podejrzeć zawartość bez otwierania karty.',
  setExplorerSpace: 'Podgląd plików Spacją w Eksploratorze Windows i na Pulpicie',
  setExplorerSpaceDesc:
    'Naciśnij Spację na zaznaczonym pliku w Eksploratorze lub na Pulpicie, aby otworzyć Szybki podgląd.',
  setKeepInTray: 'Pozostaw w zasobniku systemowym po zamknięciu okna',
  setKeepInTrayDesc:
    'Utrzymuje GenOffice w tle, aby podgląd Spacją działał w Eksploratorze nawet po zamknięciu okna głównego.',
  trayOpen: 'Otwórz GenOffice',
  trayQuit: 'Zakończ GenOffice',
} satisfies Record<keyof typeof zh, string>
