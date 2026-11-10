import type { zh } from './zh'

export const hi = {
  pageSelDelete: '{n} पृष्ठ हटाएँ',
  pageSelExtract: '{n} पृष्ठ निकालें',
  pageCut: 'काटें',
  pageCopy: 'कॉपी करें',
  pagePaste: 'पेस्ट करें',
  pagesCopied: 'कॉपी किए गए पृष्ठ: {n}',
  pagesCut: 'काटे गए पृष्ठ: {n}',
  pagesPasted: 'पेस्ट किए गए पृष्ठ: {n}',
  pageClipEmpty:
    'कोई पृष्ठ कॉपी नहीं किया गया है। थंबनेल में पृष्ठ चुनकर कॉपी करें, फिर पेस्ट करें।',
  pageClipProtected: 'पासवर्ड से सुरक्षित PDF में पृष्ठ कॉपी या पेस्ट नहीं किए जा सकते।',
} satisfies Record<keyof typeof zh, string>
