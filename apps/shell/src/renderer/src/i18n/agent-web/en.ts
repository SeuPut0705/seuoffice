import type { zh } from './zh'

export const en = {
  actWebSearch: 'Web search',
  actWebFetch: 'Read web page',
  permWebSearch: 'Search the web',
  permWebFetch: 'Read this web page',
  permAllowSearchSession: 'Allow searches for this session',
  permAllowSiteSession: 'Allow this site for this session',
  codexWebLabel: 'Web search',
  codexWebCached: 'Saved results',
  codexWebLive: 'Live',
  codexWebDisabled: 'Off',
  codexWebNote:
    'Saved results come from web content collected in advance; Live searches the web as it is now.',
  codexNetworkLabel: 'Internet access for commands',
  codexNetworkOff: 'Off',
  codexNetworkOn: 'On',
  codexNetworkWarning:
    'When on, commands that Codex runs can reach the internet. With “Trust this project” they reach it without asking. Hidden instructions in a document you received could make them send your data out.',
  codexFolderNote: 'These two settings are remembered for each project folder.',
  providerCodexNoteWeb:
    'Commands run in Codex’s isolated space: only the project folder can be written, and there is no internet unless you turn it on.',
} satisfies Record<keyof typeof zh, string>
