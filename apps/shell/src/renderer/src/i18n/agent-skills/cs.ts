import type { zh } from './zh'

export const cs = {
  noticeText:
    'Dovednosti se nyní zapínají a vypínají v Nastavení → Dovednosti. Dovednosti ze složek dovedností Claude a Codex začínají vypnuté.',
  noticeOpenSettings: 'Otevřít nastavení',
  noticeClose: 'Zavřít',
  nextSession: 'Změněné dovednosti platí od další relace',
  templateLabel: 'Dokument, který se uloží jako šablona',
  templateNone: 'Bez šablony',
  templateFromTab: 'Otevřeno v kartě',
  templateFromProject: 'Složka projektu',
  templateUnsaved: 'Tato karta má neuložené změny. Šablonou se stane uložený soubor.',
  templateChecking: 'Kontroluje se skrytý obsah…',
  templateUnknown:
    'U tohoto formátu zde nelze ověřit, zda obsahuje skrytý obsah, proto ho nelze uložit tak, jak je. Vytvořte prázdnou šablonu a uložte ji.',
  templateTooLarge: 'Tento dokument je příliš velký na uložení jako šablona',
  installTitle: 'AI navrhuje nainstalovat tuto dovednost',
  installHint:
    'Otevřete náhled, prohlédněte si obsah a pak rozhodněte, zda ji nainstalovat. Nainstalovaná dovednost je k dispozici od další relace.',
  installOpen: 'Otevřít náhled',
  installDismiss: 'Zavřít',
  installDismissed: 'Nenainstalováno',
  installCancel: 'Zrušit',
  actProposeSkill: 'Návrh dovednosti',
} satisfies Record<keyof typeof zh, string>
