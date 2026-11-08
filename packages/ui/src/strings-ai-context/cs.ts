import type { zh } from './zh'

export const cs = {
  contextConfirm:
    'Tento požadavek se blíží limitu kontextu modelu: přibližně {estimated} z {limit} tokenů ({percent} %). Přesto odeslat?',
  contextUnknown: 'Velikost kontextu modelu se nepodařilo potvrdit; předpokládá se {limit} tokenů.',
  toolsUnsupported:
    'Tento model nepodporuje volání nástrojů. Navrhne pouze text a dokument neupraví.',
  errContextLimit:
    'Nic nebylo odesláno: požadavek se blíží limitu kontextu modelu. Rozdělte jej na menší požadavky a zkuste to znovu.',
} satisfies Record<keyof typeof zh, string>
