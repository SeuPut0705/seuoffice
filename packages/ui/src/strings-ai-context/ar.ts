import type { zh } from './zh'

export const ar = {
  contextConfirm:
    'يبدو أن هذا الطلب قريب من حد سياق النموذج: نحو {estimated} من {limit} رمزًا ({percent}%). هل تريد إرساله رغم ذلك؟',
  contextUnknown: 'تعذّر التحقق من حجم سياق النموذج؛ يُفترض {limit} رمزًا.',
  toolsUnsupported: 'هذا النموذج لا يدعم استدعاء الأدوات. سيقدّم نصوصًا فقط ولن يعدّل المستند.',
  errContextLimit:
    'لم يُرسل شيء: الطلب قريب من حد سياق النموذج. قسّمه إلى طلبات أصغر وحاول مرة أخرى.',
} satisfies Record<keyof typeof zh, string>
