import type { zh } from './zh'

export const pt = {
  actWebSearch: 'Pesquisa na web',
  actWebFetch: 'Ler página web',
  permWebSearch: 'Pesquisar na web',
  permWebFetch: 'Ler esta página web',
  permAllowSearchSession: 'Permitir pesquisas nesta sessão',
  permAllowSiteSession: 'Permitir este site nesta sessão',
  codexWebLabel: 'Pesquisa na web',
  codexWebCached: 'Resultados salvos',
  codexWebLive: 'Em tempo real',
  codexWebDisabled: 'Desativada',
  codexWebNote:
    'Os resultados salvos vêm de conteúdo da web coletado previamente; “Em tempo real” pesquisa a web como ela está agora.',
  codexNetworkLabel: 'Acesso à internet dos comandos',
  codexNetworkOff: 'Desativado',
  codexNetworkOn: 'Ativado',
  codexNetworkWarning:
    'Quando ativado, os comandos que o Codex executa podem acessar a internet. Com “Confiar neste projeto”, eles acessam sem perguntar. Instruções ocultas em um documento recebido podem levá-los a enviar seus dados para fora.',
  codexFolderNote: 'Essas duas configurações são lembradas para cada pasta de projeto.',
  providerCodexNoteWeb:
    'Os comandos são executados no espaço isolado do Codex: só a pasta do projeto pode ser alterada, e não há acesso à internet a menos que você o ative.',
} satisfies Record<keyof typeof zh, string>
