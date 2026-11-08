import type { zh } from './zh'

export const en = {
  windowTitle: 'Quick Look',
  openInEditor: 'Open in GenOffice',
  revealInFolder: 'Show in Folder',
  close: 'Close',
  prevFile: 'Previous file (↑)',
  nextFile: 'Next file (↓)',
  shortcutHint: 'Space / Esc to close · ↑↓ to switch · Enter to open',
  loading: 'Loading preview…',
  empty: 'This document has no previewable text.',
  encrypted: 'Password-protected document. Open in GenOffice to unlock.',
  unsupported: 'This file format cannot be previewed directly.',
  failed: 'Could not read file preview.',
  truncated: 'Showing the beginning of this document. Open in GenOffice to view all.',
  slideLabel: 'Slide {n}',
  sheetCount: '{n} sheets',
  slideCount: '{n} slides',
  lineCount: '{n} lines',
  charCount: '{n} chars',
  tabThumbnail: 'Preview Image',
  tabContent: 'Document Text',
  setQuickLookTitle: 'Quick Look Preview (Spacebar)',
  setQuickLookHint:
    'Press Space on any file in GenOffice lists to preview its contents without opening a tab.',
  setExplorerSpace: 'Preview files with Spacebar in Windows File Explorer & Desktop',
  setExplorerSpaceDesc:
    'Press Space on a selected file in File Explorer or on the Desktop to pop up a Quick Look window.',
  setKeepInTray: 'Keep running in system tray when window closes',
  setKeepInTrayDesc:
    'Keeps GenOffice ready in the background so Spacebar preview works in File Explorer even after closing the main window.',
  trayOpen: 'Open GenOffice',
  trayQuit: 'Quit GenOffice',
} satisfies Record<keyof typeof zh, string>
