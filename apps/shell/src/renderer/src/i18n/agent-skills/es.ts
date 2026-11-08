import type { zh } from './zh'

export const es = {
  noticeText:
    'Las habilidades ahora se activan y desactivan en Configuración → Habilidades. Las habilidades de las carpetas de habilidades de Claude y Codex empiezan desactivadas.',
  noticeOpenSettings: 'Abrir configuración',
  noticeClose: 'Cerrar',
  nextSession: 'Las habilidades modificadas se aplican a partir de la próxima sesión',
  templateLabel: 'Documento que se guarda como plantilla',
  templateNone: 'Sin plantilla',
  templateFromTab: 'Abierto en una pestaña',
  templateFromProject: 'Carpeta del proyecto',
  templateUnsaved: 'Esta pestaña tiene cambios sin guardar. El archivo guardado será la plantilla.',
  templateChecking: 'Comprobando si hay contenido oculto…',
  templateUnknown:
    'En este formato no se puede comprobar aquí si hay contenido oculto, así que no se puede guardar tal cual. Cree una plantilla en blanco y guárdela.',
  templateTooLarge: 'Este documento es demasiado grande para guardarlo como plantilla',
  installTitle: 'La IA propone instalar esta habilidad',
  installHint:
    'Abra la vista previa para ver lo que contiene y decida si instalarla. Una habilidad instalada está disponible a partir de la próxima sesión.',
  installOpen: 'Abrir vista previa',
  installDismiss: 'Cerrar',
  installDismissed: 'No instalada',
  installCancel: 'Cancelar',
  actProposeSkill: 'Proponer una habilidad',
} satisfies Record<keyof typeof zh, string>
