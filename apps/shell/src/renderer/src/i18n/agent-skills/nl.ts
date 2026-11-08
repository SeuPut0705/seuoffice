import type { zh } from './zh'

export const nl = {
  noticeText:
    'Vaardigheden zet je nu aan en uit in Instellingen → Vaardigheden. Vaardigheden in de vaardighedenmappen van Claude en Codex staan eerst uit.',
  noticeOpenSettings: 'Instellingen openen',
  noticeClose: 'Sluiten',
  nextSession: 'Gewijzigde vaardigheden gelden vanaf de volgende sessie',
  templateLabel: 'Document dat als sjabloon wordt opgeslagen',
  templateNone: 'Geen sjabloon',
  templateFromTab: 'Geopend in een tabblad',
  templateFromProject: 'Projectmap',
  templateUnsaved:
    'Dit tabblad heeft niet-opgeslagen wijzigingen. Het opgeslagen bestand wordt het sjabloon.',
  templateChecking: 'Controleren op afgeschermde inhoud…',
  templateUnknown:
    'Bij dit formaat kan hier niet worden nagegaan of er inhoud is afgeschermd, dus het kan niet ongewijzigd worden opgeslagen. Maak een leeg sjabloon en sla dat op.',
  templateTooLarge: 'Dit document is te groot om als sjabloon op te slaan',
  installTitle: 'De AI stelt voor deze vaardigheid te installeren',
  installHint:
    'Open het voorbeeld om te zien wat erin zit en beslis dan of je die installeert. Een geïnstalleerde vaardigheid is beschikbaar vanaf de volgende sessie.',
  installOpen: 'Voorbeeld openen',
  installDismiss: 'Sluiten',
  installDismissed: 'Niet geïnstalleerd',
  installCancel: 'Annuleren',
  actProposeSkill: 'Vaardigheid voorstellen',
} satisfies Record<keyof typeof zh, string>
