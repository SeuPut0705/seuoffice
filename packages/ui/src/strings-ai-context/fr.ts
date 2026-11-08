import type { zh } from './zh'

export const fr = {
  contextConfirm:
    'Cette demande approche la limite de contexte du modèle : environ {estimated} sur {limit} jetons ({percent} %). L’envoyer quand même ?',
  contextUnknown:
    'La taille de contexte du modèle n’a pas pu être confirmée ; {limit} jetons sont supposés.',
  toolsUnsupported:
    'Ce modèle ne prend pas en charge les appels d’outils. Il ne proposera que du texte et ne modifiera pas le document.',
  errContextLimit:
    'Rien n’a été envoyé : la demande approche la limite de contexte du modèle. Divisez-la en demandes plus petites et réessayez.',
} satisfies Record<keyof typeof zh, string>
