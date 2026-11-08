import type { zh } from './zh'

export const he = {
  actWebSearch: 'חיפוש באינטרנט',
  actWebFetch: 'קריאת דף אינטרנט',
  permWebSearch: 'חיפוש באינטרנט',
  permWebFetch: 'קריאת דף האינטרנט הזה',
  permAllowSearchSession: 'לאשר חיפושים לאורך הסשן הזה',
  permAllowSiteSession: 'לאשר את האתר הזה לאורך הסשן הזה',
  codexWebLabel: 'חיפוש באינטרנט',
  codexWebCached: 'תוצאות שמורות',
  codexWebLive: 'בזמן אמת',
  codexWebDisabled: 'כבוי',
  codexWebNote:
    'תוצאות שמורות מגיעות מתוכן אינטרנט שנאסף מראש; חיפוש בזמן אמת מחפש באינטרנט כפי שהוא עכשיו.',
  codexNetworkLabel: 'גישה לאינטרנט לפקודות',
  codexNetworkOff: 'כבויה',
  codexNetworkOn: 'פעילה',
  codexNetworkWarning:
    'כשהגישה פעילה, הפקודות ש-Codex מריץ יכולות להגיע לאינטרנט. במצב „לסמוך על הפרויקט הזה” הן מגיעות אליו בלי לשאול. הוראות נסתרות במסמך שקיבלת עלולות לגרום להן לשלוח את הנתונים שלך החוצה.',
  codexFolderNote: 'שתי ההגדרות האלה נשמרות לכל תיקיית פרויקט בנפרד.',
  providerCodexNoteWeb:
    'הפקודות רצות במרחב המבודד של Codex: אפשר לכתוב רק לתיקיית הפרויקט, ואין גישה לאינטרנט אלא אם תפעיל אותה.',
} satisfies Record<keyof typeof zh, string>
