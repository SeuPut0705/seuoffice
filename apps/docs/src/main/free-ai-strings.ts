import { defineStrings } from '@genoffice/i18n'

/**
 * The page the browser shows after the OpenRouter sign-in hands it back to
 * this PC. `zh` defines the key set.
 */
const zh = {
  pageDoneTitle: '已连接到 GenOffice',
  pageDoneBody: '可以关闭此标签页并返回应用。',
  pageFailedTitle: '未能完成连接',
  pageFailedBody: '请返回应用后重试。',
}

type Keys = Record<keyof typeof zh, string>

export const FREE_AI_PAGE_STRINGS = defineStrings({
  zh,
  en: {
    pageDoneTitle: 'Connected to GenOffice',
    pageDoneBody: 'You can close this tab and go back to the app.',
    pageFailedTitle: 'The connection was not made',
    pageFailedBody: 'Go back to the app and try again.',
  } satisfies Keys,
  ja: {
    pageDoneTitle: 'GenOffice に接続しました',
    pageDoneBody: 'このタブを閉じてアプリに戻ってください。',
    pageFailedTitle: '接続できませんでした',
    pageFailedBody: 'アプリに戻ってもう一度お試しください。',
  } satisfies Keys,
  ko: {
    pageDoneTitle: 'GenOffice에 연결됐습니다',
    pageDoneBody: '이 탭을 닫고 앱으로 돌아가세요.',
    pageFailedTitle: '연결하지 못했습니다',
    pageFailedBody: '앱으로 돌아가 다시 시도하세요.',
  } satisfies Keys,
  fr: {
    pageDoneTitle: 'Connecté à GenOffice',
    pageDoneBody: "Vous pouvez fermer cet onglet et revenir à l'application.",
    pageFailedTitle: "La connexion n'a pas abouti",
    pageFailedBody: "Revenez à l'application et réessayez.",
  } satisfies Keys,
  de: {
    pageDoneTitle: 'Mit GenOffice verbunden',
    pageDoneBody: 'Sie können diesen Tab schließen und zur App zurückkehren.',
    pageFailedTitle: 'Die Verbindung wurde nicht hergestellt',
    pageFailedBody: 'Kehren Sie zur App zurück und versuchen Sie es erneut.',
  } satisfies Keys,
  es: {
    pageDoneTitle: 'Conectado a GenOffice',
    pageDoneBody: 'Puedes cerrar esta pestaña y volver a la aplicación.',
    pageFailedTitle: 'No se pudo completar la conexión',
    pageFailedBody: 'Vuelve a la aplicación e inténtalo de nuevo.',
  } satisfies Keys,
  th: {
    pageDoneTitle: 'เชื่อมต่อกับ GenOffice แล้ว',
    pageDoneBody: 'ปิดแท็บนี้แล้วกลับไปที่แอปได้เลย',
    pageFailedTitle: 'เชื่อมต่อไม่สำเร็จ',
    pageFailedBody: 'กลับไปที่แอปแล้วลองอีกครั้ง',
  } satisfies Keys,
  id: {
    pageDoneTitle: 'Terhubung ke GenOffice',
    pageDoneBody: 'Anda dapat menutup tab ini dan kembali ke aplikasi.',
    pageFailedTitle: 'Koneksi tidak berhasil',
    pageFailedBody: 'Kembali ke aplikasi dan coba lagi.',
  } satisfies Keys,
  ru: {
    pageDoneTitle: 'Подключено к GenOffice',
    pageDoneBody: 'Можно закрыть эту вкладку и вернуться в приложение.',
    pageFailedTitle: 'Подключиться не удалось',
    pageFailedBody: 'Вернитесь в приложение и попробуйте ещё раз.',
  } satisfies Keys,
  ar: {
    pageDoneTitle: 'تم الاتصال بـ GenOffice',
    pageDoneBody: 'يمكنك إغلاق علامة التبويب هذه والعودة إلى التطبيق.',
    pageFailedTitle: 'لم يكتمل الاتصال',
    pageFailedBody: 'عُد إلى التطبيق وحاول مرة أخرى.',
  } satisfies Keys,
  pt: {
    pageDoneTitle: 'Conectado ao GenOffice',
    pageDoneBody: 'Você pode fechar esta aba e voltar ao aplicativo.',
    pageFailedTitle: 'A conexão não foi concluída',
    pageFailedBody: 'Volte ao aplicativo e tente novamente.',
  } satisfies Keys,
  it: {
    pageDoneTitle: 'Connesso a GenOffice',
    pageDoneBody: "Puoi chiudere questa scheda e tornare all'app.",
    pageFailedTitle: 'Connessione non riuscita',
    pageFailedBody: "Torna all'app e riprova.",
  } satisfies Keys,
  pl: {
    pageDoneTitle: 'Połączono z GenOffice',
    pageDoneBody: 'Możesz zamknąć tę kartę i wrócić do aplikacji.',
    pageFailedTitle: 'Nie udało się połączyć',
    pageFailedBody: 'Wróć do aplikacji i spróbuj ponownie.',
  } satisfies Keys,
  cs: {
    pageDoneTitle: 'Připojeno ke GenOffice',
    pageDoneBody: 'Tuto kartu můžete zavřít a vrátit se do aplikace.',
    pageFailedTitle: 'Připojení se nezdařilo',
    pageFailedBody: 'Vraťte se do aplikace a zkuste to znovu.',
  } satisfies Keys,
  nl: {
    pageDoneTitle: 'Verbonden met GenOffice',
    pageDoneBody: 'Je kunt dit tabblad sluiten en teruggaan naar de app.',
    pageFailedTitle: 'De verbinding is niet gelukt',
    pageFailedBody: 'Ga terug naar de app en probeer het opnieuw.',
  } satisfies Keys,
  ms: {
    pageDoneTitle: 'Disambungkan ke GenOffice',
    pageDoneBody: 'Anda boleh menutup tab ini dan kembali ke aplikasi.',
    pageFailedTitle: 'Sambungan tidak berjaya',
    pageFailedBody: 'Kembali ke aplikasi dan cuba lagi.',
  } satisfies Keys,
  he: {
    pageDoneTitle: 'מחובר ל-GenOffice',
    pageDoneBody: 'אפשר לסגור את הכרטיסייה הזו ולחזור לאפליקציה.',
    pageFailedTitle: 'החיבור לא הושלם',
    pageFailedBody: 'חזרו לאפליקציה ונסו שוב.',
  } satisfies Keys,
  hi: {
    pageDoneTitle: 'GenOffice से कनेक्ट हो गया',
    pageDoneBody: 'आप यह टैब बंद करके ऐप पर लौट सकते हैं।',
    pageFailedTitle: 'कनेक्शन नहीं हो सका',
    pageFailedBody: 'ऐप पर लौटें और फिर से कोशिश करें।',
  } satisfies Keys,
  'zh-TW': {
    pageDoneTitle: '已連線至 GenOffice',
    pageDoneBody: '可以關閉此分頁並返回應用程式。',
    pageFailedTitle: '未能完成連線',
    pageFailedBody: '請返回應用程式後再試一次。',
  } satisfies Keys,
  vi: {
    pageDoneTitle: 'Đã kết nối với GenOffice',
    pageDoneBody: 'Bạn có thể đóng thẻ này và quay lại ứng dụng.',
    pageFailedTitle: 'Không kết nối được',
    pageFailedBody: 'Hãy quay lại ứng dụng và thử lại.',
  } satisfies Keys,
})
