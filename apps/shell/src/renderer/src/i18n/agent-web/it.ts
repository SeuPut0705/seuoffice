import type { zh } from './zh'

export const it = {
  actWebSearch: 'Ricerca web',
  actWebFetch: 'Lettura pagina web',
  permWebSearch: 'Cerca sul web',
  permWebFetch: 'Leggi questa pagina web',
  permAllowSearchSession: 'Consenti le ricerche per questa sessione',
  permAllowSiteSession: 'Consenti questo sito per questa sessione',
  codexWebLabel: 'Ricerca web',
  codexWebCached: 'Risultati salvati',
  codexWebLive: 'In tempo reale',
  codexWebDisabled: 'Disattivata',
  codexWebNote:
    'I risultati salvati provengono da contenuti web raccolti in anticipo; «In tempo reale» cerca sul web così com’è adesso.',
  codexNetworkLabel: 'Accesso a internet per i comandi',
  codexNetworkOff: 'Disattivato',
  codexNetworkOn: 'Attivato',
  codexNetworkWarning:
    'Se attivato, i comandi eseguiti da Codex possono raggiungere internet. Con «Fidati di questo progetto» lo raggiungono senza chiedere. Istruzioni nascoste in un documento ricevuto potrebbero far loro inviare i tuoi dati all’esterno.',
  codexFolderNote: 'Queste due impostazioni vengono ricordate per ogni cartella di progetto.',
  providerCodexNoteWeb:
    'I comandi vengono eseguiti nello spazio isolato di Codex: si può scrivere solo nella cartella del progetto e non c’è accesso a internet, a meno che tu non lo attivi.',
} satisfies Record<keyof typeof zh, string>
