import type { zh } from './zh'

export const fr = {
  windowTitle: 'Coup d’œil',
  openInEditor: 'Ouvrir dans GenOffice',
  revealInFolder: 'Afficher dans le dossier',
  close: 'Fermer',
  prevFile: 'Fichier précédent (↑)',
  nextFile: 'Fichier suivant (↓)',
  shortcutHint: 'Espace / Échap fermer · ↑↓ changer · Entrée ouvrir',
  loading: 'Chargement de l’aperçu…',
  empty: 'Ce document ne contient aucun texte prévisualisable.',
  encrypted: 'Document protégé par mot de passe. Ouvrez-le dans GenOffice pour le déverrouiller.',
  unsupported: 'Ce format de fichier ne peut pas être prévisualisé directement.',
  failed: 'Impossible de lire l’aperçu du fichier.',
  truncated: 'Aperçu du début du document. Ouvrez-le dans GenOffice pour tout voir.',
  slideLabel: 'Diapositive {n}',
  sheetCount: '{n} feuilles',
  slideCount: '{n} diapositives',
  lineCount: '{n} lignes',
  charCount: '{n} caractères',
  tabThumbnail: 'Image d’aperçu',
  tabContent: 'Contenu du document',
  setQuickLookTitle: 'Aperçu rapide (Barre d’espace)',
  setQuickLookHint:
    'Appuyez sur Espace sur un fichier dans GenOffice pour prévisualiser son contenu sans ouvrir d’onglet.',
  setExplorerSpace: 'Prévisualiser avec la barre d’espace dans l’Explorateur Windows et sur le Bureau',
  setExplorerSpaceDesc:
    'Appuyez sur Espace sur un fichier sélectionné dans l’Explorateur ou sur le Bureau pour afficher l’aperçu.',
  setKeepInTray: 'Garder dans la barre d’état système à la fermeture de la fenêtre',
  setKeepInTrayDesc:
    'Maintient GenOffice prêt en arrière-plan pour que l’aperçu par barre d’espace fonctionne dans l’Explorateur.',
  trayOpen: 'Ouvrir GenOffice',
  trayQuit: 'Quitter GenOffice',
} satisfies Record<keyof typeof zh, string>
