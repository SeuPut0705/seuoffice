import type { zh } from './zh'

export const pl = {
  ntOpen: 'Otwórz notatkę',
  ntOpenTip: 'Otwórz notatkę Markdown powiązaną z tym PDF',
  ntInsert: 'Dodaj do notatki',
  ntInsertTip: 'Dodaje to na końcu notatki. Zapisz ją w karcie notatki',
  ntSaveFirst: 'Najpierw zapisz PDF',
  ntUnavailable: 'Notatki otwierają się tylko w aplikacji GenOffice',
  ntFailed: 'Nie udało się otworzyć notatki. {reason}',
  ntInserted: 'Dodano do notatki',
} satisfies Record<keyof typeof zh, string>
