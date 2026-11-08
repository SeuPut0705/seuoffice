import type { zh } from './zh'

export const th = {
  contextConfirm:
    'คำขอนี้ใกล้ถึงขีดจำกัดบริบทของโมเดล: ประมาณ {estimated} จาก {limit} โทเคน ({percent}%) ยังต้องการส่งหรือไม่',
  contextUnknown: 'ยืนยันขนาดบริบทของโมเดลไม่ได้ จึงถือว่าใช้ได้ {limit} โทเคน',
  toolsUnsupported: 'โมเดลนี้ไม่รองรับการเรียกเครื่องมือ จะเสนอข้อความเท่านั้นและจะไม่แก้ไขเอกสาร',
  errContextLimit:
    'ไม่ได้ส่งคำขอ เพราะใกล้ถึงขีดจำกัดบริบทของโมเดล โปรดแบ่งเป็นคำขอเล็กลงแล้วลองอีกครั้ง',
} satisfies Record<keyof typeof zh, string>
