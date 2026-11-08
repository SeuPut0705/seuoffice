import type { zh } from './zh'

export const pl = {
  noticeText:
    'Umiejętności włącza się i wyłącza teraz w Ustawienia → Umiejętności. Umiejętności z folderów umiejętności Claude i Codex są na początku wyłączone.',
  noticeOpenSettings: 'Otwórz ustawienia',
  noticeClose: 'Zamknij',
  nextSession: 'Zmienione umiejętności obowiązują od następnej sesji',
  templateLabel: 'Dokument zapisywany jako szablon',
  templateNone: 'Bez szablonu',
  templateFromTab: 'Otwarty w karcie',
  templateFromProject: 'Folder projektu',
  templateUnsaved: 'Ta karta ma niezapisane zmiany. Szablonem stanie się zapisany plik.',
  templateChecking: 'Sprawdzanie, czy są ukryte treści…',
  templateUnknown:
    'W tym formacie nie da się tu sprawdzić, czy są ukryte treści, więc dokumentu nie można zapisać bez zmian. Utwórz pusty szablon i zapisz go.',
  templateTooLarge: 'Ten dokument jest za duży, aby zapisać go jako szablon',
  installTitle: 'AI proponuje zainstalowanie tej umiejętności',
  installHint:
    'Otwórz podgląd, aby zobaczyć zawartość, i zdecyduj, czy ją zainstalować. Zainstalowana umiejętność będzie dostępna od następnej sesji.',
  installOpen: 'Otwórz podgląd',
  installDismiss: 'Zamknij',
  installDismissed: 'Nie zainstalowano',
  installCancel: 'Anuluj',
  actProposeSkill: 'Propozycja umiejętności',
} satisfies Record<keyof typeof zh, string>
