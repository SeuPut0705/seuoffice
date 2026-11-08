import type { zh } from './zh'

export const ar = {
  windowTitle: 'معاينة سريعة',
  openInEditor: 'فتح في GenOffice',
  revealInFolder: 'إظهار في المجلد',
  close: 'إغلاق',
  prevFile: 'الملف السابق (↑)',
  nextFile: 'الملف التالي (↓)',
  shortcutHint: 'Space / Esc للإغلاق · ↑↓ للتبديل · Enter للفتح',
  loading: 'جارٍ تحميل المعاينة…',
  empty: 'لا يحتوي هذا المستند على نص قابل للمعاينة.',
  encrypted: 'مستند محمي بكلمة مرور. افتحه في GenOffice لإلغاء القفل.',
  unsupported: 'لا يمكن معاينة تنسيق الملف هذا مباشرة.',
  failed: 'تعذرت قراءة معاينة الملف.',
  truncated: 'يتم عرض بداية المستند فقط. افتحه في GenOffice لعرض الكل.',
  slideLabel: 'شريحة {n}',
  sheetCount: '{n} أوراق',
  slideCount: '{n} شرائح',
  lineCount: '{n} أسطر',
  charCount: '{n} أحرف',
  tabThumbnail: 'صورة المعاينة',
  tabContent: 'محتوى المستند',
  setQuickLookTitle: 'المعاينة السريعة (مفتاح المسافة)',
  setQuickLookHint:
    'اضغط على مفتاح المسافة على أي ملف في قوائم GenOffice لمعاينة محتواه دون فتح علامة تبويب.',
  setExplorerSpace: 'معاينة الملفات بمفتاح المسافة في مستكشف ملفات Windows وسطح المكتب',
  setExplorerSpaceDesc:
    'اضغط على المسافة على ملف محدد في مستكشف الملفات أو سطح المكتب لإظهار نافذة المعاينة السريعة.',
  setKeepInTray: 'الإبقاء قيد التشغيل في علبة النظام عند إغلاق النافذة',
  setKeepInTrayDesc:
    'يبقي GenOffice جاهزاً في الخلفية لكي تعمل المعاينة بمفتاح المسافة في مستكشف الملفات حتى بعد إغلاق النافذة.',
  trayOpen: 'فتح GenOffice',
  trayQuit: 'إنهاء GenOffice',
} satisfies Record<keyof typeof zh, string>
