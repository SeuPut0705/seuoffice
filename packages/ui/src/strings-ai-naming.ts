import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'

/**
 * What "Name with AI" says while it runs and when it gives no name, so the
 * five editors that have the command word it the same way. A provider that is
 * not connected is worded by the subscription strings (`aiRunErrorText`).
 */
export const AI_NAMING_STRINGS = defineStrings({
  zh: {
    running: '正在请 AI 命名…',
    noticeFirst: '用订阅让 AI 命名之前，请先打开 AI 面板并确认其中的提示，然后重试。',
    timeout: 'AI 未及时回应，没有给出文件名。请稍后重试。',
    failed: 'AI 没能给出文件名。请稍后重试。',
    noText: '这个文件里没有可供 AI 命名的文字。',
    unavailable: '这里无法使用 AI 命名。',
  },
  en: {
    running: 'Asking AI for a file name…',
    noticeFirst:
      'Before AI names a file on your subscription, open the AI panel and confirm the notice there. Then try again.',
    timeout: 'AI did not answer in time, so no name was suggested. Try again in a moment.',
    failed: 'AI could not suggest a file name. Try again in a moment.',
    noText: 'There is no text in this file for AI to name it from.',
    unavailable: 'Naming with AI is not available here.',
  },
  ja: {
    running: 'AI にファイル名を考えてもらっています…',
    noticeFirst:
      'サブスクリプションで AI に名前を付けてもらう前に、AI パネルを開いて案内を確認してください。そのあとでもう一度お試しください。',
    timeout:
      'AI から時間内に応答がなかったため、名前は提案されませんでした。しばらくしてからもう一度お試しください。',
    failed: 'AI はファイル名を提案できませんでした。しばらくしてからもう一度お試しください。',
    noText: 'このファイルには、AI が名前を考えるためのテキストがありません。',
    unavailable: 'ここでは AI による名前付けは使えません。',
  },
  ko: {
    running: 'AI에게 파일 이름을 물어보는 중…',
    noticeFirst:
      '구독으로 AI에게 이름을 맡기려면 먼저 AI 창을 열어 안내를 확인하세요. 그런 다음 다시 시도하세요.',
    timeout: 'AI가 제때 응답하지 않아 이름을 받지 못했습니다. 잠시 뒤 다시 시도하세요.',
    failed: 'AI가 파일 이름을 내놓지 못했습니다. 잠시 뒤 다시 시도하세요.',
    noText: '이 파일에는 AI가 이름을 지을 글이 없습니다.',
    unavailable: '여기서는 AI로 이름을 지을 수 없습니다.',
  },
  fr: {
    running: 'Demande d’un nom de fichier à l’IA…',
    noticeFirst:
      'Avant que l’IA ne nomme un fichier avec votre abonnement, ouvrez le panneau IA et confirmez l’avis qui s’y affiche. Réessayez ensuite.',
    timeout: 'L’IA n’a pas répondu à temps : aucun nom n’a été proposé. Réessayez dans un instant.',
    failed: 'L’IA n’a pas pu proposer de nom de fichier. Réessayez dans un instant.',
    noText: 'Ce fichier ne contient aucun texte à partir duquel l’IA pourrait le nommer.',
    unavailable: 'Le nommage par l’IA n’est pas disponible ici.',
  },
  de: {
    running: 'Die KI wird nach einem Dateinamen gefragt…',
    noticeFirst:
      'Bevor die KI eine Datei über Ihr Abonnement benennt, öffnen Sie das KI-Panel und bestätigen Sie den Hinweis dort. Versuchen Sie es danach erneut.',
    timeout:
      'Die KI hat nicht rechtzeitig geantwortet, daher wurde kein Name vorgeschlagen. Versuchen Sie es gleich noch einmal.',
    failed: 'Die KI konnte keinen Dateinamen vorschlagen. Versuchen Sie es gleich noch einmal.',
    noText: 'Diese Datei enthält keinen Text, aus dem die KI einen Namen ableiten könnte.',
    unavailable: 'Das Benennen mit KI ist hier nicht verfügbar.',
  },
  es: {
    running: 'Pidiendo un nombre de archivo a la IA…',
    noticeFirst:
      'Antes de que la IA ponga nombre a un archivo con tu suscripción, abre el panel de IA y confirma el aviso que aparece allí. Luego inténtalo de nuevo.',
    timeout:
      'La IA no respondió a tiempo, así que no se propuso ningún nombre. Inténtalo de nuevo en un momento.',
    failed: 'La IA no pudo proponer un nombre de archivo. Inténtalo de nuevo en un momento.',
    noText: 'Este archivo no tiene texto a partir del cual la IA pueda ponerle nombre.',
    unavailable: 'Aquí no se puede nombrar con IA.',
  },
  th: {
    running: 'กำลังขอชื่อไฟล์จาก AI…',
    noticeFirst:
      'ก่อนให้ AI ตั้งชื่อไฟล์ด้วยการสมัครสมาชิกของคุณ โปรดเปิดแผง AI แล้วยืนยันประกาศที่แสดงอยู่ จากนั้นลองอีกครั้ง',
    timeout: 'AI ไม่ตอบกลับภายในเวลาที่กำหนด จึงไม่มีชื่อที่เสนอ โปรดลองอีกครั้งในอีกสักครู่',
    failed: 'AI ไม่สามารถเสนอชื่อไฟล์ได้ โปรดลองอีกครั้งในอีกสักครู่',
    noText: 'ไฟล์นี้ไม่มีข้อความให้ AI ใช้ตั้งชื่อ',
    unavailable: 'ไม่สามารถตั้งชื่อด้วย AI ได้ที่นี่',
  },
  id: {
    running: 'Meminta nama file kepada AI…',
    noticeFirst:
      'Sebelum AI menamai file dengan langganan Anda, buka panel AI dan konfirmasi pemberitahuan di sana. Setelah itu coba lagi.',
    timeout:
      'AI tidak menjawab tepat waktu, jadi tidak ada nama yang diusulkan. Coba lagi sebentar lagi.',
    failed: 'AI tidak dapat mengusulkan nama file. Coba lagi sebentar lagi.',
    noText: 'File ini tidak berisi teks yang bisa dipakai AI untuk menamainya.',
    unavailable: 'Penamaan dengan AI tidak tersedia di sini.',
  },
  ru: {
    running: 'Запрашиваем у ИИ имя файла…',
    noticeFirst:
      'Прежде чем ИИ назовёт файл по вашей подписке, откройте панель ИИ и подтвердите уведомление в ней. Затем повторите попытку.',
    timeout: 'ИИ не ответил вовремя, поэтому имя не предложено. Повторите попытку чуть позже.',
    failed: 'ИИ не смог предложить имя файла. Повторите попытку чуть позже.',
    noText: 'В этом файле нет текста, по которому ИИ мог бы его назвать.',
    unavailable: 'Здесь нельзя назвать файл с помощью ИИ.',
  },
  ar: {
    running: 'جارٍ طلب اسم للملف من الذكاء الاصطناعي…',
    noticeFirst:
      'قبل أن يسمّي الذكاء الاصطناعي ملفًا باشتراكك، افتح لوحة الذكاء الاصطناعي وأكّد الإشعار الظاهر فيها، ثم حاول مرة أخرى.',
    timeout:
      'لم يستجب الذكاء الاصطناعي في الوقت المحدد، لذا لم يُقترح أي اسم. حاول مرة أخرى بعد قليل.',
    failed: 'تعذّر على الذكاء الاصطناعي اقتراح اسم للملف. حاول مرة أخرى بعد قليل.',
    noText: 'لا يحتوي هذا الملف على نص يسمّيه الذكاء الاصطناعي على أساسه.',
    unavailable: 'التسمية بالذكاء الاصطناعي غير متاحة هنا.',
  },
  pt: {
    running: 'Pedindo um nome de arquivo à IA…',
    noticeFirst:
      'Antes que a IA nomeie um arquivo com a sua assinatura, abra o painel de IA e confirme o aviso exibido lá. Depois tente novamente.',
    timeout:
      'A IA não respondeu a tempo, então nenhum nome foi sugerido. Tente novamente em instantes.',
    failed: 'A IA não conseguiu sugerir um nome de arquivo. Tente novamente em instantes.',
    noText: 'Este arquivo não tem texto a partir do qual a IA possa nomeá-lo.',
    unavailable: 'A nomeação com IA não está disponível aqui.',
  },
  it: {
    running: 'Richiesta di un nome file all’IA…',
    noticeFirst:
      'Prima che l’IA assegni un nome a un file con il tuo abbonamento, apri il pannello IA e conferma l’avviso mostrato lì. Poi riprova.',
    timeout:
      'L’IA non ha risposto in tempo, quindi non è stato proposto alcun nome. Riprova tra un momento.',
    failed: 'L’IA non è riuscita a proporre un nome file. Riprova tra un momento.',
    noText: 'Questo file non contiene testo da cui l’IA possa ricavare un nome.',
    unavailable: 'L’assegnazione del nome con l’IA non è disponibile qui.',
  },
  pl: {
    running: 'Pytanie AI o nazwę pliku…',
    noticeFirst:
      'Zanim AI nazwie plik w ramach Twojej subskrypcji, otwórz panel AI i potwierdź widoczną tam informację. Potem spróbuj ponownie.',
    timeout:
      'AI nie odpowiedziało na czas, więc nie zaproponowano nazwy. Spróbuj ponownie za chwilę.',
    failed: 'AI nie udało się zaproponować nazwy pliku. Spróbuj ponownie za chwilę.',
    noText: 'W tym pliku nie ma tekstu, na podstawie którego AI mogłoby go nazwać.',
    unavailable: 'Nazywanie za pomocą AI nie jest tutaj dostępne.',
  },
  cs: {
    running: 'AI vymýšlí název souboru…',
    noticeFirst:
      'Než AI pojmenuje soubor v rámci vašeho předplatného, otevřete panel AI a potvrďte tam zobrazené upozornění. Pak to zkuste znovu.',
    timeout: 'AI neodpověděla včas, takže žádný název nenavrhla. Zkuste to za chvíli znovu.',
    failed: 'AI se nepodařilo navrhnout název souboru. Zkuste to za chvíli znovu.',
    noText: 'V tomto souboru není žádný text, podle kterého by ho AI mohla pojmenovat.',
    unavailable: 'Pojmenování pomocí AI tady není k dispozici.',
  },
  nl: {
    running: 'AI wordt om een bestandsnaam gevraagd…',
    noticeFirst:
      'Voordat AI een bestand een naam geeft met je abonnement, open je het AI-paneel en bevestig je de melding daar. Probeer het daarna opnieuw.',
    timeout:
      'AI heeft niet op tijd gereageerd, dus er is geen naam voorgesteld. Probeer het zo dadelijk opnieuw.',
    failed: 'AI kon geen bestandsnaam voorstellen. Probeer het zo dadelijk opnieuw.',
    noText: 'Dit bestand bevat geen tekst waaruit AI een naam kan afleiden.',
    unavailable: 'Naam geven met AI is hier niet beschikbaar.',
  },
  ms: {
    running: 'Meminta nama fail daripada AI…',
    noticeFirst:
      'Sebelum AI menamakan fail dengan langganan anda, buka panel AI dan sahkan notis di situ. Kemudian cuba lagi.',
    timeout:
      'AI tidak menjawab dalam masa yang ditetapkan, jadi tiada nama dicadangkan. Cuba lagi sebentar lagi.',
    failed: 'AI tidak dapat mencadangkan nama fail. Cuba lagi sebentar lagi.',
    noText: 'Fail ini tiada teks untuk AI gunakan bagi menamakannya.',
    unavailable: 'Penamaan dengan AI tidak tersedia di sini.',
  },
  he: {
    running: 'מבקשים מהבינה המלאכותית שם לקובץ…',
    noticeFirst:
      'לפני שהבינה המלאכותית נותנת שם לקובץ באמצעות המינוי שלכם, פתחו את חלונית הבינה המלאכותית ואשרו את ההודעה שמוצגת בה. לאחר מכן נסו שוב.',
    timeout: 'הבינה המלאכותית לא ענתה בזמן, ולכן לא הוצע שם. נסו שוב בעוד רגע.',
    failed: 'הבינה המלאכותית לא הצליחה להציע שם לקובץ. נסו שוב בעוד רגע.',
    noText: 'בקובץ הזה אין טקסט שהבינה המלאכותית יכולה לתת לו שם על פיו.',
    unavailable: 'מתן שם באמצעות AI אינו זמין כאן.',
  },
  hi: {
    running: 'AI से फ़ाइल का नाम पूछा जा रहा है…',
    noticeFirst:
      'आपकी सदस्यता से AI फ़ाइल का नाम दे, इससे पहले AI पैनल खोलें और वहाँ दिखाई गई सूचना की पुष्टि करें। फिर दोबारा कोशिश करें।',
    timeout:
      'AI ने समय पर जवाब नहीं दिया, इसलिए कोई नाम नहीं सुझाया गया। थोड़ी देर बाद फिर से कोशिश करें।',
    failed: 'AI फ़ाइल का नाम नहीं सुझा सका। थोड़ी देर बाद फिर से कोशिश करें।',
    noText: 'इस फ़ाइल में ऐसा कोई टेक्स्ट नहीं है जिससे AI इसका नाम दे सके।',
    unavailable: 'यहाँ AI से नाम देना उपलब्ध नहीं है।',
  },
  'zh-TW': {
    running: '正在請 AI 命名…',
    noticeFirst: '以訂閱讓 AI 命名之前，請先開啟 AI 面板並確認其中的說明，然後再試一次。',
    timeout: 'AI 未及時回應，沒有提供檔案名稱。請稍後再試。',
    failed: 'AI 無法提供檔案名稱。請稍後再試。',
    noText: '這個檔案中沒有可供 AI 命名的文字。',
    unavailable: '這裡無法使用 AI 命名。',
  },
  vi: {
    running: 'Đang nhờ AI đặt tên tệp…',
    noticeFirst:
      'Trước khi AI đặt tên tệp bằng gói đăng ký của bạn, hãy mở bảng AI và xác nhận thông báo ở đó. Sau đó thử lại.',
    timeout:
      'AI không trả lời kịp thời nên chưa có tên nào được đề xuất. Hãy thử lại sau giây lát.',
    failed: 'AI không thể đề xuất tên tệp. Hãy thử lại sau giây lát.',
    noText: 'Tệp này không có văn bản nào để AI dựa vào mà đặt tên.',
    unavailable: 'Không thể đặt tên bằng AI ở đây.',
  },
})

export type AiNamingStringKey = keyof typeof AI_NAMING_STRINGS.zh

/** `aiNamingText(lang, key)`: the string in that language */
export const aiNamingText: (lang: Lang, key: AiNamingStringKey, params?: Params) => string =
  createI18n(AI_NAMING_STRINGS)
