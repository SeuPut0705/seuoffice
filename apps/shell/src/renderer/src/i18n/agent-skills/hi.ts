import type { zh } from './zh'

export const hi = {
  noticeText:
    'कौशल अब सेटिंग्स → कौशल में चालू और बंद होते हैं। Claude और Codex कौशल फ़ोल्डरों के कौशल शुरू में बंद रहते हैं।',
  noticeOpenSettings: 'सेटिंग्स खोलें',
  noticeClose: 'बंद करें',
  nextSession: 'बदले गए कौशल अगले सत्र से लागू होंगे',
  templateLabel: 'टेम्पलेट के रूप में सहेजा जाने वाला दस्तावेज़',
  templateNone: 'कोई टेम्पलेट नहीं',
  templateFromTab: 'टैब में खुला',
  templateFromProject: 'प्रोजेक्ट फ़ोल्डर',
  templateUnsaved: 'इस टैब में बिना सहेजे बदलाव हैं। सहेजी गई फ़ाइल ही टेम्पलेट बनेगी।',
  templateChecking: 'छिपाई गई सामग्री की जाँच हो रही है…',
  templateUnknown:
    'इस फ़ॉर्मैट में यहाँ यह जाँचा नहीं जा सकता कि कोई सामग्री छिपाई गई है या नहीं, इसलिए इसे जैसा है वैसा नहीं सहेजा जा सकता। खाली टेम्पलेट बनाकर उसे सहेजें।',
  templateTooLarge: 'यह दस्तावेज़ टेम्पलेट के रूप में सहेजने के लिए बहुत बड़ा है',
  installTitle: 'AI इस कौशल को इंस्टॉल करने का सुझाव दे रहा है',
  installHint:
    'पूर्वावलोकन खोलकर देखें कि इसमें क्या है, फिर तय करें कि इसे इंस्टॉल करना है या नहीं। इंस्टॉल किया गया कौशल अगले सत्र से उपलब्ध होगा।',
  installOpen: 'पूर्वावलोकन खोलें',
  installDismiss: 'बंद करें',
  installDismissed: 'इंस्टॉल नहीं किया',
  installCancel: 'रद्द करें',
  actProposeSkill: 'कौशल का सुझाव',
} satisfies Record<keyof typeof zh, string>
