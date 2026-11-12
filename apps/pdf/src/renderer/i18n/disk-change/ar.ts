import type { zh } from './zh'

export const ar = {
  diskChanged: 'تم تغيير هذا الملف. هل تريد إعادة تحميله؟',
  diskChangedUnsaved: 'تم تغيير هذا الملف. ستؤدي إعادة التحميل إلى تجاهل التعديلات غير المحفوظة.',
  diskMissing: 'تم حذف هذا الملف أو تغيير اسمه. يبقى ما يظهر على الشاشة كما هو.',
  diskReload: 'إعادة التحميل',
  diskIgnore: 'تجاهل',
  diskDismiss: 'موافق',
  diskReloadFailed: 'تعذّرت إعادة تحميل الملف: {detail}',
  diskChangedNoUndo:
    'غيّر برنامج آخر هذا الملف أو حذفه، لذلك لم يُنفَّذ التراجع أو الإعادة لهذا التغيير.',
  pageOpNoUndoConfirm:
    'هذا الملف ({size}) أكبر من الحجم الذي يُحتفَظ به للتراجع ({limit})، لذلك لا يمكن التراجع عن عملية الصفحات هذه. هل تريد المتابعة؟',
} satisfies Record<keyof typeof zh, string>
