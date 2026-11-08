import type { Lang } from '@genoffice/i18n'
import type { AiTargetKind } from './generate-api'

/**
 * The request a generate run starts with when the user leaves the box empty.
 *
 * Localized, not English: the receiving editor puts this text in its composer
 * as the user's own message (it is what the user sees in the conversation, and
 * what stays in the box when the run is blocked), so it is written in the UI
 * language like anything else the user would have typed. The window shows the
 * same text as the box's placeholder, so what is sent is what was shown.
 * None of them names the product, so no brand substitution applies.
 */
export const DEFAULT_GENERATE_PROMPTS: Record<Lang, Record<AiTargetKind, string>> = {
  zh: {
    slides: '请根据附件资料制作一份演示文稿。整理出要点，做成标题清晰的幻灯片。',
    html: '请根据附件资料制作一个网页（HTML）。把要点排得清楚易读。',
    mindmap: '请根据附件资料制作一张思维导图。把主题放在中心，用分支整理要点。',
  },
  en: {
    slides:
      'Make a presentation from the attached material. Organize the main points into slides with clear titles.',
    html: 'Make a web page (HTML) from the attached material. Lay out the main points so they are easy to read.',
    mindmap:
      'Make a mind map from the attached material. Put the main topic in the center and organize the key points as branches.',
  },
  ja: {
    slides:
      '添付した資料からプレゼンテーションを作成してください。要点を整理し、タイトルの明確なスライドにまとめてください。',
    html: '添付した資料からウェブページ（HTML）を作成してください。要点を読みやすく配置してください。',
    mindmap:
      '添付した資料からマインドマップを作成してください。中心にテーマを置き、要点を枝として整理してください。',
  },
  ko: {
    slides:
      '첨부한 자료로 발표 자료를 만들어 주세요. 핵심 내용을 정리해 제목이 분명한 슬라이드로 구성해 주세요.',
    html: '첨부한 자료로 웹 페이지(HTML)를 만들어 주세요. 핵심 내용을 읽기 쉽게 배치해 주세요.',
    mindmap:
      '첨부한 자료로 마인드맵을 만들어 주세요. 중심 주제를 가운데에 두고 핵심 내용을 가지로 정리해 주세요.',
  },
  fr: {
    slides:
      'Crée une présentation à partir des documents joints. Organise les points principaux en diapositives aux titres clairs.',
    html: 'Crée une page web (HTML) à partir des documents joints. Dispose les points principaux pour qu’ils soient faciles à lire.',
    mindmap:
      'Crée une carte mentale à partir des documents joints. Place le sujet principal au centre et organise les points clés en branches.',
  },
  de: {
    slides:
      'Erstelle aus dem angehängten Material eine Präsentation. Gliedere die wichtigsten Punkte in Folien mit klaren Titeln.',
    html: 'Erstelle aus dem angehängten Material eine Webseite (HTML). Ordne die wichtigsten Punkte gut lesbar an.',
    mindmap:
      'Erstelle aus dem angehängten Material eine Mindmap. Setze das Hauptthema in die Mitte und ordne die wichtigsten Punkte als Zweige an.',
  },
  es: {
    slides:
      'Crea una presentación a partir del material adjunto. Organiza los puntos principales en diapositivas con títulos claros.',
    html: 'Crea una página web (HTML) a partir del material adjunto. Distribuye los puntos principales para que sean fáciles de leer.',
    mindmap:
      'Crea un mapa mental a partir del material adjunto. Pon el tema principal en el centro y organiza los puntos clave como ramas.',
  },
  th: {
    slides: 'ช่วยสร้างงานนำเสนอจากเอกสารที่แนบมา จัดประเด็นสำคัญเป็นสไลด์ที่มีหัวข้อชัดเจน',
    html: 'ช่วยสร้างหน้าเว็บ (HTML) จากเอกสารที่แนบมา จัดวางประเด็นสำคัญให้อ่านง่าย',
    mindmap:
      'ช่วยสร้างแผนผังความคิดจากเอกสารที่แนบมา วางหัวข้อหลักไว้ตรงกลางและจัดประเด็นสำคัญเป็นกิ่ง',
  },
  id: {
    slides:
      'Buat presentasi dari materi terlampir. Susun poin-poin utama menjadi slide dengan judul yang jelas.',
    html: 'Buat halaman web (HTML) dari materi terlampir. Tata poin-poin utama agar mudah dibaca.',
    mindmap:
      'Buat peta pikiran dari materi terlampir. Letakkan topik utama di tengah dan susun poin-poin penting sebagai cabang.',
  },
  ru: {
    slides:
      'Сделай презентацию по приложенным материалам. Разложи главные мысли по слайдам с понятными заголовками.',
    html: 'Сделай веб-страницу (HTML) по приложенным материалам. Расположи главные мысли так, чтобы их было легко читать.',
    mindmap:
      'Сделай интеллект-карту по приложенным материалам. Помести главную тему в центр, а ключевые мысли оформи ветвями.',
  },
  ar: {
    slides:
      'أنشئ عرضًا تقديميًا من المواد المرفقة. نظّم النقاط الرئيسية في شرائح ذات عناوين واضحة.',
    html: 'أنشئ صفحة ويب (HTML) من المواد المرفقة. رتّب النقاط الرئيسية بحيث تسهل قراءتها.',
    mindmap:
      'أنشئ خريطة ذهنية من المواد المرفقة. ضع الموضوع الرئيسي في المركز ونظّم النقاط الأساسية في فروع.',
  },
  pt: {
    slides:
      'Crie uma apresentação a partir do material anexado. Organize os pontos principais em slides com títulos claros.',
    html: 'Crie uma página web (HTML) a partir do material anexado. Distribua os pontos principais para que fiquem fáceis de ler.',
    mindmap:
      'Crie um mapa mental a partir do material anexado. Coloque o tema principal no centro e organize os pontos-chave como ramos.',
  },
  it: {
    slides:
      'Crea una presentazione dal materiale allegato. Organizza i punti principali in diapositive con titoli chiari.',
    html: 'Crea una pagina web (HTML) dal materiale allegato. Disponi i punti principali in modo che siano facili da leggere.',
    mindmap:
      'Crea una mappa mentale dal materiale allegato. Metti l’argomento principale al centro e organizza i punti chiave come rami.',
  },
  pl: {
    slides:
      'Przygotuj prezentację na podstawie załączonych materiałów. Uporządkuj najważniejsze punkty w slajdy z wyraźnymi tytułami.',
    html: 'Przygotuj stronę internetową (HTML) na podstawie załączonych materiałów. Rozmieść najważniejsze punkty tak, by łatwo się je czytało.',
    mindmap:
      'Przygotuj mapę myśli na podstawie załączonych materiałów. Umieść główny temat w środku, a kluczowe punkty ułóż w gałęzie.',
  },
  cs: {
    slides:
      'Vytvoř prezentaci z přiložených materiálů. Uspořádej hlavní body do snímků s jasnými nadpisy.',
    html: 'Vytvoř webovou stránku (HTML) z přiložených materiálů. Rozvrhni hlavní body tak, aby se dobře četly.',
    mindmap:
      'Vytvoř myšlenkovou mapu z přiložených materiálů. Hlavní téma dej doprostřed a klíčové body uspořádej do větví.',
  },
  nl: {
    slides:
      'Maak een presentatie van het bijgevoegde materiaal. Orden de belangrijkste punten in dia’s met duidelijke titels.',
    html: 'Maak een webpagina (HTML) van het bijgevoegde materiaal. Zet de belangrijkste punten overzichtelijk neer.',
    mindmap:
      'Maak een mindmap van het bijgevoegde materiaal. Zet het hoofdonderwerp in het midden en orden de kernpunten als takken.',
  },
  ms: {
    slides:
      'Buat persembahan daripada bahan yang dilampirkan. Susun isi utama menjadi slaid dengan tajuk yang jelas.',
    html: 'Buat halaman web (HTML) daripada bahan yang dilampirkan. Susun isi utama supaya mudah dibaca.',
    mindmap:
      'Buat peta minda daripada bahan yang dilampirkan. Letakkan topik utama di tengah dan susun isi penting sebagai cabang.',
  },
  he: {
    slides: 'צור מצגת מהחומר המצורף. ארגן את הנקודות העיקריות בשקופיות עם כותרות ברורות.',
    html: 'צור דף אינטרנט (HTML) מהחומר המצורף. סדר את הנקודות העיקריות כך שיהיה קל לקרוא אותן.',
    mindmap: 'צור מפת חשיבה מהחומר המצורף. שים את הנושא המרכזי במרכז וארגן את נקודות המפתח כענפים.',
  },
  hi: {
    slides:
      'संलग्न सामग्री से एक प्रस्तुति बनाइए। मुख्य बातों को स्पष्ट शीर्षकों वाली स्लाइडों में व्यवस्थित कीजिए।',
    html: 'संलग्न सामग्री से एक वेब पेज (HTML) बनाइए। मुख्य बातों को इस तरह रखिए कि उन्हें पढ़ना आसान हो।',
    mindmap:
      'संलग्न सामग्री से एक माइंड मैप बनाइए। मुख्य विषय को बीच में रखिए और प्रमुख बातों को शाखाओं के रूप में व्यवस्थित कीजिए।',
  },
  'zh-TW': {
    slides: '請根據附件資料製作一份簡報。整理出重點，做成標題清楚的投影片。',
    html: '請根據附件資料製作一個網頁（HTML）。把重點排得清楚易讀。',
    mindmap: '請根據附件資料製作一張心智圖。把主題放在中心，用分支整理重點。',
  },
  vi: {
    slides:
      'Hãy tạo một bài thuyết trình từ tài liệu đính kèm. Sắp xếp các ý chính thành các trang chiếu có tiêu đề rõ ràng.',
    html: 'Hãy tạo một trang web (HTML) từ tài liệu đính kèm. Bố trí các ý chính sao cho dễ đọc.',
    mindmap:
      'Hãy tạo một sơ đồ tư duy từ tài liệu đính kèm. Đặt chủ đề chính ở giữa và sắp xếp các ý quan trọng thành các nhánh.',
  },
}

export function defaultGeneratePrompt(lang: Lang, kind: AiTargetKind): string {
  return (DEFAULT_GENERATE_PROMPTS[lang] ?? DEFAULT_GENERATE_PROMPTS.en)[kind]
}
