import type { zh } from './zh'

export const he = {
  contextConfirm:
    'הבקשה קרובה למגבלת ההקשר של המודל: כ-{estimated} מתוך {limit} אסימונים ({percent}%). לשלוח בכל זאת?',
  contextUnknown: 'לא ניתן היה לאמת את גודל ההקשר של המודל; מניחים {limit} אסימונים.',
  toolsUnsupported: 'המודל הזה אינו תומך בקריאות לכלים. הוא יציע טקסט בלבד ולא יערוך את המסמך.',
  errContextLimit:
    'לא נשלח דבר: הבקשה קרובה למגבלת ההקשר של המודל. פצלו אותה לבקשות קטנות יותר ונסו שוב.',
} satisfies Record<keyof typeof zh, string>
