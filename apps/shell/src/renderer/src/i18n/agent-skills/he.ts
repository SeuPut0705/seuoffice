import type { zh } from './zh'

export const he = {
  noticeText:
    'מעכשיו מפעילים ומכבים מיומנויות בהגדרות ← מיומנויות. מיומנויות מתיקיות המיומנויות של Claude ו־Codex מתחילות כבויות.',
  noticeOpenSettings: 'פתיחת ההגדרות',
  noticeClose: 'סגירה',
  nextSession: 'מיומנויות ששונו חלות מהפעלה הבאה',
  templateLabel: 'המסמך שיישמר כתבנית',
  templateNone: 'ללא תבנית',
  templateFromTab: 'פתוח בכרטיסייה',
  templateFromProject: 'תיקיית הפרויקט',
  templateUnsaved: 'בכרטיסייה זו יש שינויים שלא נשמרו. הקובץ השמור יהיה התבנית.',
  templateChecking: 'בודק אם יש תוכן מוסתר…',
  templateUnknown:
    'בתבנית קובץ זו לא ניתן לבדוק כאן אם יש תוכן מוסתר, ולכן אי אפשר לשמור את המסמך כמו שהוא. צרו תבנית ריקה ושמרו אותה.',
  templateTooLarge: 'המסמך הזה גדול מדי לשמירה כתבנית',
  installTitle: 'הבינה המלאכותית מציעה להתקין את המיומנות הזו',
  installHint:
    'פתחו את התצוגה המקדימה כדי לראות מה היא כוללת, ואז החליטו אם להתקין. מיומנות שהותקנה זמינה מההפעלה הבאה.',
  installOpen: 'פתיחת תצוגה מקדימה',
  installDismiss: 'סגירה',
  installDismissed: 'לא הותקן',
  installCancel: 'ביטול',
  actProposeSkill: 'הצעת מיומנות',
} satisfies Record<keyof typeof zh, string>
