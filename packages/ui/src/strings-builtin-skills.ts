import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * Names of the skills shipped with the app (apps/shell/resources/builtin-skills).
 * Must match the "name" entries of builtin-skills.json there.
 */
export const BUILTIN_SKILL_NAMES = [
  'meeting-minutes',
  'internal-comms',
  'humanizer',
  'copy-editing',
  'find-skills',
  'administration-report',
  'administration-report-draft',
  'docx',
  'pptx',
  'xlsx',
  'pdf',
  'hwp-document',
  'mindmap',
  'diagram',
  'html-document',
] as const

export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number]

const zh = {
  'builtinSkillDesc.meeting-minutes': '把会议记录整理成列明决定事项和待办事项的会议纪要。',
  'builtinSkillDesc.internal-comms': '撰写公告、内部简报、进展汇报、常见问题解答等组织内部的文字。',
  'builtinSkillDesc.humanizer': '找出文本中带有 AI 痕迹的表达，在不改变内容的前提下改得更自然。',
  'builtinSkillDesc.copy-editing': '把已经写好的英文文本逐遍检查，改得更清楚、更简洁。',
  'builtinSkillDesc.find-skills': '仅在智能体窗口中可用，需要联网，用来查找所需技能并建议安装。',
  'builtinSkillDesc.administration-report':
    '按照韩国行政安全部的指南整理报告：叙述式语句、标准编号、通用字体、简洁的表格。',
  'builtinSkillDesc.administration-report-draft':
    '按行政安全部格式从头撰写行政文书：章节结构、Ⅰ·1·가 编号、叙述式语句、表题与通用字体。',
  'builtinSkillDesc.docx':
    '仅在智能体窗口中可用。运行脚本，在项目文件夹中创建、修改和读取 .docx 文件。这台电脑上需要装有 Python 等程序。',
  'builtinSkillDesc.pptx':
    '仅在智能体窗口中可用。运行脚本，在项目文件夹中创建、修改和读取 .pptx 文件。这台电脑上需要装有 Python 等程序。',
  'builtinSkillDesc.xlsx':
    '仅在智能体窗口中可用。运行脚本，在项目文件夹中创建和修改 .xlsx 文件，并重新计算公式。这台电脑上需要装有 Python 等程序。',
  'builtinSkillDesc.pdf':
    '仅在智能体窗口中可用。运行脚本，在项目文件夹中读取、合并和拆分 .pdf 文件，并填写表单。这台电脑上需要装有 Python 等程序。',
  'builtinSkillDesc.hwp-document':
    '从头撰写 .hwp、.hwpx 文档：按报告、计划、通知、公文、会议记录选定结构，用公文语体撰写，最后进行检查。',
  'builtinSkillDesc.mindmap':
    '根据主题或资料制作思维导图：均衡地设 3 到 7 个主分支，标题简短、说明放在备注里，最后检查结构。',
  'builtinSkillDesc.diagram':
    '绘制清晰易读的图表：选对图表类型，流向保持一个方向，文字简短、颜色少用，并检查重叠和孤立的图形。',
  'builtinSkillDesc.html-document':
    '制作屏幕上好读、打印也整洁的 HTML 文档：先确定读者、篇幅和纸张，再检查分页和内容。',
}

/**
 * One-line description of each built-in skill, shared by the shell (Settings →
 * Skills) and the editors' AI panel skill list; lists show the skill's name
 * itself. Keys are `builtinSkillDesc.<name>`; `zh` defines the key set.
 */
export const BUILTIN_SKILL_STRINGS = defineStrings({
  zh,
  en: {
    'builtinSkillDesc.meeting-minutes':
      'Turns meeting notes into minutes that show the decisions and action items.',
    'builtinSkillDesc.internal-comms':
      'Writes announcements, newsletters, progress updates, FAQs and other internal messages.',
    'builtinSkillDesc.humanizer':
      'Finds phrasing that sounds AI-written and makes it natural without changing what it says.',
    'builtinSkillDesc.copy-editing':
      'Goes over English text you have already written and makes it clearer and tighter.',
    'builtinSkillDesc.find-skills':
      'Works only in the agent window and needs internet access to find skills and suggest installing them.',
    'builtinSkillDesc.administration-report':
      'Brings a report in line with the Ministry of the Interior and Safety guideline: prose, standard numbering, fonts that open anywhere, simple tables.',
    'builtinSkillDesc.administration-report-draft':
      'Writes an administrative report from scratch in the ministry format: sections, the Ⅰ·1·가 numbering, prose, table titles and compatible fonts.',
    'builtinSkillDesc.docx':
      'Works only in the agent window. Runs scripts to create, edit and read .docx files in the project folder. Python and other programs must be installed on this PC.',
    'builtinSkillDesc.pptx':
      'Works only in the agent window. Runs scripts to create, edit and read .pptx files in the project folder. Python and other programs must be installed on this PC.',
    'builtinSkillDesc.xlsx':
      'Works only in the agent window. Runs scripts to create and edit .xlsx files in the project folder and recalculate their formulas. Python and other programs must be installed on this PC.',
    'builtinSkillDesc.pdf':
      'Works only in the agent window. Runs scripts to read, merge and split .pdf files in the project folder and fill in forms. Python and other programs must be installed on this PC.',
    'builtinSkillDesc.hwp-document':
      'Writes a new .hwp or .hwpx document from scratch: picks the parts for a report, plan, notice, official letter or minutes, writes it in document style, and checks it at the end.',
    'builtinSkillDesc.mindmap':
      'Builds a mind map from a topic or material: three to seven balanced main branches, short titles with the detail in notes, and a structure check at the end.',
    'builtinSkillDesc.diagram':
      'Draws a clear diagram: picks the type that fits, keeps one direction, short labels and few colours, and checks for overlaps and loose shapes.',
    'builtinSkillDesc.html-document':
      'Makes an HTML document that reads well on screen and prints cleanly: settles the reader, length and paper first, then checks the pages and the content.',
  },
  ja: {
    'builtinSkillDesc.meeting-minutes':
      '会議のメモを、決定事項とやることが分かる議事録にまとめます。',
    'builtinSkillDesc.internal-comms':
      'お知らせ、社内報、進捗報告、よくある質問など、組織内の文章を書きます。',
    'builtinSkillDesc.humanizer':
      '文章から AI が書いたように見える表現を探し、内容を変えずに自然に直します。',
    'builtinSkillDesc.copy-editing': '書き上げた英語の文章を何度か見直し、より明確で簡潔にします。',
    'builtinSkillDesc.find-skills':
      'エージェントのウィンドウでのみ使え、インターネットにつないで必要なスキルを探し、インストールを提案します。',
    'builtinSkillDesc.administration-report':
      '行政安全部のガイドラインに合わせて報告書を整えます。叙述式の文章、標準の番号、どの環境でも開けるフォント、単純な表。',
    'builtinSkillDesc.administration-report-draft':
      '行政文書を最初から行政安全部の形式で書きます。節構成、Ⅰ・1・가の番号、叙述式の文章、表の題名と通用するフォント。',
    'builtinSkillDesc.docx':
      'エージェントのウィンドウでのみ使えます。スクリプトを実行して、プロジェクトのフォルダーの .docx ファイルを作成・編集・読み取りします。この PC に Python などのプログラムが入っている必要があります。',
    'builtinSkillDesc.pptx':
      'エージェントのウィンドウでのみ使えます。スクリプトを実行して、プロジェクトのフォルダーの .pptx ファイルを作成・編集・読み取りします。この PC に Python などのプログラムが入っている必要があります。',
    'builtinSkillDesc.xlsx':
      'エージェントのウィンドウでのみ使えます。スクリプトを実行して、プロジェクトのフォルダーの .xlsx ファイルを作成・編集し、数式を再計算します。この PC に Python などのプログラムが入っている必要があります。',
    'builtinSkillDesc.pdf':
      'エージェントのウィンドウでのみ使えます。スクリプトを実行して、プロジェクトのフォルダーの .pdf ファイルを読み取り、結合・分割し、フォームに入力します。この PC に Python などのプログラムが入っている必要があります。',
    'builtinSkillDesc.hwp-document':
      '.hwp・.hwpx の文書を最初から書きます。報告書・計画書・案内文・公文書・議事録に合った構成を選び、文書の文体で書き、最後に点検します。',
    'builtinSkillDesc.mindmap':
      'テーマや資料からマインドマップを作ります。主な枝を 3〜7 本でバランスよく取り、タイトルは短く、説明はノートに置き、最後に構成を点検します。',
    'builtinSkillDesc.diagram':
      '読みやすい図を描きます。合った種類を選び、流れは一方向に、文字は短く、色は少なくし、重なりや孤立した図形を点検します。',
    'builtinSkillDesc.html-document':
      '画面で読みやすく、印刷してもきれいな HTML 文書を作ります。読み手・分量・用紙を先に決め、ページ割りと内容を点検します。',
  },
  ko: {
    'builtinSkillDesc.meeting-minutes':
      '회의 메모를 결정 사항과 할 일이 보이는 회의록으로 정리합니다.',
    'builtinSkillDesc.internal-comms':
      '공지, 소식지, 진행 보고, 자주 묻는 질문 같은 조직 안의 글을 씁니다.',
    'builtinSkillDesc.humanizer':
      '글에서 AI가 쓴 티가 나는 표현을 찾아 내용은 그대로 두고 자연스럽게 고칩니다.',
    'builtinSkillDesc.copy-editing':
      '이미 쓴 영어 글을 여러 번 훑으며 더 분명하고 간결하게 다듬습니다.',
    'builtinSkillDesc.find-skills':
      '에이전트 창에서만 쓸 수 있으며, 인터넷에 연결해 필요한 스킬을 찾고 설치를 제안합니다.',
    'builtinSkillDesc.administration-report':
      '행안부 가이드라인에 맞게 보고서를 다듬습니다. 서술식 문장, 표준 번호, 호환 글꼴, 단순한 표.',
    'builtinSkillDesc.administration-report-draft':
      '행안부 형식으로 행정문서를 처음부터 씁니다. 절 구성, Ⅰ·1·가 번호, 서술식 문장, 표 제목과 호환 글꼴.',
    'builtinSkillDesc.docx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .docx 파일을 만들고 고치고 읽습니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.pptx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .pptx 파일을 만들고 고치고 읽습니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.xlsx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .xlsx 파일을 만들고 고치고 수식을 다시 계산합니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.pdf':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .pdf 파일을 읽고 합치고 나누고 양식을 채웁니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.hwp-document':
      '한글 문서(.hwp, .hwpx)를 처음부터 씁니다. 보고서·계획서·안내문·공문·회의록에 맞는 짜임을 고르고, 문서 문체로 쓴 뒤 마지막에 점검합니다.',
    'builtinSkillDesc.mindmap':
      '주제나 자료로 마인드맵을 만듭니다. 큰 가지 3~7개를 고르게 잡고, 제목은 짧게 쓰고 설명은 메모에 두며, 마지막에 짜임을 점검합니다.',
    'builtinSkillDesc.diagram':
      '읽기 쉬운 다이어그램을 그립니다. 알맞은 종류를 고르고, 흐름은 한 방향으로, 글은 짧게, 색은 적게 쓰며, 겹침과 떨어진 도형을 점검합니다.',
    'builtinSkillDesc.html-document':
      '화면에서 읽기 좋고 인쇄해도 깔끔한 HTML 문서를 만듭니다. 읽는 사람·분량·용지를 먼저 정하고, 쪽 나눔과 내용을 점검합니다.',
  },
  fr: {
    'builtinSkillDesc.meeting-minutes':
      'Transforme les notes de réunion en compte rendu qui fait ressortir les décisions et les actions.',
    'builtinSkillDesc.internal-comms':
      'Rédige annonces, lettres d’information, points d’avancement, FAQ et autres messages internes.',
    'builtinSkillDesc.humanizer':
      'Repère les tournures qui sonnent écrites par une IA et les rend naturelles sans changer le sens.',
    'builtinSkillDesc.copy-editing':
      'Relit en plusieurs passes un texte anglais déjà écrit pour le rendre plus clair et plus concis.',
    'builtinSkillDesc.find-skills':
      'Fonctionne uniquement dans la fenêtre Agent et demande une connexion Internet pour trouver des compétences et proposer de les installer.',
    'builtinSkillDesc.administration-report':
      "Aligne un rapport sur la directive du ministère coréen de l'Intérieur : phrases rédigées, numérotation normalisée, polices disponibles partout, tableaux simples.",
    'builtinSkillDesc.administration-report-draft':
      'Rédige un rapport administratif de zéro au format du ministère : sections, numérotation Ⅰ·1·가, phrases rédigées, titres de tableaux et polices disponibles partout.',
    'builtinSkillDesc.docx':
      'Fonctionne uniquement dans la fenêtre Agent. Exécute des scripts pour créer, modifier et lire des fichiers .docx dans le dossier du projet. Python et d’autres programmes doivent être installés sur ce PC.',
    'builtinSkillDesc.pptx':
      'Fonctionne uniquement dans la fenêtre Agent. Exécute des scripts pour créer, modifier et lire des fichiers .pptx dans le dossier du projet. Python et d’autres programmes doivent être installés sur ce PC.',
    'builtinSkillDesc.xlsx':
      'Fonctionne uniquement dans la fenêtre Agent. Exécute des scripts pour créer et modifier des fichiers .xlsx dans le dossier du projet et recalculer leurs formules. Python et d’autres programmes doivent être installés sur ce PC.',
    'builtinSkillDesc.pdf':
      'Fonctionne uniquement dans la fenêtre Agent. Exécute des scripts pour lire, fusionner et diviser des fichiers .pdf dans le dossier du projet et remplir des formulaires. Python et d’autres programmes doivent être installés sur ce PC.',
    'builtinSkillDesc.hwp-document':
      'Rédige un nouveau document .hwp ou .hwpx à partir de zéro : choisit la structure d’un rapport, d’un plan, d’un avis, d’une lettre officielle ou d’un compte rendu, écrit dans le style du document et vérifie le résultat.',
    'builtinSkillDesc.mindmap':
      'Construit une carte mentale à partir d’un sujet ou de documents : trois à sept branches principales équilibrées, des titres courts avec le détail dans les notes, et une vérification de la structure à la fin.',
    'builtinSkillDesc.diagram':
      'Dessine un diagramme clair : choisit le type adapté, garde un seul sens de lecture, des libellés courts et peu de couleurs, puis vérifie les chevauchements et les formes isolées.',
    'builtinSkillDesc.html-document':
      'Crée un document HTML agréable à lire à l’écran et propre à l’impression : fixe d’abord le lecteur, la longueur et le papier, puis vérifie les pages et le contenu.',
  },
  de: {
    'builtinSkillDesc.meeting-minutes':
      'Macht aus Besprechungsnotizen ein Protokoll, das Beschlüsse und Aufgaben zeigt.',
    'builtinSkillDesc.internal-comms':
      'Schreibt Mitteilungen, Newsletter, Statusberichte, FAQs und andere interne Texte.',
    'builtinSkillDesc.humanizer':
      'Findet Formulierungen, die nach KI klingen, und macht sie natürlich, ohne den Inhalt zu ändern.',
    'builtinSkillDesc.copy-editing':
      'Geht einen fertigen englischen Text in mehreren Durchgängen durch und macht ihn klarer und knapper.',
    'builtinSkillDesc.find-skills':
      'Funktioniert nur im Agent-Fenster und braucht Internet, um Skills zu finden und ihre Installation vorzuschlagen.',
    'builtinSkillDesc.administration-report':
      'Bringt einen Bericht auf die Linie der Richtlinie des koreanischen Innenministeriums: Fließtext, einheitliche Nummerierung, überall verfügbare Schriften, einfache Tabellen.',
    'builtinSkillDesc.administration-report-draft':
      'Schreibt einen Verwaltungsbericht von Grund auf im Format des Ministeriums: Abschnitte, Nummerierung Ⅰ·1·가, Fließtext, Tabellenüberschriften und verfügbare Schriften.',
    'builtinSkillDesc.docx':
      'Funktioniert nur im Agent-Fenster. Führt Skripte aus, um .docx-Dateien im Projektordner zu erstellen, zu bearbeiten und zu lesen. Auf diesem PC müssen Python und weitere Programme installiert sein.',
    'builtinSkillDesc.pptx':
      'Funktioniert nur im Agent-Fenster. Führt Skripte aus, um .pptx-Dateien im Projektordner zu erstellen, zu bearbeiten und zu lesen. Auf diesem PC müssen Python und weitere Programme installiert sein.',
    'builtinSkillDesc.xlsx':
      'Funktioniert nur im Agent-Fenster. Führt Skripte aus, um .xlsx-Dateien im Projektordner zu erstellen und zu bearbeiten und ihre Formeln neu zu berechnen. Auf diesem PC müssen Python und weitere Programme installiert sein.',
    'builtinSkillDesc.pdf':
      'Funktioniert nur im Agent-Fenster. Führt Skripte aus, um .pdf-Dateien im Projektordner zu lesen, zusammenzuführen und zu teilen und Formulare auszufüllen. Auf diesem PC müssen Python und weitere Programme installiert sein.',
    'builtinSkillDesc.hwp-document':
      'Schreibt ein neues .hwp- oder .hwpx-Dokument von Grund auf: wählt den Aufbau für Bericht, Plan, Mitteilung, amtliches Schreiben oder Protokoll, schreibt im Dokumentstil und prüft das Ergebnis.',
    'builtinSkillDesc.mindmap':
      'Baut eine Mindmap aus einem Thema oder Material: drei bis sieben ausgewogene Hauptzweige, kurze Titel mit den Details in Notizen und am Ende eine Prüfung der Struktur.',
    'builtinSkillDesc.diagram':
      'Zeichnet ein klares Diagramm: wählt den passenden Typ, hält eine Leserichtung, kurze Beschriftungen und wenige Farben ein und prüft auf Überlappungen und lose Formen.',
    'builtinSkillDesc.html-document':
      'Erstellt ein HTML-Dokument, das sich am Bildschirm gut liest und sauber druckt: legt zuerst Leser, Länge und Papier fest und prüft dann Seiten und Inhalt.',
  },
  es: {
    'builtinSkillDesc.meeting-minutes':
      'Convierte las notas de una reunión en un acta que muestra las decisiones y las tareas.',
    'builtinSkillDesc.internal-comms':
      'Redacta avisos, boletines, informes de avance, preguntas frecuentes y otros textos internos.',
    'builtinSkillDesc.humanizer':
      'Busca las expresiones que suenan escritas por una IA y las vuelve naturales sin cambiar lo que dicen.',
    'builtinSkillDesc.copy-editing':
      'Repasa varias veces un texto en inglés ya escrito para hacerlo más claro y conciso.',
    'builtinSkillDesc.find-skills':
      'Solo funciona en la ventana del agente y necesita internet para buscar habilidades y proponer su instalación.',
    'builtinSkillDesc.administration-report':
      'Ajusta un informe a la guía del Ministerio del Interior y Seguridad de Corea: frases redactadas, numeración estándar, fuentes disponibles en cualquier equipo, tablas sencillas.',
    'builtinSkillDesc.administration-report-draft':
      'Escribe un informe administrativo desde cero con el formato del ministerio: secciones, numeración Ⅰ·1·가, frases redactadas, títulos de tablas y fuentes disponibles.',
    'builtinSkillDesc.docx':
      'Solo funciona en la ventana del agente. Ejecuta scripts para crear, editar y leer archivos .docx en la carpeta del proyecto. Este PC debe tener instalados Python y otros programas.',
    'builtinSkillDesc.pptx':
      'Solo funciona en la ventana del agente. Ejecuta scripts para crear, editar y leer archivos .pptx en la carpeta del proyecto. Este PC debe tener instalados Python y otros programas.',
    'builtinSkillDesc.xlsx':
      'Solo funciona en la ventana del agente. Ejecuta scripts para crear y editar archivos .xlsx en la carpeta del proyecto y recalcular sus fórmulas. Este PC debe tener instalados Python y otros programas.',
    'builtinSkillDesc.pdf':
      'Solo funciona en la ventana del agente. Ejecuta scripts para leer, combinar y dividir archivos .pdf en la carpeta del proyecto y rellenar formularios. Este PC debe tener instalados Python y otros programas.',
    'builtinSkillDesc.hwp-document':
      'Redacta un documento .hwp o .hwpx nuevo desde cero: elige la estructura de un informe, plan, aviso, oficio o acta, escribe en el estilo del documento y revisa el resultado.',
    'builtinSkillDesc.mindmap':
      'Construye un mapa mental a partir de un tema o de materiales: de tres a siete ramas principales equilibradas, títulos cortos con el detalle en las notas y una revisión de la estructura al final.',
    'builtinSkillDesc.diagram':
      'Dibuja un diagrama claro: elige el tipo adecuado, mantiene una sola dirección, etiquetas cortas y pocos colores, y revisa solapamientos y formas sueltas.',
    'builtinSkillDesc.html-document':
      'Crea un documento HTML que se lee bien en pantalla y se imprime limpio: define primero el lector, la extensión y el papel, y luego revisa las páginas y el contenido.',
  },
  th: {
    'builtinSkillDesc.meeting-minutes':
      'เรียบเรียงโน้ตการประชุมเป็นบันทึกการประชุมที่เห็นข้อตัดสินใจและงานที่ต้องทำ',
    'builtinSkillDesc.internal-comms':
      'เขียนประกาศ จดหมายข่าว รายงานความคืบหน้า คำถามที่พบบ่อย และข้อความภายในองค์กรอื่น ๆ',
    'builtinSkillDesc.humanizer':
      'หาสำนวนที่ฟังเหมือน AI เขียน แล้วปรับให้เป็นธรรมชาติโดยไม่เปลี่ยนเนื้อหา',
    'builtinSkillDesc.copy-editing':
      'อ่านทวนข้อความภาษาอังกฤษที่เขียนไว้แล้วหลายรอบ ให้ชัดเจนและกระชับขึ้น',
    'builtinSkillDesc.find-skills':
      'ใช้ได้เฉพาะในหน้าต่างเอเจนต์และต้องต่ออินเทอร์เน็ต เพื่อค้นหาสกิลและเสนอให้ติดตั้ง',
    'builtinSkillDesc.administration-report':
      'ปรับรายงานให้ตรงแนวทางของกระทรวงมหาดไทยและความมั่นคงเกาหลี: ประโยคบรรยาย ลำดับเลขมาตรฐาน ฟอนต์ที่เปิดได้ทุกเครื่อง และตารางเรียบง่าย',
    'builtinSkillDesc.administration-report-draft':
      'เขียนรายงานราชการตั้งแต่ต้นตามรูปแบบกระทรวง: โครง sections ลำดับเลข Ⅰ·1·가 ประโยคบรรยาย หัวตาราง และฟอนต์ที่ใช้ได้ทั่วไป',
    'builtinSkillDesc.docx':
      'ใช้ได้เฉพาะในหน้าต่างเอเจนต์ เรียกใช้สคริปต์เพื่อสร้าง แก้ไข และอ่านไฟล์ .docx ในโฟลเดอร์โปรเจกต์ พีซีเครื่องนี้ต้องติดตั้ง Python และโปรแกรมอื่นไว้',
    'builtinSkillDesc.pptx':
      'ใช้ได้เฉพาะในหน้าต่างเอเจนต์ เรียกใช้สคริปต์เพื่อสร้าง แก้ไข และอ่านไฟล์ .pptx ในโฟลเดอร์โปรเจกต์ พีซีเครื่องนี้ต้องติดตั้ง Python และโปรแกรมอื่นไว้',
    'builtinSkillDesc.xlsx':
      'ใช้ได้เฉพาะในหน้าต่างเอเจนต์ เรียกใช้สคริปต์เพื่อสร้างและแก้ไขไฟล์ .xlsx ในโฟลเดอร์โปรเจกต์ และคำนวณสูตรใหม่ พีซีเครื่องนี้ต้องติดตั้ง Python และโปรแกรมอื่นไว้',
    'builtinSkillDesc.pdf':
      'ใช้ได้เฉพาะในหน้าต่างเอเจนต์ เรียกใช้สคริปต์เพื่ออ่าน รวม และแยกไฟล์ .pdf ในโฟลเดอร์โปรเจกต์ และกรอกแบบฟอร์ม พีซีเครื่องนี้ต้องติดตั้ง Python และโปรแกรมอื่นไว้',
    'builtinSkillDesc.hwp-document':
      'เขียนเอกสาร .hwp หรือ .hwpx ใหม่ตั้งแต่ต้น โดยเลือกโครงสร้างให้เหมาะกับรายงาน แผนงาน ประกาศ หนังสือราชการ หรือรายงานการประชุม เขียนด้วยภาษาเอกสาร แล้วตรวจทานตอนท้าย',
    'builtinSkillDesc.mindmap':
      'สร้างแผนผังความคิดจากหัวข้อหรือเอกสาร โดยวางกิ่งหลัก 3 ถึง 7 กิ่งให้สมดุล ตั้งชื่อหัวข้อสั้น ๆ ใส่รายละเอียดไว้ในบันทึก แล้วตรวจโครงสร้างตอนท้าย',
    'builtinSkillDesc.diagram':
      'วาดแผนภาพที่อ่านง่าย โดยเลือกชนิดให้เหมาะ ให้ทิศทางไหลไปทางเดียว ใช้ข้อความสั้นและสีน้อย แล้วตรวจการซ้อนทับและรูปร่างที่ไม่ได้เชื่อมต่อ',
    'builtinSkillDesc.html-document':
      'สร้างเอกสาร HTML ที่อ่านง่ายบนจอและพิมพ์ออกมาเรียบร้อย โดยกำหนดผู้อ่าน ความยาว และกระดาษก่อน แล้วตรวจการแบ่งหน้าและเนื้อหา',
  },
  id: {
    'builtinSkillDesc.meeting-minutes':
      'Mengubah catatan rapat menjadi notulen yang menampilkan keputusan dan tugas tindak lanjut.',
    'builtinSkillDesc.internal-comms':
      'Menulis pengumuman, buletin, laporan kemajuan, FAQ, dan pesan internal lainnya.',
    'builtinSkillDesc.humanizer':
      'Mencari ungkapan yang terdengar ditulis AI dan membuatnya wajar tanpa mengubah isinya.',
    'builtinSkillDesc.copy-editing':
      'Memeriksa ulang teks bahasa Inggris yang sudah ditulis beberapa kali agar lebih jelas dan ringkas.',
    'builtinSkillDesc.find-skills':
      'Hanya berfungsi di jendela agen dan memerlukan internet untuk mencari skill serta mengusulkan pemasangannya.',
    'builtinSkillDesc.administration-report':
      'Menyesuaikan laporan dengan pedoman Kementerian Dalam Negeri dan Keamanan Korea: kalimat naratif, penomoran baku, font yang tersedia di mana saja, tabel sederhana.',
    'builtinSkillDesc.administration-report-draft':
      'Menulis laporan administrasi dari nol dengan format kementerian: bagian, penomoran Ⅰ·1·가, kalimat naratif, judul tabel, dan font yang tersedia.',
    'builtinSkillDesc.docx':
      'Hanya berfungsi di jendela agen. Menjalankan skrip untuk membuat, mengedit, dan membaca file .docx di folder proyek. Python dan program lain harus terpasang di PC ini.',
    'builtinSkillDesc.pptx':
      'Hanya berfungsi di jendela agen. Menjalankan skrip untuk membuat, mengedit, dan membaca file .pptx di folder proyek. Python dan program lain harus terpasang di PC ini.',
    'builtinSkillDesc.xlsx':
      'Hanya berfungsi di jendela agen. Menjalankan skrip untuk membuat dan mengedit file .xlsx di folder proyek serta menghitung ulang rumusnya. Python dan program lain harus terpasang di PC ini.',
    'builtinSkillDesc.pdf':
      'Hanya berfungsi di jendela agen. Menjalankan skrip untuk membaca, menggabungkan, dan memisahkan file .pdf di folder proyek serta mengisi formulir. Python dan program lain harus terpasang di PC ini.',
    'builtinSkillDesc.hwp-document':
      'Menulis dokumen .hwp atau .hwpx baru dari awal: memilih susunan untuk laporan, rencana, pengumuman, surat resmi, atau notulen, menulis dengan gaya dokumen, lalu memeriksa hasilnya.',
    'builtinSkillDesc.mindmap':
      'Menyusun peta pikiran dari topik atau bahan: tiga sampai tujuh cabang utama yang seimbang, judul singkat dengan rincian di catatan, dan pemeriksaan struktur di akhir.',
    'builtinSkillDesc.diagram':
      'Menggambar diagram yang jelas: memilih jenis yang sesuai, menjaga satu arah alur, label singkat dan sedikit warna, lalu memeriksa tumpang-tindih dan bentuk yang lepas.',
    'builtinSkillDesc.html-document':
      'Membuat dokumen HTML yang enak dibaca di layar dan rapi saat dicetak: menetapkan pembaca, panjang, dan kertas lebih dulu, lalu memeriksa halaman dan isinya.',
  },
  ru: {
    'builtinSkillDesc.meeting-minutes':
      'Превращает заметки со встречи в протокол, где видны решения и задачи.',
    'builtinSkillDesc.internal-comms':
      'Пишет объявления, рассылки, отчёты о ходе работ, ответы на частые вопросы и другие внутренние тексты.',
    'builtinSkillDesc.humanizer':
      'Находит обороты, похожие на написанные ИИ, и делает их естественными, не меняя смысла.',
    'builtinSkillDesc.copy-editing':
      'Несколько раз проходит по готовому английскому тексту и делает его яснее и короче.',
    'builtinSkillDesc.find-skills':
      'Работает только в окне агента и требует интернета, чтобы найти навыки и предложить их установить.',
    'builtinSkillDesc.administration-report':
      'Приводит отчёт в соответствие с руководством Министерства внутренних дел Кореи: связные предложения, единая нумерация, доступные шрифты, простые таблицы.',
    'builtinSkillDesc.administration-report-draft':
      'Пишет административный отчёт с нуля в формате министерства: разделы, нумерация Ⅰ·1·가, связные предложения, заголовки таблиц и доступные шрифты.',
    'builtinSkillDesc.docx':
      'Работает только в окне агента. Запускает скрипты, чтобы создавать, изменять и читать файлы .docx в папке проекта. На этом компьютере должны быть установлены Python и другие программы.',
    'builtinSkillDesc.pptx':
      'Работает только в окне агента. Запускает скрипты, чтобы создавать, изменять и читать файлы .pptx в папке проекта. На этом компьютере должны быть установлены Python и другие программы.',
    'builtinSkillDesc.xlsx':
      'Работает только в окне агента. Запускает скрипты, чтобы создавать и изменять файлы .xlsx в папке проекта и пересчитывать формулы. На этом компьютере должны быть установлены Python и другие программы.',
    'builtinSkillDesc.pdf':
      'Работает только в окне агента. Запускает скрипты, чтобы читать, объединять и разделять файлы .pdf в папке проекта и заполнять формы. На этом компьютере должны быть установлены Python и другие программы.',
    'builtinSkillDesc.hwp-document':
      'Пишет новый документ .hwp или .hwpx с нуля: выбирает структуру для отчёта, плана, объявления, официального письма или протокола, пишет в стиле документа и проверяет результат.',
    'builtinSkillDesc.mindmap':
      'Строит интеллект-карту по теме или материалам: от трёх до семи уравновешенных главных ветвей, короткие заголовки с подробностями в заметках и проверка структуры в конце.',
    'builtinSkillDesc.diagram':
      'Рисует понятную диаграмму: выбирает подходящий тип, держит одно направление, короткие подписи и мало цветов, проверяет наложения и несвязанные фигуры.',
    'builtinSkillDesc.html-document':
      'Создаёт HTML-документ, который удобно читать на экране и аккуратно печатать: сначала определяет читателя, объём и бумагу, затем проверяет страницы и содержание.',
  },
  ar: {
    'builtinSkillDesc.meeting-minutes':
      'يحوّل ملاحظات الاجتماع إلى محضر يبيّن القرارات والمهام المطلوبة.',
    'builtinSkillDesc.internal-comms':
      'يكتب الإعلانات والنشرات وتقارير التقدّم والأسئلة الشائعة وغيرها من الرسائل الداخلية.',
    'builtinSkillDesc.humanizer':
      'يبحث عن العبارات التي تبدو مكتوبة بالذكاء الاصطناعي ويجعلها طبيعية دون تغيير معناها.',
    'builtinSkillDesc.copy-editing': 'يراجع نصًا إنجليزيًا مكتوبًا عدة مرات ليجعله أوضح وأوجز.',
    'builtinSkillDesc.find-skills':
      'يعمل في نافذة الوكيل فقط ويحتاج إلى الإنترنت للبحث عن المهارات واقتراح تثبيتها.',
    'builtinSkillDesc.administration-report':
      'يضبط التقرير وفق إرشادات وزارة الداخلية والسلامة الكورية: جمل سردية، ترقيم موحد، خطوط متوفرة في أي جهاز، وجداول بسيطة.',
    'builtinSkillDesc.administration-report-draft':
      'يكتب تقريراً إدارياً من الصفر بصيغة الوزارة: الأقسام، ترقيم Ⅰ·1·가، جمل سردية، عناوين الجداول وخطوط متوفرة.',
    'builtinSkillDesc.docx':
      'يعمل في نافذة الوكيل فقط. يشغّل نصوصًا برمجية لإنشاء ملفات .docx في مجلد المشروع وتعديلها وقراءتها. يجب أن يكون Python وبرامج أخرى مثبتة على هذا الكمبيوتر.',
    'builtinSkillDesc.pptx':
      'يعمل في نافذة الوكيل فقط. يشغّل نصوصًا برمجية لإنشاء ملفات .pptx في مجلد المشروع وتعديلها وقراءتها. يجب أن يكون Python وبرامج أخرى مثبتة على هذا الكمبيوتر.',
    'builtinSkillDesc.xlsx':
      'يعمل في نافذة الوكيل فقط. يشغّل نصوصًا برمجية لإنشاء ملفات .xlsx في مجلد المشروع وتعديلها وإعادة حساب صيغها. يجب أن يكون Python وبرامج أخرى مثبتة على هذا الكمبيوتر.',
    'builtinSkillDesc.pdf':
      'يعمل في نافذة الوكيل فقط. يشغّل نصوصًا برمجية لقراءة ملفات .pdf في مجلد المشروع ودمجها وتقسيمها وتعبئة النماذج. يجب أن يكون Python وبرامج أخرى مثبتة على هذا الكمبيوتر.',
    'builtinSkillDesc.hwp-document':
      'يكتب مستند .hwp أو .hwpx جديدًا من البداية: يختار بنية التقرير أو الخطة أو الإعلان أو الخطاب الرسمي أو محضر الاجتماع، ويكتب بأسلوب المستندات، ثم يراجع النتيجة.',
    'builtinSkillDesc.mindmap':
      'ينشئ خريطة ذهنية من موضوع أو مواد: من ثلاثة إلى سبعة فروع رئيسية متوازنة، وعناوين قصيرة مع وضع التفاصيل في الملاحظات، ثم يراجع البنية في النهاية.',
    'builtinSkillDesc.diagram':
      'يرسم مخططًا واضحًا: يختار النوع المناسب، ويحافظ على اتجاه واحد وتسميات قصيرة وألوان قليلة، ثم يتحقق من التداخل والأشكال غير الموصولة.',
    'builtinSkillDesc.html-document':
      'ينشئ مستند HTML سهل القراءة على الشاشة ومرتبًا عند الطباعة: يحدد القارئ والطول والورق أولًا، ثم يراجع الصفحات والمحتوى.',
  },
  pt: {
    'builtinSkillDesc.meeting-minutes':
      'Transforma anotações de reunião em uma ata que mostra as decisões e as tarefas.',
    'builtinSkillDesc.internal-comms':
      'Escreve avisos, boletins, relatórios de andamento, perguntas frequentes e outros textos internos.',
    'builtinSkillDesc.humanizer':
      'Encontra as expressões que parecem escritas por IA e as deixa naturais sem mudar o que dizem.',
    'builtinSkillDesc.copy-editing':
      'Revê em várias passadas um texto em inglês já escrito para deixá-lo mais claro e conciso.',
    'builtinSkillDesc.find-skills':
      'Funciona só na janela do agente e precisa de internet para encontrar habilidades e sugerir a instalação.',
    'builtinSkillDesc.administration-report':
      'Alinha um relatório à diretriz do Ministério do Interior e Segurança da Coreia: frases corridas, numeração padrão, fontes disponíveis em qualquer PC, tabelas simples.',
    'builtinSkillDesc.administration-report-draft':
      'Escreve um relatório administrativo do zero no formato do ministério: seções, numeração Ⅰ·1·가, frases corridas, títulos de tabelas e fontes disponíveis.',
    'builtinSkillDesc.docx':
      'Funciona só na janela do agente. Executa scripts para criar, editar e ler arquivos .docx na pasta do projeto. Este PC precisa ter o Python e outros programas instalados.',
    'builtinSkillDesc.pptx':
      'Funciona só na janela do agente. Executa scripts para criar, editar e ler arquivos .pptx na pasta do projeto. Este PC precisa ter o Python e outros programas instalados.',
    'builtinSkillDesc.xlsx':
      'Funciona só na janela do agente. Executa scripts para criar e editar arquivos .xlsx na pasta do projeto e recalcular as fórmulas. Este PC precisa ter o Python e outros programas instalados.',
    'builtinSkillDesc.pdf':
      'Funciona só na janela do agente. Executa scripts para ler, juntar e dividir arquivos .pdf na pasta do projeto e preencher formulários. Este PC precisa ter o Python e outros programas instalados.',
    'builtinSkillDesc.hwp-document':
      'Escreve um novo documento .hwp ou .hwpx do zero: escolhe a estrutura de relatório, plano, aviso, ofício ou ata, escreve no estilo do documento e confere o resultado.',
    'builtinSkillDesc.mindmap':
      'Monta um mapa mental a partir de um tema ou de materiais: de três a sete ramos principais equilibrados, títulos curtos com o detalhe nas notas e uma conferência da estrutura no final.',
    'builtinSkillDesc.diagram':
      'Desenha um diagrama claro: escolhe o tipo adequado, mantém uma só direção, rótulos curtos e poucas cores, e confere sobreposições e formas soltas.',
    'builtinSkillDesc.html-document':
      'Cria um documento HTML bom de ler na tela e limpo na impressão: define primeiro o leitor, o tamanho e o papel, depois confere as páginas e o conteúdo.',
  },
  it: {
    'builtinSkillDesc.meeting-minutes':
      'Trasforma gli appunti di una riunione in un verbale che mostra decisioni e attività.',
    'builtinSkillDesc.internal-comms':
      'Scrive avvisi, newsletter, aggiornamenti sull’avanzamento, FAQ e altri testi interni.',
    'builtinSkillDesc.humanizer':
      'Trova le espressioni che sembrano scritte da un’IA e le rende naturali senza cambiarne il senso.',
    'builtinSkillDesc.copy-editing':
      'Rilegge più volte un testo in inglese già scritto per renderlo più chiaro e conciso.',
    'builtinSkillDesc.find-skills':
      'Funziona solo nella finestra dell’agente e richiede internet per trovare abilità e proporne l’installazione.',
    'builtinSkillDesc.administration-report':
      "Allinea una relazione alle linee guida del Ministero dell'Interno coreano: frasi discorsive, numerazione standard, caratteri disponibili ovunque, tabelle semplici.",
    'builtinSkillDesc.administration-report-draft':
      'Scrive una relazione amministrativa da zero nel formato del ministero: sezioni, numerazione Ⅰ·1·가, frasi discorsive, titoli delle tabelle e caratteri disponibili.',
    'builtinSkillDesc.docx':
      'Funziona solo nella finestra dell’agente. Esegue script per creare, modificare e leggere file .docx nella cartella del progetto. Su questo PC devono essere installati Python e altri programmi.',
    'builtinSkillDesc.pptx':
      'Funziona solo nella finestra dell’agente. Esegue script per creare, modificare e leggere file .pptx nella cartella del progetto. Su questo PC devono essere installati Python e altri programmi.',
    'builtinSkillDesc.xlsx':
      'Funziona solo nella finestra dell’agente. Esegue script per creare e modificare file .xlsx nella cartella del progetto e ricalcolarne le formule. Su questo PC devono essere installati Python e altri programmi.',
    'builtinSkillDesc.pdf':
      'Funziona solo nella finestra dell’agente. Esegue script per leggere, unire e dividere file .pdf nella cartella del progetto e compilare moduli. Su questo PC devono essere installati Python e altri programmi.',
    'builtinSkillDesc.hwp-document':
      'Scrive da zero un nuovo documento .hwp o .hwpx: sceglie la struttura per relazione, piano, avviso, lettera ufficiale o verbale, scrive nello stile del documento e controlla il risultato.',
    'builtinSkillDesc.mindmap':
      'Costruisce una mappa mentale da un argomento o da materiali: da tre a sette rami principali equilibrati, titoli brevi con i dettagli nelle note e un controllo della struttura alla fine.',
    'builtinSkillDesc.diagram':
      'Disegna un diagramma chiaro: sceglie il tipo adatto, mantiene una sola direzione, etichette brevi e pochi colori, e controlla sovrapposizioni e forme isolate.',
    'builtinSkillDesc.html-document':
      'Crea un documento HTML piacevole da leggere a schermo e pulito in stampa: stabilisce prima lettore, lunghezza e carta, poi controlla le pagine e il contenuto.',
  },
  pl: {
    'builtinSkillDesc.meeting-minutes':
      'Zamienia notatki ze spotkania w protokół, w którym widać decyzje i zadania.',
    'builtinSkillDesc.internal-comms':
      'Pisze ogłoszenia, biuletyny, raporty z postępów, FAQ i inne teksty wewnętrzne.',
    'builtinSkillDesc.humanizer':
      'Wyszukuje sformułowania brzmiące jak pisane przez AI i czyni je naturalnymi bez zmiany treści.',
    'builtinSkillDesc.copy-editing':
      'Kilka razy przechodzi przez gotowy tekst angielski, by był jaśniejszy i zwięźlejszy.',
    'builtinSkillDesc.find-skills':
      'Działa tylko w oknie agenta i wymaga internetu, aby znaleźć umiejętności i zaproponować ich instalację.',
    'builtinSkillDesc.administration-report':
      'Dopasowuje raport do wytycznych koreańskiego ministerstwa spraw wewnętrznych: zdania opisowe, stała numeracja, czcionki dostępne wszędzie, proste tabele.',
    'builtinSkillDesc.administration-report-draft':
      'Pisze raport administracyjny od zera w formacie ministerstwa: sekcje, numeracja Ⅰ·1·가, zdania opisowe, tytuły tabel i dostępne czcionki.',
    'builtinSkillDesc.docx':
      'Działa tylko w oknie agenta. Uruchamia skrypty, aby tworzyć, edytować i odczytywać pliki .docx w folderze projektu. Na tym komputerze muszą być zainstalowane Python i inne programy.',
    'builtinSkillDesc.pptx':
      'Działa tylko w oknie agenta. Uruchamia skrypty, aby tworzyć, edytować i odczytywać pliki .pptx w folderze projektu. Na tym komputerze muszą być zainstalowane Python i inne programy.',
    'builtinSkillDesc.xlsx':
      'Działa tylko w oknie agenta. Uruchamia skrypty, aby tworzyć i edytować pliki .xlsx w folderze projektu oraz przeliczać formuły. Na tym komputerze muszą być zainstalowane Python i inne programy.',
    'builtinSkillDesc.pdf':
      'Działa tylko w oknie agenta. Uruchamia skrypty, aby odczytywać, scalać i dzielić pliki .pdf w folderze projektu oraz wypełniać formularze. Na tym komputerze muszą być zainstalowane Python i inne programy.',
    'builtinSkillDesc.hwp-document':
      'Pisze od zera nowy dokument .hwp lub .hwpx: dobiera układ raportu, planu, ogłoszenia, pisma urzędowego lub protokołu, pisze stylem dokumentu i sprawdza wynik.',
    'builtinSkillDesc.mindmap':
      'Buduje mapę myśli z tematu lub materiałów: od trzech do siedmiu zrównoważonych głównych gałęzi, krótkie tytuły ze szczegółami w notatkach i sprawdzenie struktury na końcu.',
    'builtinSkillDesc.diagram':
      'Rysuje czytelny diagram: dobiera właściwy typ, trzyma jeden kierunek, krótkie etykiety i niewiele kolorów, a potem sprawdza nakładanie się i luźne kształty.',
    'builtinSkillDesc.html-document':
      'Tworzy dokument HTML, który dobrze się czyta na ekranie i czysto drukuje: najpierw ustala czytelnika, długość i papier, potem sprawdza strony i treść.',
  },
  cs: {
    'builtinSkillDesc.meeting-minutes':
      'Udělá z poznámek z porady zápis, ve kterém jsou vidět rozhodnutí a úkoly.',
    'builtinSkillDesc.internal-comms':
      'Píše oznámení, zpravodaje, zprávy o postupu, časté dotazy a další interní texty.',
    'builtinSkillDesc.humanizer':
      'Najde obraty, které působí jako psané AI, a upraví je přirozeně bez změny obsahu.',
    'builtinSkillDesc.copy-editing':
      'Projde hotový anglický text v několika krocích a udělá ho jasnějším a stručnějším.',
    'builtinSkillDesc.find-skills':
      'Funguje jen v okně agenta a potřebuje internet, aby našel dovednosti a navrhl jejich instalaci.',
    'builtinSkillDesc.administration-report':
      'Uvede zprávu do souladu se směrnicí korejského ministerstva vnitra: souvislé věty, jednotné číslování, dostupné písmo, jednoduché tabulky.',
    'builtinSkillDesc.administration-report-draft':
      'Píše správní zprávu od začátku ve formátu ministerstva: oddíly, číslování Ⅰ·1·가, souvislé věty, názvy tabulek a dostupné písmo.',
    'builtinSkillDesc.docx':
      'Funguje jen v okně agenta. Spouští skripty, které vytvářejí, upravují a čtou soubory .docx ve složce projektu. Na tomto počítači musí být nainstalován Python a další programy.',
    'builtinSkillDesc.pptx':
      'Funguje jen v okně agenta. Spouští skripty, které vytvářejí, upravují a čtou soubory .pptx ve složce projektu. Na tomto počítači musí být nainstalován Python a další programy.',
    'builtinSkillDesc.xlsx':
      'Funguje jen v okně agenta. Spouští skripty, které vytvářejí a upravují soubory .xlsx ve složce projektu a přepočítávají vzorce. Na tomto počítači musí být nainstalován Python a další programy.',
    'builtinSkillDesc.pdf':
      'Funguje jen v okně agenta. Spouští skripty, které čtou, slučují a dělí soubory .pdf ve složce projektu a vyplňují formuláře. Na tomto počítači musí být nainstalován Python a další programy.',
    'builtinSkillDesc.hwp-document':
      'Napíše od začátku nový dokument .hwp nebo .hwpx: zvolí stavbu zprávy, plánu, oznámení, úředního dopisu nebo zápisu, píše stylem dokumentu a výsledek zkontroluje.',
    'builtinSkillDesc.mindmap':
      'Sestaví myšlenkovou mapu z tématu nebo podkladů: tři až sedm vyvážených hlavních větví, krátké názvy s podrobnostmi v poznámkách a na konci kontrola struktury.',
    'builtinSkillDesc.diagram':
      'Nakreslí přehledný diagram: zvolí vhodný typ, drží jeden směr, krátké popisky a málo barev a zkontroluje překryvy a nepřipojené tvary.',
    'builtinSkillDesc.html-document':
      'Vytvoří dokument HTML, který se dobře čte na obrazovce a čistě tiskne: nejdřív určí čtenáře, rozsah a papír, potom zkontroluje stránky a obsah.',
  },
  nl: {
    'builtinSkillDesc.meeting-minutes':
      'Maakt van vergaderaantekeningen notulen waarin besluiten en actiepunten zichtbaar zijn.',
    'builtinSkillDesc.internal-comms':
      'Schrijft mededelingen, nieuwsbrieven, voortgangsrapporten, veelgestelde vragen en andere interne berichten.',
    'builtinSkillDesc.humanizer':
      'Zoekt formuleringen die naar AI klinken en maakt ze natuurlijk zonder de inhoud te veranderen.',
    'builtinSkillDesc.copy-editing':
      'Loopt een geschreven Engelse tekst een paar keer na en maakt hem duidelijker en bondiger.',
    'builtinSkillDesc.find-skills':
      'Werkt alleen in het agentvenster en heeft internet nodig om vaardigheden te vinden en installatie voor te stellen.',
    'builtinSkillDesc.administration-report':
      'Brengt een rapport in lijn met de richtlijn van het Koreaanse ministerie van Binnenlandse Zaken: lopende tekst, vaste nummering, overal beschikbare lettertypen, eenvoudige tabellen.',
    'builtinSkillDesc.administration-report-draft':
      'Schrijft een bestuurlijk rapport vanaf nul in het formaat van het ministerie: secties, nummering Ⅰ·1·가, lopende tekst, tabelkoppen en overal beschikbare lettertypen.',
    'builtinSkillDesc.docx':
      'Werkt alleen in het agentvenster. Voert scripts uit om .docx-bestanden in de projectmap te maken, te bewerken en te lezen. Op deze pc moeten Python en andere programma’s zijn geïnstalleerd.',
    'builtinSkillDesc.pptx':
      'Werkt alleen in het agentvenster. Voert scripts uit om .pptx-bestanden in de projectmap te maken, te bewerken en te lezen. Op deze pc moeten Python en andere programma’s zijn geïnstalleerd.',
    'builtinSkillDesc.xlsx':
      'Werkt alleen in het agentvenster. Voert scripts uit om .xlsx-bestanden in de projectmap te maken en te bewerken en de formules opnieuw te berekenen. Op deze pc moeten Python en andere programma’s zijn geïnstalleerd.',
    'builtinSkillDesc.pdf':
      'Werkt alleen in het agentvenster. Voert scripts uit om .pdf-bestanden in de projectmap te lezen, samen te voegen en te splitsen en formulieren in te vullen. Op deze pc moeten Python en andere programma’s zijn geïnstalleerd.',
    'builtinSkillDesc.hwp-document':
      'Schrijft een nieuw .hwp- of .hwpx-document vanaf nul: kiest de opbouw voor een rapport, plan, mededeling, officiële brief of notulen, schrijft in documentstijl en controleert het resultaat.',
    'builtinSkillDesc.mindmap':
      'Bouwt een mindmap uit een onderwerp of materiaal: drie tot zeven evenwichtige hoofdtakken, korte titels met de details in notities en aan het eind een controle van de structuur.',
    'builtinSkillDesc.diagram':
      'Tekent een duidelijk diagram: kiest het passende type, houdt één richting aan, korte labels en weinig kleuren, en controleert op overlappingen en losse vormen.',
    'builtinSkillDesc.html-document':
      'Maakt een HTML-document dat prettig leest op het scherm en netjes afdrukt: legt eerst lezer, lengte en papier vast en controleert daarna de pagina’s en de inhoud.',
  },
  ms: {
    'builtinSkillDesc.meeting-minutes':
      'Menyusun nota mesyuarat menjadi minit yang menunjukkan keputusan dan tindakan susulan.',
    'builtinSkillDesc.internal-comms':
      'Menulis pengumuman, buletin, laporan kemajuan, soalan lazim dan mesej dalaman lain.',
    'builtinSkillDesc.humanizer':
      'Mencari ungkapan yang berbunyi seperti ditulis AI dan menjadikannya semula jadi tanpa mengubah maksud.',
    'builtinSkillDesc.copy-editing':
      'Menyemak teks bahasa Inggeris yang sudah ditulis beberapa kali supaya lebih jelas dan ringkas.',
    'builtinSkillDesc.find-skills':
      'Hanya berfungsi dalam tetingkap ejen dan memerlukan internet untuk mencari kemahiran serta mencadangkan pemasangannya.',
    'builtinSkillDesc.administration-report':
      'Menyesuaikan laporan dengan garis panduan Kementerian Dalam Negeri dan Keselamatan Korea: ayat naratif, penomboran piawai, fon yang ada di mana-mana, jadual ringkas.',
    'builtinSkillDesc.administration-report-draft':
      'Menulis laporan pentadbiran dari awal mengikut format kementerian: bahagian, penomboran Ⅰ·1·가, ayat naratif, tajuk jadual dan fon yang tersedia.',
    'builtinSkillDesc.docx':
      'Hanya berfungsi dalam tetingkap ejen. Menjalankan skrip untuk mencipta, mengedit dan membaca fail .docx dalam folder projek. Python dan program lain mesti dipasang pada PC ini.',
    'builtinSkillDesc.pptx':
      'Hanya berfungsi dalam tetingkap ejen. Menjalankan skrip untuk mencipta, mengedit dan membaca fail .pptx dalam folder projek. Python dan program lain mesti dipasang pada PC ini.',
    'builtinSkillDesc.xlsx':
      'Hanya berfungsi dalam tetingkap ejen. Menjalankan skrip untuk mencipta dan mengedit fail .xlsx dalam folder projek serta mengira semula formulanya. Python dan program lain mesti dipasang pada PC ini.',
    'builtinSkillDesc.pdf':
      'Hanya berfungsi dalam tetingkap ejen. Menjalankan skrip untuk membaca, menggabungkan dan memisahkan fail .pdf dalam folder projek serta mengisi borang. Python dan program lain mesti dipasang pada PC ini.',
    'builtinSkillDesc.hwp-document':
      'Menulis dokumen .hwp atau .hwpx baharu dari awal: memilih susunan untuk laporan, rancangan, notis, surat rasmi atau minit mesyuarat, menulis dalam gaya dokumen, kemudian menyemak hasilnya.',
    'builtinSkillDesc.mindmap':
      'Membina peta minda daripada topik atau bahan: tiga hingga tujuh cabang utama yang seimbang, tajuk ringkas dengan butiran dalam nota, dan semakan struktur pada akhirnya.',
    'builtinSkillDesc.diagram':
      'Melukis rajah yang jelas: memilih jenis yang sesuai, mengekalkan satu arah aliran, label ringkas dan sedikit warna, kemudian menyemak pertindihan dan bentuk yang terlepas.',
    'builtinSkillDesc.html-document':
      'Membuat dokumen HTML yang selesa dibaca pada skrin dan kemas apabila dicetak: menetapkan pembaca, panjang dan kertas dahulu, kemudian menyemak halaman dan kandungannya.',
  },
  he: {
    'builtinSkillDesc.meeting-minutes': 'הופך רשימות מפגישה לסיכום שמציג את ההחלטות ואת המשימות.',
    'builtinSkillDesc.internal-comms':
      'כותב הודעות, עלוני מידע, דיווחי התקדמות, שאלות נפוצות ושאר טקסטים פנימיים.',
    'builtinSkillDesc.humanizer':
      'מאתר ניסוחים שנשמעים כאילו AI כתב אותם והופך אותם לטבעיים בלי לשנות את התוכן.',
    'builtinSkillDesc.copy-editing':
      'עובר כמה פעמים על טקסט באנגלית שכבר נכתב והופך אותו לבהיר ולתמציתי יותר.',
    'builtinSkillDesc.find-skills':
      'פועל רק בחלון הסוכן ודורש אינטרנט כדי למצוא מיומנויות ולהציע להתקין אותן.',
    'builtinSkillDesc.administration-report':
      'מתאים דוח להנחיות משרד הפנים והביטחון של קוריאה: משפטים רצופים, מספור אחיד, גופנים זמינים בכל מחשב וטבלאות פשוטות.',
    'builtinSkillDesc.administration-report-draft':
      'כותב דוח מנהלי מאפס בפורמט של המשרד: סעיפים, מספור Ⅰ·1·가, משפטים רצופים, כותרות טבלאות וגופנים זמינים.',
    'builtinSkillDesc.docx':
      'פועל רק בחלון הסוכן. מריץ סקריפטים כדי ליצור, לערוך ולקרוא קובצי .docx בתיקיית הפרויקט. Python ותוכנות נוספות צריכות להיות מותקנות במחשב הזה.',
    'builtinSkillDesc.pptx':
      'פועל רק בחלון הסוכן. מריץ סקריפטים כדי ליצור, לערוך ולקרוא קובצי .pptx בתיקיית הפרויקט. Python ותוכנות נוספות צריכות להיות מותקנות במחשב הזה.',
    'builtinSkillDesc.xlsx':
      'פועל רק בחלון הסוכן. מריץ סקריפטים כדי ליצור ולערוך קובצי .xlsx בתיקיית הפרויקט ולחשב מחדש את הנוסחאות. Python ותוכנות נוספות צריכות להיות מותקנות במחשב הזה.',
    'builtinSkillDesc.pdf':
      'פועל רק בחלון הסוכן. מריץ סקריפטים כדי לקרוא, למזג ולפצל קובצי .pdf בתיקיית הפרויקט ולמלא טפסים. Python ותוכנות נוספות צריכות להיות מותקנות במחשב הזה.',
    'builtinSkillDesc.hwp-document':
      'כותב מסמך .hwp או .hwpx חדש מאפס: בוחר מבנה לדוח, לתוכנית, להודעה, למכתב רשמי או לפרוטוקול, כותב בסגנון של מסמך ובודק את התוצאה.',
    'builtinSkillDesc.mindmap':
      'בונה מפת חשיבה מנושא או מחומרים: שלושה עד שבעה ענפים ראשיים מאוזנים, כותרות קצרות עם הפירוט בהערות, ובדיקת המבנה בסוף.',
    'builtinSkillDesc.diagram':
      'משרטט תרשים ברור: בוחר את הסוג המתאים, שומר על כיוון אחד, תוויות קצרות ומעט צבעים, ובודק חפיפות וצורות שאינן מחוברות.',
    'builtinSkillDesc.html-document':
      'יוצר מסמך HTML שנוח לקרוא על המסך ונקי בהדפסה: קובע קודם את הקורא, האורך והנייר, ואז בודק את העמודים והתוכן.',
  },
  hi: {
    'builtinSkillDesc.meeting-minutes':
      'बैठक के नोट्स को ऐसे कार्यवृत्त में बदलता है जिसमें निर्णय और करने के काम साफ़ दिखें।',
    'builtinSkillDesc.internal-comms':
      'सूचनाएँ, न्यूज़लेटर, प्रगति रिपोर्ट, सामान्य प्रश्न और दूसरे आंतरिक संदेश लिखता है।',
    'builtinSkillDesc.humanizer':
      'AI के लिखे जैसे लगने वाले वाक्यांश ढूँढता है और अर्थ बदले बिना उन्हें स्वाभाविक बनाता है।',
    'builtinSkillDesc.copy-editing':
      'पहले से लिखे अंग्रेज़ी पाठ को कई बार जाँचकर उसे ज़्यादा साफ़ और संक्षिप्त बनाता है।',
    'builtinSkillDesc.find-skills':
      'केवल एजेंट विंडो में काम करता है और कौशल खोजने व उन्हें इंस्टॉल करने का सुझाव देने के लिए इंटरनेट चाहिए।',
    'builtinSkillDesc.administration-report':
      'रिपोर्ट को कोरिया के आंतरिक एवं सुरक्षा मंत्रालय के दिशानिर्देश के अनुसार ढालता है: वर्णनात्मक वाक्य, मानक क्रमांकन, हर जगह उपलब्ध फ़ॉन्ट, सरल तालिकाएँ।',
    'builtinSkillDesc.administration-report-draft':
      'मंत्रालय के प्रारूप में प्रशासनिक रिपोर्ट शुरू से लिखता है: अनुभाग, Ⅰ·1·가 क्रमांकन, वर्णनात्मक वाक्य, तालिका शीर्षक और उपलब्ध फ़ॉन्ट।',
    'builtinSkillDesc.docx':
      'केवल एजेंट विंडो में काम करता है। स्क्रिप्ट चलाकर प्रोजेक्ट फ़ोल्डर में .docx फ़ाइलें बनाता, संपादित करता और पढ़ता है। इस PC पर Python और अन्य प्रोग्राम इंस्टॉल होने चाहिए।',
    'builtinSkillDesc.pptx':
      'केवल एजेंट विंडो में काम करता है। स्क्रिप्ट चलाकर प्रोजेक्ट फ़ोल्डर में .pptx फ़ाइलें बनाता, संपादित करता और पढ़ता है। इस PC पर Python और अन्य प्रोग्राम इंस्टॉल होने चाहिए।',
    'builtinSkillDesc.xlsx':
      'केवल एजेंट विंडो में काम करता है। स्क्रिप्ट चलाकर प्रोजेक्ट फ़ोल्डर में .xlsx फ़ाइलें बनाता और संपादित करता है और उनके फ़ॉर्मूले दोबारा गिनता है। इस PC पर Python और अन्य प्रोग्राम इंस्टॉल होने चाहिए।',
    'builtinSkillDesc.pdf':
      'केवल एजेंट विंडो में काम करता है। स्क्रिप्ट चलाकर प्रोजेक्ट फ़ोल्डर की .pdf फ़ाइलें पढ़ता, जोड़ता और बाँटता है और फ़ॉर्म भरता है। इस PC पर Python और अन्य प्रोग्राम इंस्टॉल होने चाहिए।',
    'builtinSkillDesc.hwp-document':
      'नया .hwp या .hwpx दस्तावेज़ शुरू से लिखता है: रिपोर्ट, योजना, सूचना, सरकारी पत्र या बैठक के कार्यवृत्त के लिए ढाँचा चुनता है, दस्तावेज़ की शैली में लिखता है और अंत में जाँच करता है।',
    'builtinSkillDesc.mindmap':
      'किसी विषय या सामग्री से माइंड मैप बनाता है: तीन से सात संतुलित मुख्य शाखाएँ, छोटे शीर्षक और ब्योरा नोट में, और अंत में ढाँचे की जाँच।',
    'builtinSkillDesc.diagram':
      'साफ़ आरेख बनाता है: सही प्रकार चुनता है, प्रवाह एक ही दिशा में, लेबल छोटे और रंग कम रखता है, और ओवरलैप व बिना जुड़ी आकृतियों की जाँच करता है।',
    'builtinSkillDesc.html-document':
      'ऐसा HTML दस्तावेज़ बनाता है जो स्क्रीन पर पढ़ने में अच्छा और छपने पर साफ़ हो: पहले पाठक, लंबाई और काग़ज़ तय करता है, फिर पृष्ठों और सामग्री की जाँच करता है।',
  },
  'zh-TW': {
    'builtinSkillDesc.meeting-minutes': '把會議筆記整理成列明決議事項和待辦事項的會議紀錄。',
    'builtinSkillDesc.internal-comms': '撰寫公告、內部電子報、進度報告、常見問題等組織內部的文字。',
    'builtinSkillDesc.humanizer': '找出文字中帶有 AI 痕跡的說法，在不改變內容的前提下改得更自然。',
    'builtinSkillDesc.copy-editing': '把已經寫好的英文文字逐次檢查，改得更清楚、更簡潔。',
    'builtinSkillDesc.find-skills':
      '僅能在代理程式視窗中使用，需要連網，用來尋找所需技能並建議安裝。',
    'builtinSkillDesc.administration-report':
      '依照韓國行政安全部的指南整理報告：敘述式語句、標準編號、通用字體、簡潔的表格。',
    'builtinSkillDesc.administration-report-draft':
      '依行政安全部格式從頭撰寫行政文書：章節結構、Ⅰ·1·가 編號、敘述式語句、表題與通用字體。',
    'builtinSkillDesc.docx':
      '僅能在代理程式視窗中使用。執行指令碼，在專案資料夾中建立、修改和讀取 .docx 檔案。這台電腦上需要安裝 Python 等程式。',
    'builtinSkillDesc.pptx':
      '僅能在代理程式視窗中使用。執行指令碼，在專案資料夾中建立、修改和讀取 .pptx 檔案。這台電腦上需要安裝 Python 等程式。',
    'builtinSkillDesc.xlsx':
      '僅能在代理程式視窗中使用。執行指令碼，在專案資料夾中建立和修改 .xlsx 檔案，並重新計算公式。這台電腦上需要安裝 Python 等程式。',
    'builtinSkillDesc.pdf':
      '僅能在代理程式視窗中使用。執行指令碼，在專案資料夾中讀取、合併和分割 .pdf 檔案，並填寫表單。這台電腦上需要安裝 Python 等程式。',
    'builtinSkillDesc.hwp-document':
      '從頭撰寫 .hwp、.hwpx 文件：依報告、計畫、通知、公文、會議紀錄選定架構，用公文語體撰寫，最後進行檢查。',
    'builtinSkillDesc.mindmap':
      '根據主題或資料製作心智圖：均衡地設 3 到 7 個主分支，標題簡短、說明放在備註裡，最後檢查架構。',
    'builtinSkillDesc.diagram':
      '繪製清楚易讀的圖表：選對圖表類型，流向保持同一方向，文字簡短、顏色少用，並檢查重疊和孤立的圖形。',
    'builtinSkillDesc.html-document':
      '製作在螢幕上好讀、列印也整潔的 HTML 文件：先確定讀者、篇幅和紙張，再檢查分頁和內容。',
  },
  vi: {
    'builtinSkillDesc.meeting-minutes':
      'Biến ghi chú cuộc họp thành biên bản nêu rõ các quyết định và việc cần làm.',
    'builtinSkillDesc.internal-comms':
      'Viết thông báo, bản tin, báo cáo tiến độ, câu hỏi thường gặp và các văn bản nội bộ khác.',
    'builtinSkillDesc.humanizer':
      'Tìm những cách diễn đạt nghe như AI viết và sửa cho tự nhiên mà không đổi nội dung.',
    'builtinSkillDesc.copy-editing':
      'Rà lại nhiều lượt một văn bản tiếng Anh đã viết để nó rõ ràng và gọn hơn.',
    'builtinSkillDesc.find-skills':
      'Chỉ dùng được trong cửa sổ tác tử và cần internet để tìm kỹ năng và đề xuất cài đặt.',
    'builtinSkillDesc.administration-report':
      'Đưa báo cáo về đúng hướng dẫn của Bộ Nội vụ và An toàn Hàn Quốc: câu diễn đạt, đánh số chuẩn, phông chữ mở được mọi nơi, bảng đơn giản.',
    'builtinSkillDesc.administration-report-draft':
      'Viết báo cáo hành chính từ đầu theo định dạng của bộ: các phần, đánh số Ⅰ·1·가, câu diễn đạt, tiêu đề bảng và phông chữ phổ dụng.',
    'builtinSkillDesc.docx':
      'Chỉ dùng được trong cửa sổ tác tử. Chạy tập lệnh để tạo, sửa và đọc tệp .docx trong thư mục dự án. PC này cần cài sẵn Python và các chương trình khác.',
    'builtinSkillDesc.pptx':
      'Chỉ dùng được trong cửa sổ tác tử. Chạy tập lệnh để tạo, sửa và đọc tệp .pptx trong thư mục dự án. PC này cần cài sẵn Python và các chương trình khác.',
    'builtinSkillDesc.xlsx':
      'Chỉ dùng được trong cửa sổ tác tử. Chạy tập lệnh để tạo và sửa tệp .xlsx trong thư mục dự án và tính lại công thức. PC này cần cài sẵn Python và các chương trình khác.',
    'builtinSkillDesc.pdf':
      'Chỉ dùng được trong cửa sổ tác tử. Chạy tập lệnh để đọc, gộp và tách tệp .pdf trong thư mục dự án và điền biểu mẫu. PC này cần cài sẵn Python và các chương trình khác.',
    'builtinSkillDesc.hwp-document':
      'Viết mới tài liệu .hwp hoặc .hwpx từ đầu: chọn bố cục cho báo cáo, kế hoạch, thông báo, công văn hoặc biên bản họp, viết theo văn phong tài liệu rồi kiểm tra kết quả.',
    'builtinSkillDesc.mindmap':
      'Dựng sơ đồ tư duy từ một chủ đề hoặc tài liệu: ba đến bảy nhánh chính cân đối, tiêu đề ngắn với chi tiết đặt trong ghi chú, và kiểm tra cấu trúc ở cuối.',
    'builtinSkillDesc.diagram':
      'Vẽ sơ đồ rõ ràng: chọn loại phù hợp, giữ một hướng đi, nhãn ngắn và ít màu, rồi kiểm tra chồng lấn và hình rời rạc.',
    'builtinSkillDesc.html-document':
      'Tạo tài liệu HTML dễ đọc trên màn hình và gọn gàng khi in: xác định người đọc, độ dài và khổ giấy trước, rồi kiểm tra các trang và nội dung.',
  },
})

export type BuiltinSkillStringKey = keyof typeof zh

/** `builtinSkillText(lang, key)`: one built-in skill string in that language */
export const builtinSkillText: (lang: Lang, key: BuiltinSkillStringKey) => string =
  createI18n(BUILTIN_SKILL_STRINGS)

/** One-line description of a built-in skill in `lang` (key `builtinSkillDesc.<name>`) */
export function builtinSkillDesc(lang: Lang, name: BuiltinSkillName): string {
  return builtinSkillText(lang, `builtinSkillDesc.${name}`)
}

/** Narrows a skill name read from disk or settings to a built-in skill name */
export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name)
}
