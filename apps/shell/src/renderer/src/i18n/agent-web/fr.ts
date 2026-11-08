import type { zh } from './zh'

export const fr = {
  actWebSearch: 'Recherche web',
  actWebFetch: 'Lecture de page web',
  permWebSearch: 'Rechercher sur le web',
  permWebFetch: 'Lire cette page web',
  permAllowSearchSession: 'Autoriser les recherches pour cette session',
  permAllowSiteSession: 'Autoriser ce site pour cette session',
  codexWebLabel: 'Recherche web',
  codexWebCached: 'Résultats enregistrés',
  codexWebLive: 'En direct',
  codexWebDisabled: 'Désactivée',
  codexWebNote:
    'Les résultats enregistrés proviennent de contenus web collectés à l’avance ; « En direct » interroge le web tel qu’il est maintenant.',
  codexNetworkLabel: 'Accès à Internet pour les commandes',
  codexNetworkOff: 'Désactivé',
  codexNetworkOn: 'Activé',
  codexNetworkWarning:
    'Une fois activé, les commandes lancées par Codex peuvent accéder à Internet. Avec « Faire confiance à ce projet », elles y accèdent sans demander. Des instructions cachées dans un document reçu pourraient leur faire envoyer vos données à l’extérieur.',
  codexFolderNote: 'Ces deux réglages sont mémorisés pour chaque dossier de projet.',
  providerCodexNoteWeb:
    'Les commandes s’exécutent dans l’espace isolé de Codex : seul le dossier du projet peut être modifié, et Internet reste inaccessible tant que vous ne l’activez pas.',
} satisfies Record<keyof typeof zh, string>
