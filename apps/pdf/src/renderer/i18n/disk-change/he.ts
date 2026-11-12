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
  pageOpNoUndoConfirm:
    'הקובץ הזה ({size}) גדול מהגודל שנשמר לצורך ביטול ({limit}), ולכן לא ניתן יהיה לבטל את פעולת העמודים הזו. להמשיך?',
  undoNoRedoConfirm:
    'הקובץ במצבו הנוכחי ({size}) גדול מהגודל שנשמר לצורך ביצוע מחדש ({limit}), ולכן לא ניתן יהיה לבצע מחדש את הביטול הזה. להמשיך?',
} satisfies Record<keyof typeof zh, string>
