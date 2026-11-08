import type { zh } from './zh'

export const it = {
  noticeText:
    'Le abilità ora si attivano e disattivano in Impostazioni → Abilità. Le abilità delle cartelle di abilità di Claude e Codex partono disattivate.',
  noticeOpenSettings: 'Apri impostazioni',
  noticeClose: 'Chiudi',
  nextSession: 'Le abilità modificate valgono dalla prossima sessione',
  templateLabel: 'Documento da salvare come modello',
  templateNone: 'Nessun modello',
  templateFromTab: 'Aperto in una scheda',
  templateFromProject: 'Cartella del progetto',
  templateUnsaved: 'Questa scheda ha modifiche non salvate. Il file salvato diventa il modello.',
  templateChecking: 'Verifica dei contenuti nascosti…',
  templateUnknown:
    'Per questo formato qui non si può verificare se ci sono contenuti nascosti, quindi il documento non può essere salvato così com’è. Crea un modello vuoto e salva quello.',
  templateTooLarge: 'Questo documento è troppo grande per essere salvato come modello',
  installTitle: 'L’IA propone di installare questa abilità',
  installHint:
    'Apri l’anteprima per vedere cosa contiene, poi decidi se installarla. Un’abilità installata è disponibile dalla prossima sessione.',
  installOpen: 'Apri anteprima',
  installDismiss: 'Chiudi',
  installDismissed: 'Non installata',
  installCancel: 'Annulla',
  actProposeSkill: 'Proponi un’abilità',
} satisfies Record<keyof typeof zh, string>
