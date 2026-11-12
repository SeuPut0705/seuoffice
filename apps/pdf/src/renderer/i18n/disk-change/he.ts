import type { zh } from './zh'

export const he = {
  diskChanged: 'הקובץ הזה השתנה. לטעון אותו מחדש?',
  diskChangedUnsaved: 'הקובץ הזה השתנה. טעינה מחדש תמחק את העריכות שלא נשמרו.',
  diskMissing: 'הקובץ הזה נמחק או ששמו שונה. מה שמוצג על המסך נשאר כפי שהוא.',
  diskReload: 'טעינה מחדש',
  diskIgnore: 'התעלמות',
  diskDismiss: 'אישור',
  diskReloadFailed: 'לא ניתן היה לטעון את הקובץ מחדש: {detail}',
  diskChangedNoUndo:
    'תוכנה אחרת שינתה או מחקה את הקובץ הזה, ולכן ביטול הפעולה והביצוע מחדש של השינוי הזה לא בוצעו.',
} satisfies Record<keyof typeof zh, string>
