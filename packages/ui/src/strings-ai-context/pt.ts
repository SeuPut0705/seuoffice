import type { zh } from './zh'

export const pt = {
  contextConfirm:
    'Este pedido está perto do limite de contexto do modelo: cerca de {estimated} de {limit} tokens ({percent}%). Enviar mesmo assim?',
  contextUnknown:
    'Não foi possível confirmar o tamanho do contexto do modelo; assume-se {limit} tokens.',
  toolsUnsupported:
    'Este modelo não suporta chamadas de ferramentas. Vai sugerir apenas texto e não vai editar o documento.',
  errContextLimit:
    'Nada foi enviado: o pedido está perto do limite de contexto do modelo. Divida-o em pedidos menores e tente de novo.',
} satisfies Record<keyof typeof zh, string>
