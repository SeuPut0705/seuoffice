import type { zh } from './zh'

export const ar = {
  actWebSearch: 'البحث في الويب',
  actWebFetch: 'قراءة صفحة ويب',
  permWebSearch: 'البحث في الويب',
  permWebFetch: 'قراءة صفحة الويب هذه',
  permAllowSearchSession: 'السماح بالبحث طوال هذه الجلسة',
  permAllowSiteSession: 'السماح بهذا الموقع طوال هذه الجلسة',
  codexWebLabel: 'البحث في الويب',
  codexWebCached: 'نتائج محفوظة',
  codexWebLive: 'مباشر',
  codexWebDisabled: 'إيقاف',
  codexWebNote:
    'تأتي النتائج المحفوظة من محتوى ويب جُمع مسبقًا؛ أما البحث المباشر فيبحث في الويب كما هو الآن.',
  codexNetworkLabel: 'وصول الأوامر إلى الإنترنت',
  codexNetworkOff: 'إيقاف',
  codexNetworkOn: 'تشغيل',
  codexNetworkWarning:
    'عند التشغيل، يمكن للأوامر التي يشغّلها Codex الوصول إلى الإنترنت. ومع «الثقة بهذا المشروع» تصل إليه دون أن تسأل. قد تدفعها تعليمات مخفية في مستند تلقيته إلى إرسال بياناتك إلى الخارج.',
  codexFolderNote: 'يُحفَظ هذان الإعدادان لكل مجلد مشروع على حدة.',
  providerCodexNoteWeb:
    'تعمل الأوامر في المساحة المعزولة الخاصة بـ Codex: لا يمكن الكتابة إلا في مجلد المشروع، ولا يتوفر اتصال بالإنترنت ما لم تشغّله.',
} satisfies Record<keyof typeof zh, string>
