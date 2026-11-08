import type { zh } from './zh'

export const pt = {
  windowTitle: 'Visualização Rápida',
  openInEditor: 'Abrir no GenOffice',
  revealInFolder: 'Mostrar na pasta',
  close: 'Fechar',
  prevFile: 'Arquivo anterior (↑)',
  nextFile: 'Próximo arquivo (↓)',
  shortcutHint: 'Espaço / Esc fechar · ↑↓ alternar · Enter abrir',
  loading: 'Carregando visualização…',
  empty: 'Este documento não possui texto para visualização.',
  encrypted: 'Documento protegido por senha. Abra no GenOffice para desbloquear.',
  unsupported: 'Este formato de arquivo não pode ser visualizado diretamente.',
  failed: 'Não foi possível ler a visualização do arquivo.',
  truncated: 'Mostrando o início do documento. Abra no GenOffice para ver tudo.',
  slideLabel: 'Slide {n}',
  sheetCount: '{n} planilhas',
  slideCount: '{n} slides',
  lineCount: '{n} linhas',
  charCount: '{n} caracteres',
  tabThumbnail: 'Imagem de visualização',
  tabContent: 'Conteúdo do documento',
  setQuickLookTitle: 'Visualização Rápida (Barra de espaço)',
  setQuickLookHint:
    'Pressione Espaço em qualquer arquivo nas listas do GenOffice para visualizar seu conteúdo sem abrir uma guia.',
  setExplorerSpace: 'Visualizar arquivos com Espaço no Explorador de Arquivos do Windows e Área de Trabalho',
  setExplorerSpaceDesc:
    'Pressione Espaço em um arquivo selecionado no Explorador de Arquivos ou na Área de Trabalho para abrir a Visualização Rápida.',
  setKeepInTray: 'Manter em execução na bandeja do sistema ao fechar a janela',
  setKeepInTrayDesc:
    'Mantém o GenOffice pronto em segundo plano para que a visualização com Espaço funcione no Explorador.',
  trayOpen: 'Abrir GenOffice',
  trayQuit: 'Sair do GenOffice',
} satisfies Record<keyof typeof zh, string>
