import type { zh } from './zh'

export const fr = {
  noticeText:
    'Les compétences s’activent et se désactivent désormais dans Paramètres → Compétences. Les compétences des dossiers de compétences Claude et Codex sont désactivées au départ.',
  noticeOpenSettings: 'Ouvrir les paramètres',
  noticeClose: 'Fermer',
  nextSession: 'Les compétences modifiées s’appliquent à partir de la prochaine session',
  templateLabel: 'Document à enregistrer comme modèle',
  templateNone: 'Aucun modèle',
  templateFromTab: 'Ouvert dans un onglet',
  templateFromProject: 'Dossier du projet',
  templateUnsaved:
    'Cet onglet a des modifications non enregistrées. C’est le fichier enregistré qui devient le modèle.',
  templateChecking: 'Recherche de contenu masqué…',
  templateUnknown:
    'Pour ce format, l’application ne peut pas vérifier ici si un contenu est masqué ; le document ne peut donc pas être enregistré tel quel. Créez un modèle vierge et enregistrez-le.',
  templateTooLarge: 'Ce document est trop volumineux pour être enregistré comme modèle',
  installTitle: 'L’IA propose d’installer cette compétence',
  installHint:
    'Ouvrez l’aperçu pour voir son contenu, puis décidez de l’installer ou non. Une compétence installée est disponible à partir de la prochaine session.',
  installOpen: 'Ouvrir l’aperçu',
  installDismiss: 'Fermer',
  installDismissed: 'Non installée',
  installCancel: 'Annuler',
  actProposeSkill: 'Proposer une compétence',
} satisfies Record<keyof typeof zh, string>
