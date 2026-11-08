import type { zh } from './zh'

export const th = {
  ntOpen: 'เปิดโน้ต',
  ntOpenTip: 'เปิดโน้ต Markdown ที่เชื่อมกับ PDF นี้',
  ntInsert: 'เพิ่มลงในโน้ต',
  ntInsertTip: 'เพิ่มเนื้อหานี้ต่อท้ายโน้ต บันทึกได้ในแท็บของโน้ต',
  ntSaveFirst: 'โปรดบันทึก PDF ก่อน',
  ntUnavailable: 'เปิดโน้ตได้เฉพาะในแอป GenOffice',
  ntFailed: 'เปิดโน้ตไม่ได้ {reason}',
  ntInserted: 'เพิ่มลงในโน้ตแล้ว',
} satisfies Record<keyof typeof zh, string>
