import type { zh } from './zh'

export const it = {
  windowTitle: 'Visualizzazione rapida',
  openInEditor: 'Apri in GenOffice',
  revealInFolder: 'Mostra nella cartella',
  close: 'Chiudi',
  prevFile: 'File precedente (↑)',
  nextFile: 'File successivo (↓)',
  shortcutHint: 'Spazio / Esc chiudi · ↑↓ cambia · Invio apri',
  loading: 'Caricamento anteprima…',
  empty: 'Questo documento non contiene testo visualizzabile in anteprima.',
  encrypted: 'Documento protetto da password. Aprilo in GenOffice per sbloccarlo.',
  unsupported: 'Questo formato di file non può essere visualizzato direttamente.',
  failed: 'Impossibile leggere l’anteprima del file.',
  truncated: 'Viene mostrato l’inizio del documento. Aprilo in GenOffice per vedere tutto.',
  slideLabel: 'Diapositiva {n}',
  sheetCount: '{n} fogli',
  slideCount: '{n} diapositive',
  lineCount: '{n} righe',
  charCount: '{n} caratteri',
  tabThumbnail: 'Immagine anteprima',
  tabContent: 'Contenuto documento',
  setQuickLookTitle: 'Visualizzazione rapida (Barra spaziatrice)',
  setQuickLookHint:
    'Premi Spazio su qualsiasi file negli elenchi di GenOffice per visualizzarne il contenuto senza aprire una scheda.',
  setExplorerSpace: 'Visualizza file con Spazio in Esplora file di Windows e sul Desktop',
  setExplorerSpaceDesc:
    'Premi Spazio su un file selezionato in Esplora file o sul Desktop per aprire la visualizzazione rapida.',
  setKeepInTray: 'Mantieni attivo nell’area di notifica alla chiusura della finestra',
  setKeepInTrayDesc:
    'Mantiene GenOffice pronto in background affinché l’anteprima con Spazio funzioni sempre in Esplora file.',
  trayOpen: 'Apri GenOffice',
  trayQuit: 'Esci da GenOffice',
} satisfies Record<keyof typeof zh, string>
