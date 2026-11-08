import type { zh } from './zh'

export const nl = {
  contextConfirm:
    'Dit verzoek zit dicht bij de contextlimiet van het model: ongeveer {estimated} van {limit} tokens ({percent}%). Toch verzenden?',
  contextUnknown:
    'De contextgrootte van het model kon niet worden bevestigd; er wordt uitgegaan van {limit} tokens.',
  toolsUnsupported:
    'Dit model ondersteunt geen aanroepen van hulpmiddelen. Het stelt alleen tekst voor en bewerkt het document niet.',
  errContextLimit:
    'Er is niets verzonden: het verzoek zit dicht bij de contextlimiet van het model. Splits het in kleinere verzoeken en probeer opnieuw.',
} satisfies Record<keyof typeof zh, string>
