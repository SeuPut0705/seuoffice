import type { zh } from './zh'

export const hi = {
  windowTitle: 'त्वरित पूर्वावलोकन',
  openInEditor: 'GenOffice में खोलें',
  revealInFolder: 'फ़ोल्डर में दिखाएँ',
  close: 'बंद करें',
  prevFile: 'पिछली फ़ाइल (↑)',
  nextFile: 'अगली फ़ाइल (↓)',
  shortcutHint: 'Space / Esc बंद करें · ↑↓ बदलें · Enter खोलें',
  loading: 'पूर्वावलोकन लोड हो रहा है…',
  empty: 'इस दस्तावेज़ में पूर्वावलोकन योग्य पाठ नहीं है।',
  encrypted: 'पासवर्ड-संरक्षित दस्तावेज़। अनलॉक करने के लिए GenOffice में खोलें।',
  unsupported: 'इस फ़ाइल प्रारूप का सीधे पूर्वावलोकन नहीं किया जा सकता।',
  failed: 'फ़ाइल पूर्वावलोकन नहीं पढ़ा जा सका।',
  truncated: 'दस्तावेज़ का प्रारंभिक भाग दिखाया जा रहा है। पूरा देखने के लिए GenOffice में खोलें।',
  slideLabel: 'स्लाइड {n}',
  sheetCount: '{n} शीट',
  slideCount: '{n} स्लाइड',
  lineCount: '{n} पंक्तियाँ',
  charCount: '{n} अक्षर',
  tabThumbnail: 'पूर्वावलोकन छवि',
  tabContent: 'दस्तावेज़ सामग्री',
  setQuickLookTitle: 'त्वरित पूर्वावलोकन (Spacebar)',
  setQuickLookHint:
    'बिना टैब खोले सामग्री देखने के लिए GenOffice सूचियों में किसी भी फ़ाइल पर Space दबाएँ।',
  setExplorerSpace: 'Windows File Explorer और डेस्कटॉप में Spacebar से फ़ाइल पूर्वावलोकन करें',
  setExplorerSpaceDesc:
    'त्वरित पूर्वावलोकन विंडो खोलने के लिए File Explorer या डेस्कटॉप में चयनित फ़ाइल पर Space दबाएँ।',
  setKeepInTray: 'विंडो बंद होने पर सिस्टम ट्रे में चालू रखें',
  setKeepInTrayDesc:
    'मुख्य विंडो बंद करने के बाद भी File Explorer में Spacebar पूर्वावलोकन के लिए GenOffice को पृष्ठभूमि में तैयार रखता है।',
  trayOpen: 'GenOffice खोलें',
  trayQuit: 'GenOffice से बाहर निकलें',
} satisfies Record<keyof typeof zh, string>
