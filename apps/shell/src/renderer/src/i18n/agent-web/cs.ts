import type { zh } from './zh'

export const cs = {
  actWebSearch: 'Vyhledávání na webu',
  actWebFetch: 'Čtení webové stránky',
  permWebSearch: 'Hledat na webu',
  permWebFetch: 'Přečíst tuto webovou stránku',
  permAllowSearchSession: 'Povolit vyhledávání po dobu této relace',
  permAllowSiteSession: 'Povolit tento web po dobu této relace',
  codexWebLabel: 'Vyhledávání na webu',
  codexWebCached: 'Uložené výsledky',
  codexWebLive: 'Živě',
  codexWebDisabled: 'Vypnuto',
  codexWebNote:
    'Uložené výsledky pocházejí z webového obsahu shromážděného předem; „Živě“ prohledává web v jeho současné podobě.',
  codexNetworkLabel: 'Přístup příkazů k internetu',
  codexNetworkOff: 'Vypnuto',
  codexNetworkOn: 'Zapnuto',
  codexNetworkWarning:
    'Po zapnutí se příkazy, které Codex spouští, dostanou na internet. V režimu „Důvěřovat tomuto projektu“ se tam dostanou bez ptaní. Skryté pokyny v přijatém dokumentu je mohou přimět k odeslání vašich dat ven.',
  codexFolderNote: 'Tato dvě nastavení se pamatují pro každou složku projektu zvlášť.',
  providerCodexNoteWeb:
    'Příkazy běží v izolovaném prostoru programu Codex: zapisovat lze jen do složky projektu a internet není k dispozici, dokud ho nezapnete.',
} satisfies Record<keyof typeof zh, string>
