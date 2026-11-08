import type { zh } from './zh'

export const es = {
  actWebSearch: 'Búsqueda web',
  actWebFetch: 'Leer página web',
  permWebSearch: 'Buscar en la web',
  permWebFetch: 'Leer esta página web',
  permAllowSearchSession: 'Permitir búsquedas durante esta sesión',
  permAllowSiteSession: 'Permitir este sitio durante esta sesión',
  codexWebLabel: 'Búsqueda web',
  codexWebCached: 'Resultados guardados',
  codexWebLive: 'En vivo',
  codexWebDisabled: 'Desactivada',
  codexWebNote:
    'Los resultados guardados provienen de contenido web recopilado de antemano; «En vivo» busca en la web tal como está ahora.',
  codexNetworkLabel: 'Acceso a internet de los comandos',
  codexNetworkOff: 'Desactivado',
  codexNetworkOn: 'Activado',
  codexNetworkWarning:
    'Si lo activas, los comandos que ejecuta Codex pueden acceder a internet. Con «Confiar en este proyecto» acceden sin preguntar. Instrucciones ocultas en un documento recibido podrían hacer que envíen tus datos al exterior.',
  codexFolderNote: 'Estos dos ajustes se recuerdan para cada carpeta de proyecto.',
  providerCodexNoteWeb:
    'Los comandos se ejecutan en el espacio aislado de Codex: solo se puede escribir en la carpeta del proyecto y no hay acceso a internet a menos que lo actives.',
} satisfies Record<keyof typeof zh, string>
