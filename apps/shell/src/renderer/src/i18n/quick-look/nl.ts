import type { zh } from './zh'

export const nl = {
  windowTitle: 'Snelle weergave',
  openInEditor: 'Openen in GenOffice',
  revealInFolder: 'Tonen in map',
  close: 'Sluiten',
  prevFile: 'Vorig bestand (↑)',
  nextFile: 'Volgend bestand (↓)',
  shortcutHint: 'Spatie / Esc sluiten · ↑↓ wisselen · Enter openen',
  loading: 'Voorbeeld laden…',
  empty: 'Dit document bevat geen tekst voor een voorbeeld.',
  encrypted: 'Met wachtwoord beveiligd document. Open in GenOffice om te ontgrendelen.',
  unsupported: 'Dit bestandsformaat kan niet direct worden bekeken.',
  failed: 'Kan bestandsvoorbeeld niet lezen.',
  truncated: 'Alleen het begin van het document wordt getoond. Open in GenOffice om alles te zien.',
  slideLabel: 'Dia {n}',
  sheetCount: '{n} bladen',
  slideCount: '{n} dia’s',
  lineCount: '{n} regels',
  charCount: '{n} tekens',
  tabThumbnail: 'Voorbeeldafbeelding',
  tabContent: 'Documentinhoud',
  setQuickLookTitle: 'Snelle weergave (Spatiebalk)',
  setQuickLookHint:
    'Druk op Spatie op een bestand in GenOffice-lijsten om de inhoud te bekijken zonder een tabblad te openen.',
  setExplorerSpace: 'Bestanden met Spatiebalk bekijken in Windows Verkenner en op het Bureaublad',
  setExplorerSpaceDesc:
    'Druk op Spatie bij een geselecteerd bestand in Verkenner of op het Bureaublad om Snelle weergave te openen.',
  setKeepInTray: 'Actief houden in systeemvak wanneer het venster wordt gesloten',
  setKeepInTrayDesc:
    'Houdt GenOffice op de achtergrond gereed zodat Spatiebalk-weergave in Verkenner blijft werken.',
  trayOpen: 'GenOffice openen',
  trayQuit: 'GenOffice afsluiten',
} satisfies Record<keyof typeof zh, string>
