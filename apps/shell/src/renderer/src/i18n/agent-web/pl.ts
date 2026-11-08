import type { zh } from './zh'

export const pl = {
  actWebSearch: 'Wyszukiwanie w sieci',
  actWebFetch: 'Odczyt strony internetowej',
  permWebSearch: 'Szukaj w sieci',
  permWebFetch: 'Odczytaj tę stronę internetową',
  permAllowSearchSession: 'Zezwól na wyszukiwanie do końca sesji',
  permAllowSiteSession: 'Zezwól na tę witrynę do końca sesji',
  codexWebLabel: 'Wyszukiwanie w sieci',
  codexWebCached: 'Zapisane wyniki',
  codexWebLive: 'Na żywo',
  codexWebDisabled: 'Wyłączone',
  codexWebNote:
    'Zapisane wyniki pochodzą z treści internetowych zebranych wcześniej; „Na żywo” przeszukuje sieć w jej obecnym stanie.',
  codexNetworkLabel: 'Dostęp poleceń do internetu',
  codexNetworkOff: 'Wyłączony',
  codexNetworkOn: 'Włączony',
  codexNetworkWarning:
    'Po włączeniu polecenia uruchamiane przez Codex mogą łączyć się z internetem. W trybie „Ufaj temu projektowi” robią to bez pytania. Ukryte instrukcje w otrzymanym dokumencie mogą sprawić, że wyślą Twoje dane na zewnątrz.',
  codexFolderNote: 'Te dwa ustawienia są zapamiętywane osobno dla każdego folderu projektu.',
  providerCodexNoteWeb:
    'Polecenia działają w izolowanej przestrzeni Codex: zapisywać można tylko w folderze projektu, a dostępu do internetu nie ma, dopóki go nie włączysz.',
} satisfies Record<keyof typeof zh, string>
