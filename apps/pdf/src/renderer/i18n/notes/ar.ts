import type { zh } from './zh'

export const ar = {
  ntOpen: 'فتح الملاحظة',
  ntOpenTip: 'فتح ملاحظة Markdown المرتبطة بملف PDF هذا',
  ntInsert: 'إضافة إلى الملاحظة',
  ntInsertTip: 'يضيف هذا إلى نهاية الملاحظة. احفظها من تبويب الملاحظة',
  ntSaveFirst: 'احفظ ملف PDF أولًا',
  ntUnavailable: 'لا تُفتح الملاحظات إلا داخل تطبيق GenOffice',
  ntFailed: 'تعذر فتح الملاحظة. {reason}',
  ntInserted: 'أُضيف إلى الملاحظة',
} satisfies Record<keyof typeof zh, string>
