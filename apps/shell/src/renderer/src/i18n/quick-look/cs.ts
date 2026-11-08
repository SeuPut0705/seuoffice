import type { zh } from './zh'

export const cs = {
  windowTitle: 'Rychlý náhled',
  openInEditor: 'Otevřít v GenOffice',
  revealInFolder: 'Zobrazit ve složce',
  close: 'Zavřít',
  prevFile: 'Předchozí soubor (↑)',
  nextFile: 'Další soubor (↓)',
  shortcutHint: 'Mezerník / Esc zavřít · ↑↓ přepnout · Enter otevřít',
  loading: 'Načítání náhledu…',
  empty: 'Tento dokument neobsahuje žádný text k náhledu.',
  encrypted: 'Dokument chráněný heslem. Otevřete jej v GenOffice pro odemknutí.',
  unsupported: 'Tento formát souboru nelze přímo zobrazit v náhledu.',
  failed: 'Nepodařilo se načíst náhled souboru.',
  truncated: 'Zobrazen začátek dokumentu. Otevřete v GenOffice pro zobrazení celého obsahu.',
  slideLabel: 'Snímek {n}',
  sheetCount: '{n} listů',
  slideCount: '{n} snímků',
  lineCount: '{n} řádků',
  charCount: '{n} znaků',
  tabThumbnail: 'Obrázek náhledu',
  tabContent: 'Obsah dokumentu',
  setQuickLookTitle: 'Rychlý náhled (Mezerník)',
  setQuickLookHint:
    'Stisknutím Mezerníku na souboru v seznamech GenOffice zobrazíte náhled obsahu bez otevření karty.',
  setExplorerSpace: 'Náhled souborů Mezerníkem v Průzkumníku Windows a na Ploše',
  setExplorerSpaceDesc:
    'Stisknutím Mezerníku na vybraném souboru v Průzkumníku nebo na Ploše otevřete okno Rychlého náhledu.',
  setKeepInTray: 'Ponechat běžet v oznamovací oblasti po zavření okna',
  setKeepInTrayDesc:
    'Udržuje GenOffice připravený na pozadí, aby náhled Mezerníkem v Průzkumníku fungoval i po zavření okna.',
  trayOpen: 'Otevřít GenOffice',
  trayQuit: 'Ukončit GenOffice',
} satisfies Record<keyof typeof zh, string>
