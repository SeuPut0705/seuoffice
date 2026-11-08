import type { zh } from './zh'

export const de = {
  noticeText:
    'Skills werden jetzt unter Einstellungen → Skills ein- und ausgeschaltet. Skills aus den Claude- und Codex-Skill-Ordnern sind anfangs ausgeschaltet.',
  noticeOpenSettings: 'Einstellungen öffnen',
  noticeClose: 'Schließen',
  nextSession: 'Geänderte Skills gelten ab der nächsten Sitzung',
  templateLabel: 'Dokument, das als Vorlage gespeichert wird',
  templateNone: 'Keine Vorlage',
  templateFromTab: 'In einem Tab geöffnet',
  templateFromProject: 'Projektordner',
  templateUnsaved:
    'Dieser Tab hat ungespeicherte Änderungen. Die gespeicherte Datei wird zur Vorlage.',
  templateChecking: 'Es wird geprüft, ob Inhalte zurückgehalten werden…',
  templateUnknown:
    'Bei diesem Format kann hier nicht geprüft werden, ob Inhalte zurückgehalten werden; es kann daher nicht unverändert gespeichert werden. Erstellen Sie eine leere Vorlage und speichern Sie diese.',
  templateTooLarge: 'Dieses Dokument ist zu groß, um als Vorlage gespeichert zu werden',
  installTitle: 'Die KI schlägt vor, diesen Skill zu installieren',
  installHint:
    'Öffnen Sie die Vorschau, um den Inhalt zu prüfen, und entscheiden Sie dann über die Installation. Ein installierter Skill ist ab der nächsten Sitzung verfügbar.',
  installOpen: 'Vorschau öffnen',
  installDismiss: 'Schließen',
  installDismissed: 'Nicht installiert',
  installCancel: 'Abbrechen',
  actProposeSkill: 'Skill vorschlagen',
} satisfies Record<keyof typeof zh, string>
