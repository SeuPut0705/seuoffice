import type { zh } from './zh'

export const es = {
  contextConfirm:
    'Esta solicitud se acerca al límite de contexto del modelo: unos {estimated} de {limit} tokens ({percent} %). ¿Enviarla igualmente?',
  contextUnknown:
    'No se pudo confirmar el tamaño de contexto del modelo; se suponen {limit} tokens.',
  toolsUnsupported:
    'Este modelo no admite llamadas a herramientas. Solo sugerirá texto y no editará el documento.',
  errContextLimit:
    'No se envió nada: la solicitud se acerca al límite de contexto del modelo. Divídela en solicitudes más pequeñas e inténtalo de nuevo.',
} satisfies Record<keyof typeof zh, string>
