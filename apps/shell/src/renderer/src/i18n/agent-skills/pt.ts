import type { zh } from './zh'

export const pt = {
  noticeText:
    'As habilidades agora são ativadas e desativadas em Configurações → Habilidades. As habilidades das pastas de habilidades do Claude e do Codex começam desativadas.',
  noticeOpenSettings: 'Abrir configurações',
  noticeClose: 'Fechar',
  nextSession: 'As habilidades alteradas valem a partir da próxima sessão',
  templateLabel: 'Documento a salvar como modelo',
  templateNone: 'Sem modelo',
  templateFromTab: 'Aberto em uma aba',
  templateFromProject: 'Pasta do projeto',
  templateUnsaved: 'Esta aba tem alterações não salvas. O arquivo salvo se torna o modelo.',
  templateChecking: 'Verificando se há conteúdo ocultado…',
  templateUnknown:
    'Neste formato não é possível verificar aqui se há conteúdo ocultado, então o documento não pode ser salvo como está. Crie um modelo em branco e salve-o.',
  templateTooLarge: 'Este documento é grande demais para ser salvo como modelo',
  installTitle: 'A IA propõe instalar esta habilidade',
  installHint:
    'Abra a pré-visualização para ver o conteúdo e depois decida se vai instalá-la. Uma habilidade instalada fica disponível a partir da próxima sessão.',
  installOpen: 'Abrir pré-visualização',
  installDismiss: 'Fechar',
  installDismissed: 'Não instalada',
  installCancel: 'Cancelar',
  actProposeSkill: 'Propor uma habilidade',
} satisfies Record<keyof typeof zh, string>
