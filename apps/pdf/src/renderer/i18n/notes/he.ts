import type { zh } from './zh'

export const he = {
  ntOpen: 'פתיחת ההערה',
  ntOpenTip: 'פתיחת הערת ה-Markdown המקושרת ל-PDF הזה',
  ntInsert: 'הוספה להערה',
  ntInsertTip: 'מוסיף את זה לסוף ההערה. שומרים בכרטיסיית ההערה',
  ntSaveFirst: 'יש לשמור קודם את ה-PDF',
  ntUnavailable: 'הערות נפתחות רק בתוך אפליקציית GenOffice',
  ntFailed: 'לא ניתן היה לפתוח את ההערה. {reason}',
  ntInserted: 'נוסף להערה',
} satisfies Record<keyof typeof zh, string>
