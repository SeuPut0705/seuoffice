import type { zh } from './zh'

export const nl = {
  actWebSearch: 'Zoeken op het web',
  actWebFetch: 'Webpagina lezen',
  permWebSearch: 'Zoeken op het web',
  permWebFetch: 'Deze webpagina lezen',
  permAllowSearchSession: 'Zoeken toestaan voor deze sessie',
  permAllowSiteSession: 'Deze site toestaan voor deze sessie',
  codexWebLabel: 'Zoeken op het web',
  codexWebCached: 'Opgeslagen resultaten',
  codexWebLive: 'Live',
  codexWebDisabled: 'Uit',
  codexWebNote:
    'Opgeslagen resultaten komen uit vooraf verzamelde webinhoud; Live doorzoekt het web zoals het nu is.',
  codexNetworkLabel: 'Internettoegang voor opdrachten',
  codexNetworkOff: 'Uit',
  codexNetworkOn: 'Aan',
  codexNetworkWarning:
    'Als dit aan staat, kunnen opdrachten die Codex uitvoert het internet bereiken. Met ‘Dit project vertrouwen’ gebeurt dat zonder te vragen. Verborgen instructies in een ontvangen document kunnen ze je gegevens naar buiten laten sturen.',
  codexFolderNote: 'Deze twee instellingen worden per projectmap onthouden.',
  providerCodexNoteWeb:
    'Opdrachten worden uitgevoerd in de afgeschermde ruimte van Codex: alleen in de projectmap kan worden geschreven en er is geen internet tenzij je het aanzet.',
} satisfies Record<keyof typeof zh, string>
