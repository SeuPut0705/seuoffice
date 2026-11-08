import type { zh } from './zh'

export const es = {
  windowTitle: 'Vista rápida',
  openInEditor: 'Abrir en GenOffice',
  revealInFolder: 'Mostrar en carpeta',
  close: 'Cerrar',
  prevFile: 'Archivo anterior (↑)',
  nextFile: 'Archivo siguiente (↓)',
  shortcutHint: 'Espacio / Esc cerrar · ↑↓ cambiar · Intro abrir',
  loading: 'Cargando vista previa…',
  empty: 'Este documento no tiene texto para previsualizar.',
  encrypted: 'Documento protegido con contraseña. Ábralo en GenOffice para desbloquearlo.',
  unsupported: 'Este formato de archivo no se puede previsualizar directamente.',
  failed: 'No se pudo leer la vista previa del archivo.',
  truncated: 'Mostrando el inicio del documento. Ábralo en GenOffice para ver todo.',
  slideLabel: 'Diapositiva {n}',
  sheetCount: '{n} hojas',
  slideCount: '{n} diapositivas',
  lineCount: '{n} líneas',
  charCount: '{n} caracteres',
  tabThumbnail: 'Imagen previa',
  tabContent: 'Contenido del documento',
  setQuickLookTitle: 'Vista rápida (Barra espaciadora)',
  setQuickLookHint:
    'Pulse Espacio sobre cualquier archivo en las listas de GenOffice para previsualizar su contenido sin abrir una pestaña.',
  setExplorerSpace: 'Previsualizar archivos con Espacio en el Explorador de Windows y el Escritorio',
  setExplorerSpaceDesc:
    'Pulse Espacio sobre un archivo seleccionado en el Explorador o el Escritorio para abrir la vista rápida.',
  setKeepInTray: 'Mantener en la bandeja del sistema al cerrar la ventana',
  setKeepInTrayDesc:
    'Mantiene GenOffice listo en segundo plano para que la vista rápida funcione en el Explorador tras cerrar la ventana.',
  trayOpen: 'Abrir GenOffice',
  trayQuit: 'Salir de GenOffice',
} satisfies Record<keyof typeof zh, string>
