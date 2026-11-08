import type { zh } from './zh'

export const hi = {
  ntOpen: 'नोट खोलें',
  ntOpenTip: 'इस PDF से जुड़ा Markdown नोट खोलें',
  ntInsert: 'नोट में जोड़ें',
  ntInsertTip: 'इसे नोट के अंत में जोड़ता है। नोट वाले टैब में सहेजें',
  ntSaveFirst: 'पहले PDF सहेजें',
  ntUnavailable: 'नोट केवल GenOffice ऐप के अंदर खुलते हैं',
  ntFailed: 'नोट नहीं खुल सका। {reason}',
  ntInserted: 'नोट में जोड़ दिया गया',
} satisfies Record<keyof typeof zh, string>
