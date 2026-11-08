import type { zh } from './zh'

export const it = {
  contextConfirm:
    'Questa richiesta è vicina al limite di contesto del modello: circa {estimated} su {limit} token ({percent}%). Inviarla comunque?',
  contextUnknown:
    'Non è stato possibile confermare la dimensione del contesto del modello; si presuppongono {limit} token.',
  toolsUnsupported:
    'Questo modello non supporta le chiamate agli strumenti. Suggerirà solo testo e non modificherà il documento.',
  errContextLimit:
    'Non è stato inviato nulla: la richiesta è vicina al limite di contesto del modello. Dividila in richieste più piccole e riprova.',
} satisfies Record<keyof typeof zh, string>
