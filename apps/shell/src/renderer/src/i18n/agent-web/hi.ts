import type { zh } from './zh'

export const hi = {
  actWebSearch: 'वेब खोज',
  actWebFetch: 'वेब पेज पढ़ें',
  permWebSearch: 'वेब पर खोजें',
  permWebFetch: 'यह वेब पेज पढ़ें',
  permAllowSearchSession: 'इस सत्र के दौरान खोज की अनुमति दें',
  permAllowSiteSession: 'इस सत्र के दौरान इस साइट की अनुमति दें',
  codexWebLabel: 'वेब खोज',
  codexWebCached: 'सहेजे गए परिणाम',
  codexWebLive: 'लाइव',
  codexWebDisabled: 'बंद',
  codexWebNote:
    'सहेजे गए परिणाम पहले से इकट्ठा की गई वेब सामग्री से आते हैं; लाइव अभी के वेब में खोजता है।',
  codexNetworkLabel: 'कमांड की इंटरनेट पहुँच',
  codexNetworkOff: 'बंद',
  codexNetworkOn: 'चालू',
  codexNetworkWarning:
    'चालू करने पर Codex जो कमांड चलाता है, वे इंटरनेट तक पहुँच सकते हैं। “इस प्रोजेक्ट पर भरोसा करें” में वे बिना पूछे पहुँचते हैं। मिले हुए दस्तावेज़ में छिपे निर्देश उनसे आपका डेटा बाहर भिजवा सकते हैं।',
  codexFolderNote: 'ये दोनों सेटिंग हर प्रोजेक्ट फ़ोल्डर के लिए अलग से याद रखी जाती हैं।',
  providerCodexNoteWeb:
    'कमांड Codex के अलग किए गए स्थान में चलते हैं: केवल प्रोजेक्ट फ़ोल्डर में लिखा जा सकता है, और जब तक आप चालू न करें, इंटरनेट उपलब्ध नहीं है।',
} satisfies Record<keyof typeof zh, string>
