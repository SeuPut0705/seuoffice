import type { zh } from './zh'

export const ar = {
  noticeText:
    'أصبح تشغيل المهارات وإيقافها الآن من الإعدادات ← المهارات. تبدأ المهارات الموجودة في مجلدات مهارات Claude وCodex وهي متوقفة.',
  noticeOpenSettings: 'فتح الإعدادات',
  noticeClose: 'إغلاق',
  nextSession: 'تُطبَّق المهارات التي تغيّرت بدءًا من الجلسة التالية',
  templateLabel: 'المستند الذي يُحفظ كقالب',
  templateNone: 'بلا قالب',
  templateFromTab: 'مفتوح في علامة تبويب',
  templateFromProject: 'مجلد المشروع',
  templateUnsaved: 'في علامة التبويب هذه تغييرات غير محفوظة. سيصبح الملف المحفوظ هو القالب.',
  templateChecking: 'جارٍ التحقق من وجود محتوى محجوب…',
  templateUnknown:
    'لا يمكن هنا التحقق مما إذا كان في هذا التنسيق محتوى محجوب، لذا لا يمكن حفظه كما هو. أنشئ قالبًا فارغًا واحفظه.',
  templateTooLarge: 'هذا المستند كبير جدًا بحيث لا يمكن حفظه كقالب',
  installTitle: 'يقترح الذكاء الاصطناعي تثبيت هذه المهارة',
  installHint:
    'افتح المعاينة لترى محتواها، ثم قرّر ما إذا كنت ستثبّتها. تتوفر المهارة المثبّتة بدءًا من الجلسة التالية.',
  installOpen: 'فتح المعاينة',
  installDismiss: 'إغلاق',
  installDismissed: 'لم تُثبَّت',
  installCancel: 'إلغاء',
  actProposeSkill: 'اقتراح مهارة',
} satisfies Record<keyof typeof zh, string>
