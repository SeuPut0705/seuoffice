import type { zh } from './zh'

export const hi = {
  contextConfirm:
    'यह अनुरोध मॉडल की संदर्भ सीमा के करीब है: लगभग {estimated} / {limit} टोकन ({percent}%)। फिर भी भेजें?',
  contextUnknown: 'मॉडल के संदर्भ का आकार पुष्ट नहीं हो सका; {limit} टोकन माने गए हैं।',
  toolsUnsupported:
    'यह मॉडल टूल कॉल का समर्थन नहीं करता। यह केवल पाठ सुझाएगा और दस्तावेज़ को संपादित नहीं करेगा।',
  errContextLimit:
    'कुछ नहीं भेजा गया: अनुरोध मॉडल की संदर्भ सीमा के करीब है। इसे छोटे अनुरोधों में बाँटकर फिर से कोशिश करें।',
} satisfies Record<keyof typeof zh, string>
