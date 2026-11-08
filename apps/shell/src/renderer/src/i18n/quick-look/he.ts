import type { zh } from './zh'

export const he = {
  windowTitle: 'הצצה מהירה',
  openInEditor: 'פתח ב-GenOffice',
  revealInFolder: 'הצג בתיקייה',
  close: 'סגור',
  prevFile: 'הקובץ הקודם (↑)',
  nextFile: 'הקובץ הבא (↓)',
  shortcutHint: 'רווח / Esc לסגירה · ↑↓ למעבר · Enter לפתיחה',
  loading: 'טוען תצוגה מקדימה…',
  empty: 'במסמך זה אין טקסט לתצוגה מקדימה.',
  encrypted: 'מסמך מוגן בסיסמה. פתח ב-GenOffice כדי לבטל את הנעילה.',
  unsupported: 'לא ניתן להציג תצוגה מקדימה ישירה של פורמט קובץ זה.',
  failed: 'לא ניתן לקרוא תצוגה מקדימה של הקובץ.',
  truncated: 'מוצגת תחילת המסמך בלבד. פתח ב-GenOffice לצפייה בהכל.',
  slideLabel: 'שקופית {n}',
  sheetCount: '{n} גיליונות',
  slideCount: '{n} שקופיות',
  lineCount: '{n} שורות',
  charCount: '{n} תווים',
  tabThumbnail: 'תמונת תצוגה מקדימה',
  tabContent: 'תוכן המסמך',
  setQuickLookTitle: 'הצצה מהירה (מקש רווח)',
  setQuickLookHint:
    'לחץ על מקש הרווח על קובץ ברשימות GenOffice כדי להציג את תוכנו ללא פתיחת כרטיסייה.',
  setExplorerSpace: 'תצוגה מקדימה עם מקש רווח בסייר הקבצים ובשולחן העבודה של Windows',
  setExplorerSpaceDesc:
    'לחץ על רווח על קובץ נבחר בסייר הקבצים או בשולחן העבודה כדי לפתוח חלון הצצה מהירה.',
  setKeepInTray: 'השאר פעיל במגש המערכת בעת סגירת החלון',
  setKeepInTrayDesc:
    'משאיר את GenOffice זמין ברקע כדי שהצצה מהירה במקש רווח תעבוד בסייר הקבצים גם לאחר סגירת החלון.',
  trayOpen: 'פתח את GenOffice',
  trayQuit: 'צא מ-GenOffice',
} satisfies Record<keyof typeof zh, string>
