import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * The published feedback survey (Google Forms, owned by the repository owner).
 * The Help menu and Settings → About open it in the user's browser; the app
 * itself sends nothing. Changing the form's questions does not change this
 * address, so the link stays valid as the survey is edited.
 */
export const FEEDBACK_SURVEY_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfD_dlKfi_ZkcjBJFTH3S2nldTIoW0cMI9d_yDaEe6DwKY47A/viewform'

const zh = {
  menuLabel: '发送反馈',
  dialogTitle: '发送反馈',
  dialogBody:
    '问卷将在浏览器中打开。下面的信息会复制到剪贴板，方便你粘贴到问卷中。应用本身不会发送任何内容，也不会包含文档内容。',
  details: '版本 {version}\n操作系统 {os}\n界面语言 {language}',
  btnOpen: '打开问卷',
  btnCancel: '取消',
}

type Keys = Record<keyof typeof zh, string>

export const FEEDBACK_STRINGS = defineStrings({
  zh,
  en: {
    menuLabel: 'Send feedback',
    dialogTitle: 'Send feedback',
    dialogBody:
      'The survey opens in your browser. The details below are copied to the clipboard so you can paste them into the survey. The app sends nothing itself, and document contents are never included.',
    details: 'Version {version}\nOS {os}\nUI language {language}',
    btnOpen: 'Open survey',
    btnCancel: 'Cancel',
  } satisfies Keys,
  vi: {
    menuLabel: 'Gửi phản hồi',
    dialogTitle: 'Gửi phản hồi',
    dialogBody:
      'Bảng hỏi mở trong trình duyệt. Thông tin bên dưới được sao chép vào bộ nhớ tạm để bạn dán vào bảng hỏi. Ứng dụng không tự gửi gì và không bao giờ kèm nội dung tài liệu.',
    details: 'Phiên bản {version}\nHệ thống {os}\nNgôn ngữ {language}',
    btnOpen: 'Mở bảng hỏi',
    btnCancel: 'Hủy',
  } satisfies Keys,
  ja: {
    menuLabel: 'フィードバックを送る',
    dialogTitle: 'フィードバックを送る',
    dialogBody:
      'アンケートがブラウザで開きます。下の情報はクリップボードにコピーされ、アンケートに貼り付けられます。アプリ自体は何も送信せず、文書の内容も含まれません。',
    details: 'バージョン {version}\nOS {os}\n表示言語 {language}',
    btnOpen: 'アンケートを開く',
    btnCancel: 'キャンセル',
  } satisfies Keys,
  ko: {
    menuLabel: '의견 보내기',
    dialogTitle: '의견 보내기',
    dialogBody:
      '설문이 브라우저에서 열립니다. 아래 정보는 클립보드에 복사되어 설문에 붙여 넣을 수 있습니다. 앱은 아무것도 보내지 않으며, 문서 내용은 포함되지 않습니다.',
    details: '버전 {version}\n운영체제 {os}\n화면 언어 {language}',
    btnOpen: '설문 열기',
    btnCancel: '취소',
  } satisfies Keys,
  fr: {
    menuLabel: 'Envoyer un commentaire',
    dialogTitle: 'Envoyer un commentaire',
    dialogBody:
      "Le questionnaire s'ouvre dans votre navigateur. Les informations ci-dessous sont copiées dans le presse-papiers pour que vous puissiez les coller dans le questionnaire. L'application n'envoie rien elle-même et le contenu des documents n'est jamais inclus.",
    details: 'Version {version}\nSystème {os}\nLangue {language}',
    btnOpen: 'Ouvrir le questionnaire',
    btnCancel: 'Annuler',
  } satisfies Keys,
  de: {
    menuLabel: 'Feedback senden',
    dialogTitle: 'Feedback senden',
    dialogBody:
      'Die Umfrage öffnet sich im Browser. Die Angaben unten werden in die Zwischenablage kopiert, damit Sie sie in die Umfrage einfügen können. Die App selbst sendet nichts, und Dokumentinhalte sind nie enthalten.',
    details: 'Version {version}\nBetriebssystem {os}\nSprache {language}',
    btnOpen: 'Umfrage öffnen',
    btnCancel: 'Abbrechen',
  } satisfies Keys,
  es: {
    menuLabel: 'Enviar comentarios',
    dialogTitle: 'Enviar comentarios',
    dialogBody:
      'La encuesta se abre en el navegador. Los datos de abajo se copian al portapapeles para que los pegues en la encuesta. La aplicación no envía nada por sí misma y el contenido de los documentos nunca se incluye.',
    details: 'Versión {version}\nSistema {os}\nIdioma {language}',
    btnOpen: 'Abrir la encuesta',
    btnCancel: 'Cancelar',
  } satisfies Keys,
  th: {
    menuLabel: 'ส่งข้อเสนอแนะ',
    dialogTitle: 'ส่งข้อเสนอแนะ',
    dialogBody:
      'แบบสอบถามจะเปิดในเบราว์เซอร์ ข้อมูลด้านล่างจะถูกคัดลอกไปยังคลิปบอร์ดเพื่อให้คุณวางในแบบสอบถาม แอปไม่ได้ส่งข้อมูลใด ๆ ด้วยตัวเอง และไม่รวมเนื้อหาเอกสาร',
    details: 'เวอร์ชัน {version}\nระบบ {os}\nภาษา {language}',
    btnOpen: 'เปิดแบบสอบถาม',
    btnCancel: 'ยกเลิก',
  } satisfies Keys,
  id: {
    menuLabel: 'Kirim masukan',
    dialogTitle: 'Kirim masukan',
    dialogBody:
      'Survei terbuka di peramban. Detail di bawah disalin ke papan klip agar Anda dapat menempelkannya ke survei. Aplikasi tidak mengirim apa pun sendiri, dan isi dokumen tidak pernah disertakan.',
    details: 'Versi {version}\nSistem {os}\nBahasa {language}',
    btnOpen: 'Buka survei',
    btnCancel: 'Batal',
  } satisfies Keys,
  ru: {
    menuLabel: 'Отправить отзыв',
    dialogTitle: 'Отправить отзыв',
    dialogBody:
      'Опрос откроется в браузере. Данные ниже копируются в буфер обмена, чтобы вы могли вставить их в опрос. Приложение само ничего не отправляет, содержимое документов не включается.',
    details: 'Версия {version}\nСистема {os}\nЯзык {language}',
    btnOpen: 'Открыть опрос',
    btnCancel: 'Отмена',
  } satisfies Keys,
  ar: {
    menuLabel: 'إرسال ملاحظات',
    dialogTitle: 'إرسال ملاحظات',
    dialogBody:
      'يُفتح الاستبيان في المتصفح. تُنسخ التفاصيل أدناه إلى الحافظة لتلصقها في الاستبيان. لا يرسل التطبيق أي شيء بنفسه، ولا يُضمَّن محتوى المستندات أبدًا.',
    details: 'الإصدار {version}\nالنظام {os}\nاللغة {language}',
    btnOpen: 'فتح الاستبيان',
    btnCancel: 'إلغاء',
  } satisfies Keys,
  pt: {
    menuLabel: 'Enviar comentários',
    dialogTitle: 'Enviar comentários',
    dialogBody:
      'A pesquisa abre no navegador. Os dados abaixo são copiados para a área de transferência para você colá-los na pesquisa. O aplicativo não envia nada por conta própria, e o conteúdo dos documentos nunca é incluído.',
    details: 'Versão {version}\nSistema {os}\nIdioma {language}',
    btnOpen: 'Abrir pesquisa',
    btnCancel: 'Cancelar',
  } satisfies Keys,
  it: {
    menuLabel: 'Invia feedback',
    dialogTitle: 'Invia feedback',
    dialogBody:
      "Il sondaggio si apre nel browser. I dati qui sotto vengono copiati negli appunti per poterli incollare nel sondaggio. L'app non invia nulla da sola e il contenuto dei documenti non viene mai incluso.",
    details: 'Versione {version}\nSistema {os}\nLingua {language}',
    btnOpen: 'Apri il sondaggio',
    btnCancel: 'Annulla',
  } satisfies Keys,
  pl: {
    menuLabel: 'Wyślij opinię',
    dialogTitle: 'Wyślij opinię',
    dialogBody:
      'Ankieta otworzy się w przeglądarce. Poniższe dane są kopiowane do schowka, aby można je było wkleić do ankiety. Aplikacja sama nic nie wysyła, a treść dokumentów nigdy nie jest dołączana.',
    details: 'Wersja {version}\nSystem {os}\nJęzyk {language}',
    btnOpen: 'Otwórz ankietę',
    btnCancel: 'Anuluj',
  } satisfies Keys,
  cs: {
    menuLabel: 'Odeslat zpětnou vazbu',
    dialogTitle: 'Odeslat zpětnou vazbu',
    dialogBody:
      'Dotazník se otevře v prohlížeči. Údaje níže se zkopírují do schránky, abyste je mohli vložit do dotazníku. Aplikace sama nic neodesílá a obsah dokumentů se nikdy nepřikládá.',
    details: 'Verze {version}\nSystém {os}\nJazyk {language}',
    btnOpen: 'Otevřít dotazník',
    btnCancel: 'Zrušit',
  } satisfies Keys,
  nl: {
    menuLabel: 'Feedback sturen',
    dialogTitle: 'Feedback sturen',
    dialogBody:
      'De enquête opent in je browser. De gegevens hieronder worden naar het klembord gekopieerd zodat je ze in de enquête kunt plakken. De app verstuurt zelf niets en de inhoud van documenten wordt nooit meegestuurd.',
    details: 'Versie {version}\nSysteem {os}\nTaal {language}',
    btnOpen: 'Enquête openen',
    btnCancel: 'Annuleren',
  } satisfies Keys,
  ms: {
    menuLabel: 'Hantar maklum balas',
    dialogTitle: 'Hantar maklum balas',
    dialogBody:
      'Tinjauan dibuka dalam pelayar. Butiran di bawah disalin ke papan keratan supaya anda boleh menampalnya dalam tinjauan. Aplikasi tidak menghantar apa-apa sendiri, dan kandungan dokumen tidak pernah disertakan.',
    details: 'Versi {version}\nSistem {os}\nBahasa {language}',
    btnOpen: 'Buka tinjauan',
    btnCancel: 'Batal',
  } satisfies Keys,
  he: {
    menuLabel: 'שליחת משוב',
    dialogTitle: 'שליחת משוב',
    dialogBody:
      'השאלון ייפתח בדפדפן. הפרטים למטה מועתקים ללוח כדי שתוכלו להדביק אותם בשאלון. האפליקציה עצמה לא שולחת דבר, ותוכן המסמכים אינו נכלל לעולם.',
    details: 'גרסה {version}\nמערכת {os}\nשפה {language}',
    btnOpen: 'פתיחת השאלון',
    btnCancel: 'ביטול',
  } satisfies Keys,
  hi: {
    menuLabel: 'फ़ीडबैक भेजें',
    dialogTitle: 'फ़ीडबैक भेजें',
    dialogBody:
      'सर्वेक्षण ब्राउज़र में खुलेगा। नीचे की जानकारी क्लिपबोर्ड पर कॉपी हो जाती है ताकि आप उसे सर्वेक्षण में पेस्ट कर सकें। ऐप स्वयं कुछ नहीं भेजता, और दस्तावेज़ की सामग्री कभी शामिल नहीं होती।',
    details: 'संस्करण {version}\nसिस्टम {os}\nभाषा {language}',
    btnOpen: 'सर्वेक्षण खोलें',
    btnCancel: 'रद्द करें',
  } satisfies Keys,
  'zh-TW': {
    menuLabel: '傳送意見回饋',
    dialogTitle: '傳送意見回饋',
    dialogBody:
      '問卷將在瀏覽器中開啟。下方的資訊會複製到剪貼簿，方便你貼到問卷中。應用程式本身不會傳送任何內容，也不會包含文件內容。',
    details: '版本 {version}\n作業系統 {os}\n介面語言 {language}',
    btnOpen: '開啟問卷',
    btnCancel: '取消',
  } satisfies Keys,
})

export const feedbackText = createI18n(FEEDBACK_STRINGS)

export interface FeedbackEnvironment {
  version: string
  os: string
  language: string
}

/** `Windows`, `macOS`, `Linux`; anything else is shown as the platform names itself. */
export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** The block copied to the clipboard: version, OS and UI language, nothing else. */
export function feedbackDetails(lang: Lang, env: FeedbackEnvironment): string {
  return feedbackText(lang, 'details', {
    version: env.version,
    os: env.os,
    language: env.language,
  })
}
