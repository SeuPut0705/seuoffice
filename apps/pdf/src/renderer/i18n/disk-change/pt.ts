import type { zh } from './zh'

export const pt = {
  diskChanged: 'Este arquivo foi alterado. Recarregar?',
  diskChangedUnsaved: 'Este arquivo foi alterado. Recarregar descarta as edições não salvas.',
  diskMissing: 'Este arquivo foi excluído ou renomeado. O conteúdo na tela permanece como está.',
  diskReload: 'Recarregar',
  diskIgnore: 'Ignorar',
  diskDismiss: 'OK',
  diskReloadFailed: 'Não foi possível recarregar o arquivo: {detail}',
  diskChangedNoUndo:
    'Outro programa alterou ou removeu este arquivo, por isso Desfazer e Refazer não foram aplicados a esta alteração.',
  pageOpNoUndoConfirm:
    'Este arquivo ({size}) é maior que o tamanho mantido para Desfazer ({limit}), por isso esta operação de páginas não poderá ser desfeita. Continuar?',
} satisfies Record<keyof typeof zh, string>
