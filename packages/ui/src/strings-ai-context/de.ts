import type { zh } from './zh'

export const de = {
  contextConfirm:
    'Diese Anfrage liegt nahe am Kontextlimit des Modells: etwa {estimated} von {limit} Tokens ({percent} %). Trotzdem senden?',
  contextUnknown:
    'Die Kontextgröße des Modells ließ sich nicht bestätigen; es werden {limit} Tokens angenommen.',
  toolsUnsupported:
    'Dieses Modell unterstützt keine Tool-Aufrufe. Es schlägt nur Text vor und bearbeitet das Dokument nicht.',
  errContextLimit:
    'Es wurde nichts gesendet: Die Anfrage liegt nahe am Kontextlimit des Modells. Teilen Sie sie in kleinere Anfragen und versuchen Sie es erneut.',
} satisfies Record<keyof typeof zh, string>
